package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	CloudPendingMaxItems      = 20
	CloudPendingMaxItemBytes  = 4 << 20
	CloudPendingMaxQueueBytes = 16 << 20
)

var (
	ErrCloudPendingConflict = errors.New("pending queue version changed")
	ErrCloudPendingLimit    = errors.New("pending queue capacity exceeded")
)

// A pending item is private, inert user data. It has no execution session, lease,
// run state or server credential. Only explicit admission can turn it into a Run.
type CloudPendingItem struct {
	ClientItemID    string                  `json:"client_item_id"`
	Version         int64                   `json:"version,string"`
	Content         json.RawMessage         `json:"content"`
	Model           string                  `json:"model"`
	ProviderKeyID   int64                   `json:"provider_key_id,omitempty"`
	ReasoningEffort string                  `json:"reasoning_effort,omitempty"`
	ModelParameters CloudRunModelParameters `json:"model_parameters"`
	PublicResearch  *CloudRunPublicResearch `json:"public_research,omitempty"`
	Composer        json.RawMessage         `json:"composer,omitempty"`
	Presentation    string                  `json:"presentation"`
	CreatedAt       time.Time               `json:"created_at"`
	UpdatedAt       time.Time               `json:"updated_at"`
}

type CloudPendingQueue struct {
	ConversationID string             `json:"conversation_id"`
	Version        int64              `json:"version,string"`
	Items          []CloudPendingItem `json:"items"`
}

type CloudPendingMutation struct {
	Kind            string
	ExpectedVersion int64
	ItemID          string
	Item            *CloudPendingItem
	Order           []string
}

type CloudPendingQueueStore interface {
	GetCloudPendingQueue(context.Context, int64, string) (*CloudPendingQueue, error)
	MutateCloudPendingQueue(context.Context, int64, string, CloudPendingMutation) (*CloudPendingQueue, error)
}

func (item CloudPendingItem) runInput(conversationID string) CreateCloudRunInput {
	return CreateCloudRunInput{ConversationID: conversationID, ClientRequestID: item.ClientItemID,
		Content: item.Content, Model: item.Model, ProviderKeyID: item.ProviderKeyID,
		ReasoningEffort: item.ReasoningEffort, ModelParameters: item.ModelParameters, PublicResearch: item.PublicResearch}
}

func cloneCloudPendingQueue(queue CloudPendingQueue) *CloudPendingQueue {
	// Bounded JSON cloning also isolates nested composer segments and parameter slices.
	var copy CloudPendingQueue
	_ = json.Unmarshal(cloudJSON(queue), &copy)
	if copy.Items == nil {
		copy.Items = []CloudPendingItem{}
	}
	return &copy
}

func normalizeCloudPendingItem(input *CloudPendingItem) (*CloudPendingItem, error) {
	if input == nil {
		return nil, ErrCloudRunInvalid
	}
	item := *input
	id, err := uuid.Parse(item.ClientItemID)
	if err != nil || id == uuid.Nil {
		return nil, ErrCloudRunInvalid
	}
	item.ClientItemID = id.String()
	item.Model = strings.TrimSpace(item.Model)
	if item.Model == "" || len(item.Model) > 200 || item.ProviderKeyID < 0 || !validCloudReasoningEffort(item.ReasoningEffort) {
		return nil, ErrCloudRunInvalid
	}
	if item.Presentation != "chat" && item.Presentation != "work" {
		return nil, ErrCloudRunInvalid
	}
	if len(item.Content)+len(item.Composer) > CloudPendingMaxItemBytes {
		return nil, ErrCloudPendingLimit
	}
	item.Content, err = validateCloudContent(item.Content)
	if err != nil {
		return nil, err
	}
	item.Content, err = logicalCloudRunContent(item.Content)
	if err != nil {
		return nil, err
	}
	item.ModelParameters, err = normalizeCloudModelParameters(item.ModelParameters)
	if err != nil {
		return nil, err
	}
	item.PublicResearch, err = normalizeCloudPublicResearch(item.PublicResearch)
	if err != nil {
		return nil, err
	}
	if !cloudAllowsImage(item.ModelParameters) && cloudContainsImage(item.Content) {
		return nil, ErrCloudRunInvalid
	}
	if len(item.Composer) > 0 {
		var composer map[string]json.RawMessage
		if len(item.Composer) > 1<<20 || !utf8.Valid(item.Composer) || json.Unmarshal(item.Composer, &composer) != nil || composer == nil {
			return nil, ErrCloudRunInvalid
		}
		// This opaque editor snapshot is never interpreted as executable content.
		item.Composer = append(json.RawMessage(nil), item.Composer...)
	}
	item.Version, item.CreatedAt, item.UpdatedAt = 0, time.Time{}, time.Time{}
	if len(cloudJSON(item)) > CloudPendingMaxItemBytes {
		return nil, ErrCloudPendingLimit
	}
	return &item, nil
}

func cloudPendingIndex(queue *CloudPendingQueue, id string) int {
	for index := range queue.Items {
		if queue.Items[index].ClientItemID == id {
			return index
		}
	}
	return -1
}

func cloudPendingEquivalent(left, right CloudPendingItem) bool {
	left.Version, right.Version = 0, 0
	left.CreatedAt, left.UpdatedAt, right.CreatedAt, right.UpdatedAt = time.Time{}, time.Time{}, time.Time{}, time.Time{}
	// JSONB reorders object keys, including nested RawMessage editor snapshots.
	// Decode and re-encode both trees before comparing an uncertain enqueue
	// receipt. Preserve JSON numbers rather than rounding identities to float64.
	canonical := func(item CloudPendingItem) []byte {
		var value any
		decoder := json.NewDecoder(bytes.NewReader(cloudJSON(item)))
		decoder.UseNumber()
		if decoder.Decode(&value) != nil {
			return nil
		}
		return cloudJSON(value)
	}
	a, b := canonical(left), canonical(right)
	return len(a) > 0 && len(b) > 0 && bytes.Equal(a, b)
}

