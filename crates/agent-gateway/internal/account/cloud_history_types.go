package account

import (
	"context"
	"encoding/json"
	"time"
)

const (
	CloudHistoryMaxPage         = 100
	CloudHistoryPageBytes       = int64(2 << 20)
	CloudHistoryMaxWindowBytes  = int64(8 << 20)
	CloudHistoryMaxUsageBytes   = int64(64 << 10)
	CloudHistoryMaxExcerptBytes = int64(48 << 10)
)

type CloudMessageHead struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	Role           string    `json:"role"`
	CreatedAt      time.Time `json:"created_at"`
	ContentBytes   int64     `json:"content_bytes"`
	ContentSHA256  string    `json:"content_sha256"`
	UsageBytes     int64     `json:"usage_bytes,omitempty"`
}

type CloudHistoryHeadsPage struct {
	Items        []CloudMessageHead `json:"items"`
	NextBeforeID string             `json:"next_before_id"`
	HasMore      bool               `json:"has_more"`
}

type CloudHistoryMessage struct {
	CloudMessage
	ContentBytes   int64  `json:"content_bytes"`
	ContentSHA256  string `json:"content_sha256"`
	ContentOmitted bool   `json:"content_omitted"`
	UsageOmitted   bool   `json:"usage_omitted,omitempty"`
}

type CloudHistoryPage struct {
	Messages     []CloudHistoryMessage `json:"messages"`
	NextBeforeID string                `json:"next_before_id"`
	HasMore      bool                  `json:"has_more"`
}

// A fragment is explicitly raw JSON UTF-8, not a complete message or summary.
type CloudHistoryExcerpt struct {
	CloudMessageHead
	OffsetBytes     int64           `json:"offset_bytes"`
	NextOffsetBytes int64           `json:"next_offset_bytes"`
	HasMore         bool            `json:"has_more"`
	Encoding        string          `json:"encoding"`
	Excerpt         string          `json:"excerpt"`
	Complete        bool            `json:"complete"`
	Content         json.RawMessage `json:"content,omitempty"`
}

type CloudHistoryStore interface {
	ListCloudMessageHeads(context.Context, int64, string, string, int) (*CloudHistoryHeadsPage, error)
	GetCloudHistoryMessages(context.Context, int64, string, []string, int64) ([]CloudHistoryMessage, error)
	ReadCloudHistoryFragment(context.Context, int64, string, string, int64, int64) (*CloudHistoryExcerpt, error)
}
