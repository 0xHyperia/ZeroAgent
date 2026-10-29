package account

import (
	"encoding/json"
	"errors"
	"time"
)

const (
	CloudToolPrepared                = "prepared"
	CloudToolExecuting               = "executing"
	CloudToolSucceeded               = "succeeded"
	CloudToolFailed                  = "failed"
	CloudToolCancelled               = "cancelled"
	CloudToolUnknown                 = "unknown"
	CloudToolMaxInput                = 2 << 20
	CloudToolMaxResult               = 2 << 20
	CloudToolMaxRunOperations        = 128
	CloudWorkspacePrepared           = "prepared"
	CloudWorkspaceReady              = "ready"
	CloudWorkspaceUnknown            = "allocation_unknown"
	CloudWorkspaceCleanupPending     = "cleanup_pending"
	CloudWorkspaceClosed             = "closed"
	CloudWorkspaceMaxAllocation      = 3600
	CloudWorkspaceMaxDailyAllocation = 86400
)

var (
	ErrCloudToolInvalid  = errors.New("invalid cloud tool operation")
	ErrCloudToolConflict = errors.New("cloud tool operation changed")
	ErrCloudToolQuota    = errors.New("cloud tool allocation limit reached")
)

// Input/Result are private facts, not automatically safe public progress. The
// caller must reject session/provider secrets before Prepare, and filter output
// again before public events. A private JSON column is not a secret boundary.
type CloudToolOperation struct {
	ID               string          `json:"id"`
	UserID           int64           `json:"-"`
	ConversationID   string          `json:"conversation_id"`
	RunID            string          `json:"run_id"`
	CallKey          string          `json:"call_key"`
	Name             string          `json:"name"`
	RequestHash      string          `json:"-"`
	Input            json.RawMessage `json:"-"`
	State            string          `json:"state"`
	Result           json.RawMessage `json:"-"`
	ErrorCode        string          `json:"error_code,omitempty"`
	ExecutionAttempt int64           `json:"-"`
	Version          int64           `json:"version"`
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
}

type CloudWorkspaceBinding struct {
	ID                string    `json:"id"`
	UserID            int64     `json:"-"`
	ConversationID    string    `json:"conversation_id"`
	RunID             string    `json:"-"`
	LeaseOwner        string    `json:"-"`
	ExecutionAttempt  int64     `json:"-"`
	CreateOperationID string    `json:"-"`
	OwnerScope        string    `json:"-"`
	WorkspaceRef      string    `json:"-"`
	SandboxID         string    `json:"-"`
	State             string    `json:"state"`
	AllocationDay     string    `json:"-"`
	ReservedSeconds   int64     `json:"reserved_seconds"`
	Version           int64     `json:"version"`
	StartedAt         time.Time `json:"-"`
	ExpiresAt         time.Time `json:"expires_at"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

// This is an observation of an external effect, not an execution grant. Every
// distinct sandbox ID is retained even when a late/duplicate receipt conflicts.
type CloudWorkspaceReceipt struct {
	SandboxID string
	State     string // ready, allocation_unknown, or closed (confirmed no allocation)
	StartedAt time.Time
	ExpiresAt time.Time
}

type CloudWorkspaceCleanup struct {
	ID                 string    `json:"-"` // observation ID; use this ID when committing cleanup
	UserID             int64     `json:"-"`
	BindingID          string    `json:"-"`
	ConversationID     string    `json:"-"`
	CreateOperationID  string    `json:"-"`
	CleanupOperationID string    `json:"-"`
	OwnerScope         string    `json:"-"`
	WorkspaceRef       string    `json:"-"`
	SandboxID          string    `json:"-"`
	State              string    `json:"-"`
	ErrorCode          string    `json:"-"`
	Version            int64     `json:"-"`
	CreatedAt          time.Time `json:"-"`
	UpdatedAt          time.Time `json:"-"`
}
