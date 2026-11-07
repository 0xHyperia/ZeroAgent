package account

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDesktopCloudUsesExistingBearerWithoutExchange(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	token := func(client string, expires time.Time) string {
		payload, err := json.Marshal(map[string]any{
			"token_use": "app", "client_id": client, "sub": "41",
			"grant_id": "grant", "session_id": "session", "family_id": "family", "exp": expires.Unix(),
		})
		if err != nil {
			t.Fatal(err)
		}
		return "header." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
	}
	original := token("zeroagent-desktop", now.Add(5*time.Minute))
	renewed := token("zeroagent-desktop", now.Add(10*time.Minute))
	var revoked atomic.Bool
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/app/me" {
			t.Errorf("unexpected platform request: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		auth := r.Header.Get("Authorization")
		if revoked.Load() || (auth != "Bearer "+original && auth != "Bearer "+renewed) {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"success":false,"error":{"code":"invalid_token"}}`)
			return
		}
		_, _ = io.WriteString(w, `{"success":true,"data":{"id":41}}`)
	}))
	t.Cleanup(platform.Close)
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(store, NewUSAClientWithHTTPClient(platform.URL, platform.Client(), ""), time.Hour, time.Hour)
	mux := http.NewServeMux()
	NewHTTPHandler(service, true).Register(mux)
	call := func(method, path, bearer, cookie, owner string) *httptest.ResponseRecorder {
		var body io.Reader
		if method == http.MethodPatch && path == "/api/web-settings" {
			body = strings.NewReader(`{"model":"desktop-task-model","reasoning_effort":"medium"}`)
		}
		req := httptest.NewRequest(method, "https://gateway.test"+path, body)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: cookie})
		}
		req.Header.Set("X-ZeroAgent-Account-ID", owner)
		result := httptest.NewRecorder()
		mux.ServeHTTP(result, req)
		return result
	}
	current := call("GET", "/api/auth/me", original, "", "41")
	if current.Code != http.StatusOK || len(current.Result().Cookies()) != 0 {
		t.Fatalf("desktop account should open without a cookie: %d %s", current.Code, current.Body)
	}
	if code := call("GET", "/api/web-chat/conversations", original, "", "41").Code; code != http.StatusOK {
		t.Fatalf("desktop bearer could not read cloud conversations: %d", code)
	}
	if code := call("PATCH", "/api/web-settings", original, "", "41").Code; code != http.StatusOK {
		t.Fatalf("desktop bearer could not update its model preferences: %d", code)
	}
	modelSettings := call("GET", "/api/web-settings", original, "", "41")
	if modelSettings.Code != http.StatusOK || !strings.Contains(modelSettings.Body.String(), "desktop-task-model") {
		t.Fatalf("desktop bearer did not read its model preferences: %d %s", modelSettings.Code, modelSettings.Body)
	}
	if code := call("GET", "/api/web-settings", original, "", "42").Code; code != http.StatusConflict {
		t.Fatalf("mismatched owner could read model preferences: %d", code)
	}
	if code := call("GET", "/api/auth/me", original, "", "42").Code; code != http.StatusConflict {
		t.Fatalf("stale account assertion should be rejected: %d", code)
	}
	if code := call("POST", "/api/execution-target/select", original, "", "").Code; code != http.StatusUnauthorized {
		t.Fatalf("desktop cloud bearer authorized a browser-only operation: %d", code)
	}
	if code := call("GET", "/api/auth/me", token("zeroagent-web", now.Add(time.Minute)), "", "").Code; code != http.StatusUnauthorized {
		t.Fatalf("non-desktop application bearer accepted: %d", code)
	}
	session, err := service.desktopCloudAccess(ctx, original)
	if err != nil {
		t.Fatal(err)
	}
	ref, err := store.BindCloudRunSession(ctx, session)
	if err != nil {
		t.Fatal(err)
	}
	if code := call("GET", "/api/auth/me", "", session.ID, "").Code; code != http.StatusUnauthorized {
		t.Fatalf("private run reference accepted as a cookie: %d", code)
	}
	if code := call("GET", "/api/auth/me", renewed, "", "").Code; code != http.StatusOK {
		t.Fatalf("rotated desktop bearer was rejected: %d", code)
	}
	call("GET", "/api/auth/me", original, "", "")
	stored, err := store.GetCloudRunSession(ctx, ref)
	if err != nil || stored.AccessToken != renewed || stored.RefreshToken != "" {
		t.Fatal("existing run did not retain the latest desktop access token")
	}
	revoked.Store(true)
	if code := call("GET", "/api/auth/me", renewed, "", "").Code; code != http.StatusUnauthorized {
		t.Fatalf("revoked desktop access still authorized: %d", code)
	}
	if _, err := service.Session(ctx, session.ID); !sessionDefiniteRejection(err) {
		t.Fatalf("revoked desktop authorization still available to Cloud Run: %v", err)
	}
}

func TestRedisDesktopCloudAccessRenewsExistingRunReference(t *testing.T) {
	store := redisSessionRefreshFixture(t).store.(*PersistentStore)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	first := &Session{
		ID: desktopCloudAccessPrefix + uuid.NewString(), UserID: 41,
		Purpose: desktopCloudAccessPurpose, AccessToken: "original",
		AccessExpiresAt: now.Add(time.Minute), SessionExpiresAt: now.Add(time.Minute),
	}
	t.Cleanup(func() { _ = store.DeleteSession(context.Background(), first.ID) })
	if err := store.PutSession(ctx, first); err != nil {
		t.Fatal(err)
	}
	ref, err := store.BindCloudRunSession(ctx, first)
	if err != nil {
		t.Fatal(err)
	}
	renewed := *first
	renewed.AccessToken = "rotated"
	renewed.AccessExpiresAt = now.Add(3 * time.Minute)
	renewed.SessionExpiresAt = renewed.AccessExpiresAt
	if err := store.PutSession(ctx, &renewed); err != nil {
		t.Fatal(err)
	}
	if err := store.PutSession(ctx, first); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetCloudRunSession(ctx, ref)
	if err != nil || stored.AccessToken != renewed.AccessToken {
		t.Fatal("Redis lost the rotated access token for the existing run")
	}
	ttl, err := store.rdb.PTTL(ctx, cloudSessionReferenceKey(ref)).Result()
	if err != nil || ttl <= time.Minute || ttl > 3*time.Minute {
		t.Fatalf("run reference did not follow the new token deadline: %v (%v)", ttl, err)
	}
}
