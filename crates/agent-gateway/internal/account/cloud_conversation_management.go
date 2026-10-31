package account

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

// Management changes never touch run authority, the conversation's model, or
// message timestamps. A separate revision prevents cross-tab lost updates.
const CloudConversationManagementSchema = `
ALTER TABLE zerobox_cloud_conversations ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE zerobox_cloud_conversations ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE zerobox_cloud_conversations ADD COLUMN IF NOT EXISTS management_version BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS zeroagent_cloud_conversation_catalog_idx ON zerobox_cloud_conversations(user_id,archived,pinned,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_message_search_owner_idx ON zerobox_cloud_messages(user_id,created_at DESC,id DESC);
`

type CloudConversationManagementPatch struct {
	ExpectedVersion *int64 `json:"expected_version"`
	Pinned          *bool  `json:"pinned,omitempty"`
	Archived        *bool  `json:"archived,omitempty"`
}

type CloudConversationCatalog struct {
	Conversations []CloudConversation `json:"conversations"`
	HasMore       bool                `json:"has_more"`
	NextCursor    string              `json:"next_cursor"`
}

type CloudConversationSearchItem struct {
	Conversation CloudConversation `json:"conversation"`
	MessageID    string            `json:"message_id,omitempty"`
	Role         string            `json:"role,omitempty"`
	Excerpt      string            `json:"excerpt"`
	Match        string            `json:"match"`
	CreatedAt    time.Time         `json:"created_at"`
}

type CloudConversationSearchPage struct {
	Items      []CloudConversationSearchItem `json:"items"`
	HasMore    bool                          `json:"has_more"`
	NextCursor string                        `json:"next_cursor"`
}

type CloudConversationBranchSource struct {
	ConversationID string `json:"conversation_id"`
	MessageID      string `json:"message_id"`
	Action         string `json:"action"`
	Title          string `json:"title"`
	Available      bool   `json:"available"`
}

type CloudConversationBranchChild struct {
	Conversation    CloudConversation `json:"conversation"`
	SourceMessageID string            `json:"source_message_id"`
	Action          string            `json:"action"`
}

type CloudConversationBranches struct {
	Source     *CloudConversationBranchSource `json:"source"`
	Children   []CloudConversationBranchChild `json:"children"`
	HasMore    bool                           `json:"has_more"`
	NextCursor string                         `json:"next_cursor"`
}

type CloudConversationWindowHeads struct {
	Items               []CloudMessageHead
	HasBefore, HasAfter bool
}

type CloudConversationWindow struct {
	Messages     []CloudHistoryMessage `json:"messages"`
	AnchorID     string                `json:"anchor_id"`
	HasBefore    bool                  `json:"has_before"`
	HasAfter     bool                  `json:"has_after"`
	NextBeforeID string                `json:"next_before_id"`
	NextAfterID  string                `json:"next_after_id"`
}

type cloudConversationManagementStore interface {
	ManageCloudConversation(context.Context, int64, string, CloudConversationManagementPatch) (*CloudConversation, error)
	CloudConversationCatalog(context.Context, int64, string, string, int) (*CloudConversationCatalog, error)
	SearchCloudConversations(context.Context, int64, string, string, string, int) (*CloudConversationSearchPage, error)
	CloudConversationWindowHeads(context.Context, int64, string, string, int, int) (*CloudConversationWindowHeads, error)
	CloudConversationBranches(context.Context, int64, string, string, int) (*CloudConversationBranches, error)
}

// Cursor bindings include the account, operation, query and scope. Decoding a
// cursor cannot grant access: every storage query separately checks ownership.
type cloudManagementCursor struct {
	Binding string    `json:"b"`
	At      time.Time `json:"t"`
	ID      string    `json:"i"`
}

func cloudManagementBinding(uid int64, kind, filter string) string {
	digest := sha256.Sum256(cloudJSON([]any{1, uid, kind, filter}))
	return hex.EncodeToString(digest[:])
}

func parseCloudManagementCursor(uid int64, kind, filter, value string, limit int) (cloudManagementCursor, error) {
	var cursor cloudManagementCursor
	if uid <= 0 || limit < 1 || limit > 100 || len(value) > 512 {
		return cursor, ErrCloudRunInvalid
	}
	if value == "" {
		return cursor, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || json.Unmarshal(raw, &cursor) != nil || cursor.Binding != cloudManagementBinding(uid, kind, filter) || cursor.At.IsZero() || len(cursor.ID) > 64 {
		return cursor, ErrCloudRunInvalid
	}
	id := cursor.ID
	if kind == "search" {
		if !strings.HasPrefix(id, "message:") && !strings.HasPrefix(id, "title:") {
			return cursor, ErrCloudRunInvalid
		}
		id = strings.SplitN(id, ":", 2)[1]
	}
	parsed, err := uuid.Parse(id)
	if err != nil || parsed.String() != id {
		return cursor, ErrCloudRunInvalid
	}
	return cursor, nil
}

func encodeCloudManagementCursor(uid int64, kind, filter string, at time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString(cloudJSON(cloudManagementCursor{cloudManagementBinding(uid, kind, filter), at, id}))
}

func validateCloudScope(scope string) bool {
	return scope == "active" || scope == "unassigned" || scope == "archived" || scope == "pinned" || scope == "all"
}
func cloudConversationInScope(c CloudConversation, scope string) bool {
	switch scope {
	case "active", "unassigned":
		return !c.Archived
	case "archived":
		return c.Archived
	case "pinned":
		return c.Pinned && !c.Archived
	case "all":
		return true
	}
	return false
}

func validateCloudManagementPatch(p CloudConversationManagementPatch) error {
	if p.ExpectedVersion == nil || *p.ExpectedVersion < 0 || (p.Pinned == nil && p.Archived == nil) {
		return ErrCloudRunInvalid
	}
	return nil
}

func validateCloudSearch(q string) (string, error) {
	q = strings.TrimSpace(q)
	if q == "" || !utf8.ValidString(q) || utf8.RuneCountInString(q) > 200 || strings.ContainsRune(q, 0) {
		return "", ErrCloudRunInvalid
	}
	return q, nil
}

func cloudSearchText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var result strings.Builder
	for _, part := range parts {
		if part.Type == "text" {
			if result.Len() > 0 {
				result.WriteByte('\n')
			}
			result.WriteString(part.Text)
		}
	}
	return result.String()
}

func cloudSearchExcerpt(text, q string) string {
	lower := strings.ToLower(text)
	position := strings.Index(lower, strings.ToLower(q))
	start := 0
	if position > 0 {
		start = max(0, utf8.RuneCountInString(lower[:position])-80)
	}
	runes := []rune(text)
	start = min(start, len(runes))
	end := min(len(runes), start+320)
	return string(runes[start:end])
}

func cloudSearchKey(item CloudConversationSearchItem) string {
	if item.Match == "message" {
		return "message:" + item.MessageID
	}
	return "title:" + item.Conversation.ID
}

func validateCloudWindow(conversationID, messageID string, before, after int) (string, string, error) {
	c, err := canonicalCloudRunID(conversationID)
	if err != nil {
		return "", "", ErrCloudRunInvalid
	}
	m, err := canonicalCloudRunID(messageID)
	if err != nil || before < 0 || before > 49 || after < 0 || after > 49 {
		return "", "", ErrCloudRunInvalid
	}
	return c, m, nil
}
