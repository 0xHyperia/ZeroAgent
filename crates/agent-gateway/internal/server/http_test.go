package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/config"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/shared"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/proto"
)

func TestDesktopControllerWebSocketAuthenticatesWithoutGatewayCookie(t *testing.T) {
	usa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/api/v1/auth/me" || (r.Header.Get("Authorization") != "Bearer desktop-access" && r.Header.Get("Authorization") != "Bearer refreshed-desktop-access") {
			http.NotFound(w, r)
			return
		}
		_, _ = fmt.Fprint(w, `{"code":0,"message":"success","data":{"id":7,"email":"desktop@example.com"}}`)
	}))
	defer usa.Close()

	store := account.NewMemoryStore()
	accounts := account.NewService(
		store,
		account.NewUSAClientWithHTTPClient(usa.URL, usa.Client()),
		time.Hour,
		time.Hour,
	)
	desktop, err := accounts.DesktopSession(context.Background(), "desktop-access")
	if err != nil {
		t.Fatal(err)
	}
	// A desktop selection must survive an access-token refresh. The lease is
	// account-owned, whereas DesktopSession.ID is intentionally token-derived.
	refreshedDesktop, err := accounts.DesktopSession(context.Background(), "refreshed-desktop-access")
	if err != nil {
		t.Fatal(err)
	}
	if desktop.ID == refreshedDesktop.ID {
		t.Fatal("expected refreshed access token to receive a new desktop session ID")
	}
	device, _, err := accounts.RegisterDevice(context.Background(), desktop.UserID, account.RegisterDeviceInput{
		InstallationID: "desktop-controller-device",
		Name:           "Desktop controller target",
		Platform:       "windows",
		Version:        "1.0.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetDevicePresence(context.Background(), device.ID, true, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	lease, err := accounts.SelectTarget(context.Background(), desktop, account.SelectTargetInput{
		RuntimeKind: account.RuntimeKindDeviceAgent,
		DeviceID:    device.ID,
		Scope:       account.SelectionScopeDevice,
		Target:      account.TargetFingerprint(account.RuntimeKindDeviceAgent, device.ID, ""),
	})
	if err != nil {
		t.Fatal(err)
	}

	ts := httptest.NewServer(NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager(), accounts))
	defer ts.Close()
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws/v2"
	dialer := websocket.Dialer{Subprotocols: []string{"liveagent.v2.pb"}}
	conn, _, err := dialer.Dial(wsURL, http.Header{"Origin": []string{ts.URL}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	hello := &gatewayv2.WebClientFrame{
		RequestId: "auth-desktop-controller",
		Payload: &gatewayv2.WebClientFrame_Hello{Hello: &gatewayv2.ClientHello{
			ProtocolVersion: 2,
			Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
			Token:           "refreshed-desktop-access",
			SelectionLease:  lease.ID,
			RuntimeKind:     string(account.RuntimeKindDeviceAgent),
			ClientName:      "desktop-controller",
		}},
	}
	data, err := proto.Marshal(hello)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
		t.Fatal(err)
	}
	_, responseData, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var response gatewayv2.WebServerFrame
	if err := proto.Unmarshal(responseData, &response); err != nil {
		t.Fatal(err)
	}
	if !response.GetHello().GetOk() {
		t.Fatalf("desktop controller hello rejected: %q", response.GetHello().GetMessage())
	}
}

func TestNewHTTPServerServesRootWithoutRedirect(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager(), nil)

	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rec.Code)
	}
	if location := rec.Header().Get("Location"); location != "" {
		t.Fatalf("expected no redirect location, got %q", location)
	}
	if !strings.Contains(rec.Body.String(), "<title>ZeroAgent</title>") {
		t.Fatalf("expected WebUI index.html, got body %q", rec.Body.String())
	}
	if cacheControl := rec.Header().Get("Cache-Control"); !strings.Contains(cacheControl, "no-store") {
		t.Fatalf("Cache-Control = %q, want no-store for index.html", cacheControl)
	}
}