func applyCloudPendingMutation(queue *CloudPendingQueue, mutation CloudPendingMutation, now time.Time) (*CloudPendingQueue, error) {
	next := cloneCloudPendingQueue(*queue)
	index := cloudPendingIndex(next, mutation.ItemID)
	switch mutation.Kind {
	case "enqueue":
		item, err := normalizeCloudPendingItem(mutation.Item)
		if err != nil {
			return nil, err
		}
		index = cloudPendingIndex(next, item.ClientItemID)
		if index >= 0 {
			if cloudPendingEquivalent(next.Items[index], *item) {
				return next, nil
			}
			return nil, ErrCloudPendingConflict
		}
		if mutation.ExpectedVersion != next.Version {
			return nil, ErrCloudPendingConflict
		}
		if len(next.Items) >= CloudPendingMaxItems {
			return nil, ErrCloudPendingLimit
		}
		item.Version, item.CreatedAt, item.UpdatedAt = 1, now.UTC(), now.UTC()
		next.Items = append(next.Items, *item)
	case "edit":
		if index < 0 {
			return nil, ErrNotFound
		}
		if mutation.ExpectedVersion != next.Items[index].Version {
			return nil, ErrCloudPendingConflict
		}
		if next.Items[index].Version == math.MaxInt64 {
			return nil, ErrCloudPendingLimit
		}
		item, err := normalizeCloudPendingItem(mutation.Item)
		if err != nil {
			return nil, err
		}
		if item.ClientItemID != mutation.ItemID {
			return nil, ErrCloudRunInvalid
		}
		item.Version, item.CreatedAt, item.UpdatedAt = next.Items[index].Version+1, next.Items[index].CreatedAt, now.UTC()
		next.Items[index] = *item
	case "remove":
		if index < 0 {
			return nil, ErrNotFound
		}
		if mutation.ExpectedVersion != next.Items[index].Version {
			return nil, ErrCloudPendingConflict
		}
		next.Items = append(next.Items[:index], next.Items[index+1:]...)
	case "reorder":
		if mutation.ExpectedVersion != next.Version {
			return nil, ErrCloudPendingConflict
		}
		if len(mutation.Order) != len(next.Items) {
			return nil, ErrCloudRunInvalid
		}
		items := make([]CloudPendingItem, 0, len(next.Items))
		seen := map[string]bool{}
		for _, id := range mutation.Order {
			index := cloudPendingIndex(next, id)
			if seen[id] || index < 0 {
				return nil, ErrCloudRunInvalid
			}
			seen[id] = true
			items = append(items, next.Items[index])
		}
		next.Items = items
	default:
		return nil, ErrCloudRunInvalid
	}
	next.Version++
	if next.Version <= 0 || len(cloudJSON(next.Items)) > CloudPendingMaxQueueBytes {
		return nil, ErrCloudPendingLimit
	}
	return next, nil
}

func consumeCloudPendingQueue(queue *CloudPendingQueue, run *CloudRun) (*CloudPendingQueue, error) {
	index := cloudPendingIndex(queue, run.ClientRequestID)
	if run.pendingVersion == 0 {
		if index >= 0 {
			return nil, ErrCloudPendingConflict
		}
		return queue, nil
	}
	if index < 0 {
		return nil, ErrNotFound
	}
	item := queue.Items[index]
	if item.Version != run.pendingVersion {
		return nil, ErrCloudPendingConflict
	}
	hash, err := cloudRunLogicalRequestHash(item.runInput(queue.ConversationID))
	if err != nil || hash != run.RequestHash {
		return nil, ErrCloudPendingConflict
	}
	return applyCloudPendingMutation(queue, CloudPendingMutation{Kind: "remove", ItemID: item.ClientItemID, ExpectedVersion: item.Version}, run.CreatedAt)
}

func (s *Service) SubmitCloudPendingItem(ctx context.Context, session *Session, conversationID, itemID string, version int64) (*CloudRun, bool, error) {
	if session == nil || session.UserID <= 0 || version <= 0 {
		return nil, false, ErrCloudRunInvalid
	}
	store, ok := s.store.(CloudPendingQueueStore)
	if !ok {
		return nil, false, ErrCloudRunInvalid
	}
	queue, err := store.GetCloudPendingQueue(ctx, session.UserID, conversationID)
	if err != nil {
		return nil, false, err
	}
	index := cloudPendingIndex(queue, itemID)
	if index < 0 {
		// A lost admission receipt is recovered without creating or claiming work.
		if replay, ok := s.store.(cloudRunReplayStore); ok {
			run, readErr := replay.GetCloudRunByClientRequest(ctx, session.UserID, itemID)
			if readErr == nil && run.ConversationID == conversationID {
				current, authErr := s.Session(ctx, session.ID)
				if authErr != nil {
					return nil, false, authErr
				}
				if current.UserID != session.UserID {
					return nil, false, sessionMissingError()
				}
				return run, false, nil
			}
		}
		return nil, false, ErrNotFound
	}
	if queue.Items[index].Version != version {
		return nil, false, ErrCloudPendingConflict
	}
	input := queue.Items[index].runInput(conversationID)
	input.pendingVersion = version
	return s.CreateCloudRun(ctx, session, input)
}
