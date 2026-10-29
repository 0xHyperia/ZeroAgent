package account

import (
	"encoding/json"
	"errors"
	"time"
)

const (
	CloudArtifactStaging            = "staging"
	CloudArtifactReady              = "ready"
	CloudArtifactFailed             = "failed"
	CloudArtifactUnknown            = "unknown"
	CloudArtifactDeleting           = "deleting"
	CloudArtifactDeleted            = "deleted"
	CloudArtifactMaxBytes           = int64(32 << 20)
	CloudArtifactMaxAccountBytes    = int64(256 << 20)
	CloudArtifactMaxAccountVersions = 500
	CloudArtifactMaxFamilyVersions  = 100
)

var (
	ErrCloudArtifactInvalid  = errors.New("invalid cloud artifact operation")
	ErrCloudArtifactConflict = errors.New("cloud artifact operation changed")
	ErrCloudArtifactQuota    = errors.New("cloud artifact account quota reached")
)

type CloudArtifactFamily struct {
	ID             string     `json:"id"`
	UserID         int64      `json:"-"`
	ConversationID string     `json:"conversation_id"`
	CreatedAt      time.Time  `json:"created_at"`
	DeletedAt      *time.Time `json:"-"`
}
type CloudArtifactVersion struct {
	ID              string          `json:"id"`
	FamilyID        string          `json:"family_id"`
	Number          int64           `json:"number"`
	UserID          int64           `json:"-"`
	ConversationID  string          `json:"conversation_id"`
	SourceRunID     string          `json:"source_run_id"`
	ToolOperationID string          `json:"-"`
	RequestHash     string          `json:"-"`
	ObjectKey       string          `json:"-"`
	Name            string          `json:"name"`
	MIME            string          `json:"mime"`
	Size            int64           `json:"size"`
	SHA256          string          `json:"sha256"`
	State           string          `json:"state"`
	ErrorCode       string          `json:"error_code,omitempty"`
	Version         int64           `json:"version"`
	Journal         json.RawMessage `json:"-"`
	DownloadPath    string          `json:"download_url,omitempty"`
	CreatedAt       time.Time       `json:"created_at"`
	UpdatedAt       time.Time       `json:"updated_at"`
	DeletedAt       *time.Time      `json:"-"`
}
type CloudArtifactPublication struct {
	ConversationID   string
	RunID            string
	ToolOperationID  string
	LeaseOwner       string
	ExecutionAttempt int64
	FamilyID         string
	Name             string
	MIME             string
	WorkspaceRef     string
	SandboxID        string
	Path             string
	Size             int64
	SHA256           string
	TransferID       string
}
type CloudArtifactUpdate struct {
	State     string
	ErrorCode string
	Journal   json.RawMessage
}
