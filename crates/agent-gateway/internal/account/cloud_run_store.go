package account

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

// CloudRunStore is separate from the device relay's transient event buffer. Each
// mutation atomically updates the run, event log and canonical cloud history.
type CloudRunStore interface {
	CreateCloudRun(context.Context, *CloudRun) (*CloudRun, bool, error)
	GetCloudRun(context.Context, int64, string) (*CloudRun, error)
	ListCloudRuns(context.Context, int64, string, bool) ([]CloudRun, error)
	ClaimCloudRun(context.Context, string, time.Duration) (*CloudRun, error)
	RenewCloudRunLease(context.Context, int64, string, string, int64, time.Duration) (*CloudRun, error)
	CommitCloudRun(context.Context, int64, string, string, int64, CloudRunCommit) (*CloudRun, error)
	CancelCloudRun(context.Context, int64, string) (*CloudRun, error)
	ListCloudRunEvents(context.Context, int64, string, int64, int) ([]CloudRunEvent, error)
	InterruptExpiredCloudRuns(context.Context) (int, error)
}

func prepareCloudRun(input *CloudRun, now time.Time) (*CloudRun, error) {
	if input == nil || input.UserID <= 0 || len(input.SessionRef) != 64 ||
		strings.TrimSpace(input.ClientRequestID) == "" || len(input.ClientRequestID) > 128 ||
		strings.TrimSpace(input.Model) == "" || len(input.Model) > 512 || len(input.ReasoningEffort) > 64 || input.ProviderKeyID < 0 ||
		len(input.RequestHash) != 64 || !json.Valid(input.RequestContent) || bytes.Equal(bytes.TrimSpace(input.RequestContent), []byte("null")) ||
		!utf8.Valid(input.RequestContent) {
		return nil, ErrCloudRunInvalid
	}
	if _, err := hex.DecodeString(input.RequestHash); err != nil {
		return nil, ErrCloudRunInvalid
	}
	if _, err := hex.DecodeString(input.SessionRef); err != nil {
		return nil, ErrCloudRunInvalid
	}
	if len(input.RequestContent) > CloudRunMaxInputBytes {
		return nil, ErrCloudRunLimit
	}
	if !validCloudReasoningEffort(input.ReasoningEffort) {
		return nil, ErrCloudRunInvalid
	}
	parameters, err := normalizeCloudModelParameters(input.ModelParameters)
	if err != nil {
		return nil, err
	}
	publicResearch, err := normalizeCloudPublicResearch(input.PublicResearch)
	if err != nil {
		return nil, err
	}
	run := cloneCloudRun(*input)
	run.ModelParameters = parameters
	run.PublicResearch = publicResearch
	conversationID, err := uuid.Parse(run.ConversationID)
	if err != nil {
		return nil, ErrCloudRunInvalid
	}
	run.ConversationID = conversationID.String()
	for _, id := range []*string{&run.ID, &run.UserMessageID, &run.AssistantMessageID} {
		if *id == "" {
			*id = uuid.NewString()
		} else {
			parsed, err := uuid.Parse(*id)
			if err != nil {
				return nil, ErrCloudRunInvalid
			}
			*id = parsed.String()
		}
	}
	if run.UserMessageID == run.AssistantMessageID || run.ID == run.UserMessageID || run.ID == run.AssistantMessageID {
		return nil, ErrCloudRunInvalid
	}
	run.State, run.Output, run.ErrorCode, run.LeaseOwner = CloudRunQueued, "", "", ""
	run.Usage, run.Attempt, run.LastSeq, run.LeaseUntil = nil, 0, 0, time.Time{}
	run.CreatedAt, run.UpdatedAt = now.UTC(), now.UTC()
	return &run, nil
}

func canonicalCloudRunID(id string) (string, error) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", ErrNotFound
	}
	return parsed.String(), nil
}

func cloneCloudRun(run CloudRun) CloudRun {
	run.ModelParameters = cloneCloudModelParameters(run.ModelParameters)
	if run.PublicResearch != nil {
		copy := *run.PublicResearch
		run.PublicResearch = &copy
	}
	run.RequestContent = append(json.RawMessage(nil), run.RequestContent...)
	run.Usage = append(json.RawMessage(nil), run.Usage...)
	return run
}

func cloudRunEventPayload(state, delta, errorCode string) json.RawMessage {
	data, _ := json.Marshal(struct {
		State     string `json:"state"`
		Delta     string `json:"delta,omitempty"`
		ErrorCode string `json:"error_code,omitempty"`
	}{state, delta, errorCode})
	return data
}

func prepareCloudRunCommit(commit CloudRunCommit) (CloudRunCommit, string, error) {
	if strings.TrimSpace(commit.OperationID) == "" || len(commit.OperationID) > 128 ||
		len(commit.ErrorCode) > 128 || !utf8.ValidString(commit.Delta) || len(commit.EventType) > 80 ||
		(len(commit.Usage) > 0 && (!json.Valid(commit.Usage) || len(commit.Usage) > 64<<10)) ||
		(len(commit.Payload) > 0 && (!json.Valid(commit.Payload) || !utf8.Valid(commit.Payload))) {
		return commit, "", ErrCloudRunInvalid
	}
	if commit.State != "" && commit.State != CloudRunRunning && !cloudRunTerminal(commit.State) {
		return commit, "", ErrCloudRunInvalid
	}
	if commit.EventType == "" {
		if cloudRunTerminal(commit.State) {
			commit.EventType = "run." + commit.State
		} else {
			commit.EventType = "message.delta"
		}
	}
	if len(commit.Payload) == 0 {
		commit.Payload = cloudRunEventPayload(commit.State, commit.Delta, commit.ErrorCode)
	}
	if len(commit.Delta) > CloudRunMaxEventBytes || len(commit.Payload) > CloudRunMaxEventBytes {
		return commit, "", ErrCloudRunLimit
	}
	data, _ := json.Marshal(commit)
	hash := sha256.Sum256(data)
	return commit, hex.EncodeToString(hash[:]), nil
}

func validateCloudRunLease(run *CloudRun, owner string, attempt int64, now time.Time) error {
	if owner == "" || run.LeaseOwner != owner || run.Attempt != attempt || !run.LeaseUntil.After(now) ||
		(run.State != CloudRunRunning && run.State != CloudRunCancelling) {
		return ErrCloudRunLeaseLost
	}
	return nil
}

func normalizeCloudRunLease(owner string, lease time.Duration) error {
	if strings.TrimSpace(owner) == "" || len(owner) > 256 || lease < time.Second || lease > 5*time.Minute {
		return ErrCloudRunInvalid
	}
	return nil
}

func cloudRunEventsLimit(limit int) int {
	if limit <= 0 || limit > 256 {
		return 256
	}
	return limit
}
