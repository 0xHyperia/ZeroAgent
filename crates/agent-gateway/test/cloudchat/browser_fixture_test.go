package cloudchat_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
)

// Explicit, test-only loopback fixture for checking the real embedded production
// WebUI. No fixture route is linked into cmd/gateway; all accounts and models are
// synthetic. This test contacts only its local model and S3 protocol peers,
// never USA-Zero, E2B or a real object-storage account.
func TestCloudChatBrowserFixture(t *testing.T) {
	output := os.Getenv("ZEROAGENT_CLOUDCHAT_BROWSER_FIXTURE_FILE")
	if output == "" {
		t.Skip("explicit local browser fixture not requested")
	}
	evidence := newBrowserFixtureEvidence()
	workflow := newBrowserToolFixture(t)
	app := func(w http.ResponseWriter, value any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": value})
	}
	user := map[string]any{"id": 700127, "email": "cloudchat-fixture@example.invalid", "username": "CloudChat 本地验收", "role": "user", "status": "active", "balance": 100}
	group := map[string]any{"id": 1, "name": "本地验收", "platform": "openai", "status": "active"}
	key := map[string]any{"id": 41, "name": "本地测试模型", "key": "fixture-model-key-only", "group_id": 1, "group": group, "status": "active"}
	usa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/app/me":
			app(w, user)
		case "/api/v1/app/keys":
			app(w, map[string]any{"items": []any{key}, "total": 1, "page": 1, "page_size": 1000, "pages": 1})
		case "/api/v1/app/groups":
			app(w, []any{group})
		case "/api/v1/app/usage":
			app(w, map[string]any{"total_requests": 0, "total_cost": 0, "today_requests": 0})
		case "/api/v1/app/subscriptions":
			app(w, []any{})
		case "/v1/models":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"id": "gpt-5.1", "object": "model", "owned_by": "fixture"}}})
		case "/v1/chat/completions":
			w.Header().Set("Content-Type", "text/event-stream")
			if r.Header.Get("Authorization") != "Bearer fixture-model-key-only" {
				http.Error(w, "fixture authorization rejected", 401)
				return
			}
			body, err := io.ReadAll(io.LimitReader(r.Body, (2<<20)+1))
			if err != nil || len(body) > 2<<20 {
				http.Error(w, "invalid synthetic model request", 400)
				return
			}
			citation, err := evidence.recordModelRequest(body)
			if err != nil {
				http.Error(w, "invalid synthetic model request", 400)
				return
			}
			if workflow.respondModel(w, body) {
				return
			}
			chunks := []string{"这是一份", "本地流式验收回复。\n\n", "- 页面刷新后可以继续查看。\n", "- 任务输出保存在账户历史中。\n", "- 本次没有调用付费模型。"}
			if citation != "" {
				chunks = append(chunks, citation)
			}
			for _, text := range chunks {
				data, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": text}}}})
				_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
				if f, ok := w.(http.Flusher); ok {
					f.Flush()
				}
				select {
				case <-r.Context().Done():
					return
				case <-time.After(700 * time.Millisecond):
				}
			}
			_, _ = io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"total_tokens\":30}}\n\ndata: [DONE]\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	defer usa.Close()
	store := account.NewMemoryStore()
	historySeed, err := seedBrowserHistory(context.Background(), store, 700127)
	if err != nil {
		t.Fatal("seed synthetic bounded conversation history")
	}
	recoverySeed, err := seedBrowserRecovery(context.Background(), store, 700127)
	if err != nil {
		t.Fatal("seed synthetic offline terminal recovery")
	}
	accounts := account.NewService(store, account.NewUSAClientWithHTTPClient(usa.URL, usa.Client()), time.Hour, time.Hour)
	defer accounts.CloseCloudRuns()
	if err := accounts.SetCloudObjectStore(newBrowserFixtureS3(t, evidence)); err != nil {
		t.Fatal("configure local S3 protocol peer")
	}
	if err := accounts.SetCloudExecutor(workflow.client); err != nil {
		t.Fatal("configure local executor protocol peer")
	}
	configureBrowserResearch(t, accounts)
	identity, _ := json.Marshal(user)
	browserSession := &account.Session{ID: uuid.NewString(), UserID: 700127, User: identity, AccessToken: "fixture-app-access-only", AuthKind: account.AuthKindOAuth, OAuthClientID: "zeroagent-web", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}
	if err := store.PutSession(context.Background(), browserSession); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{RequestTimeout: 5 * time.Second, MaxMessageBytes: config.DefaultMaxMessageBytes, WebSocketWriteTimeout: time.Second, WebSocketWriteQueueSize: 64, HeartbeatPeriod: 30 * time.Second, WebSocketHeartbeatPeriod: 15 * time.Second, WebSocketHeartbeatGrace: 5 * time.Second}
	manager := session.NewManager()
	handler := server.NewHTTPServer(cfg, manager, accounts)
	if closer, ok := handler.(io.Closer); ok {
		defer closer.Close()
	}
	done := make(chan struct{})
	var once sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc("GET /__fixture/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		status := evidence.snapshot()
		status["executor"] = workflow.snapshot()
		status["history"] = historySeed
		status["offline_recovery"] = recoverySeed
		status["pagination_seed_count"] = 65
		preferences, err := browserRunPreferences(r.Context(), store, 700127)
		if err != nil {
			http.Error(w, "fixture metadata unavailable", http.StatusInternalServerError)
			return
		}
		status["run_preferences"] = preferences
		digest := sha256.Sum256([]byte(browserFixtureText))
		status["sample_sha256"] = hex.EncodeToString(digest[:])
		_ = json.NewEncoder(w).Encode(status)
	})
	mux.HandleFunc("GET /__fixture/sample.txt", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="cloudchat-source.txt"`)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, browserFixtureText)
	})
	mux.HandleFunc("/__fixture/login", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: account.SessionCookieName, Value: browserSession.ID, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
		http.Redirect(w, r, "/", http.StatusSeeOther)
	})
	mux.HandleFunc("POST /__fixture/finish", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" && !strings.Contains(r.Header.Get("Origin"), "127.0.0.1") {
			http.Error(w, "local fixture only", 403)
			return
		}
		once.Do(func() { close(done) })
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/web-chat/") {
			t.Logf("fixture HTTP %s %s content_type=%q", r.Method, r.URL.Path, r.Header.Get("Content-Type"))
		}
		handler.ServeHTTP(w, r)
	}))
	web := httptest.NewServer(mux)
	defer web.Close()
	if err := os.MkdirAll(filepath.Dir(output), 0700); err != nil {
		t.Fatal(err)
	}
	// Known synthetic bytes only, alongside the explicitly requested artifact.
	// Never overwrite another local file when reusing the fixture directory.
	samplePath := filepath.Join(filepath.Dir(output), "cloudchat-source.txt")
	sample, err := os.OpenFile(samplePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if os.IsExist(err) {
		existing, readErr := os.ReadFile(samplePath)
		if readErr != nil || string(existing) != browserFixtureText {
			t.Fatal("existing fixture sample does not match synthetic source")
		}
	} else if err != nil {
		t.Fatal("write synthetic source sample")
	} else {
		_, writeErr := io.WriteString(sample, browserFixtureText)
		closeErr := sample.Close()
		if writeErr != nil || closeErr != nil {
			t.Fatal("write synthetic source sample")
		}
	}
	if err := os.WriteFile(output, []byte(web.URL+"/__fixture/login"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("synthetic production-bundle fixture: %s/__fixture/login", web.URL)
	select {
	case <-done:
	case <-time.After(20 * time.Minute):
		t.Fatal("local browser fixture expired")
	}
}