func TestNewHTTPServerServesSpaFallbackWithoutRedirect(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager(), nil)

	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/history/session-123", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rec.Code)
	}
	if location := rec.Header().Get("Location"); location != "" {
		t.Fatalf("expected no redirect location, got %q", location)
	}
	if !strings.Contains(rec.Body.String(), "<title>ZeroAgent</title>") {
		t.Fatalf("expected WebUI index.html, got body %q", rec.Body.String())
	}
}

func TestNewHTTPServerDoesNotFallbackMissingStaticAssetsToIndex(t *testing.T) {
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager(), nil)

	for _, target := range []string{
		"http://gateway.test/assets/missing-module.js",
		"http://gateway.test/assets/missing-style.css",
		"http://gateway.test/missing-icon.svg",
	} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want %d", target, rec.Code, http.StatusNotFound)
		}
		if strings.Contains(rec.Body.String(), "<title>ZeroAgent</title>") {
			t.Fatalf("%s returned SPA index fallback for a missing static asset", target)
		}
		if contentType := rec.Header().Get("Content-Type"); strings.Contains(contentType, "text/html") {
			t.Fatalf("%s Content-Type = %q, want non-html 404", target, contentType)
		}
	}
}

func TestWebSocketRejectsForeignOrigin(t *testing.T) {
	ts := httptest.NewServer(NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager(), nil))
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws/v2"
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{
		"Origin": []string{"https://evil.example"},
	})
	if err == nil {
		_ = conn.Close()
		t.Fatal("expected websocket handshake with foreign origin to be rejected")
	}
	if resp == nil {
		t.Fatalf("expected forbidden websocket response, got nil response and error %v", err)
	}
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("websocket response status = %d, want %d", resp.StatusCode, http.StatusForbidden)
	}
}

func TestPublicHistoryShareResolvesWithoutAuthorization(t *testing.T) {
	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot("desktop-agent"))
	sm.SetSession(agentSession)

	handler := NewHTTPServer(&config.Config{
		Token:          "dev-token",
		RequestTimeout: time.Second,
	}, sm, nil)
	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/api/public/history-shares/share-token", nil)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(done)
	}()

	var outbound *gatewayv2.GatewayEnvelope
	select {
	case delivered := <-agentSession.Outbound():
		delivered.Ack(nil)
		outbound = delivered.GatewayEnvelope
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for public share request")
	}
	shareReq := outbound.GetHistoryShareResolve()
	if shareReq == nil {
		t.Fatalf("public share outbound payload = %T, want HistoryShareResolveRequest", outbound.GetPayload())
	}
	if shareReq.GetToken() != "share-token" {
		t.Fatalf("public share token = %q", shareReq.GetToken())
	}

	sm.DispatchFromAgent("desktop-agent", &gatewayv2.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.AgentEnvelope_HistoryShareResolveResp{
			HistoryShareResolveResp: &gatewayv2.HistoryShareResolveResponse{
				ConversationId:    "conversation-1",
				MessagesJson:      `[{"role":"user","content":"hello"}]`,
				TotalMessageCount: 1,
				RedactToolContent: true,
				Conversation: &gatewayv2.ConversationSummary{
					Id:           "conversation-1",
					Title:        "Shared conversation",
					CreatedAt:    10,
					UpdatedAt:    11,
					MessageCount: 1,
				},
			},
		},
	})

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for public share response")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d body %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode public share payload: %v", err)
	}
	if payload["conversation_id"] != "conversation-1" ||
		payload["messages_json"] != `[{"role":"user","content":"hello"}]` ||
		payload["total_message_count"] != float64(1) ||
		payload["redact_tool_content"] != true {
		t.Fatalf("public share payload = %#v", payload)
	}
}

