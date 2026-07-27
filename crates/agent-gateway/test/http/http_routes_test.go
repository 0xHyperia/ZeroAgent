package httproutes_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/test/testutil"
)

func newHTTPTestHandler(t *testing.T) (http.Handler, *session.Manager, *testutil.AccountFixture) {
	t.Helper()
	sm := session.NewManager()
	accountFixture := testutil.NewAccountFixture(t, sm)
	return server.NewHTTPServer(&config.Config{
		Token:          "dev-token",
		RequestTimeout: 500 * time.Millisecond,
	}, sm, accountFixture.Service), sm, accountFixture
}

func TestAPIRoutesRequireBearerToken(t *testing.T) {
	t.Parallel()

	handler, _, _ := newHTTPTestHandler(t)

	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/api/status", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
	if contentType := rec.Header().Get("Content-Type"); !strings.Contains(contentType, "application/json") {
		t.Fatalf("content-type = %q, want JSON", contentType)
	}
	if !strings.Contains(rec.Body.String(), "unauthorized") {
		t.Fatalf("body = %q, want unauthorized error", rec.Body.String())
	}
}

func TestHealthRouteIsPublic(t *testing.T) {
	t.Parallel()

	handler, _, _ := newHTTPTestHandler(t)

	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/healthz", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("body = %q, want health payload", rec.Body.String())
	}
}

func TestStatusRouteReturnsAgentDirectory(t *testing.T) {
	t.Parallel()

	handler, sm, accountFixture := newHTTPTestHandler(t)
	sm.RecordAuthentication(accountFixture.Device.ID, "0.9.0", "session-1")
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot(accountFixture.Device.ID)))

	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/api/status", nil)
	accountFixture.Authorize(req)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d, body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var payload struct {
		Agents []struct {
			Online       bool   `json:"online"`
			AgentID      string `json:"agent_id"`
			AgentVersion string `json:"agent_version"`
			SessionID    string `json:"session_id"`
		} `json:"agents"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&payload); err != nil {
		t.Fatalf("decode status payload: %v", err)
	}
	if len(payload.Agents) != 1 {
		t.Fatalf("agents = %#v, want one entry", payload.Agents)
	}
	agent := payload.Agents[0]
	if !agent.Online || agent.AgentID != accountFixture.Device.ID || agent.AgentVersion != "0.9.0" || agent.SessionID != "session-1" {
		t.Fatalf("agent = %#v, want authenticated session identity", agent)
	}
}

func TestSPAFallbackServesIndexWithoutAuthorization(t *testing.T) {
	t.Parallel()

	handler, _, _ := newHTTPTestHandler(t)

	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/conversations/session-1", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if location := rec.Header().Get("Location"); location != "" {
		t.Fatalf("expected no redirect, got Location=%q", location)
	}
	if !strings.Contains(rec.Body.String(), "<title>ZeroAgent</title>") {
		t.Fatalf("expected embedded WebUI index.html, got %q", rec.Body.String())
	}
}
