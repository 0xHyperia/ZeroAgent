package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestHTTPRefreshConsumesTokenOnceAndCannotOverwriteNewLogin(t *testing.T) {
	fixture := memorySessionRefreshFixture(t)
	platform := newRotatingAccountServer(t)
	release := make(chan struct{})
	platform.refreshRelease = release
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	session := seedRefreshingSession(t, fixture)
	service := NewService(fixture.store, platform.client(), time.Hour, time.Hour)
	mux := http.NewServeMux()
	NewHTTPHandler(service, true).Register(mux)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: session.ID})
	req.Header.Set("X-ZeroAgent-Account-ID", "7")
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { defer close(done); mux.ServeHTTP(rec, req) }()
	select {
	case <-platform.refreshEntered:
	case <-time.After(3 * time.Second):
		t.Fatal("refresh did not reach platform")
	}
	other := &Session{ID: "new-browser-login", UserID: 8, User: json.RawMessage(`{"id":8}`), AccessToken: "account-eight", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}
	if err := fixture.store.PutSession(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	unblock()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("refresh did not finish")
	}
	if rec.Code != http.StatusOK || len(rec.Result().Cookies()) != 0 || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("late refresh mutated cookie or failed: status=%d cookies=%d", rec.Code, len(rec.Result().Cookies()))
	}
	if platform.calls() != 1 {
		t.Fatalf("one HTTP refresh consumed %d tokens", platform.calls())
	}
	if _, err := fixture.store.GetSession(context.Background(), other.ID); err != nil {
		t.Fatal("new login lost")
	}
	for _, secret := range []string{"original-access", "new-access", "original-refresh", "new-refresh"} {
		if strings.Contains(rec.Body.String(), secret) {
			t.Fatal("refresh exposed credential")
		}
	}
}

func TestHTTPRefreshRejectsStaleAccountBeforeTokenUse(t *testing.T) {
	fixture := memorySessionRefreshFixture(t)
	platform := newRotatingAccountServer(t)
	session := seedRefreshingSession(t, fixture)
	service := NewService(fixture.store, platform.client(), time.Hour, time.Hour)
	service.EnableCloudWorkspace()
	mux := http.NewServeMux()
	NewHTTPHandler(service, true).Register(mux)
	for _, crossSite := range []bool{false, true} {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/refresh", nil)
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: session.ID})
		req.Header.Set("X-ZeroAgent-Account-ID", "8")
		want := http.StatusConflict
		if crossSite {
			req.Header.Set("Origin", "https://other.invalid")
			want = http.StatusForbidden
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != want || len(rec.Result().Cookies()) != 0 {
			t.Fatalf("status=%d expected=%d", rec.Code, want)
		}
	}
	if platform.calls() != 0 {
		t.Fatal("unauthorized refresh consumed one-use token")
	}
	staleRead := httptest.NewRequest(http.MethodGet, "/api/web-chat/conversations", nil)
	staleRead.AddCookie(&http.Cookie{Name: SessionCookieName, Value: session.ID})
	staleRead.Header.Set("X-ZeroAgent-Account-ID", "8")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, staleRead)
	if rec.Code != http.StatusConflict || platform.calls() != 0 {
		t.Fatal("stale read refreshed a different account before rejecting its assertion")
	}
}

func TestHTTPLogoutFailureKeepsCookieForCleanupRetryWithoutAuthority(t *testing.T) {
	fixture := memorySessionRefreshFixture(t)
	platform := newRotatingAccountServer(t)
	session := seedRefreshingSession(t, fixture)
	service := NewService(fixture.store, platform.client(), time.Hour, time.Hour)
	mux := http.NewServeMux()
	NewHTTPHandler(service, true).Register(mux)
	logout := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: session.ID})
		req.Header.Set("X-ZeroAgent-Account-ID", "7")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	platform.revokeFails.Store(true)
	first := logout()
	if first.Code != http.StatusBadGateway || len(first.Result().Cookies()) != 0 {
		t.Fatalf("cleanup failure status=%d cookies=%d", first.Code, len(first.Result().Cookies()))
	}
	if _, err := service.Session(context.Background(), session.ID); err == nil {
		t.Fatal("failed upstream cleanup restored local authority")
	}
	platform.revokeFails.Store(false)
	second := logout()
	if second.Code != http.StatusNoContent || len(second.Result().Cookies()) != 0 {
		t.Fatalf("cleanup retry status=%d", second.Code)
	}
	platform.mu.Lock()
	revokedAccess, revokedRefresh := platform.revoked[session.AccessToken], platform.revoked[session.RefreshToken]
	platform.mu.Unlock()
	if !revokedAccess || !revokedRefresh {
		t.Fatal("cleanup retry failed to revoke both app credentials")
	}
	if platform.calls() != 0 {
		t.Fatal("logout refreshed expired credentials")
	}
}
