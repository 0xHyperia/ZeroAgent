package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

func runCloudConversationManagementContract(t *testing.T, f cloudRunTestFixture) {
	t.Helper()
	ctx := context.Background()
	store := f.store.(cloudConversationManagementStore)
	if p, ok := f.store.(*PersistentStore); ok {
		if _, err := p.db.Exec(CloudProjectSchema + CloudBranchSchema); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC()
	c := &CloudConversation{ID: uuid.NewString(), UserID: 71, Title: "例子 NEEDLE_100%", CreatedAt: now, UpdatedAt: now}
	if err := f.store.PutCloudConversation(ctx, c); err != nil {
		t.Fatal(err)
	}
	messages := []CloudMessage{}
	for i := 0; i < 63; i++ {
		text := fmt.Sprintf("正文 %d", i)
		if i == 7 || i == 59 {
			text = strings.Repeat("前文。", 150) + "needle_100%" + strings.Repeat(" 后文。", 150)
		}
		m := CloudMessage{ID: uuid.NewString(), ConversationID: c.ID, UserID: 71, Role: "user", Content: cloudJSON(text)}
		if i == 9 {
			m.Content = cloudJSON([]map[string]any{{"type": "text", "text": "ordinary"}, {"type": "image_url", "image_url": map[string]string{"url": "https://invalid.example/needle_100%"}}})
		}
		if err := f.store.AddCloudMessage(ctx, &m); err != nil {
			t.Fatal(err)
		}
		messages = append(messages, m)
	}
	foreign := &CloudConversation{ID: uuid.NewString(), UserID: 72, Title: "needle_100% foreign", CreatedAt: now, UpdatedAt: now}
	if err := f.store.PutCloudConversation(ctx, foreign); err != nil {
		t.Fatal(err)
	}
	// Scope/search pagination is based on all persisted rows, not the first
	// sidebar page, and excludes attachment payloads even if they match.
	seen := map[string]bool{}
	cursor := ""
	for {
		page, err := store.SearchCloudConversations(ctx, 71, "NEEDLE_100%", "all", cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			key := cloudSearchKey(item)
			if item.Conversation.UserID != 71 || seen[key] || !strings.Contains(strings.ToLower(item.Excerpt), "needle_100%") || utf8.RuneCountInString(item.Excerpt) > 320 {
				t.Fatal("search lost matching text, exceeded excerpt bound, duplicated or leaked owner")
			}
			seen[key] = true
		}
		if !page.HasMore {
			break
		}
		if page.NextCursor == "" || page.NextCursor == cursor {
			t.Fatal("search did not progress")
		}
		cursor = page.NextCursor
	}
	if len(seen) != 3 || !seen["message:"+messages[7].ID] || !seen["message:"+messages[59].ID] {
		t.Fatalf("global title/body search lost matches: %v", seen)
	}
	if _, err := store.SearchCloudConversations(ctx, 72, "NEEDLE_100%", "all", cursor, 1); !errors.Is(err, ErrCloudRunInvalid) {
		t.Fatal("foreign cursor accepted")
	}
	window, err := store.CloudConversationWindowHeads(ctx, 71, c.ID, messages[59].ID, 2, 2)
	if err != nil || len(window.Items) != 5 || window.Items[2].ID != messages[59].ID || !window.HasBefore || !window.HasAfter {
		t.Fatalf("anchor window: %+v %v", window, err)
	}
	if _, err = store.CloudConversationWindowHeads(ctx, 72, c.ID, messages[59].ID, 2, 2); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign message window accepted")
	}
	version := int64(0)
	yes, no := true, false
	managed, err := store.ManageCloudConversation(ctx, 71, c.ID, CloudConversationManagementPatch{&version, &yes, &yes})
	if err != nil || !managed.Pinned || !managed.Archived || managed.ManagementVersion != 1 {
		t.Fatalf("manage: %+v %v", managed, err)
	}
	if _, err = store.ManageCloudConversation(ctx, 71, c.ID, CloudConversationManagementPatch{&version, &no, nil}); !errors.Is(err, ErrCloudRunConflict) {
		t.Fatal("stale mutation overwritten")
	}
	if _, err = store.ManageCloudConversation(ctx, 72, c.ID, CloudConversationManagementPatch{&version, &no, nil}); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign mutation accepted")
	}
	// A rename/model update through the old path must not undo management.
	c.Title = "renamed"
	if err = f.store.PutCloudConversation(ctx, c); err != nil {
		t.Fatal(err)
	}
	got, err := f.store.GetCloudConversation(ctx, 71, c.ID)
	if err != nil || !got.Pinned || !got.Archived || got.ManagementVersion != 1 {
		t.Fatal("legacy write reset management metadata")
	}
	active, _ := store.CloudConversationCatalog(ctx, 71, "active", "", 10)
	archived, _ := store.CloudConversationCatalog(ctx, 71, "archived", "", 10)
	if len(active.Conversations) != 0 || len(archived.Conversations) != 1 {
		t.Fatal("archive scopes incorrect")
	}
	version = 1
	if _, err = store.ManageCloudConversation(ctx, 71, c.ID, CloudConversationManagementPatch{&version, nil, &no}); err != nil {
		t.Fatal(err)
	}
	pinned, _ := store.CloudConversationCatalog(ctx, 71, "pinned", "", 10)
	if len(pinned.Conversations) != 1 {
		t.Fatal("restore archive lost pinned state")
	}
	branch, _, err := f.store.(CloudBranchStore).CreateCloudBranch(ctx, 71, c.ID, CloudBranchInput{ClientRequestID: uuid.NewString(), MessageID: messages[7].ID, Action: "fork"})
	if err != nil {
		t.Fatal(err)
	}
	lineage, err := store.CloudConversationBranches(ctx, 71, c.ID, "", 1)
	if err != nil || len(lineage.Children) != 1 || lineage.Children[0].Conversation.ID != branch.Conversation.ID {
		t.Fatalf("child navigation %+v %v", lineage, err)
	}
	lineage, err = store.CloudConversationBranches(ctx, 71, branch.Conversation.ID, "", 1)
	if err != nil || lineage.Source == nil || !lineage.Source.Available || lineage.Source.Title != "renamed" {
		t.Fatal("source navigation lost live title")
	}
	if err = f.store.DeleteCloudConversation(ctx, 71, c.ID); err != nil {
		t.Fatal(err)
	}
	lineage, err = store.CloudConversationBranches(ctx, 71, branch.Conversation.ID, "", 1)
	if err != nil || lineage.Source == nil || lineage.Source.Available || lineage.Source.Title != "" {
		t.Fatal("deleted source leaked stale title or removed surviving branch")
	}
}

