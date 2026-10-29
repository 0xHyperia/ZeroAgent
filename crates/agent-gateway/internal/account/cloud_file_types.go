package account

import (
	"errors"
	"time"
)

const (
	CloudFileUploading       = "uploading"
	CloudFileUploaded        = "uploaded"
	CloudFileProcessing      = "processing"
	CloudFileReady           = "ready"
	CloudFileVisionReady     = "vision_ready"
	CloudFileFailed          = "failed"
	CloudFileDeleting        = "deleting"
	CloudFileDeleted         = "deleted"
	CloudFileMaxBytes        = 32 << 20
	CloudFileMaxTextBytes    = 2 << 20
	CloudFileMaxVisionBytes  = 8 << 20
	CloudFileMaxAccountBytes = 256 << 20
	CloudFileMaxAccountFiles = 500
)

var (
	ErrCloudFileInvalid  = errors.New("invalid cloud file operation")
	ErrCloudFileConflict = errors.New("cloud file version changed")
	ErrCloudFileBusy     = errors.New("cloud file operation is busy")
	ErrCloudFileTooLarge = errors.New("cloud file exceeds its size limit")
	ErrCloudFileQuota    = errors.New("cloud file account quota reached")
)

// CloudFile is a canonical, account-owned original. Removing a conversation does
// not remove this row or its object; the account file library remains its owner.
type CloudFile struct {
	ID              string `json:"id"`
	UserID          int64  `json:"-"`
	ConversationID  string `json:"conversation_id"`
	ObjectKey       string `json:"-"`
	Name            string `json:"name"`
	MIME            string `json:"mime"`
	Size            int64  `json:"size"`
	SHA256          string `json:"sha256"`
	State           string `json:"state"`
	ProcessingStage string `json:"processing_stage,omitempty"`
	Text            string `json:"-"`
	TextBytes       int    `json:"text_bytes"`
	ParseTruncated  bool   `json:"parse_truncated,omitempty"`
	// WorkspaceLoadable is a response-only capability, never a parsed-text state.
	WorkspaceLoadable bool                `json:"workspace_loadable,omitempty"`
	Segments          []CloudFileSegment  `json:"-"`
	ParseTask         *CloudFileParseTask `json:"-"`
	ErrorCode         string              `json:"error_code,omitempty"`
	Version           int64               `json:"version"`
	CreatedAt         time.Time           `json:"created_at"`
	UpdatedAt         time.Time           `json:"updated_at"`
	UploadedAt        *time.Time          `json:"uploaded_at,omitempty"`
	// DeletedAt is set with deletion intent, before remote deletion. It is never
	// cleared, even when a failed or late upload needs another cleanup attempt.
	DeletedAt *time.Time `json:"-"`
}

type CloudFileUpdate struct {
	State           string
	ProcessingStage string
	Text            *string
	ErrorCode       string
	MarkUploaded    bool
	Segments        *[]CloudFileSegment
	ParseTask       *CloudFileParseTask
}
