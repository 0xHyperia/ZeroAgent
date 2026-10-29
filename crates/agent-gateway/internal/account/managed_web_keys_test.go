package account

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type managedWebKeyFixture struct {
	service               *Service
	store                 *MemoryStore
	handler               http.Handler
	session               *Session
	login, keys, cleanup  atomic.Int32
	onLogin, onKeys       func()
	passwordMode, keyMode string
}

func newManagedWebKeyFixture(t *testing.T, oauth bool) *managedWebKeyFixture {
	t.Helper()
	f := &managedWebKeyFixture{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/auth/login":
			f.login.Add(1)
			if f.onLogin != nil {
				f.onLogin()
			}
			var input struct{ Email, Password string }
			if json.NewDecoder(r.Body).Decode(&input) != nil || input.Email != "a@example.test" || input.Password != "proof-password" {
				t.Error("unbound password proof")
			}
			data := map[string]any{"access_token": "temporary-proof-access", "refresh_token": "temporary-proof-refresh", "user": map[string]any{"id": 7}}
			code := 0
			switch f.passwordMode {
			case "wrong":
				w.WriteHeader(401)
				code = 1
			case "foreign":
				data["user"] = map[string]any{"id": 8}
			case "incomplete":
				delete(data, "user")
			case "malformed-user":
				data["user"] = map[string]any{"id": "invalid"}
			case "reflect-session":
				data["refresh_token"] = f.session.RefreshToken
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "data": data, "message": "do-not-reflect-temporary-proof-access"})
		case "/api/v1/auth/logout":
			f.cleanup.Add(1)
			var input struct {
				Refresh string `json:"refresh_token"`
			}
			if json.NewDecoder(r.Body).Decode(&input) != nil || input.Refresh != "temporary-proof-refresh" {
				t.Error("proof revoked an existing account token")
			}
			if f.passwordMode == "cleanup-failed" {
				w.WriteHeader(503)
				_, _ = io.WriteString(w, `{"code":1,"message":"temporary-proof-refresh"}`)
				return
			}
			_, _ = io.WriteString(w, `{"code":0,"data":{}}`)
		case "/api/v1/app/me":
			_, _ = io.WriteString(w, `{"success":true,"data":{"id":7,"email":"a@example.test","status":"active"}}`)
		case "/api/v1/auth/me":
			_, _ = io.WriteString(w, `{"code":0,"data":{"id":7,"email":"a@example.test","status":"active"}}`)
		case "/api/v1/app/keys", "/api/v1/keys", "/api/v1/app/groups/3/keys":
			f.keys.Add(1)
			if f.onKeys != nil {
				f.onKeys()
			}
			if f.keyMode == "error" {
				w.WriteHeader(403)
				_, _ = io.WriteString(w, `{"code":1,"message":"sk-private-seven","error":{"message":"sk-private-seven","code":"sk-private-seven"}}`)
				return
			}
			row := map[string]any{"id": 7, "key": "sk-private-seven", "name": "label sk-private-seven", "status": "active", "group_id": 3, "quota": 0, "quota_used": 1, "created_at": "2026-10-29T00:00:00Z", "access_token": "reflected-extra-token", "sk-private-seven": "forbidden-key-name", "group": map[string]any{"id": 3, "name": "group reflected-extra-token", "platform": "openai", "status": "active", "rate_multiplier": 1, "description": "never reflect " + f.session.AccessToken, "key": "nested-private-key"}}
			var data any = map[string]any{"items": []any{row}, "total": 1, "page": 1, "page_size": 1000, "unknown": "sk-private-seven"}
			if r.Method == http.MethodPost {
				data = row
			}
			if strings.HasPrefix(r.URL.Path, "/api/v1/app/") {
				_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": data})
			} else {
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data})
			}
		default:
			t.Errorf("unexpected account request %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	t.Cleanup(upstream.Close)
	f.store = NewMemoryStore()
	f.service = NewService(f.store, NewUSAClientWithHTTPClient(upstream.URL, upstream.Client()), time.Hour, time.Hour)
	f.session = &Session{ID: "managed-web-cookie", UserID: 7, User: json.RawMessage(`{"id":7,"email":"a@example.test","status":"active"}`), AccessToken: "original-account-access", RefreshToken: "original-account-refresh", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour), AuthKind: AuthKindPassword}
	if oauth {
		f.session.AuthKind = AuthKindOAuth
		f.session.OAuthClientID = "zeroagent-web"
		f.session.User = markOAuthUser(f.session.User)
	}
	if err := f.store.PutSession(context.Background(), f.session); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewHTTPHandler(f.service, true).Register(mux)
	f.handler = mux
	return f
}

