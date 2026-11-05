package account

import (
	"encoding/json"
	"errors"
	"time"
)

const (
	CloudRunQueued         = "queued"
	CloudRunRunning        = "running"
	CloudRunCancelling     = "cancelling"
	CloudRunCompleted      = "completed"
	CloudRunFailed         = "failed"
	CloudRunCancelled      = "cancelled"
	CloudRunInterrupted    = "interrupted"
	CloudRunMaxInputBytes  = 32 << 20
	CloudRunMaxOutputBytes = 8 << 20
	CloudRunMaxEventBytes  = 256 << 10
)

var (
	ErrCloudRunConflict  = errors.New("cloud run request conflicts with an existing request")
	ErrCloudRunBusy      = errors.New("cloud conversation already has an active run")
	ErrCloudRunLeaseLost = errors.New("cloud run execution lease is no longer valid")
	ErrCloudRunInvalid   = errors.New("invalid cloud run operation")
	ErrCloudRunLimit     = errors.New("cloud run size limit exceeded")
)

// CloudRun contains only execution metadata and user content. Provider and OAuth
// credentials are resolved through the original server-owned session at runtime.
// SessionRef is SHA-256(session.ID), never the browser's bearer cookie itself.
type CloudRun struct {
	pendingVersion     int64
	historyEdit        *CloudRunHistoryEdit
	ID                 string                  `json:"id"`
	ConversationID     string                  `json:"conversation_id"`
	UserID             int64                   `json:"-"`
	SessionRef         string                  `json:"-"`
	ClientRequestID    string                  `json:"client_request_id"`
	RequestHash        string                  `json:"-"`
	Model              string                  `json:"model"`
	ReasoningEffort    string                  `json:"reasoning_effort,omitempty"`
	ProviderKeyID      int64                   `json:"provider_key_id,omitempty"`
	ModelParameters    CloudRunModelParameters `json:"model_parameters"`
	PublicResearch     *CloudRunPublicResearch `json:"public_research,omitempty"`
	RequestContent     json.RawMessage         `json:"-"`
	UserMessageID      string                  `json:"user_message_id"`
	AssistantMessageID string                  `json:"assistant_message_id"`
	State              string                  `json:"state"`
	Output             string                  `json:"output"`
	Presentation       json.RawMessage         `json:"presentation,omitempty"`
	Usage              json.RawMessage         `json:"usage,omitempty"`
	ErrorCode          string                  `json:"error_code,omitempty"`
	LeaseOwner         string                  `json:"-"`
	Attempt            int64                   `json:"-"`
	LeaseUntil         time.Time               `json:"-"`
	LastSeq            int64                   `json:"last_seq,string"`
	CreatedAt          time.Time               `json:"created_at"`
	UpdatedAt          time.Time               `json:"updated_at"`
}

func (r *CloudRun) Terminal() bool {
	return r != nil && cloudRunTerminal(r.State)
}

func cloudRunTerminal(state string) bool {
	switch state {
	case CloudRunCompleted, CloudRunFailed, CloudRunCancelled, CloudRunInterrupted:
		return true
	}
	return false
}

type CloudRunEvent struct {
	ID             string          `json:"id"`
	RunID          string          `json:"run_id"`
	ConversationID string          `json:"conversation_id"`
	Seq            int64           `json:"seq,string"`
	Type           string          `json:"type"`
	Payload        json.RawMessage `json:"payload"`
	CreatedAt      time.Time       `json:"created_at"`
}

// CloudRunCommit is one fenced, idempotent write. Keep OperationID unchanged when
// retrying an uncertain database commit; changing it would append Delta twice.
type CloudRunCommit struct {
	OperationID string
	Delta       string
	Usage       json.RawMessage
	State       string
	ErrorCode   string
	EventType   string
	Payload     json.RawMessage
	// Set only by the canonical tool-result transaction, never from event JSON.
	presentationResources []CloudPresentationResource
}
