package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

type cloudProjectFixture struct {
	store     Store
	projects  CloudProjectStore
	memories  CloudMemoryStore
	files     CloudFileStore
	seedQuota func(int64)
}

func memoryCloudProjectFixture(t *testing.T) cloudProjectFixture {
	store := NewMemoryStore()
	return cloudProjectFixture{store, store, store, store, func(userID int64) {
		store.mu.Lock()
		defer store.mu.Unlock()
		state := store.cloudProjectStateLocked()
		if store.cloudMemories == nil {
			store.cloudMemories = map[string]CloudMemory{}
		}
		for range CloudProjectMaxAccountProjects {
			id := uuid.NewString()
			state.projects[id] = CloudProject{ID: id, UserID: userID, Name: "bulk", Version: 1}
		}
		for range CloudMemoryMaxEntries {
			id := uuid.NewString()
			store.cloudMemories[id] = CloudMemory{ID: id, UserID: userID, Content: "bulk", Version: 1}
		}
	}}
}

func postgresCloudProjectFixture(t *testing.T) cloudProjectFixture {
	base := cloudRunPostgresFixture(t)
	store := base.store.(*PersistentStore)
	if _, err := store.db.Exec(CloudFileSchema + CloudProjectSchema + CloudMemorySchema); err != nil {
		t.Fatalf("create project and explicit memory schema: %v", err)
	}
	return cloudProjectFixture{store, store, store, store, func(userID int64) {
		if _, err := store.db.Exec(`INSERT INTO zeroagent_cloud_projects(id,user_id,name) SELECT gen_random_uuid(),$1,'bulk' FROM generate_series(1,$2)`, userID, CloudProjectMaxAccountProjects); err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.Exec(`INSERT INTO zeroagent_cloud_memories(id,user_id,content) SELECT gen_random_uuid(),$1,'bulk' FROM generate_series(1,$2)`, userID, CloudMemoryMaxEntries); err != nil {
			t.Fatal(err)
		}
	}}
}

