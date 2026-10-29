package account

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func passwordVerificationFixture(t *testing.T, login http.HandlerFunc) (*Service, *MemoryStore, http.Handler, *Session) {
	t.Helper()
	usa := httptest.NewServer(login)
	t.Cleanup(usa.Close)
	store := NewMemoryStore()
	service := NewService(store, NewUSAClientWithHTTPClient(usa.URL, usa.Client()), time.Hour, time.Hour)
	session := &Session{
		ID: "existing-oauth-session", UserID: 7, User: json.RawMessage(`{"id":7,"email":"a@example.test"}`),
		AccessToken: "existing-oauth-access", RefreshToken: "existing-oauth-refresh",
		AuthKind: AuthKindOAuth, OAuthClientID: "zeroagent-web", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour),
	}
	if err := store.PutSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewHTTPHandler(service, true).Register(mux)
	return service, store, mux, session
}

func TestPasswordVerificationPreservesOAuthSession(t *testing.T) {
	for _, tc := range []struct {
		name, password, email, owner, cookie string
		status, upstreamCalls                int
	}{
		{"accepted", "correct", "a@example.test", "7", "existing-oauth-session", 200, 1},
		{"password accepted awaiting MFA", "requires-2fa", "a@example.test", "7", "existing-oauth-session", 200, 1},
		{"wrong password", "wrong", "a@example.test", "7", "existing-oauth-session", 403, 1},
		{"different upstream identity", "different-user", "a@example.test", "7", "existing-oauth-session", 403, 1},
		{"unavailable", "unavailable", "a@example.test", "7", "existing-oauth-session", 502, 1},
		{"another email", "correct", "b@example.test", "7", "existing-oauth-session", 403, 0},
		{"stale account assertion", "correct", "a@example.test", "8", "existing-oauth-session", 409, 0},
		{"missing cookie", "correct", "a@example.test", "7", "", 401, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			var cleanups atomic.Int32
			_, store, handler, original := passwordVerificationFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/auth/logout" {
					cleanups.Add(1)
					var input struct {
						RefreshToken string `json:"refresh_token"`
					}
					if json.NewDecoder(r.Body).Decode(&input) != nil || input.RefreshToken != "temporary-refresh-token" {
						t.Error("password proof cleaned the wrong credential")
					}
					_, _ = io.WriteString(w, `{"code":0,"data":{}}`)
					return
				}
				calls.Add(1)
				var input struct{ Email, Password string }
				if r.URL.Path != "/api/v1/auth/login" || json.NewDecoder(r.Body).Decode(&input) != nil || input.Email != "a@example.test" {
					t.Error("verification did not use the current account's email")
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				switch input.Password {
				case "wrong":
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = io.WriteString(w, `{"code":1,"message":"do-not-echo-upstream-secret"}`)
				case "unavailable":
					w.WriteHeader(http.StatusServiceUnavailable)
					_, _ = io.WriteString(w, `{"message":"do-not-echo-upstream-secret"}`)
				case "requires-2fa":
					_, _ = io.WriteString(w, `{"code":0,"data":{"requires_2fa":true,"temp_token":"temporary-verification-token"}}`)
				case "different-user":
					_, _ = io.WriteString(w, `{"code":0,"data":{"access_token":"temporary-verification-token","user":{"id":8,"email":"b@example.test"}}}`)
				default:
					_, _ = io.WriteString(w, `{"code":0,"data":{"access_token":"temporary-verification-token","refresh_token":"temporary-refresh-token","expires_in":3600,"user":{"id":7,"email":"a@example.test"}}}`)
				}
			})
			body, _ := json.Marshal(map[string]string{"email": tc.email, "password": tc.password})
			req := httptest.NewRequest(http.MethodPost, "/api/auth/verify-password", strings.NewReader(string(body)))
			if tc.cookie != "" {
				req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: tc.cookie})
			}
			req.Header.Set("X-ZeroAgent-Account-ID", tc.owner)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != tc.status || len(rec.Result().Cookies()) != 0 || int(calls.Load()) != tc.upstreamCalls {
				t.Fatalf("status=%d cookies=%d upstream calls=%d", rec.Code, len(rec.Result().Cookies()), calls.Load())
			}
			if tc.name == "accepted" && cleanups.Load() != 1 {
				t.Fatal("temporary password refresh was not cleaned")
			}
			for _, forbidden := range []string{"temporary-verification-token", "temporary-refresh-token", "do-not-echo-upstream-secret"} {
				if strings.Contains(rec.Body.String(), forbidden) {
					t.Fatal("verification response exposed upstream details")
				}
			}
			current, err := store.GetSession(context.Background(), original.ID)
			if err != nil || !reflect.DeepEqual(current, original) {
				t.Fatal("password proof changed the existing OAuth session")
			}
		})
	}
}

func TestPasswordVerificationRejectsRevocationDuringProof(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	_, store, handler, original := passwordVerificationFixture(t, func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		_, _ = io.WriteString(w, `{"code":0,"data":{"access_token":"temporary-verification-token","user":{"id":7,"email":"a@example.test"}}}`)
	})
	t.Cleanup(unblock)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/verify-password", strings.NewReader(`{"email":"a@example.test","password":"fixture-password"}`))
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: original.ID})
	req.Header.Set("X-ZeroAgent-Account-ID", "7")
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { handler.ServeHTTP(rec, req); close(done) }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("password proof did not reach USA-Zero")
	}
	if err := store.DeleteSession(context.Background(), original.ID); err != nil {
		t.Fatal(err)
	}
	unblock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("password proof did not finish")
	}
	if rec.Code != http.StatusUnauthorized || len(rec.Result().Cookies()) != 0 || strings.Contains(rec.Body.String(), "temporary-verification-token") {
		t.Fatal("revoked password proof approved or changed a cookie")
	}
}
