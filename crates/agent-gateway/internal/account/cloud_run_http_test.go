package account

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type cloudHTTPFixture struct {
	service      *Service
	store        *MemoryStore
	server       *httptest.Server
	conversation *CloudConversation
	calls        atomic.Int64
}

func newCloudHTTPFixture(t *testing.T, generate http.HandlerFunc) *cloudHTTPFixture {
	return newCloudHTTPFixtureWithPlatform(t, generate, http.NotFound)
}

func newCloudHTTPFixtureWithPlatform(t *testing.T, generate, platform http.HandlerFunc) *cloudHTTPFixture {
	t.Helper()
	fixture := &cloudHTTPFixture{store: NewMemoryStore()}
	usa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/keys":
			_, _ = io.WriteString(w, `{"code":0,"data":{"items":[{"id":41,"key":"synthetic-model-key","status":"active","name":"ZeroAgent Web"}]}}`)
		case "/api/v1/auth/logout":
			_, _ = io.WriteString(w, `{"code":0,"data":{}}`)
		case "/v1/chat/completions":
			fixture.calls.Add(1)
			if r.Header.Get("Authorization") != "Bearer synthetic-model-key" {
				t.Error("model key not resolved from account")
			}
			generate(w, r)
		default:
			platform(w, r)
		}
	}))
	t.Cleanup(usa.Close)
	fixture.service = NewService(fixture.store, NewUSAClientWithHTTPClient(usa.URL, usa.Client()), time.Hour, time.Hour)
	fixture.service.EnableCloudWorkspace()
	t.Cleanup(fixture.service.CloseCloudRuns)
	for _, session := range []*Session{
		{ID: "synthetic-browser-cookie", UserID: 1, AccessToken: "synthetic-access-token", RefreshToken: "synthetic-refresh-token", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)},
		{ID: "synthetic-second-viewer", UserID: 1, AccessToken: "synthetic-access-token", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)},
		{ID: "synthetic-other-account", UserID: 2, AccessToken: "second-account-access", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)},
	} {
		if err := fixture.store.PutSession(context.Background(), session); err != nil {
			t.Fatal(err)
		}
	}
	var err error
	fixture.conversation, err = fixture.service.CreateCloudConversation(context.Background(), 1, "test-model")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewHTTPHandler(fixture.service, false).Register(mux)
	fixture.server = httptest.NewServer(mux)
	t.Cleanup(fixture.server.Close)
	return fixture
}

func (f *cloudHTTPFixture) request(t *testing.T, method, path, cookie, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: cookie})
	}
	response, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, string(data)
}

func (f *cloudHTTPFixture) create(t *testing.T, id, text string) (*CloudRun, string) {
	t.Helper()
	body := string(cloudJSON(CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: id, Model: "test-model", Content: cloudJSON(text), ProviderKeyID: 41}))
	status, data := f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", body)
	if status != http.StatusAccepted {
		t.Fatalf("create status=%d body=%s", status, data)
	}
	var result struct {
		Run *CloudRun `json:"run"`
	}
	if err := json.Unmarshal([]byte(data), &result); err != nil || result.Run == nil {
		t.Fatalf("decode run: %v %s", err, data)
	}
	if strings.Contains(data, "synthetic-browser-cookie") || strings.Contains(data, "synthetic-model-key") || strings.Contains(data, "session_ref") {
		t.Fatal("private authorization leaked into run response")
	}
	return result.Run, body
}

func (f *cloudHTTPFixture) wait(t *testing.T, id string, predicate func(*CloudRun) bool) *CloudRun {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		run, err := f.store.GetCloudRun(context.Background(), 1, id)
		if err != nil {
			t.Fatal(err)
		}
		if predicate(run) {
			return run
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for cloud run state")
	return nil
}

func emitCloudDelta(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	_, _ = fmt.Fprintf(w, "data: %s\n\n", cloudJSON(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": text}}}}))
	if flush, ok := w.(http.Flusher); ok {
		flush.Flush()
	}
}

func TestCloudRunHTTPDisconnectReplayAndIdempotency(t *testing.T) {
	release := make(chan struct{})
	cancelled := make(chan struct{}, 1)
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		emitCloudDelta(w, "Hello ")
		select {
		case <-release:
		case <-r.Context().Done():
			cancelled <- struct{}{}
			return
		}
		emitCloudDelta(w, "world")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	})
	run, body := f.create(t, "stable-request-1", "Hi")
	req, _ := http.NewRequest(http.MethodGet, f.server.URL+"/api/web-chat/runs/"+run.ID+"/events", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "synthetic-browser-cookie"})
	response, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(response.Body)
	found := false
	for scanner.Scan() {
		if strings.Contains(scanner.Text(), "Hello ") {
			found = true
			break
		}
	}
	_ = response.Body.Close()
	if !found {
		t.Fatal("viewer did not receive output while model is still running")
	}
	select {
	case <-cancelled:
		t.Fatal("disconnect cancelled server task")
	default:
	}
	close(release)
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || finished.Output != "Hello world" {
		t.Fatalf("finished=%+v", finished)
	}
	status, duplicate := f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", body)
	if status != http.StatusOK || !strings.Contains(duplicate, run.ID) || f.calls.Load() != 1 {
		t.Fatalf("duplicate status=%d calls=%d", status, f.calls.Load())
	}
	status, _ = f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", strings.Replace(body, `"Hi"`, `"different"`, 1))
	if status != http.StatusConflict {
		t.Fatalf("changed request status=%d", status)
	}
	status, replay := f.request(t, http.MethodGet, "/api/web-chat/runs/"+run.ID+"/events?after_seq=1", "synthetic-second-viewer", "")
	if status != http.StatusOK || !strings.Contains(replay, "message.delta") || !strings.Contains(replay, "run.completed") || !strings.Contains(replay, "world") {
		t.Fatalf("invalid replay=%s", replay)
	}
	messages, err := f.store.ListCloudMessages(context.Background(), 1, f.conversation.ID)
	if err != nil || len(messages) != 2 || string(messages[1].Content) != `"Hello world"` {
		t.Fatalf("canonical history=%+v error=%v", messages, err)
	}
	for _, path := range []string{"/api/web-chat/runs/" + run.ID, "/api/web-chat/runs/" + run.ID + "/events", "/api/web-chat/runs?conversation_id=" + f.conversation.ID} {
		status, _ = f.request(t, http.MethodGet, path, "synthetic-other-account", "")
		if status != http.StatusNotFound {
			t.Fatalf("cross-account %s status=%d", path, status)
		}
	}
	status, _ = f.request(t, http.MethodPost, "/api/web-chat/runs/"+run.ID+"/cancel", "synthetic-other-account", "")
	if status != http.StatusNotFound {
		t.Fatalf("cross-account cancel=%d", status)
	}
}