func projectConversation(t *testing.T, f cloudProjectFixture, userID int64) string {
	t.Helper()
	id := uuid.NewString()
	now := time.Now().UTC()
	if err := f.store.PutCloudConversation(context.Background(), &CloudConversation{ID: id, UserID: userID, Title: "canonical history", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	return id
}

func projectReadyFile(t *testing.T, f cloudProjectFixture, userID int64, conversationID string) *CloudFile {
	t.Helper()
	id := uuid.NewString()
	file, err := f.files.CreateCloudFile(context.Background(), &CloudFile{ID: id, UserID: userID, ConversationID: conversationID, ObjectKey: cloudFileObjectKey(userID, id), Name: "project.txt", MIME: "text/plain", Size: 3, SHA256: strings.Repeat("a", 64), State: CloudFileUploading})
	if err != nil {
		t.Fatal(err)
	}
	file, err = f.files.UpdateCloudFile(context.Background(), userID, id, file.Version, CloudFileUpdate{State: CloudFileUploaded, MarkUploaded: true})
	if err != nil {
		t.Fatal(err)
	}
	text := "document text"
	file, err = f.files.UpdateCloudFile(context.Background(), userID, id, file.Version, CloudFileUpdate{State: CloudFileReady, Text: &text})
	if err != nil {
		t.Fatal(err)
	}
	return file
}

func TestCloudProjectAndMemoryContractMemory(t *testing.T) {
	testCloudProjectContract(t, memoryCloudProjectFixture)
}
func TestCloudProjectAndMemoryContractPostgres(t *testing.T) {
	testCloudProjectContract(t, postgresCloudProjectFixture)
}

func testCloudProjectContract(t *testing.T, factory func(*testing.T) cloudProjectFixture) {
	ctx := context.Background()
	t.Run("project scoped CRUD and concurrent CAS", func(t *testing.T) {
		f := factory(t)
		p, err := f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 7, Name: "Project", Description: "work", Instructions: "project-only instructions"})
		if err != nil || p.Version != 1 {
			t.Fatalf("create: %v", err)
		}
		if _, err = f.projects.GetCloudProject(ctx, 8, p.ID); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign project readable")
		}
		var success atomic.Int32
		var wg sync.WaitGroup
		for range 8 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := f.projects.UpdateCloudProject(ctx, 7, p.ID, 1, CloudProjectUpdate{Name: "edited", Instructions: "instructions"}); err == nil {
					success.Add(1)
				} else if !errors.Is(err, ErrCloudProjectConflict) {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
		if success.Load() != 1 {
			t.Fatal("concurrent project write lost CAS")
		}
		if err = f.projects.DeleteCloudProject(ctx, 7, p.ID, 1); !errors.Is(err, ErrCloudProjectConflict) {
			t.Fatal("stale delete succeeded")
		}
		if err = f.projects.DeleteCloudProject(ctx, 8, p.ID, 2); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign delete succeeded")
		}
		if err = f.projects.DeleteCloudProject(ctx, 7, p.ID, 2); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("conversation membership moves canonical history and deletion only unlinks", func(t *testing.T) {
		f := factory(t)
		conversationID := projectConversation(t, f, 7)
		foreign := projectConversation(t, f, 8)
		p, _ := f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 7, Name: "one"})
		other, _ := f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 7, Name: "two"})
		foreignProject, _ := f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 8, Name: "foreign"})
		binding, err := f.projects.GetCloudConversationProject(ctx, 7, conversationID)
		if err != nil || binding.Version != 0 || binding.ProjectID != "" {
			t.Fatal("missing association is not a version-zero snapshot")
		}
		if _, err = f.projects.SetCloudConversationProject(ctx, 7, foreign, p.ID, 0); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign conversation attached")
		}
		if _, err = f.projects.SetCloudConversationProject(ctx, 7, conversationID, foreignProject.ID, 0); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign project attached")
		}
		binding, err = f.projects.SetCloudConversationProject(ctx, 7, conversationID, p.ID, 0)
		if err != nil || binding.Version != 1 {
			t.Fatal(err)
		}
		if _, err = f.projects.SetCloudConversationProject(ctx, 7, conversationID, other.ID, 0); !errors.Is(err, ErrCloudProjectConflict) {
			t.Fatal("membership ignored CAS")
		}
		binding, err = f.projects.SetCloudConversationProject(ctx, 7, conversationID, other.ID, 1)
		if err != nil || binding.Version != 2 {
			t.Fatal(err)
		}
		items, err := f.projects.ListCloudProjectConversations(ctx, 7, p.ID, "", 10)
		if err != nil || len(items) != 0 {
			t.Fatal("move copied a conversation")
		}
		items, err = f.projects.ListCloudProjectConversations(ctx, 7, other.ID, "", 10)
		if err != nil || len(items) != 1 || items[0].Conversation.Title != "canonical history" {
			t.Fatal("membership lost canonical history")
		}
		if err = f.projects.DeleteCloudProject(ctx, 7, other.ID, 1); err != nil {
			t.Fatal(err)
		}
		binding, err = f.projects.GetCloudConversationProject(ctx, 7, conversationID)
		if err != nil || binding.ProjectID != "" || binding.Version != 3 {
			t.Fatal("project deletion did not invalidate membership CAS")
		}
		if _, err = f.store.GetCloudConversation(ctx, 7, conversationID); err != nil {
			t.Fatal("project deletion removed user history")
		}
		if _, err = f.projects.SetCloudConversationProject(ctx, 7, conversationID, p.ID, 3); err != nil {
			t.Fatal(err)
		}
		if err = f.store.DeleteCloudConversation(ctx, 7, conversationID); err != nil {
			t.Fatal(err)
		}
		now := time.Now()
		if err = f.store.PutCloudConversation(ctx, &CloudConversation{ID: conversationID, UserID: 7, Title: "new canonical row", CreatedAt: now, UpdatedAt: now}); err != nil {
			t.Fatal(err)
		}
		binding, err = f.projects.GetCloudConversationProject(ctx, 7, conversationID)
		if err != nil || binding.Version != 0 {
			t.Fatal("deleted history retained an old membership")
		}
	})
	t.Run("project files are owned references and keep originals", func(t *testing.T) {
		f := factory(t)
		conversationID := projectConversation(t, f, 7)
		foreignID := projectConversation(t, f, 8)
		file := projectReadyFile(t, f, 7, conversationID)
		foreign := projectReadyFile(t, f, 8, foreignID)
		p, _ := f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 7, Name: "files"})
		if _, err := f.projects.SetCloudProjectFile(ctx, 7, p.ID, foreign.ID, p.Version, true); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign file attached")
		}
		p, err := f.projects.SetCloudProjectFile(ctx, 7, p.ID, file.ID, 1, true)
		if err != nil || p.Version != 2 {
			t.Fatal(err)
		}
		if _, err = f.projects.SetCloudProjectFile(ctx, 7, p.ID, file.ID, 1, false); !errors.Is(err, ErrCloudProjectConflict) {
			t.Fatal("file refs ignored project version")
		}
		items, err := f.projects.ListCloudProjectFiles(ctx, 7, p.ID, "", 10)
		if err != nil || len(items) != 1 || items[0].ID != file.ID {
			t.Fatal("project file list lost the canonical original")
		}
		if err = f.projects.DeleteCloudProject(ctx, 7, p.ID, p.Version); err != nil {
			t.Fatal(err)
		}
		if _, err = f.files.GetCloudFile(ctx, 7, file.ID); err != nil {
			t.Fatal("project deletion removed the original")
		}
		p, _ = f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 7, Name: "second"})
		p, err = f.projects.SetCloudProjectFile(ctx, 7, p.ID, file.ID, p.Version, true)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.files.UpdateCloudFile(ctx, 7, file.ID, file.Version, CloudFileUpdate{State: CloudFileDeleting}); err != nil {
			t.Fatal(err)
		}
		items, err = f.projects.ListCloudProjectFiles(ctx, 7, p.ID, "", 10)
		if err != nil || len(items) != 0 {
			t.Fatal("deleting project file remained available")
		}
	})
	t.Run("stable bounded scoped pagination", func(t *testing.T) {
		f := factory(t)
		for range 3 {
			if _, err := f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 7, Name: "page"}); err != nil {
				t.Fatal(err)
			}
		}
		foreign, _ := f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 8, Name: "foreign"})
		seen := map[string]bool{}
		before := ""
		for range 4 {
			items, err := f.projects.ListCloudProjects(ctx, 7, before, 1)
			if err != nil {
				t.Fatal(err)
			}
			if len(items) == 0 {
				break
			}
			if seen[items[0].ID] {
				t.Fatal("duplicate page cursor")
			}
			seen[items[0].ID] = true
			before = items[0].ID
		}
		if len(seen) != 3 {
			t.Fatal("pagination lost projects")
		}
		if _, err := f.projects.ListCloudProjects(ctx, 7, foreign.ID, 10); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign cursor accepted")
		}
		if _, err := f.projects.ListCloudProjects(ctx, 7, "", 102); !errors.Is(err, ErrCloudProjectInvalid) {
			t.Fatal("unbounded page accepted")
		}
	})
	t.Run("explicit memory default-off edit disable and delete context", func(t *testing.T) {
		f := factory(t)
		enabled, err := f.memories.CreateCloudMemory(ctx, &CloudMemory{UserID: 7, Content: "explicit preference", Enabled: true})
		if err != nil {
			t.Fatal(err)
		}
		disabled, err := f.memories.CreateCloudMemory(ctx, &CloudMemory{UserID: 7, Content: "disabled preference", Enabled: false})
		if err != nil {
			t.Fatal(err)
		}
		settings, err := f.memories.GetCloudMemorySettings(ctx, 7)
		if err != nil || settings.Enabled || settings.Version != 0 {
			t.Fatal("memory was not default-off")
		}
		memoryCtx, err := f.memories.GetCloudMemoryContext(ctx, 7, CloudMemoryMaxContext)
		if err != nil || memoryCtx.Enabled || len(memoryCtx.Items) != 0 {
			t.Fatal("default-off memory entered context")
		}
		settings, err = f.memories.SetCloudMemorySettings(ctx, 7, 0, true)
		if err != nil || settings.Version != 1 {
			t.Fatal(err)
		}
		if _, err = f.memories.SetCloudMemorySettings(ctx, 7, 0, false); !errors.Is(err, ErrCloudProjectConflict) {
			t.Fatal("memory switch ignored CAS")
		}
		memoryCtx, err = f.memories.GetCloudMemoryContext(ctx, 7, CloudMemoryMaxContext)
		if err != nil || len(memoryCtx.Items) != 1 || memoryCtx.Items[0].ID != enabled.ID {
			t.Fatal("disabled entries entered context")
		}
		memoryCtx, err = f.memories.GetCloudMemoryContext(ctx, 7, 1)
		if err != nil || len(memoryCtx.Items) != 0 || !memoryCtx.Truncated {
			t.Fatal("memory context exceeded byte budget")
		}
		enabled, err = f.memories.UpdateCloudMemory(ctx, 7, enabled.ID, 1, "updated explicit preference", true)
		if err != nil || enabled.Version != 2 {
			t.Fatal(err)
		}
		if _, err = f.memories.UpdateCloudMemory(ctx, 7, enabled.ID, 1, "stale", true); !errors.Is(err, ErrCloudProjectConflict) {
			t.Fatal("memory edit ignored CAS")
		}
		if err = f.memories.DeleteCloudMemory(ctx, 7, enabled.ID, 2); err != nil {
			t.Fatal(err)
		}
		memoryCtx, err = f.memories.GetCloudMemoryContext(ctx, 7, CloudMemoryMaxContext)
		if err != nil || len(memoryCtx.Items) != 0 {
			t.Fatal("deleted memory remained in later context")
		}
		if _, err = f.memories.GetCloudMemory(ctx, 8, disabled.ID); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign memory exposed")
		}
		if _, err = f.memories.SetCloudMemorySettings(ctx, 7, 1, false); err != nil {
			t.Fatal(err)
		}
		memoryCtx, err = f.memories.GetCloudMemoryContext(ctx, 7, CloudMemoryMaxContext)
		if err != nil || memoryCtx.Enabled {
			t.Fatal("disabled account memory remained active")
		}
	})
	t.Run("quotas and input limits apply independently per account", func(t *testing.T) {
		f := factory(t)
		f.seedQuota(77)
		if _, err := f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 77, Name: "overflow"}); !errors.Is(err, ErrCloudProjectQuota) {
			t.Fatal("project quota missing")
		}
		if _, err := f.memories.CreateCloudMemory(ctx, &CloudMemory{UserID: 77, Content: "overflow"}); !errors.Is(err, ErrCloudProjectQuota) {
			t.Fatal("memory quota missing")
		}
		if _, err := f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 78, Name: "other"}); err != nil {
			t.Fatal("one account exhausted another's quota")
		}
		for _, content := range []string{"", " \n", strings.Repeat("x", CloudMemoryMaxContent+1), "bad\x00data", string([]byte{0xff})} {
			if _, err := f.memories.CreateCloudMemory(ctx, &CloudMemory{UserID: 78, Content: content}); !errors.Is(err, ErrCloudProjectInvalid) {
				t.Fatal("invalid memory accepted")
			}
		}
		if _, err := f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 78, Name: "test", Instructions: strings.Repeat("x", CloudProjectMaxInstructions+1)}); !errors.Is(err, ErrCloudProjectInvalid) {
			t.Fatal("project instructions exceeded bound")
		}
	})
}

