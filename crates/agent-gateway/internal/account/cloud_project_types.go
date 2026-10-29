package account

import (
	"errors"
	"time"
)

const (
	CloudProjectMaxAccountProjects = 500
	CloudProjectMaxFiles           = 50
	CloudProjectMaxInstructions    = 16 << 10
	CloudMemoryMaxEntries          = 100
	CloudMemoryMaxContent          = 4096
	CloudMemoryMaxContext          = 32 << 10
)

var (
	ErrCloudProjectInvalid  = errors.New("invalid cloud project or memory operation")
	ErrCloudProjectConflict = errors.New("cloud project or memory version changed")
	ErrCloudProjectQuota    = errors.New("cloud project or memory resource limit reached")
)

type CloudProject struct {
	ID           string    `json:"id"`
	UserID       int64     `json:"-"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	Instructions string    `json:"instructions"`
	Version      int64     `json:"version"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type CloudProjectUpdate struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	Instructions string `json:"instructions"`
}

// The association has its own CAS version, independent of streaming history.
// A missing association is represented by project_id="", version=0.
type CloudProjectConversation struct {
	ConversationID string             `json:"conversation_id"`
	ProjectID      string             `json:"project_id"`
	Version        int64              `json:"version"`
	CreatedAt      time.Time          `json:"created_at"`
	Conversation   *CloudConversation `json:"conversation,omitempty"`
}

// Memory is written only through explicit user operations, never auto-extracted.
// Project-specific instructions remain on CloudProject, not in global memory.
type CloudMemory struct {
	ID        string    `json:"id"`
	UserID    int64     `json:"-"`
	Content   string    `json:"content"`
	Enabled   bool      `json:"enabled"`
	Version   int64     `json:"version"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type CloudMemorySettings struct {
	Enabled   bool      `json:"enabled"`
	Version   int64     `json:"version"`
	UpdatedAt time.Time `json:"updated_at"`
}

type CloudMemoryContext struct {
	Enabled   bool          `json:"enabled"`
	Items     []CloudMemory `json:"items"`
	Truncated bool          `json:"truncated"`
}