func TestCloudRunHTTPCancelStopsModelAndPersistsPartial(t *testing.T) {
	stopped := make(chan struct{}, 1)
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		emitCloudDelta(w, "partial reply")
		<-r.Context().Done()
		stopped <- struct{}{}
	})
	run, _ := f.create(t, "cancel-request", "Hi")
	f.wait(t, run.ID, func(run *CloudRun) bool { return run.Output == "partial reply" })
	status, _ := f.request(t, http.MethodPost, "/api/web-chat/runs/"+run.ID+"/cancel", "synthetic-browser-cookie", "")
	if status != http.StatusOK {
		t.Fatalf("cancel=%d", status)
	}
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCancelled || finished.Output != "partial reply" {
		t.Fatalf("cancelled run=%+v", finished)
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("model request did not stop")
	}
	if f.calls.Load() != 1 {
		t.Fatal("cancel caused a second generation")
	}
	messages, _ := f.store.ListCloudMessages(context.Background(), 1, f.conversation.ID)
	if len(messages) != 2 {
		t.Fatalf("partial history=%+v", messages)
	}
}

func TestCloudRunHTTPTruncatedStreamIsInterrupted(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) { emitCloudDelta(w, "unfinished") })
	run, _ := f.create(t, "truncated-request", "Hi")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunInterrupted || finished.Output != "unfinished" || finished.ErrorCode != "model_stream_interrupted" {
		t.Fatalf("interrupted run=%+v", finished)
	}
}

func TestCloudRunHTTPRedactsSplitCredentialsAndUsage(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		for _, part := range []string{"safe synthetic-model-", "key / synthetic-access-", "token / synthetic-refresh-token / synthetic-browser-cookie end"} {
			emitCloudDelta(w, part)
		}
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"total_tokens\":3,\"secret\":\"synthetic-model-key\"}}\n\ndata: [DONE]\n\n")
	})
	run, _ := f.create(t, "redaction-request", "Hi")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted {
		t.Fatalf("redaction run=%+v", finished)
	}
	data := string(cloudJSON(finished))
	for _, secret := range []string{"synthetic-model-key", "synthetic-access-token", "synthetic-refresh-token", "synthetic-browser-cookie"} {
		if strings.Contains(data, secret) {
			t.Fatalf("credential reflected in public run: %s", secret)
		}
	}
	if !strings.Contains(finished.Output, "[redacted]") || string(finished.Usage) != `{"total_tokens":3}` {
		t.Fatalf("unexpected sanitized run=%+v", finished)
	}
}

func TestCloudRunHTTPLogoutRevokesRunningTask(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) { emitCloudDelta(w, "before logout"); <-r.Context().Done() })
	run, _ := f.create(t, "logout-request", "Hi")
	f.wait(t, run.ID, func(run *CloudRun) bool { return run.Output == "before logout" })
	status, _ := f.request(t, http.MethodPost, "/api/auth/logout", "synthetic-browser-cookie", "")
	if status != http.StatusNoContent {
		t.Fatalf("logout=%d", status)
	}
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunInterrupted {
		t.Fatalf("revoked task=%+v", finished)
	}
	status, _ = f.request(t, http.MethodGet, "/api/web-chat/runs/"+run.ID, "synthetic-browser-cookie", "")
	if status != http.StatusUnauthorized {
		t.Fatalf("revoked viewer=%d", status)
	}
}

func TestCloudRunHTTPRejectsCrossOriginAndRemoteImage(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("invalid input reached model") })
	body := string(cloudJSON(CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: "origin-test", Model: "test-model", Content: cloudJSON("Hi"), ProviderKeyID: 41}))
	req, _ := http.NewRequest(http.MethodPost, f.server.URL+"/api/web-chat/runs", strings.NewReader(body))
	req.Header.Set("Origin", "https://untrusted.invalid")
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "synthetic-browser-cookie"})
	response, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin=%d", response.StatusCode)
	}
	input := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: "image-test", Model: "test-model", ProviderKeyID: 41, Content: json.RawMessage(`[{"type":"image_url","image_url":{"url":"http://127.0.0.1/private"}}]`)}
	status, _ := f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	if status != http.StatusBadRequest || f.calls.Load() != 0 {
		t.Fatalf("remote image=%d model calls=%d", status, f.calls.Load())
	}
	messages, _ := f.store.ListCloudMessages(context.Background(), 1, f.conversation.ID)
	if len(messages) != 0 {
		t.Fatal("invalid input modified history")
	}
}