func (f *managedWebKeyFixture) request(method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: f.session.ID})
	r.Header.Set("X-ZeroAgent-Account-ID", "7")
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	return w
}

func TestManagedWebKeysMetadataBoundary(t *testing.T) {
	for _, oauth := range []bool{false, true} {
		name := "password"
		if oauth {
			name = "oauth"
		}
		t.Run(name, func(t *testing.T) {
			f := newManagedWebKeyFixture(t, oauth)
			for _, request := range []struct{ method, path, body string }{{"GET", "/api/usa-zero/keys?page=1&page_size=1000", ""}, {"POST", "/api/usa-zero/keys", `{"name":"fixture","group_id":3}`}} {
				w := f.request(request.method, request.path, request.body)
				if w.Code != 200 {
					t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
				}
				for _, secret := range []string{"sk-private-seven", "nested-private-key", "reflected-extra-token", f.session.AccessToken, f.session.RefreshToken, "forbidden-key-name"} {
					if strings.Contains(w.Body.String(), secret) {
						t.Fatal("key metadata reflected a private credential")
					}
				}
				if !strings.Contains(w.Body.String(), `"key_configured":true`) || !strings.Contains(w.Body.String(), managedKeyMask) {
					t.Fatal("metadata lost configured state")
				}
			}
			f.keyMode = "error"
			w := f.request("GET", "/api/usa-zero/keys", "")
			if w.Code != 403 || strings.Contains(w.Body.String(), "sk-private-seven") {
				t.Fatal("proxy reflected a secret-bearing error")
			}
		})
	}
}

func TestManagedWebProxyRejectsAlternateSecretRoutes(t *testing.T) {
	for _, oauth := range []bool{false, true} {
		f := newManagedWebKeyFixture(t, oauth)
		for _, path := range []string{"keys/7", "keys/7/reveal", "keys/export", "app/keys", "auth/me", "keys/../keys", "keys/", "keys?include_key=true", "keys?page=1&page=2", "keys%2f7", "keys\\7", "keys;reveal"} {
			if _, err := f.service.ProxyManagedWeb(context.Background(), f.session, "GET", path, nil); err == nil {
				t.Errorf("accepted %s", path)
			}
		}
		for _, method := range []string{"DELETE", "PUT", "PATCH", "HEAD"} {
			if _, err := f.service.ProxyManagedWeb(context.Background(), f.session, method, "keys", nil); err == nil {
				t.Errorf("accepted %s keys", method)
			}
		}
		if _, err := f.service.ProxyManagedWeb(context.Background(), f.session, "POST", "keys", []byte(`{"name":"fixture","group_id":3,"key":"injected"}`)); err == nil {
			t.Fatal("accepted arbitrary key creation fields")
		}
		if f.keys.Load() != 0 || f.login.Load() != 0 {
			t.Fatal("rejected proxy route reached upstream")
		}
	}
}

