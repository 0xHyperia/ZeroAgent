package account

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/google/uuid"
)

const (
	CloudPrivateDraftMaxBytes     = 32 << 20
	CloudPrivateDraftAccountBytes = 64 << 20
	CloudPrivateDraftMaxCount     = 100
)

var (
	ErrCloudDraftChanged           = errors.New("private draft changed")
	ErrCloudDraftOperationConflict = errors.New("private draft operation conflicts")
	ErrCloudDraftLimit             = errors.New("private draft capacity exceeded")
)

// Drafts are inert private editor state. They never acquire run credentials,
// create conversations, become canonical messages or enter the runner queue.
// Per-scope tombstones prevent ABA after deletion without making unrelated
// conversation saves conflict. Small operation receipts retain idempotency
// without keeping obsolete copies of large drafts.
const CloudPrivateDraftSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_draft_accounts (
 user_id BIGINT PRIMARY KEY,version BIGINT NOT NULL DEFAULT 0 CHECK(version>=0)
);
CREATE TABLE IF NOT EXISTS zeroagent_cloud_private_drafts (
 user_id BIGINT NOT NULL REFERENCES zeroagent_cloud_draft_accounts(user_id) ON DELETE CASCADE,
 scope TEXT NOT NULL,conversation_id UUID REFERENCES zerobox_cloud_conversations(id) ON DELETE CASCADE,
 version BIGINT NOT NULL CHECK(version>0),draft JSONB NULL CHECK(draft IS NULL OR jsonb_typeof(draft)='object'),
 size_bytes BIGINT NOT NULL CHECK(size_bytes>=0 AND size_bytes<=33554432),
 last_operation_id UUID NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(user_id,scope),
 CHECK((scope='blank' AND conversation_id IS NULL) OR (conversation_id IS NOT NULL AND scope=conversation_id::text))
);
CREATE TABLE IF NOT EXISTS zeroagent_cloud_draft_operations (
 user_id BIGINT NOT NULL REFERENCES zeroagent_cloud_draft_accounts(user_id) ON DELETE CASCADE,
 client_operation_id UUID NOT NULL,request_hash TEXT NOT NULL,
 result_version BIGINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(user_id,client_operation_id)
);
`

type CloudPrivateDraftSnapshot struct {
	Scope           string          `json:"scope"`
	Version         string          `json:"version"`
	Draft           json.RawMessage `json:"draft"`
	UpdatedAt       *time.Time      `json:"updated_at,omitempty"`
	LastOperationID string          `json:"last_operation_id,omitempty"`
	AppliedVersion  string          `json:"applied_version,omitempty"`
	Replayed        bool            `json:"replayed,omitempty"`
}

type CloudPrivateDraftInput struct {
	ExpectedVersion   string          `json:"expected_version"`
	ClientOperationID string          `json:"client_operation_id"`
	Draft             json.RawMessage `json:"draft,omitempty"`
}

type cloudPrivateDraftStore interface {
	GetCloudPrivateDraft(context.Context, int64, string) (*CloudPrivateDraftSnapshot, error)
	WriteCloudPrivateDraft(context.Context, int64, string, CloudPrivateDraftInput, bool) (*CloudPrivateDraftSnapshot, error)
}

func cloudPrivateDraftScope(uid int64, scope string) (string, error) {
	if uid <= 0 {
		return "", ErrCloudRunInvalid
	}
	if scope == "blank" {
		return scope, nil
	}
	id, err := canonicalCloudRunID(scope)
	if err != nil {
		return "", ErrCloudRunInvalid
	}
	return id, nil
}

func prepareCloudPrivateDraft(uid int64, scope string, input CloudPrivateDraftInput, remove bool) (string, CloudPrivateDraftInput, int64, string, error) {
	scope, err := cloudPrivateDraftScope(uid, scope)
	if err != nil {
		return "", input, 0, "", err
	}
	version, err := strconv.ParseInt(input.ExpectedVersion, 10, 64)
	if err != nil || version < 0 || strconv.FormatInt(version, 10) != input.ExpectedVersion {
		return "", input, 0, "", ErrCloudRunInvalid
	}
	id, err := uuid.Parse(input.ClientOperationID)
	if err != nil || id.String() != input.ClientOperationID {
		return "", input, 0, "", ErrCloudRunInvalid
	}
	if remove {
		if len(input.Draft) > 0 {
			return "", input, 0, "", ErrCloudRunInvalid
		}
	} else {
		if len(input.Draft) > CloudPrivateDraftMaxBytes {
			return "", input, 0, "", ErrCloudDraftLimit
		}
		var compact bytes.Buffer
		if json.Compact(&compact, input.Draft) != nil || compact.Len() < 2 || compact.Bytes()[0] != '{' {
			return "", input, 0, "", ErrCloudRunInvalid
		}
		input.Draft = append(json.RawMessage(nil), compact.Bytes()...)
	}
	hash := sha256.Sum256(cloudJSON(struct {
		Scope   string
		Version int64
		Remove  bool
		Draft   json.RawMessage
	}{scope, version, remove, input.Draft}))
	return scope, input, version, hex.EncodeToString(hash[:]), nil
}

type cloudPrivateDraftReceipt struct {
	Hash    string
	Version int64
}
type cloudPrivateDraftRecord struct {
	Data        json.RawMessage
	Version     int64
	OperationID string
	UpdatedAt   time.Time
}
type cloudPrivateDraftAccount struct {
	Version    int64
	Drafts     map[string]cloudPrivateDraftRecord
	Operations map[string]cloudPrivateDraftReceipt
}

func privateDraftMemorySnapshot(account *cloudPrivateDraftAccount, scope string) *CloudPrivateDraftSnapshot {
	result := &CloudPrivateDraftSnapshot{Scope: scope, Version: "0"}
	if account == nil {
		return result
	}
	if draft, exists := account.Drafts[scope]; exists {
		result.Version = strconv.FormatInt(draft.Version, 10)
		result.Draft = append(json.RawMessage(nil), draft.Data...)
		result.UpdatedAt = &draft.UpdatedAt
		result.LastOperationID = draft.OperationID
	}
	return result
}

func (s *MemoryStore) cloudPrivateDraftOwnerLocked(uid int64, scope string) error {
	if scope == "blank" {
		return nil
	}
	c, exists := s.cloudConversations[scope]
	if !exists || c.UserID != uid {
		return ErrNotFound
	}
	return nil
}

func (s *MemoryStore) GetCloudPrivateDraft(ctx context.Context, uid int64, scope string) (*CloudPrivateDraftSnapshot, error) {
	scope, err := cloudPrivateDraftScope(uid, scope)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if err = s.cloudPrivateDraftOwnerLocked(uid, scope); err != nil {
		return nil, err
	}
	return privateDraftMemorySnapshot(s.cloudPrivateDrafts[uid], scope), nil
}

func (s *MemoryStore) WriteCloudPrivateDraft(ctx context.Context, uid int64, scope string, input CloudPrivateDraftInput, remove bool) (*CloudPrivateDraftSnapshot, error) {
	scope, input, expected, hash, err := prepareCloudPrivateDraft(uid, scope, input, remove)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err = s.cloudPrivateDraftOwnerLocked(uid, scope); err != nil {
		return nil, err
	}
	account := s.cloudPrivateDrafts[uid]
	if account == nil {
		account = &cloudPrivateDraftAccount{Drafts: map[string]cloudPrivateDraftRecord{}, Operations: map[string]cloudPrivateDraftReceipt{}}
	}
	if receipt, exists := account.Operations[input.ClientOperationID]; exists {
		if receipt.Hash != hash {
			return nil, ErrCloudDraftOperationConflict
		}
		result := privateDraftMemorySnapshot(account, scope)
		result.AppliedVersion = strconv.FormatInt(receipt.Version, 10)
		result.Replayed = true
		return result, nil
	}
	current := int64(0)
	if draft, exists := account.Drafts[scope]; exists {
		current = draft.Version
	}
	if current != expected {
		return nil, ErrCloudDraftChanged
	}
	if !remove {
		count, total := 1, int64(len(input.Draft))
		for key, draft := range account.Drafts {
			if key != scope && len(draft.Data) > 0 {
				count++
				total += int64(len(draft.Data))
			}
		}
		if count > CloudPrivateDraftMaxCount || total > CloudPrivateDraftAccountBytes {
			return nil, ErrCloudDraftLimit
		}
	}
	if account.Version == int64(^uint64(0)>>1) {
		return nil, ErrCloudDraftLimit
	}
	account.Version++
	account.Drafts[scope] = cloudPrivateDraftRecord{append(json.RawMessage(nil), input.Draft...), account.Version, input.ClientOperationID, s.now().UTC()}
	account.Operations[input.ClientOperationID] = cloudPrivateDraftReceipt{hash, account.Version}
	if s.cloudPrivateDrafts == nil {
		s.cloudPrivateDrafts = map[int64]*cloudPrivateDraftAccount{}
	}
	s.cloudPrivateDrafts[uid] = account
	result := privateDraftMemorySnapshot(account, scope)
	result.AppliedVersion = strconv.FormatInt(account.Version, 10)
	return result, nil
}

func (s *MemoryStore) deleteCloudPrivateDraftLocked(conversationID string) {
	for _, account := range s.cloudPrivateDrafts {
		delete(account.Drafts, conversationID)
	}
}
