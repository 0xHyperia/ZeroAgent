package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

func runCloudPrivateDraftContract(t *testing.T, f cloudRunTestFixture) {
	t.Helper()
	ctx := context.Background()
	store := f.store.(cloudPrivateDraftStore)
	initial, err := store.GetCloudPrivateDraft(ctx, 81, "blank")
	if err != nil || initial.Version != "0" || initial.Draft != nil {
		t.Fatalf("initial %+v %v", initial, err)
	}
	raw := json.RawMessage(`{"composer":{"text":"未发送正文"},"files":[{"name":"本地.txt","data":"data:text/plain;base64,YQ=="}],"artifacts":[],"presentation":"work","researchEnabled":true,"selection":{"model":"fixture","reasoning_effort":"high"}}`)
	input := CloudPrivateDraftInput{ExpectedVersion: initial.Version, ClientOperationID: uuid.NewString(), Draft: raw}
	one, err := store.WriteCloudPrivateDraft(ctx, 81, "blank", input, false)
	if err != nil || one.Version != "1" || one.LastOperationID != input.ClientOperationID {
		t.Fatalf("write %+v %v", one, err)
	}
	conversations, _ := f.store.ListCloudConversations(ctx, 81)
	if len(conversations) != 0 {
		t.Fatal("blank draft created empty conversation")
	}
	other, _ := store.GetCloudPrivateDraft(ctx, 82, "blank")
	if other.Draft != nil || other.Version != "0" {
		t.Fatal("draft leaked across accounts")
	}
	repeat, err := store.WriteCloudPrivateDraft(ctx, 81, "blank", input, false)
	if err != nil || !repeat.Replayed || repeat.Version != "1" || repeat.AppliedVersion != "1" {
		t.Fatal("lost response retry duplicated operation")
	}
	changed := input
	changed.Draft = json.RawMessage(`{"composer":{"text":"changed"}}`)
	if _, err = store.WriteCloudPrivateDraft(ctx, 81, "blank", changed, false); !errors.Is(err, ErrCloudDraftOperationConflict) {
		t.Fatal("operation ID reused with different content")
	}
	changed.ClientOperationID = uuid.NewString()
	if _, err = store.WriteCloudPrivateDraft(ctx, 81, "blank", changed, false); !errors.Is(err, ErrCloudDraftChanged) {
		t.Fatal("stale draft overwrote newer state")
	}
	changed.ExpectedVersion = one.Version
	two, err := store.WriteCloudPrivateDraft(ctx, 81, "blank", changed, false)
	if err != nil {
		t.Fatal(err)
	}
	repeat, err = store.WriteCloudPrivateDraft(ctx, 81, "blank", input, false)
	if err != nil || !repeat.Replayed || repeat.Version != two.Version || repeat.AppliedVersion != "1" || !strings.Contains(string(repeat.Draft), "changed") {
		t.Fatal("late idempotent retry rolled back newer edits")
	}
	remove := CloudPrivateDraftInput{ExpectedVersion: two.Version, ClientOperationID: uuid.NewString()}
	deleted, err := store.WriteCloudPrivateDraft(ctx, 81, "blank", remove, true)
	if err != nil || deleted.Draft != nil || deleted.Version == "0" || deleted.Version == two.Version {
		t.Fatal("delete lost monotonically increasing absent revision")
	}
	stale := input
	stale.ClientOperationID = uuid.NewString()
	if _, err = store.WriteCloudPrivateDraft(ctx, 81, "blank", stale, false); !errors.Is(err, ErrCloudDraftChanged) {
		t.Fatal("old create resurrected deleted draft")
	}
	stale.ExpectedVersion = deleted.Version
	recreated, err := store.WriteCloudPrivateDraft(ctx, 81, "blank", stale, false)
	if err != nil {
		t.Fatal(err)
	}
	repeat, err = store.WriteCloudPrivateDraft(ctx, 81, "blank", remove, true)
	if err != nil || !repeat.Replayed || repeat.Draft == nil || repeat.Version != recreated.Version {
		t.Fatal("late delete retry erased recreated draft")
	}
	var winners atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := store.WriteCloudPrivateDraft(ctx, 81, "blank", CloudPrivateDraftInput{ExpectedVersion: recreated.Version, ClientOperationID: uuid.NewString(), Draft: raw}, false)
			if err == nil {
				winners.Add(1)
			} else if !errors.Is(err, ErrCloudDraftChanged) {
				t.Errorf("concurrent draft %v", err)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatal("CAS permitted concurrent lost update")
	}
	c := &CloudConversation{ID: uuid.NewString(), UserID: 81, Title: "private scope"}
	if err = f.store.PutCloudConversation(ctx, c); err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.GetCloudPrivateDraft(ctx, 81, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.WriteCloudPrivateDraft(ctx, 82, c.ID, CloudPrivateDraftInput{ExpectedVersion: "0", ClientOperationID: uuid.NewString(), Draft: raw}, false); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign conversation accepted private draft")
	}
	if _, err = store.WriteCloudPrivateDraft(ctx, 81, c.ID, CloudPrivateDraftInput{ExpectedVersion: snapshot.Version, ClientOperationID: uuid.NewString(), Draft: raw}, false); err != nil {
		t.Fatal(err)
	}
	if err = f.store.DeleteCloudConversation(ctx, 81, c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = store.GetCloudPrivateDraft(ctx, 81, c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("deleted conversation draft still accessible")
	}
	if p, ok := f.store.(*PersistentStore); ok {
		var count int
		if err = p.db.QueryRow(`SELECT count(*) FROM zeroagent_cloud_private_drafts WHERE user_id=81 AND scope=$1`, c.ID).Scan(&count); err != nil || count != 0 {
			t.Fatal("conversation delete did not cascade draft")
		}
	}
}

func TestCloudPrivateDraftMemory(t *testing.T) {
	runCloudPrivateDraftContract(t, cloudRunMemoryFixture(t))
}
func TestCloudPrivateDraftPostgres(t *testing.T) {
	runCloudPrivateDraftContract(t, cloudRunPostgresFixture(t))
}

func TestCloudPrivateDraftValidationAndCountQuota(t *testing.T) {
	ctx := context.Background()
	s := NewMemoryStore()
	for i := 0; i < CloudPrivateDraftMaxCount; i++ {
		c := &CloudConversation{ID: uuid.NewString(), UserID: 91}
		if err := s.PutCloudConversation(ctx, c); err != nil {
			t.Fatal(err)
		}
		_, err := s.WriteCloudPrivateDraft(ctx, 91, c.ID, CloudPrivateDraftInput{ExpectedVersion: "0", ClientOperationID: uuid.NewString(), Draft: json.RawMessage(`{}`)}, false)
		if err != nil {
			t.Fatal(err)
		}
	}
	input := CloudPrivateDraftInput{ExpectedVersion: "0", ClientOperationID: uuid.NewString(), Draft: json.RawMessage(`{}`)}
	if _, err := s.WriteCloudPrivateDraft(ctx, 91, "blank", input, false); !errors.Is(err, ErrCloudDraftLimit) {
		t.Fatal("account draft-count quota not enforced")
	}
	for _, bad := range []json.RawMessage{json.RawMessage(`[]`), json.RawMessage(`null`), json.RawMessage(`"text"`), json.RawMessage(`{"x":`)} {
		input.Draft = bad
		if _, err := s.WriteCloudPrivateDraft(ctx, 91, "blank", input, false); !errors.Is(err, ErrCloudRunInvalid) {
			t.Fatal("invalid draft payload accepted")
		}
	}
	input.Draft = json.RawMessage(`{}`)
	input.ExpectedVersion = "00"
	if _, err := s.WriteCloudPrivateDraft(ctx, 91, "blank", input, false); !errors.Is(err, ErrCloudRunInvalid) {
		t.Fatal("noncanonical version accepted")
	}
}

func TestCloudPrivateDraftHTTPIsPrivateInertAndSameOrigin(t *testing.T) {
	f := newCloudHTTPFixture(t, func(http.ResponseWriter, *http.Request) { t.Fatal("draft must not call model") })
	path := "/api/web-chat/drafts/blank"
	body := string(cloudJSON(CloudPrivateDraftInput{ExpectedVersion: "0", ClientOperationID: uuid.NewString(), Draft: json.RawMessage(`{"composer":{"text":"private unsent"}}`)}))
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		if status, _ := f.request(t, method, path, "", body); status != 401 {
			t.Fatal("unauthenticated draft access")
		}
	}
	status, data := f.request(t, "PUT", path, "synthetic-browser-cookie", body)
	if status != 200 {
		t.Fatalf("draft write %d %s", status, data)
	}
	status, data = f.request(t, "GET", path, "synthetic-other-account", "")
	if status != 200 || strings.Contains(data, "private unsent") {
		t.Fatal("another account read private draft")
	}
	req, _ := http.NewRequest("PUT", f.server.URL+path, strings.NewReader(body))
	req.Header.Set("Origin", "https://foreign.invalid")
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "synthetic-browser-cookie"})
	resp, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("cross-origin draft write accepted")
	}
	if f.calls.Load() != 0 {
		t.Fatal("draft activated runner")
	}
}
