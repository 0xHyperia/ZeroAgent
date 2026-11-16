package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
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

func TestDeviceImageAccountLeaseAndStream(t *testing.T) {
	ctx := t.Context()
	store := account.NewMemoryStore()
	accounts := account.NewService(store, nil, time.Hour, time.Hour)
	for _, viewer := range []*account.Session{{ID: "viewer", UserID: 7}, {ID: "another-account", UserID: 9}} {
		viewer.AccessToken = "fixture"
		viewer.AccessExpiresAt = time.Now().Add(time.Hour)
		viewer.SessionExpiresAt = viewer.AccessExpiresAt
		if err := store.PutSession(ctx, viewer); err != nil {
			t.Fatal(err)
		}
	}
	device, token, err := accounts.RegisterDevice(ctx, 7, account.RegisterDeviceInput{
		InstallationID: "image-fixture", Name: "Image fixture", Platform: "windows", Version: "1",
	})
	if err != nil {
		t.Fatal(err)
	}
	bearer := func(id, scope, workspace string) string {
		if err := store.PutSelectionLease(ctx, &account.SelectionLease{
			ID: id, ControllerID: "viewer", UserID: 7, AgentID: device.ID, DeviceID: device.ID,
			RuntimeKind: account.RuntimeKindDeviceAgent, Scope: scope, WorkspaceID: workspace,
			ExpiresAt: time.Now().Add(time.Hour),
		}); err != nil {
			t.Fatal(err)
		}
		payload, _ := json.Marshal(selectionCredentialPayload{
			Lease: id, RuntimeKind: account.RuntimeKindDeviceAgent, DeviceID: device.ID,
			AgentID: device.ID, WorkspaceID: workspace,
		})
		return "Bearer selection." + base64.RawURLEncoding.EncodeToString(payload)
	}
	selected := bearer("image-selection", account.SelectionScopeDevice, "")
	workspace := bearer("image-project", account.SelectionScopeWorkspace, "project")
	handler := NewHTTPServer(&config.Config{RequestTimeout: time.Second}, session.NewManager(), accounts)
	defer handler.(*httpHandler).Close()
	server := httptest.NewServer(handler)
	defer server.Close()

	request := func(method, path, viewer, credential, payload string) *http.Request {
		req, err := http.NewRequestWithContext(ctx, method, server.URL+"/api/image/"+path, strings.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(&http.Cookie{Name: account.SessionCookieName, Value: viewer})
		req.Header.Set("Authorization", credential)
		req.Header.Set(imageAccountHeader, "9")
		return req
	}
	for _, check := range []struct {
		path, viewer, credential string
		status                   int
	}{
		{"identity", "another-account", selected, 401},
		{"identity", "viewer", workspace, 403},
		{"jobs?backendId=another-device", "viewer", selected, 403},
		{"secrets?backendId=" + device.ID, "viewer", selected, 404},
		{"jobs?backendId=" + device.ID, "viewer", selected, 502},
	} {
		resp, err := server.Client().Do(request("GET", check.path, check.viewer, check.credential, ""))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != check.status {
			t.Errorf("%s for %s returned %d, want %d", check.path, check.viewer, resp.StatusCode, check.status)
		}
	}
	identity, err := server.Client().Do(request("GET", "identity", "viewer", selected, ""))
	if err != nil {
		t.Fatal(err)
	}
	var resolved map[string]string
	err = json.NewDecoder(identity.Body).Decode(&resolved)
	identity.Body.Close()
	if identity.StatusCode != 200 || err != nil || resolved["ownerId"] != "7" ||
		resolved["backendId"] != device.ID || resolved["mode"] != "device" {
		t.Fatalf("unexpected image identity: %+v", resolved)
	}

	dialer := websocket.Dialer{Subprotocols: []string{"liveagent.v2.pb"}}
	agent, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws/v2/agent", http.Header{"Origin": {server.URL}})
	if err != nil {
		t.Fatal(err)
	}
	defer agent.Close()
	send := func(frame *v2.AgentClientFrame) error {
		data, err := proto.Marshal(frame)
		if err != nil {
			return err
		}
		return agent.WriteMessage(websocket.BinaryMessage, data)
	}
	read := func() (*v2.AgentServerFrame, error) {
		_ = agent.SetReadDeadline(time.Now().Add(8 * time.Second))
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
	if hello, err := read(); err != nil || !hello.GetHello().GetOk() {
		t.Fatalf("device authentication failed: %v %v", hello, err)
	}
	// Buffered response and live SSE go through the same selected device. The
	// fake device never invokes a provider.
	cancelled := make(chan bool, 1)
	const payload = `{"prompt":"fixture"}`
	const imageBytes = "\x89PNG\r\n\x1a\n\x00\xff"
	go func() {
		var path string
		var body string
		reply := func(frame *v2.TunnelFrame) bool {
			return send(&v2.AgentClientFrame{Payload: &v2.AgentClientFrame_Envelope{Envelope: &v2.AgentEnvelope{
				RequestId: frame.StreamId, Payload: &v2.AgentEnvelope_TunnelFrame{TunnelFrame: frame},
			}}}) == nil
		}
		for {
			message, err := read()
			if err != nil {
				cancelled <- false
				return
			}
			frame := message.GetEnvelope().GetTunnelFrame()
			switch frame.GetKind() {
			case v2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_START:
				path, body = frame.Path, ""
				if frame.TargetUrl != "" || !strings.HasPrefix(frame.StreamId, "image-") {
					t.Error("image request included a generic proxy target")
				}
				if frame.GetHeaders()[0].GetValue() != "7" {
					t.Error("forged image owner reached the device")
				}
				if path == "/api/image/jobs" && (len(frame.Headers) != 2 || frame.Headers[1].Value != "same-job") {
					t.Error("idempotency key did not reach the device")
				}
			case v2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_BODY:
				body += string(frame.Body)
			case v2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_END:
				contentType, response := "application/json", `{"job":"image-job"}`
				stream := strings.HasSuffix(path, "/events")
				if stream {
					contentType, response = "text/event-stream", "id: 1\ndata: {}\n\n"
				} else if path == "/api/image/assets/image-id/content?variant=thumbnail" {
					contentType, response = "image/png", imageBytes
				} else if path != "/api/image/jobs" || body != payload {
					t.Error("job request changed in transit")
				}
				if !reply(&v2.TunnelFrame{StreamId: frame.StreamId, Kind: v2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_START,
					Status: 200, Headers: []*v2.TunnelHeader{{Name: "Content-Type", Value: contentType}}}) ||
					!reply(&v2.TunnelFrame{StreamId: frame.StreamId, Kind: v2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_BODY, Body: []byte(response)}) ||
					!stream && !reply(&v2.TunnelFrame{StreamId: frame.StreamId, Kind: v2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_END}) {
					cancelled <- false
					return
				}
			case v2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL:
				cancelled <- strings.HasSuffix(path, "/events")
				return
			}
		}
	}()
	job := request("POST", "jobs?backendId="+device.ID, "viewer", selected, payload)
	job.Header.Set("Idempotency-Key", "same-job")
	completed, err := server.Client().Do(job)
	if err != nil {
		t.Fatal(err)
	}
	result, err := io.ReadAll(completed.Body)
	completed.Body.Close()
	if completed.StatusCode != 200 || err != nil || string(result) != `{"job":"image-job"}` {
		t.Fatalf("job response failed: %s %v", result, err)
	}
	asset, err := server.Client().Do(request("GET", "assets/image-id/content?variant=thumbnail&backendId="+device.ID, "viewer", selected, ""))
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(asset.Body)
	asset.Body.Close()
	if asset.StatusCode != 200 || asset.Header.Get("Content-Type") != "image/png" || err != nil || string(data) != imageBytes {
		t.Fatalf("image download failed: status %d, content type %q, data %x, error %v", asset.StatusCode, asset.Header.Get("Content-Type"), data, err)
	}
	events, err := server.Client().Do(request("GET", "jobs/image-job/events?backendId="+device.ID, "viewer", selected, ""))
	if err != nil {
		t.Fatal(err)
	}
	defer events.Body.Close()
	if got := events.Header.Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("got event content type %q", got)
	}
	expected := "id: 1\ndata: {}\n\n"
	event := make([]byte, len(expected))
	if _, err := io.ReadFull(events.Body, event); err != nil || string(event) != expected {
		t.Fatalf("event was not streamed: %q %v", event, err)
	}
	if err := store.DeleteSession(context.Background(), "viewer"); err != nil {
		t.Fatal(err)
	}
	select {
	case ok := <-cancelled:
		if !ok {
			t.Fatal("device stream ended without authorization cancellation")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("device did not receive stream cancellation")
	}
}
