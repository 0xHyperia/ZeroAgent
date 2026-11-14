package account

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

type cloudReplayFixture struct {
	cloudRunTestFixture
	service    *Service
	session    *Session
	remember   func(string)
	keyActive  atomic.Bool
	modelCalls atomic.Int32
	keyReads   atomic.Int32
}

func newCloudReplayFixture(t *testing.T, postgres bool) *cloudReplayFixture {
	t.Helper()
	var base cloudRunTestFixture
	remember := func(string) {}
	if postgres {
		base = cloudRunPostgresFixture(t)
		authority := redisSessionRefreshFixture(t)
		remember = authority.remember
		persistent := base.store.(*PersistentStore)
		persistent.rdb = authority.store.(*PersistentStore).rdb
		if _, err := persistent.db.Exec(CloudFileSchema + CloudProjectSchema + CloudMemorySchema + CloudToolSchema + CloudArtifactSchema + CloudResearchSourceSchema + CloudBranchSchema); err != nil {
			t.Fatal(err)
		}
	} else {
		base = cloudRunMemoryFixture(t)
	}
	f := &cloudReplayFixture{cloudRunTestFixture: base, remember: remember}
	f.keyActive.Store(true)
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/keys":
			f.keyReads.Add(1)
			if f.keyActive.Load() {
				_, _ = io.WriteString(w, `{"code":0,"data":{"items":[{"id":41,"key":"replay-fixture-model-key","status":"active","name":"ZeroAgent Web"}]}}`)
			} else {
				_, _ = io.WriteString(w, `{"code":0,"data":{"items":[]}}`)
			}
		case "/v1/chat/completions":
			f.modelCalls.Add(1)
			if r.Header.Get("Authorization") != "Bearer replay-fixture-model-key" {
				t.Error("fixture model key escaped ownership resolution")
			}
			emitCloudDelta(w, "已完成合成任务")
			emitModelFinish(w, "stop", 1)
		default:
			t.Errorf("unexpected platform request %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	t.Cleanup(platform.Close)
	f.service = NewService(base.store, NewUSAClientWithHTTPClient(platform.URL, platform.Client()), time.Hour, time.Hour)
	t.Cleanup(f.service.CloseCloudRuns)
	f.session = f.newSession(t, 7)
	return f
}

func (f *cloudReplayFixture) newSession(t *testing.T, uid int64) *Session {
	t.Helper()
	session := &Session{ID: "replay-only-" + uuid.NewString(), UserID: uid, AccessToken: "replay-fixture-access", RefreshToken: "replay-fixture-refresh", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}
	f.remember(session.ID)
	if err := f.store.PutSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	return session
}

func (f *cloudReplayFixture) file(t *testing.T, cid string) *CloudFile {
	t.Helper()
	ctx := context.Background()
	files := f.store.(CloudFileStore)
	file, err := files.CreateCloudFile(ctx, newCloudFileRecord(7, cid))
	if err != nil {
		t.Fatal(err)
	}
	file, err = files.UpdateCloudFile(ctx, 7, file.ID, file.Version, CloudFileUpdate{State: CloudFileUploaded, MarkUploaded: true})
	if err != nil {
		t.Fatal(err)
	}
	text := "x"
	file, err = files.UpdateCloudFile(ctx, 7, file.ID, file.Version, CloudFileUpdate{State: CloudFileReady, Text: &text})
	if err != nil {
		t.Fatal(err)
	}
	return file
}

func (f *cloudReplayFixture) artifact(t *testing.T) *CloudArtifactVersion {
	t.Helper()
	ctx := context.Background()
	source := cloudRunTestInput(t, f.cloudRunTestFixture, 7, "", "artifact-origin-"+uuid.NewString(), "fixture source")
	if _, _, err := f.runs.CreateCloudRun(ctx, source); err != nil {
		t.Fatal(err)
	}
	run, err := f.runs.ClaimCloudRun(ctx, "replay-artifact-fixture", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	artifacts := f.store.(CloudArtifactStore)
	version, _, err := artifacts.ReserveCloudArtifact(ctx, 7, run.LeaseOwner, run.Attempt, artifactContractVersion(run))
	if err != nil {
		t.Fatal(err)
	}
	version, err = artifacts.UpdateCloudArtifact(ctx, 7, version.ID, version.Version, run.LeaseOwner, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.runs.CommitCloudRun(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, CloudRunCommit{OperationID: "fixture-source-finished", State: CloudRunCompleted}); err != nil {
		t.Fatal(err)
	}
	return version
}

func (f *cloudReplayFixture) wait(t *testing.T, id string) *CloudRun {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		run, err := f.runs.GetCloudRun(context.Background(), 7, id)
		if err != nil {
			t.Fatal(err)
		}
		if run.Terminal() {
			return run
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("accepted fixture task did not finish")
	return nil
}

func TestCloudRunLogicalReplayMemory(t *testing.T)   { runCloudRunLogicalReplay(t, false) }
func TestCloudRunLogicalReplayPostgres(t *testing.T) { runCloudRunLogicalReplay(t, true) }
func runCloudRunLogicalReplay(t *testing.T, postgres bool) {
	for _, kind := range []string{"deleted_file", "deleted_artifact", "revoked_key"} {
		t.Run(kind, func(t *testing.T) {
			f := newCloudReplayFixture(t, postgres)
			ctx := context.Background()
			cid := historyConversation(t, f.cloudRunTestFixture, 7)
			parts := []any{map[string]any{"type": "text", "text": "accepted work"}}
			var file *CloudFile
			var artifact *CloudArtifactVersion
			switch kind {
			case "deleted_file":
				file = f.file(t, cid)
				parts = append(parts, map[string]any{"type": "file_reference", "file_id": strings.ToUpper(file.ID), "name": "untrusted-client-name"})
			case "deleted_artifact":
				artifact = f.artifact(t)
				parts = append(parts, map[string]any{"type": "artifact_reference", "version_id": strings.ToUpper(artifact.ID), "name": "untrusted-client-name", "sandbox_id": "not-authority"})
			}
			input := CreateCloudRunInput{ConversationID: strings.ToUpper(cid), ClientRequestID: "lost-receipt-" + uuid.NewString(), Model: "test-model", ProviderKeyID: 41, Content: cloudJSON(parts)}
			first, created, err := f.service.CreateCloudRun(ctx, f.session, input)
			if err != nil || !created {
				t.Fatalf("first acceptance: created=%v err=%v", created, err)
			}
			finished := f.wait(t, first.ID)
			if finished.State != CloudRunCompleted || f.modelCalls.Load() != 1 {
				t.Fatalf("fixture execution failed: state=%s code=%s", finished.State, finished.ErrorCode)
			}
			// Treat the first receipt as lost. Change only external mutable facts.
			switch kind {
			case "deleted_file":
				if _, err = f.store.(CloudFileStore).UpdateCloudFile(ctx, 7, file.ID, file.Version, CloudFileUpdate{State: CloudFileDeleting}); err != nil {
					t.Fatal(err)
				}
			case "deleted_artifact":
				if _, err = f.store.(CloudArtifactStore).DeleteCloudArtifactFamily(ctx, 7, artifact.FamilyID); err != nil {
					t.Fatal(err)
				}
			case "revoked_key":
				f.keyActive.Store(false)
			}
			keyReads := f.keyReads.Load()
			if len(parts) > 1 {
				parts[1].(map[string]any)["name"] = "different-ignored-client-metadata"
				input.Content = cloudJSON(parts)
			}
			replayed, created, err := f.service.CreateCloudRun(ctx, f.session, input)
			if err != nil || created || replayed == nil || replayed.ID != first.ID || replayed.State != CloudRunCompleted || f.modelCalls.Load() != 1 || f.keyReads.Load() != keyReads {
				t.Fatalf("accepted logical request lost idempotency: created=%v err=%v calls=%d keys=%d/%d", created, err, f.modelCalls.Load(), f.keyReads.Load(), keyReads)
			}
			if len(replayed.RequestContent) != 0 || replayed.SessionRef != "" || strings.Contains(string(cloudJSON(replayed)), "request_hash") {
				t.Fatal("private replay lookup loaded or exposed original authority/input")
			}
			stored, err := f.runs.GetCloudRun(ctx, 7, first.ID)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(stored.RequestContent), "untrusted-client-name") || strings.Contains(string(stored.RequestContent), "not-authority") {
				t.Fatal("untrusted client metadata entered the canonical snapshot")
			}
			if file != nil && !strings.Contains(string(stored.RequestContent), file.Name) {
				t.Fatal("trusted accepted file metadata was not snapshotted")
			}
			changed := input
			changed.Content = cloudJSON("changed logical work")
			if other, _, err := f.service.CreateCloudRun(ctx, f.session, changed); !errors.Is(err, ErrCloudRunConflict) || other != nil {
				t.Fatal("changed logical body did not conflict before resource validation")
			}
			changed = input
			changed.ConversationID = historyConversation(t, f.cloudRunTestFixture, 7)
			if other, _, err := f.service.CreateCloudRun(ctx, f.session, changed); !errors.Is(err, ErrCloudRunConflict) || other != nil {
				t.Fatal("same account request ID crossed conversations")
			}
			foreign := f.newSession(t, 8)
			if other, _, err := f.service.CreateCloudRun(ctx, foreign, input); !errors.Is(err, ErrNotFound) || other != nil {
				t.Fatal("foreign account recovered an accepted task")
			}
			if _, err := f.store.(cloudRunReplayStore).GetCloudRunByClientRequest(ctx, 8, input.ClientRequestID); !errors.Is(err, ErrNotFound) {
				t.Fatal("private replay index leaked across accounts")
			}
			newInput := input
			newInput.ClientRequestID = "new-request-" + uuid.NewString()
			if other, _, err := f.service.CreateCloudRun(ctx, f.session, newInput); err == nil || other != nil {
				t.Fatal("new request bypassed current resource/key authorization")
			}
			if _, err := f.store.(cloudRunReplayStore).GetCloudRunByClientRequest(ctx, 7, newInput.ClientRequestID); !errors.Is(err, ErrNotFound) {
				t.Fatal("denied new request wrote a task")
			}
			messages, err := f.store.ListCloudMessages(ctx, 7, cid)
			if err != nil || len(messages) != 2 || f.modelCalls.Load() != 1 {
				t.Fatal("logical replay or denied request duplicated history/model calls")
			}
			viewer := f.newSession(t, 7)
			if err = f.store.DeleteSession(ctx, f.session.ID); err != nil {
				t.Fatal(err)
			}
			if other, _, err := f.service.CreateCloudRun(ctx, f.session, input); err == nil || other != nil {
				t.Fatal("revoked original session recovered a task")
			}
			if other, created, err := f.service.CreateCloudRun(ctx, viewer, input); err != nil || created || other.ID != first.ID {
				t.Fatal("fresh same-account viewer could not recover its accepted task")
			}
			storedAgain, err := f.runs.GetCloudRun(ctx, 7, first.ID)
			if err != nil || storedAgain.SessionRef != stored.SessionRef {
				t.Fatal("read-only replay rebound the original execution authority")
			}
		})
	}
}

func TestCloudRunHTTPReplaysLostReceiptAfterFileDeletion(t *testing.T) {
	f := newCloudReplayFixture(t, false)
	ctx := context.Background()
	cid := historyConversation(t, f.cloudRunTestFixture, 7)
	file := f.file(t, cid)
	mux := http.NewServeMux()
	NewHTTPHandler(f.service, false).Register(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	request := func(input CreateCloudRunInput) (int, []byte) {
		req, err := http.NewRequest("POST", server.URL+"/api/web-chat/runs", strings.NewReader(string(cloudJSON(input))))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: f.session.ID})
		response, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, err := io.ReadAll(response.Body)
		if err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, data
	}
	input := CreateCloudRunInput{ConversationID: cid, ClientRequestID: "http-lost-receipt", Model: "test-model", ProviderKeyID: 41, Content: cloudJSON([]any{map[string]any{"type": "text", "text": "work"}, map[string]any{"type": "file_reference", "file_id": file.ID}})}
	status, _ := request(input)
	if status != 202 {
		t.Fatalf("first request status=%d", status)
	}
	accepted, err := f.store.(cloudRunReplayStore).GetCloudRunByClientRequest(ctx, 7, input.ClientRequestID)
	if err != nil {
		t.Fatal(err)
	}
	f.wait(t, accepted.ID)
	if _, err = f.store.(CloudFileStore).UpdateCloudFile(ctx, 7, file.ID, file.Version, CloudFileUpdate{State: CloudFileDeleting}); err != nil {
		t.Fatal(err)
	}
	status, data := request(input)
	var result struct {
		Run *CloudRun `json:"run"`
	}
	if status != 200 || json.Unmarshal(data, &result) != nil || result.Run == nil || result.Run.ID != accepted.ID || f.modelCalls.Load() != 1 {
		t.Fatalf("lost receipt replay status=%d body=%s", status, data)
	}
	if strings.Contains(string(data), "request_hash") || strings.Contains(string(data), "session_ref") {
		t.Fatal("HTTP replay revealed private execution authority")
	}
	changed := input
	changed.Content = cloudJSON("changed")
	if status, _ = request(changed); status != 409 {
		t.Fatal("HTTP changed logical request did not conflict")
	}
	input.ClientRequestID = "new-after-delete"
	if status, _ = request(input); status != 404 || f.modelCalls.Load() != 1 {
		t.Fatal("new HTTP request bypassed deleted-file authorization")
	}
}

type cloudReplayLookupHookStore struct {
	*MemoryStore
	beforeFile   func()
	beforeReturn func()
	lookupErr    error
}

func (s *cloudReplayLookupHookStore) GetCloudRunByClientRequest(ctx context.Context, uid int64, id string) (*CloudRun, error) {
	if s.lookupErr != nil {
		return nil, s.lookupErr
	}
	run, err := s.MemoryStore.GetCloudRunByClientRequest(ctx, uid, id)
	if err == nil && s.beforeReturn != nil {
		s.beforeReturn()
	}
	return run, err
}
func (s *cloudReplayLookupHookStore) GetCloudFile(ctx context.Context, uid int64, id string) (*CloudFile, error) {
	if s.beforeFile != nil {
		s.beforeFile()
	}
	return s.MemoryStore.GetCloudFile(ctx, uid, id)
}

func TestCloudRunReplayValidationRaceFindsConcurrentAcceptedRequest(t *testing.T) {
	f := newCloudReplayFixture(t, false)
	ctx := context.Background()
	cid := historyConversation(t, f.cloudRunTestFixture, 7)
	file := f.file(t, cid)
	input := CreateCloudRunInput{ConversationID: cid, ClientRequestID: "concurrent-acceptance", Model: "test-model", ProviderKeyID: 41, Content: cloudJSON([]any{map[string]any{"type": "text", "text": "work"}, map[string]any{"type": "file_reference", "file_id": file.ID}})}
	normalized := input
	normalized.ModelParameters, _ = normalizeCloudModelParameters(input.ModelParameters)
	normalized.Content, _ = validateCloudContent(input.Content)
	hash, err := cloudRunLogicalRequestHash(normalized)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := f.service.canonicalCloudFileReferences(ctx, 7, normalized.Content)
	if err != nil {
		t.Fatal(err)
	}
	var accepted *CloudRun
	hook := &cloudReplayLookupHookStore{MemoryStore: f.store.(*MemoryStore)}
	hook.beforeFile = func() {
		if accepted != nil {
			return
		}
		var createErr error
		accepted, _, createErr = f.runs.CreateCloudRun(ctx, &CloudRun{ConversationID: cid, UserID: 7, SessionRef: cloudSessionReference(f.session.ID), ClientRequestID: input.ClientRequestID, RequestHash: hash, Model: input.Model, ProviderKeyID: 41, ModelParameters: normalized.ModelParameters, RequestContent: snapshot})
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, deleteErr := hook.UpdateCloudFile(ctx, 7, file.ID, file.Version, CloudFileUpdate{State: CloudFileDeleting}); deleteErr != nil {
			t.Fatal(deleteErr)
		}
	}
	f.service.store = hook
	run, created, err := f.service.CreateCloudRun(ctx, f.session, input)
	if err != nil || created || accepted == nil || run.ID != accepted.ID || f.modelCalls.Load() != 0 || f.keyReads.Load() != 0 {
		t.Fatalf("concurrent accepted row was hidden by later file failure: created=%v err=%v", created, err)
	}
	messages, err := f.store.ListCloudMessages(ctx, 7, cid)
	if err != nil || len(messages) != 1 {
		t.Fatal("validation race duplicated accepted user history")
	}
}

func TestCloudRunReplayLookupFailureIsNotTreatedAsMissing(t *testing.T) {
	f := newCloudReplayFixture(t, false)
	ctx := context.Background()
	cid := historyConversation(t, f.cloudRunTestFixture, 7)
	failure := errors.New("synthetic replay storage failure")
	f.service.store = &cloudReplayLookupHookStore{MemoryStore: f.store.(*MemoryStore), lookupErr: failure}
	run, _, err := f.service.CreateCloudRun(ctx, f.session, CreateCloudRunInput{ConversationID: cid, ClientRequestID: "lookup-unavailable", Model: "test-model", ProviderKeyID: 41, Content: cloudJSON("work")})
	if !errors.Is(err, failure) || run != nil || f.keyReads.Load() != 0 || f.modelCalls.Load() != 0 {
		t.Fatal("temporary replay failure fell through to a new effect")
	}
	messages, err := f.store.ListCloudMessages(ctx, 7, cid)
	if err != nil || len(messages) != 0 {
		t.Fatal("unavailable replay index accepted new history")
	}
}

func TestCloudRunReplayRechecksLogoutAfterLookup(t *testing.T) {
	f := newCloudReplayFixture(t, false)
	ctx := context.Background()
	cid := historyConversation(t, f.cloudRunTestFixture, 7)
	input := CreateCloudRunInput{ConversationID: cid, ClientRequestID: "logout-during-replay", Model: "test-model", ProviderKeyID: 41, Content: cloudJSON("work")}
	// Install the wrapper before the first run can start a title worker.
	// Arm the logout hook only for the explicit replay under test.
	var revokeOnLookup atomic.Bool
	f.service.store = &cloudReplayLookupHookStore{MemoryStore: f.store.(*MemoryStore), beforeReturn: func() {
		if revokeOnLookup.Swap(false) {
			if err := f.store.DeleteSession(ctx, f.session.ID); err != nil {
				t.Fatal(err)
			}
		}
	}}
	run, _, err := f.service.CreateCloudRun(ctx, f.session, input)
	if err != nil {
		t.Fatal(err)
	}
	f.wait(t, run.ID)
	revokeOnLookup.Store(true)
	keyReads := f.keyReads.Load()
	replayed, _, err := f.service.CreateCloudRun(ctx, f.session, input)
	var api *APIError
	if err == nil || !errors.As(err, &api) || api.Status != 401 || replayed != nil || f.keyReads.Load() != keyReads || f.modelCalls.Load() != 1 {
		t.Fatal("late accepted-task read survived its session revocation")
	}
}
