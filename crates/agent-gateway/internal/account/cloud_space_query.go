package account

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

var ErrCloudSpacePageChanged = errors.New("space changed during pagination")

type CloudSpaceQuery struct {
	Query, Category, Scope, Folder, Sort, Cursor string
	// Kept for existing callers; new clients use an owner/query-bound cursor.
	Offset int
}
type CloudSpacePage struct {
	Items      []CloudSpaceItem `json:"items"`
	Total      int              `json:"total"`
	NextCursor string           `json:"next_cursor"`
	NextOffset int              `json:"next_offset"`
	Usage      CloudSpaceUsage  `json:"usage"`
	Folders    []CloudSpaceItem `json:"folders"`
	Pinned     []CloudSpaceItem `json:"pinned"`
}
type cloudSpaceCursor struct {
	Version  int       `json:"v"`
	Owner    int64     `json:"u"`
	Scope    string    `json:"q"`
	Revision string    `json:"r"`
	ID       string    `json:"id"`
	Kind     string    `json:"k"`
	Name     string    `json:"n"`
	Size     int64     `json:"s"`
	Updated  time.Time `json:"t"`
}

func normalizeSpaceQuery(userID int64, q CloudSpaceQuery) (CloudSpaceQuery, *cloudSpaceCursor, error) {
	if q.Category == "" {
		q.Category = "all"
	}
	if q.Scope == "" {
		q.Scope = "all"
	}
	if q.Sort == "" {
		q.Sort = "updated"
	}
	q.Query = strings.TrimSpace(q.Query)
	if userID <= 0 || !utf8.ValidString(q.Query) || len(q.Query) > 200 || q.Offset < 0 || q.Offset > 5000 ||
		!strings.Contains("|all|uploads|outputs|images|documents|sites|", "|"+q.Category+"|") ||
		!strings.Contains("|all|starred|trash|", "|"+q.Scope+"|") ||
		!strings.Contains("|updated|name|size|", "|"+q.Sort+"|") {
		return q, nil, ErrCloudFileInvalid
	}
	if q.Folder != "" {
		var err error
		q.Folder, err = canonicalCloudFileID(q.Folder)
		if err != nil {
			return q, nil, err
		}
	}
	if q.Cursor == "" {
		return q, nil, nil
	}
	if q.Offset != 0 || len(q.Cursor) > 2048 {
		return q, nil, ErrCloudFileInvalid
	}
	data, err := base64.RawURLEncoding.DecodeString(q.Cursor)
	var cursor cloudSpaceCursor
	if err != nil || json.Unmarshal(data, &cursor) != nil || cursor.Version != 1 || cursor.Owner != userID || cursor.Scope != spaceQueryScope(q) || cursor.Revision == "" || len(cursor.Revision) > 64 || cursor.Size < 0 || cursor.Updated.IsZero() || !utf8.ValidString(cursor.Name) || len(cursor.Name) > 1024 || !strings.Contains("|file|artifact|folder|", "|"+cursor.Kind+"|") {
		return q, nil, ErrCloudFileInvalid
	}
	if _, err := canonicalCloudFileID(cursor.ID); err != nil {
		return q, nil, err
	}
	return q, &cursor, nil
}
func spaceQueryScope(q CloudSpaceQuery) string {
	data, _ := json.Marshal([]string{q.Query, q.Category, q.Scope, q.Folder, q.Sort})
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:16])
}
func nextSpaceCursor(userID int64, q CloudSpaceQuery, revision string, item CloudSpaceItem) string {
	name := item.sortName
	if name == "" {
		name = strings.ToLower(item.Name)
	}
	data, _ := json.Marshal(cloudSpaceCursor{Version: 1, Owner: userID, Scope: spaceQueryScope(q), Revision: revision, ID: item.ID, Kind: item.Kind, Name: name, Size: item.Size, Updated: item.UpdatedAt})
	return base64.RawURLEncoding.EncodeToString(data)
}

func (s *MemoryStore) QueryCloudSpace(ctx context.Context, userID int64, query CloudSpaceQuery) (*CloudSpacePage, error) {
	q, cursor, err := normalizeSpaceQuery(userID, query)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	snapshot := s.spaceRecordsLocked(userID).snapshot()
	// The memory store is a bounded test adapter. Fingerprint its complete view;
	// PostgreSQL tracks the same invalidation with transactional row triggers.
	sort.Slice(snapshot.Items, func(i, j int) bool {
		return snapshot.Items[i].Kind+snapshot.Items[i].ID < snapshot.Items[j].Kind+snapshot.Items[j].ID
	})
	encoded, _ := json.Marshal(snapshot)
	digest := sha256.Sum256(encoded)
	revision := hex.EncodeToString(digest[:])
	if cursor != nil && cursor.Revision != revision {
		return nil, ErrCloudSpacePageChanged
	}
	all := filterCloudSpaceItems(snapshot, q.Query, q.Category, q.Scope, q.Folder, q.Sort)
	page := &CloudSpacePage{Items: []CloudSpaceItem{}, Total: len(all), NextOffset: -1, Usage: snapshot.Usage, Folders: []CloudSpaceItem{}, Pinned: []CloudSpaceItem{}}
	for _, item := range snapshot.Items {
		if item.Kind == "folder" && !item.Trashed {
			page.Folders = append(page.Folders, item)
		}
	}
	pinned := filterCloudSpaceItems(snapshot, "", "all", "starred", "", "updated")
	page.Pinned = append(page.Pinned, pinned[:min(6, len(pinned))]...)
	start := min(q.Offset, len(all))
	if cursor != nil {
		start = len(all)
		for i, item := range all {
			if item.ID == cursor.ID && item.Kind == cursor.Kind {
				start = i + 1
				break
			}
		}
	}
	end := min(start+50, len(all))
	page.Items = append(page.Items, all[start:end]...)
	if end < len(all) && len(page.Items) > 0 {
		page.NextOffset = end
		page.NextCursor = nextSpaceCursor(userID, q, revision, page.Items[len(page.Items)-1])
	}
	return page, nil
}