func TestCloudConversationManagementMemory(t *testing.T) {
	runCloudConversationManagementContract(t, cloudRunMemoryFixture(t))
}
func TestCloudConversationManagementPostgres(t *testing.T) {
	runCloudConversationManagementContract(t, cloudRunPostgresFixture(t))
}

func TestCloudConversationManagementHTTP(t *testing.T) {
	f := newCloudHTTPFixture(t, func(http.ResponseWriter, *http.Request) { t.Fatal("management must not call model") })
	ctx := context.Background()
	m := CloudMessage{ID: uuid.NewString(), ConversationID: f.conversation.ID, UserID: 1, Role: "user", Content: cloudJSON("精确正文搜索")}
	if err := f.store.AddCloudMessage(ctx, &m); err != nil {
		t.Fatal(err)
	}
	base := "/api/web-chat/conversations/" + f.conversation.ID
	for _, path := range []string{"/api/web-chat/conversations/catalog?scope=active", "/api/web-chat/conversations/search?q=正文", base + "/metadata", base + "/messages/" + m.ID + "/window?before=0&after=0", base + "/branches"} {
		status, body := f.request(t, "GET", path, "synthetic-browser-cookie", "")
		if status != 200 {
			t.Fatalf("%s = %d %s", path, status, body)
		}
		if status, _ = f.request(t, "GET", path, "", ""); status != 401 {
			t.Fatal("anonymous management read accepted")
		}
	}
	status, body := f.request(t, "PATCH", base+"/management", "synthetic-browser-cookie", `{"expected_version":0,"pinned":true}`)
	if status != 200 {
		t.Fatalf("pin %d %s", status, body)
	}
	status, body = f.request(t, "PATCH", base+"/management", "synthetic-browser-cookie", `{"expected_version":0,"archived":true}`)
	if status != 409 || !strings.Contains(body, "conversation_changed") {
		t.Fatalf("conflict %d %s", status, body)
	}
	for _, bad := range []string{`{"pinned":true}`, `{"expected_version":1}`, `{"expected_version":1,"pinned":true,"model":"injected"}`} {
		if status, _ = f.request(t, "PATCH", base+"/management", "synthetic-browser-cookie", bad); status != 400 {
			t.Fatal("malformed management accepted")
		}
	}
	status, body = f.request(t, "GET", base+"/messages/"+m.ID+"/window?before=0&after=0", "synthetic-browser-cookie", "")
	var window CloudConversationWindow
	if status != 200 || json.Unmarshal([]byte(body), &window) != nil || len(window.Messages) != 1 || window.AnchorID != m.ID || window.Messages[0].ContentOmitted {
		t.Fatalf("HTTP window %d %s", status, body)
	}
	if f.calls.Load() != 0 {
		t.Fatal("management triggered model")
	}
}