func TestManagedWebKeyRevealUsesFreshBoundProof(t *testing.T) {
	for _, oauth := range []bool{false, true} {
		f := newManagedWebKeyFixture(t, oauth)
		original := copySession(f.session)
		w := f.request("POST", "/api/managed-provider-keys/7/reveal", `{"password":"proof-password"}`)
		if w.Code != 200 || w.Body.String() != `{"key":"sk-private-seven"}`+"\n" {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "no-store" || len(w.Result().Cookies()) != 0 || f.login.Load() != 1 || f.keys.Load() != 1 || f.cleanup.Load() != 1 {
			t.Fatal("reveal lost its proof/privacy contract")
		}
		current, err := f.store.GetSession(context.Background(), f.session.ID)
		if err != nil || !reflect.DeepEqual(current, original) {
			t.Fatal("proof replaced the account OAuth/password session")
		}
		w = f.request("POST", "/api/managed-provider-keys/8/reveal", `{"password":"proof-password"}`)
		if w.Code != 404 || strings.Contains(w.Body.String(), "sk-private-seven") {
			t.Fatal("proof revealed a different key ID")
		}
		if f.login.Load() != 2 {
			t.Fatal("password proof was reused across operations")
		}
	}
}

func TestManagedWebKeyRevealFailuresCleanCredentials(t *testing.T) {
	for _, tc := range []struct {
		mode     string
		status   int
		cleanups int32
	}{{"wrong", 403, 1}, {"foreign", 403, 1}, {"incomplete", 403, 1}, {"malformed-user", 403, 1}, {"cleanup-failed", 502, 1}, {"reflect-session", 403, 0}} {
		t.Run(tc.mode, func(t *testing.T) {
			f := newManagedWebKeyFixture(t, true)
			f.passwordMode = tc.mode
			w := f.request("POST", "/api/managed-provider-keys/7/reveal", `{"password":"proof-password"}`)
			if w.Code != tc.status || f.cleanup.Load() != tc.cleanups || f.keys.Load() != 0 {
				t.Fatalf("status=%d cleanups=%d keys=%d", w.Code, f.cleanup.Load(), f.keys.Load())
			}
			for _, secret := range []string{"temporary-proof-access", "temporary-proof-refresh", "sk-private-seven", f.session.RefreshToken} {
				if strings.Contains(w.Body.String(), secret) {
					t.Fatal("failed proof exposed a credential")
				}
			}
			if _, err := f.store.GetSession(context.Background(), f.session.ID); err != nil {
				t.Fatal("proof failure revoked original OAuth session")
			}
		})
	}
}

func TestManagedWebKeyRevealRejectsForgedProofAndOrigin(t *testing.T) {
	f := newManagedWebKeyFixture(t, true)
	for _, body := range []string{`{"password":"proof-password","verified":true}`, `{"password":"proof-password","key":"sk-injected"}`, `{"password":""}`, `{"password":"proof-password"} {}`} {
		w := f.request("POST", "/api/managed-provider-keys/7/reveal", body)
		if w.Code != 400 && w.Code != 403 {
			t.Fatalf("forged proof status=%d", w.Code)
		}
	}
	r := httptest.NewRequest("POST", "/api/managed-provider-keys/7/reveal", strings.NewReader(`{"password":"proof-password"}`))
	r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: f.session.ID})
	r.Header.Set("Origin", "https://foreign.invalid")
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Code != 403 || f.login.Load() != 0 {
		t.Fatal("cross-origin or forged proof reached upstream")
	}
}

func TestManagedWebKeyRevealLogoutAndRefreshRaces(t *testing.T) {
	for _, phase := range []string{"password", "key", "refresh"} {
		t.Run(phase, func(t *testing.T) {
			f := newManagedWebKeyFixture(t, true)
			change := func() {
				if phase == "refresh" {
					updated := copySession(f.session)
					updated.AccessToken = "rotated-account-access"
					updated.RefreshToken = "rotated-account-refresh"
					if err := f.store.PutSession(context.Background(), updated); err != nil {
						t.Error(err)
					}
				} else if err := f.store.DeleteSession(context.Background(), f.session.ID); err != nil {
					t.Error(err)
				}
			}
			if phase == "password" {
				f.onLogin = change
			} else {
				f.onKeys = change
			}
			w := f.request("POST", "/api/managed-provider-keys/7/reveal", `{"password":"proof-password"}`)
			expected := 401
			if phase == "refresh" {
				expected = 409
			}
			if w.Code != expected || strings.Contains(w.Body.String(), "sk-private-seven") || f.cleanup.Load() != 1 {
				t.Fatalf("late proof escaped session generation: status=%d", w.Code)
			}
		})
	}
}