func TestCloudProjectMemoryHTTPAccountAndCAS(t *testing.T) {
	store := NewMemoryStore()
	service := NewService(store, nil, time.Hour, time.Hour)
	service.EnableCloudWorkspace()
	session := &Session{ID: "project-http-cookie", UserID: 7, AccessToken: "fixture-token", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}
	if err := store.PutSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewHTTPHandler(service, true).Register(mux)
	request := func(method, path, body, owner, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: session.ID})
		r.Header.Set("X-ZeroAgent-Account-ID", owner)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	w := request("POST", "/api/web-chat/projects", `{"name":"Project","instructions":"explicit"}`, "7", "")
	if w.Code != 201 {
		t.Fatalf("create status=%d %s", w.Code, w.Body.String())
	}
	var project CloudProject
	if json.Unmarshal(w.Body.Bytes(), &project) != nil || project.ID == "" {
		t.Fatal("invalid public project")
	}
	if strings.Contains(w.Body.String(), "user_id") {
		t.Fatal("resource owner leaked into editable metadata")
	}
	if w = request("PUT", "/api/web-chat/projects/"+project.ID, `{"name":"draft","expected_version":9}`, "7", ""); w.Code != 409 {
		t.Fatal("HTTP project ignored CAS")
	}
	if w = request("GET", "/api/web-chat/projects/"+project.ID, "", "8", ""); w.Code != 409 {
		t.Fatal("stale account assertion accepted")
	}
	if w = request("POST", "/api/web-chat/memories", `{"content":"secret","user_id":8}`, "7", ""); w.Code != 400 {
		t.Fatal("memory allowed caller ownership")
	}
	if w = request("POST", "/api/web-chat/memories", `{"content":"explicit"}`, "7", "https://foreign.invalid"); w.Code != 403 {
		t.Fatal("cross-site memory mutation accepted")
	}
	w = request("GET", "/api/web-chat/memory-settings", "", "7", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"enabled":false`) {
		t.Fatal("HTTP memory not default-off")
	}
	w = request("PUT", "/api/web-chat/memory-settings", `{"enabled":true,"expected_version":0}`, "7", "")
	if w.Code != 200 {
		t.Fatal("explicit memory enable failed")
	}
	w = request("GET", "/api/web-chat/projects?limit=1000", "", "7", "")
	if w.Code != 400 {
		t.Fatal("HTTP allowed an unbounded project page")
	}
}

func runCloudProjectSidebarContract(t *testing.T, f cloudProjectFixture) {
	t.Helper()
	ctx := context.Background()
	catalog := f.store.(cloudConversationManagementStore)
	project, err := f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 7, Name: "Project sidebar"})
	if err != nil {
		t.Fatal(err)
	}
	first, second, member := projectConversation(t, f, 7), projectConversation(t, f, 7), projectConversation(t, f, 7)
	foreign := projectConversation(t, f, 8)
	binding, err := f.projects.SetCloudConversationProject(ctx, 7, member, project.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	cursor := ""
	for {
		page, err := catalog.CloudConversationCatalog(ctx, 7, "unassigned", cursor, 1)
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range page.Conversations {
			if c.ID == member || c.ID == foreign || seen[c.ID] {
				t.Fatal("project/foreign member leaked into recent pagination")
			}
			seen[c.ID] = true
		}
		if !page.HasMore {
			break
		}
		if page.NextCursor == cursor || page.NextCursor == "" {
			t.Fatal("cursor did not advance")
		}
		if _, err := catalog.CloudConversationCatalog(ctx, 7, "active", page.NextCursor, 1); !errors.Is(err, ErrCloudRunInvalid) {
			t.Fatal("scope cursor replay accepted")
		}
		cursor = page.NextCursor
	}
	if !seen[first] || !seen[second] || len(seen) != 2 {
		t.Fatal("unassigned pagination omitted rows")
	}
	page, err := catalog.CloudConversationCatalog(ctx, 7, "active", "", 10)
	if err != nil || len(page.Conversations) != 3 {
		t.Fatal("existing active scope changed", err)
	}
	yes := true
	zero := int64(0)
	if _, err := catalog.ManageCloudConversation(ctx, 7, member, CloudConversationManagementPatch{ExpectedVersion: &zero, Pinned: &yes, Archived: &yes}); err != nil {
		t.Fatal(err)
	}
	members, err := f.projects.ListCloudProjectConversations(ctx, 7, project.ID, "", 10)
	if err != nil || len(members) != 1 || !members[0].Conversation.Archived || !members[0].Conversation.Pinned {
		t.Fatal("project membership lost canonical conversation flags", err)
	}
	if _, err = f.projects.SetCloudConversationProject(ctx, 7, member, "", binding.Version); err != nil {
		t.Fatal(err)
	}
	page, err = catalog.CloudConversationCatalog(ctx, 7, "unassigned", "", 10)
	if err != nil || len(page.Conversations) != 2 {
		t.Fatal("archived move-out surfaced in recent", err)
	}
	no := false
	one := int64(1)
	if _, err := catalog.ManageCloudConversation(ctx, 7, member, CloudConversationManagementPatch{ExpectedVersion: &one, Archived: &no}); err != nil {
		t.Fatal(err)
	}
	page, err = catalog.CloudConversationCatalog(ctx, 7, "unassigned", "", 10)
	if err != nil || len(page.Conversations) != 3 {
		t.Fatal("move-out did not return to recent", err)
	}
}

func TestCloudProjectSidebarMemory(t *testing.T) {
	runCloudProjectSidebarContract(t, memoryCloudProjectFixture(t))
}
func TestCloudProjectSidebarPostgres(t *testing.T) {
	runCloudProjectSidebarContract(t, postgresCloudProjectFixture(t))
}

func testCloudProjectAppearance(t *testing.T, f cloudProjectFixture) {
	ctx := context.Background()
	p, err := f.projects.CreateCloudProject(ctx, &CloudProject{UserID: 7, Name: "appearance", Icon: "palette", Color: "violet"})
	if err != nil || p.Icon != "palette" || p.Color != "violet" {
		t.Fatal("create appearance", err)
	}
	icon, color := "code", "blue"
	p, err = f.projects.UpdateCloudProject(ctx, 7, p.ID, p.Version, CloudProjectUpdate{Name: p.Name, Icon: &icon, Color: &color})
	if err != nil {
		t.Fatal(err)
	}
	p, err = f.projects.UpdateCloudProject(ctx, 7, p.ID, p.Version, CloudProjectUpdate{Name: "legacy edit", Instructions: "keep context"})
	if err != nil {
		t.Fatal(err)
	}
	read, err := f.projects.GetCloudProject(ctx, 7, p.ID)
	if err != nil || read.Icon != icon || read.Color != color {
		t.Fatal("omitted appearance changed canonical state", err)
	}
	invalid := "folder|book"
	if _, err = f.projects.UpdateCloudProject(ctx, 7, p.ID, p.Version, CloudProjectUpdate{Name: p.Name, Icon: &invalid}); !errors.Is(err, ErrCloudProjectInvalid) {
		t.Fatal("non-allowlisted icon accepted")
	}
	if _, err = f.projects.GetCloudProject(ctx, 8, p.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign appearance leaked")
	}
}
func TestCloudProjectAppearanceMemory(t *testing.T) {
	testCloudProjectAppearance(t, memoryCloudProjectFixture(t))
}
func TestCloudProjectAppearancePostgres(t *testing.T) {
	testCloudProjectAppearance(t, postgresCloudProjectFixture(t))
}
