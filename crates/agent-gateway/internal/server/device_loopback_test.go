package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/config"
	v2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/proto"
)

func TestPrivateDeviceLoopbackAuthenticatesBothSidesAndRelaysBytes(t *testing.T) {
	ctx := context.Background()
	store := account.NewMemoryStore()
	accounts := account.NewService(store, nil, time.Hour, time.Hour)
	for _, viewer := range []*account.Session{
		{ID: "private-controller", UserID: 7, Purpose: account.DesktopDeviceHandoffPurpose},
		{ID: "same-user-web", UserID: 7},
		{ID: "other-account", UserID: 9, Purpose: account.DesktopDeviceHandoffPurpose},
	} {
		viewer.AccessToken = "fixture"
		viewer.AccessExpiresAt = time.Now().Add(time.Hour)
		viewer.SessionExpiresAt = viewer.AccessExpiresAt
		if err := store.PutSession(ctx, viewer); err != nil {
			t.Fatal(err)
		}
	}
	device, token, err := accounts.RegisterDevice(ctx, 7, account.RegisterDeviceInput{
		InstallationID: "private-fixture", Name: "Fixture", Platform: "windows", Version: "1",
	})
	if err != nil {
		t.Fatal(err)
	}
	credential := func(id, controller, scope, workspace string, deadline time.Time) string {
		t.Helper()
		if err := store.PutSelectionLease(ctx, &account.SelectionLease{
			ID: id, ControllerID: controller, UserID: 7, AgentID: device.ID, DeviceID: device.ID,
			RuntimeKind: account.RuntimeKindDeviceAgent, Scope: scope, WorkspaceID: workspace, ExpiresAt: deadline,
		}); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(selectionCredentialPayload{
			Lease: id, DeviceID: device.ID, AgentID: device.ID, RuntimeKind: account.RuntimeKindDeviceAgent, WorkspaceID: workspace,
		})
		return "Bearer selection." + base64.RawURLEncoding.EncodeToString(raw)
	}
	now := time.Now()
	valid := credential("private-valid", "private-controller", account.SelectionScopeDevice, "", now.Add(time.Hour))
	web := credential("private-web", "same-user-web", account.SelectionScopeDevice, "", now.Add(time.Hour))
	workspace := credential("private-workspace", "private-controller", account.SelectionScopeWorkspace, "chosen", now.Add(time.Hour))
	expired := credential("private-expired", "private-controller", account.SelectionScopeDevice, "", now.Add(-time.Second))
	manager := session.NewManager()
	handler := NewHTTPServer(&config.Config{RequestTimeout: time.Second}, manager, accounts)
	server := httptest.NewServer(handler)
	defer server.Close()
	defer handler.(*httpHandler).Close()
	base := "ws" + strings.TrimPrefix(server.URL, "http")
	path := base + "/api/desktop/device-loopback"
	headers := func(viewer, bearer string) http.Header {
		return http.Header{"Cookie": {account.SessionCookieName + "=" + viewer}, "Authorization": {bearer}}
	}
	for _, check := range []struct {
		path, viewer, auth, origin string
		status                     int
	}{
		{"?port=5173", "other-account", valid, "", 401},
		{"?port=5173", "same-user-web", web, "", 403},
		{"?port=5173", "private-controller", workspace, "", 403},
		{"?port=5173", "private-controller", expired, "", 401},
		{"?port=5173", "private-controller", valid, server.URL, 400},
		{"?port=22", "private-controller", valid, "", 400},
	} {
		h := headers(check.viewer, check.auth)
		if check.origin != "" {
			h.Set("Origin", check.origin)
		}
		ws, response, err := websocket.DefaultDialer.Dial(path+check.path, h)
		if ws != nil {
			ws.Close()
		}
		if response != nil {
			response.Body.Close()
		}
		if err == nil || response == nil || response.StatusCode != check.status {
			t.Fatalf("private access must be blocked for %s %s with %d, got %v %v", check.viewer, check.path, check.status, response, err)
		}
	}

	agentDialer := websocket.Dialer{Subprotocols: []string{"liveagent.v2.pb"}}
	agent, _, err := agentDialer.Dial(base+"/ws/v2/agent", http.Header{"Origin": {server.URL}})
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	send := func(frame *v2.AgentClientFrame) error {
		encoded, err := proto.Marshal(frame)
		if err != nil {
			return err
		}
		return agent.WriteMessage(websocket.BinaryMessage, encoded)
	}
	read := func() (*v2.AgentServerFrame, error) {
		_ = agent.SetReadDeadline(time.Now().Add(7 * time.Second))
		_, data, err := agent.ReadMessage()
		if err != nil {
			return nil, err
		}
		var decoded v2.AgentServerFrame
		return &decoded, proto.Unmarshal(data, &decoded)
	}
	if err := send(&v2.AgentClientFrame{Payload: &v2.AgentClientFrame_Hello{Hello: &v2.ClientHello{
		ProtocolVersion: 2, Role: v2.ClientRole_CLIENT_ROLE_AGENT, Token: token, AgentId: device.ID,
	}}}); err != nil {
		t.Fatal(err)
	}
	hello, err := read()
	if err != nil || !hello.GetHello().GetOk() {
		t.Fatalf("device authentication failed: %v %v", hello, err)
	}
	results := make(chan error, 1)
	go func() {
		reply := func(id string, kind v2.TunnelFrameKind, body []byte) error {
			return send(&v2.AgentClientFrame{Payload: &v2.AgentClientFrame_Envelope{Envelope: &v2.AgentEnvelope{
				RequestId: id, Payload: &v2.AgentEnvelope_TunnelFrame{TunnelFrame: &v2.TunnelFrame{StreamId: id, Kind: kind, Body: body}},
			}}})
		}
		for {
			message, err := read()
			if err != nil {
				results <- err
				return
			}
			frame := message.GetEnvelope().GetTunnelFrame()
			switch frame.GetKind() {
			case v2.TunnelFrameKind_TUNNEL_FRAME_KIND_PRIVATE_OPEN:
				if frame.GetTargetUrl() != "http://127.0.0.1:5173" {
					t.Errorf("unexpected private target %q", frame.GetTargetUrl())
				}
				err = reply(frame.StreamId, v2.TunnelFrameKind_TUNNEL_FRAME_KIND_PRIVATE_READY, nil)
			case v2.TunnelFrameKind_TUNNEL_FRAME_KIND_PRIVATE_DATA:
				err = reply(frame.StreamId, frame.Kind, append([]byte("device:"), frame.Body...))
			case v2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL:
				results <- nil
				return
			}
			if err != nil {
				results <- err
				return
			}
		}
	}()
	visitor, _, err := websocket.DefaultDialer.Dial(path+"?port=5173", headers("private-controller", valid))
	if err != nil {
		t.Fatal(err)
	}
	defer visitor.Close()
	if err := visitor.WriteMessage(websocket.BinaryMessage, []byte("request")); err != nil {
		t.Fatal(err)
	}
	_ = visitor.SetReadDeadline(time.Now().Add(5 * time.Second))
	kind, body, err := visitor.ReadMessage()
	if err != nil || kind != websocket.BinaryMessage || string(body) != "device:request" {
		t.Fatalf("unexpected device response %q: %v", body, err)
	}
	if len(manager.TunnelStateSnapshot(device.ID).GetTunnels()) != 0 {
		t.Fatal("private stream appeared in the public tunnel directory")
	}
	if err := store.DeleteSession(ctx, "private-controller"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := visitor.ReadMessage(); err == nil {
		t.Fatal("revoked account stream stayed open")
	}
	select {
	case err := <-results:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("device did not receive cancellation")
	}
}
