package account

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
)

func runCloudConversationPageContract(t *testing.T, fixture cloudRunTestFixture) {
	t.Helper()
	ctx := context.Background()
	store := fixture.store.(cloudConversationPager)
	stamp := time.Date(2026, 10, 29, 9, 0, 0, 123456000, time.UTC)
	// All timestamps tie: a timestamp-only cursor would silently lose 476 rows.
	for i := 0; i < 513; i++ {
		item := &CloudConversation{ID: fmt.Sprintf("82000000-0000-4000-8000-%012d", i), UserID: 177, Title: fmt.Sprintf("history-%d", i), CreatedAt: stamp, UpdatedAt: stamp}
		if err := fixture.store.PutCloudConversation(ctx, item); err != nil {
			t.Fatal(err)
		}
	}
	if err := fixture.store.PutCloudConversation(ctx, &CloudConversation{ID: uuid.NewString(), UserID: 178, Title: "foreign", CreatedAt: stamp, UpdatedAt: stamp.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	cursor, previous := "", ""
	seen := make(map[string]bool)
	for page := 0; page < 20; page++ {
		items, err := store.ListCloudConversationPage(ctx, 177, cursor, 37)
		if err != nil {
			t.Fatal(err)
		}
		if len(items) == 0 {
			break
		}
		for _, item := range items {
			if item.UserID != 177 || seen[item.ID] || (previous != "" && item.ID >= previous) {
				t.Fatal("pagination leaked, duplicated, or reordered a tied conversation")
			}
			seen[item.ID], previous = true, item.ID
		}
		cursor = encodeCloudConversationCursor(177, items[len(items)-1])
	}
	if len(seen) != 513 {
		t.Fatalf("history beyond row 500 hidden: saw %d", len(seen))
	}
	if _, err := store.ListCloudConversationPage(ctx, 178, cursor, 37); err == nil {
		t.Fatal("accepted another account's cursor")
	}
	for _, value := range []string{"not-a-cursor", "e30", cursor + "!"} {
		if _, err := store.ListCloudConversationPage(ctx, 177, value, 37); err == nil {
			t.Fatal("malformed cursor accepted")
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := store.ListCloudConversationPage(cancelled, 177, "", 50); err == nil {
		t.Fatal("cancelled page read accepted")
	}
}

func TestCloudConversationPageMemoryContract(t *testing.T) {
	runCloudConversationPageContract(t, cloudRunMemoryFixture(t))
}

func TestCloudConversationPagePostgresContract(t *testing.T) {
	runCloudConversationPageContract(t, cloudRunPostgresFixture(t))
}

func TestCloudConversationPageHTTP(t *testing.T) {
	f := newCloudHTTPFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("listing must not invoke a model") })
	for i := 0; i < 3; i++ {
		if _, err := f.service.CreateCloudConversation(context.Background(), 1, "test-model"); err != nil {
			t.Fatal(err)
		}
	}
	var result struct {
		Conversations []CloudConversation `json:"conversations"`
		HasMore       bool                `json:"has_more"`
		NextCursor    string              `json:"next_cursor"`
	}
	status, data := f.request(t, http.MethodGet, "/api/web-chat/conversations/page?limit=2", "synthetic-browser-cookie", "")
	if status != 200 || json.Unmarshal([]byte(data), &result) != nil || len(result.Conversations) != 2 || !result.HasMore || result.NextCursor == "" {
		t.Fatalf("first page status=%d data=%s", status, data)
	}
	status, data = f.request(t, http.MethodGet, "/api/web-chat/conversations/page?limit=2&cursor="+url.QueryEscape(result.NextCursor), "synthetic-browser-cookie", "")
	if status != 200 || json.Unmarshal([]byte(data), &result) != nil || len(result.Conversations) != 2 || result.HasMore || result.NextCursor != "" {
		t.Fatalf("last page status=%d data=%s", status, data)
	}
	for _, path := range []string{"?limit=0", "?limit=101", "?limit=abc", "?cursor=invalid"} {
		if status, _ := f.request(t, http.MethodGet, "/api/web-chat/conversations/page"+path, "synthetic-browser-cookie", ""); status != 400 {
			t.Fatalf("invalid page accepted: %s status=%d", path, status)
		}
	}
	if status, _ := f.request(t, http.MethodGet, "/api/web-chat/conversations/page", "", ""); status != 401 {
		t.Fatal("unauthenticated page accepted")
	}
	if f.calls.Load() != 0 {
		t.Fatal("page read executed a model")
	}
}
