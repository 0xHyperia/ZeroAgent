package account

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestWebSettingsPersistEveryAdvertisedReasoningLevelAndRejectForeignOrigin(t *testing.T) {
	_, store, handler := newAccountTestRuntime(t)
	now := time.Now()
	for id, user := range map[string]int64{"reasoning-one": 1, "reasoning-two": 2} {
		if err := store.PutSession(context.Background(), &Session{ID: id, UserID: user, User: json.RawMessage(fmt.Sprintf(`{"id":%d}`, user)), AccessToken: "synthetic-access-only", AccessExpiresAt: now.Add(time.Hour), SessionExpiresAt: now.Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
	}
	request := func(method, session, effort, origin string) *httptest.ResponseRecorder {
		var body string
		if method == http.MethodPatch {
			body = fmt.Sprintf(`{"model":"test-model","reasoning_effort":%q}`, effort)
		}
		r := httptest.NewRequest(method, "/api/web-settings", strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: session})
		r.Header.Set("Content-Type", "application/json")
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, effort := range []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"} {
		if result := request(http.MethodPatch, "reasoning-one", effort, ""); result.Code != 200 {
			t.Fatalf("effort=%s status=%d", effort, result.Code)
		}
		read := request(http.MethodGet, "reasoning-one", "", "")
		if read.Code != 200 || !strings.Contains(read.Body.String(), `"reasoning_effort":"`+effort+`"`) {
			t.Fatalf("saved reasoning not returned: %s", effort)
		}
	}
	for _, effort := range []string{"", "off", "invented"} {
		if request(http.MethodPatch, "reasoning-one", effort, "").Code != 400 {
			t.Fatal("unsupported reasoning accepted")
		}
	}
	if request(http.MethodPatch, "reasoning-one", "low", "https://foreign.invalid").Code != 403 {
		t.Fatal("foreign settings mutation accepted")
	}
	if !strings.Contains(request(http.MethodGet, "reasoning-one", "", "").Body.String(), `"reasoning_effort":"max"`) {
		t.Fatal("rejected input overwrote saved reasoning")
	}
	if !strings.Contains(request(http.MethodGet, "reasoning-two", "", "").Body.String(), `"reasoning_effort":"medium"`) {
		t.Fatal("reasoning settings leaked across accounts")
	}
}