func TestPublicHistoryShareReturnsNotFoundForDisabledToken(t *testing.T) {
	status := publicHistoryShareErrorStatusForTest(t, http.StatusNotFound, "分享链接不存在或已关闭")
	if status != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d", http.StatusNotFound, status)
	}
}

func TestPublicHistoryShareReturnsBadRequestFromAgentCode(t *testing.T) {
	status := publicHistoryShareErrorStatusForTest(t, http.StatusBadRequest, "分享 token 不能为空")
	if status != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, status)
	}
}

func TestPublicHistoryShareDoesNotInferStatusFromLegacyMessage(t *testing.T) {
	status := publicHistoryShareErrorStatusForTest(t, http.StatusInternalServerError, "分享链接不存在或已关闭")
	if status != http.StatusBadGateway {
		t.Fatalf("expected status %d, got %d", http.StatusBadGateway, status)
	}
}

func publicHistoryShareErrorStatusForTest(t *testing.T, code int, message string) int {
	t.Helper()

	sm := session.NewManager()
	sm.RecordAuthentication("desktop-agent", "0.9.0", "session-1")
	agentSession := session.NewAgentSession(sm.LatestAuthSnapshot("desktop-agent"))
	sm.SetSession(agentSession)

	handler := NewHTTPServer(&config.Config{
		Token:          "dev-token",
		RequestTimeout: time.Second,
	}, sm, nil)
	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/api/public/history-shares/disabled-token", nil)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		handler.ServeHTTP(rec, req)
		close(done)
	}()

	var outbound *gatewayv2.GatewayEnvelope
	select {
	case delivered := <-agentSession.Outbound():
		delivered.Ack(nil)
		outbound = delivered.GatewayEnvelope
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for public share request")
	}

	sm.DispatchFromAgent("desktop-agent", &gatewayv2.AgentEnvelope{
		RequestId: outbound.GetRequestId(),
		Timestamp: time.Now().Unix(),
		Payload: &gatewayv2.AgentEnvelope_Error{
			Error: &gatewayv2.ErrorResponse{
				Code:    int32(code),
				Message: message,
			},
		},
	})

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for public share response")
	}
	return rec.Code
}

func TestPublicHistoryShareReturnsUnavailableWhenAgentOffline(t *testing.T) {
	handler := NewHTTPServer(&config.Config{
		Token:          "dev-token",
		RequestTimeout: time.Second,
	}, session.NewManager(), nil)

	req := httptest.NewRequest(http.MethodGet, "http://gateway.test/api/public/history-shares/share-token", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected status %d, got %d body %s", http.StatusServiceUnavailable, rec.Code, rec.Body.String())
	}
}

func TestOriginAllowedRequiresStrictOriginForPublicHosts(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://gateway.test:8080/api/chat/commands", nil)
	req.Header.Set("Origin", "http://gateway.test:5173")

	if shared.OriginAllowed(req) {
		t.Fatal("expected same hostname with different public port to be rejected")
	}
}

func TestOriginAllowedPermitsLoopbackDevPorts(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8080/api/chat/commands", nil)
	req.Header.Set("Origin", "http://localhost:5173")

	if !shared.OriginAllowed(req) {
		t.Fatal("expected loopback development origins to be allowed across ports")
	}
}

func TestOriginAllowedPermitsLoopbackDesktopAgainstRemoteGateway(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://172.16.0.121:50052/api/chat/commands", nil)
	req.Header.Set("Origin", "http://localhost:2120")

	if !shared.OriginAllowed(req) {
		t.Fatal("expected local desktop origin to be allowed against a remote Gateway")
	}
}

func TestOriginAllowedUsesForwardedProtoForSameOrigin(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "http://gateway.test/api/chat/commands", nil)
	req.Host = "gateway.test"
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("Origin", "https://gateway.test")

	if !shared.OriginAllowed(req) {
		t.Fatal("expected forwarded https origin to be allowed")
	}
}
