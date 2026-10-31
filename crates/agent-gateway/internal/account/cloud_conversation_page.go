package account

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Cursor reads use only conversation metadata. Message bodies are never loaded
// to populate the sidebar, including when an account has years of history.
type cloudConversationPager interface {
	ListCloudConversationPage(context.Context, int64, string, int) ([]CloudConversation, error)
}

type cloudConversationCursor struct {
	Version int       `json:"v"`
	UserID  int64     `json:"u"`
	Updated time.Time `json:"t"`
	ID      string    `json:"i"`
}

func parseCloudConversationCursor(userID int64, value string, limit int) (cloudConversationCursor, error) {
	var cursor cloudConversationCursor
	if userID <= 0 || limit < 1 || limit > 101 || len(value) > 512 {
		return cursor, ErrCloudRunInvalid
	}
	if value == "" {
		return cursor, nil
	}
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || json.Unmarshal(data, &cursor) != nil {
		return cursor, ErrCloudRunInvalid
	}
	id, err := uuid.Parse(cursor.ID)
	if err != nil || cursor.Version != 1 || cursor.UserID != userID || cursor.Updated.IsZero() || id.String() != cursor.ID {
		return cursor, ErrCloudRunInvalid
	}
	return cursor, nil
}

func encodeCloudConversationCursor(userID int64, item CloudConversation) string {
	data, _ := json.Marshal(cloudConversationCursor{1, userID, item.UpdatedAt, item.ID})
	return base64.RawURLEncoding.EncodeToString(data)
}

func (s *MemoryStore) ListCloudConversationPage(ctx context.Context, userID int64, value string, limit int) ([]CloudConversation, error) {
	cursor, err := parseCloudConversationCursor(userID, value, limit)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]CloudConversation, 0)
	for _, item := range s.cloudConversations {
		if item.UserID != userID || (value != "" && !(item.UpdatedAt.Before(cursor.Updated) || (item.UpdatedAt.Equal(cursor.Updated) && item.ID < cursor.ID))) {
			continue
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].UpdatedAt.Equal(items[j].UpdatedAt) {
			return items[i].ID > items[j].ID
		}
		return items[i].UpdatedAt.After(items[j].UpdatedAt)
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (s *PersistentStore) ListCloudConversationPage(ctx context.Context, userID int64, value string, limit int) ([]CloudConversation, error) {
	cursor, err := parseCloudConversationCursor(userID, value, limit)
	if err != nil {
		return nil, err
	}
	query := `SELECT id::text,user_id,title,model,created_at,updated_at,pinned,archived,management_version FROM zerobox_cloud_conversations WHERE user_id=$1`
	args := []any{userID, limit}
	if value != "" {
		query += ` AND (updated_at,id)<($3,$4::uuid)`
		args = append(args, cursor.Updated, cursor.ID)
	}
	rows, err := s.db.QueryContext(ctx, query+` ORDER BY updated_at DESC,id DESC LIMIT $2`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]CloudConversation, 0)
	for rows.Next() {
		var item CloudConversation
		if err := rows.Scan(&item.ID, &item.UserID, &item.Title, &item.Model, &item.CreatedAt, &item.UpdatedAt, &item.Pinned, &item.Archived, &item.ManagementVersion); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (h *HTTPHandler) listCloudConversationPage(w http.ResponseWriter, r *http.Request, session *Session) {
	limit := 50
	for key, values := range r.URL.Query() {
		if (key != "limit" && key != "cursor") || len(values) != 1 {
			writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
			return
		}
	}
	if value := r.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 100 {
			writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
			return
		}
		limit = parsed
	}
	cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
	if _, err := parseCloudConversationCursor(session.UserID, cursor, limit); err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	store, ok := h.service.store.(cloudConversationPager)
	if !ok {
		writeError(w, &APIError{Status: http.StatusServiceUnavailable, Message: "cloud conversation pagination is unavailable"})
		return
	}
	items, err := store.ListCloudConversationPage(r.Context(), session.UserID, cursor, limit+1)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	hasMore := len(items) > limit
	nextCursor := ""
	if hasMore {
		items = items[:limit]
		nextCursor = encodeCloudConversationCursor(session.UserID, items[len(items)-1])
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"conversations": items, "has_more": hasMore, "next_cursor": nextCursor})
}
