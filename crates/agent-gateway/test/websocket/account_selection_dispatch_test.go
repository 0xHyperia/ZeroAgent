package websocket_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/liveagent/agent-gateway/internal/account"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	gatewayserver "github.com/liveagent/agent-gateway/internal/server"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/proto"
)

type selectionDispatchFixture struct {
	service    *account.Service
	store      *account.MemoryStore
	controller *account.Session
	device     *account.Device
	lease      *account.SelectionLease
}

func newSelectionDispatchFixture(t *testing.T, scope string) *selectionDispatchFixture {
	t.Helper()
	ctx := context.Background()
	store := account.NewMemoryStore()
	service := account.NewService(store, nil, time.Hour, time.Hour)
	controller := &account.Session{ID: "controller", UserID: 7, AccessToken: "synthetic", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}
	if err := store.PutSession(ctx, controller); err != nil {
		t.Fatal(err)
	}
	device, _, err := service.RegisterDevice(ctx, controller.UserID, account.RegisterDeviceInput{InstallationID: "selection-dispatch", Name: "Synthetic", Platform: "test", Version: "1"})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.UpdateAgentWorkspaces(ctx, device.ID, []account.Workspace{{ID: "workspace-1", Name: "Project", Path: "/workspace/project"}, {ID: "workspace-2", Name: "Second", Path: "/workspace/second"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SetDevicePresence(ctx, device.ID, true, time.Now()); err != nil {
		t.Fatal(err)
	}
	workspaceID := "workspace-1"
	if scope == account.SelectionScopeDevice {
		workspaceID = ""
	}
	lease, err := service.SelectTarget(ctx, controller, account.SelectTargetInput{RuntimeKind: account.RuntimeKindDeviceAgent, DeviceID: device.ID, WorkspaceID: workspaceID, Scope: scope, Target: account.TargetFingerprint(account.RuntimeKindDeviceAgent, device.ID, workspaceID)})
	if err != nil {
		t.Fatal(err)
	}
	return &selectionDispatchFixture{service, store, controller, device, lease}
}
func (f *selectionDispatchFixture) invalidate(t *testing.T, kind string) {
	t.Helper()
	ctx := context.Background()
	var err error
	switch kind {
	case "logout":
		err = f.service.Logout(ctx, f.controller.ID)
	case "lease-expiry":
		lease := *f.lease
		lease.ExpiresAt = time.Now().Add(-time.Second)
		err = f.store.PutSelectionLease(ctx, &lease)
	case "session-expiry":
		controller := *f.controller
		controller.SessionExpiresAt = time.Now().Add(-time.Second)
		err = f.store.PutSession(ctx, &controller)
	case "device-revocation":
		err = f.service.RevokeDevice(ctx, f.controller.UserID, f.device.ID)
	case "workspace-removal":
		err = f.service.UpdateAgentWorkspaces(ctx, f.device.ID, nil)
	}
	if err != nil {
		t.Fatal(err)
	}
}
func (f *selectionDispatchFixture) header() http.Header {
	return http.Header{"Cookie": []string{"zeroagent_session=" + f.controller.ID}}
}
func (f *selectionDispatchFixture) authorizeHTTP(t *testing.T, request *http.Request) {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"lease": f.lease.ID, "runtimeKind": f.lease.RuntimeKind, "agentId": f.device.ID, "workspaceId": f.lease.WorkspaceID})
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer selection."+base64.RawURLEncoding.EncodeToString(raw))
	request.AddCookie(&http.Cookie{Name: account.SessionCookieName, Value: f.controller.ID})
}
func dialSelectionDispatch(t *testing.T, handler http.Handler, headers http.Header) *websocket.Conn {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	headers.Set("Origin", server.URL)
	dialer := websocket.Dialer{Subprotocols: []string{pbws.Subprotocol}}
	conn, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), headers)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}
func selectionHello(f *selectionDispatchFixture) *gatewayv2.ClientHello {
	return &gatewayv2.ClientHello{ProtocolVersion: pbws.ProtocolVersion, Role: gatewayv2.ClientRole_CLIENT_ROLE_BROWSER, SelectionLease: f.lease.ID}
}
func requireControllerSocketClosed(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			if netErr, ok := err.(interface{ Timeout() bool }); ok && netErr.Timeout() {
				t.Fatalf("invalid controller socket stayed open: %v", err)
			}
			return
		}
	}
}
func TestAccountControllerRevalidatesBeforeDispatch(t *testing.T) {
	for _, kind := range []string{"logout", "lease-expiry", "session-expiry", "device-revocation", "workspace-removal"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newSelectionDispatchFixture(t, account.SelectionScopeWorkspace)
			sm := session.NewManager()
			sm.RecordAuthentication(fixture.device.ID, "1", "owned")
			agent := session.NewAgentSession(sm.LatestAuthSnapshot(fixture.device.ID))
			sm.SetSession(agent)
			defer agent.Close()
			gateway := pbws.NewServer(newV2TestConfig(), sm, fixture.service)
			defer gateway.Close()
			conn := dialSelectionDispatch(t, gateway.BrowserHandler(), fixture.header())
			sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{RequestId: "hello", Payload: &gatewayv2.WebClientFrame_Hello{Hello: selectionHello(fixture)}})
			if hello := receiveWebFrameRaw(t, conn).GetHello(); hello == nil || !hello.GetOk() {
				t.Fatalf("hello: %v", hello)
			}
			sendWrite := func(id string) {
				sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{RequestId: id, AgentId: fixture.device.ID, Payload: &gatewayv2.WebClientFrame_AgentRequest{AgentRequest: &gatewayv2.GatewayEnvelope{Payload: &gatewayv2.GatewayEnvelope_FsWriteText{FsWriteText: &gatewayv2.FsWriteTextRequest{Workdir: "/workspace/project", Path: "synthetic.txt", Content: "synthetic"}}}}})
			}
			sendWrite("valid")
			if readOutboundEnvelope(t, agent).GetFsWriteText() == nil {
				t.Fatal("valid write was not forwarded")
			}
			fixture.invalidate(t, kind)
			sendWrite("invalid")
			requireControllerSocketClosed(t, conn)
			select {
			case forwarded := <-agent.Outbound():
				t.Fatalf("invalid controller forwarded %T", forwarded.GetPayload())
			default:
			}
		})
	}
}
func TestAccountTerminalRevalidatesBeforeInput(t *testing.T) {
	for _, kind := range []string{"logout", "lease-expiry", "session-expiry", "device-revocation", "workspace-removal"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newSelectionDispatchFixture(t, account.SelectionScopeWorkspace)
			sm := session.NewManager()
			sm.ApplySettingsJSON(fixture.device.ID, `{"remote":{"enableWebTerminal":true}}`)
			frames := make(chan *gatewayv2.TerminalStreamFrame, 4)
			cleanup, ok := sm.RegisterTerminalStreamToAgentIfCurrent(fixture.device.ID, frames, func() {}, func() bool { return true })
			if !ok {
				t.Fatal("register terminal")
			}
			defer cleanup()
			gateway := pbws.NewServer(newV2TestConfig(), sm, fixture.service)
			defer gateway.Close()
			conn := dialSelectionDispatch(t, gateway.TerminalHandler(), fixture.header())
			send := func(frame *gatewayv2.TerminalClientFrame) {
				raw, err := proto.Marshal(frame)
				if err != nil {
					t.Fatal(err)
				}
				if err := conn.WriteMessage(websocket.BinaryMessage, raw); err != nil {
					t.Fatal(err)
				}
			}
			send(&gatewayv2.TerminalClientFrame{Payload: &gatewayv2.TerminalClientFrame_Hello{Hello: selectionHello(fixture)}})
			_, raw, err := conn.ReadMessage()
			if err != nil {
				t.Fatal(err)
			}
			var hello gatewayv2.TerminalServerFrame
			if err := proto.Unmarshal(raw, &hello); err != nil || !hello.GetHello().GetOk() {
				t.Fatalf("hello: %v %v", err, &hello)
			}
			send(&gatewayv2.TerminalClientFrame{Payload: &gatewayv2.TerminalClientFrame_Frame{Frame: &gatewayv2.TerminalStreamFrame{Kind: "attach", SessionId: "synthetic-terminal"}}})
			select {
			case <-frames:
			case <-time.After(time.Second):
				t.Fatal("valid terminal attach not forwarded")
			}
			fixture.invalidate(t, kind)
			send(&gatewayv2.TerminalClientFrame{Payload: &gatewayv2.TerminalClientFrame_Frame{Frame: &gatewayv2.TerminalStreamFrame{Kind: "input", SessionId: "synthetic-terminal", Data: []byte("synthetic")}}})
			requireControllerSocketClosed(t, conn)
			select {
			case frame := <-frames:
				t.Fatalf("invalid controller forwarded terminal %s", frame.GetKind())
			default:
			}
		})
	}
}
func TestAccountHTTPImportsRespectSelectionScope(t *testing.T) {
	cases := []struct {
		name, scope, path, workdir string
		forward                    bool
	}{
		{"workspace-own", account.SelectionScopeWorkspace, "/api/files/import", "/workspace/project", true},
		{"workspace-other", account.SelectionScopeWorkspace, "/api/files/import", "/workspace/second", false},
		{"device-other-published", account.SelectionScopeDevice, "/api/files/import", "/workspace/second", true},
		{"device-unpublished", account.SelectionScopeDevice, "/api/files/import", "/workspace/unpublished", false},
		{"workspace-project-creation", account.SelectionScopeWorkspace, "/api/files/import-directory", "", false},
		{"device-project-creation", account.SelectionScopeDevice, "/api/files/import-directory", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newSelectionDispatchFixture(t, tc.scope)
			sm := session.NewManager()
			sm.RecordAuthentication(fixture.device.ID, "1", "owned")
			agent := session.NewAgentSession(sm.LatestAuthSnapshot(fixture.device.ID))
			sm.SetSession(agent)
			defer agent.Close()
			body := new(bytes.Buffer)
			form := multipart.NewWriter(body)
			_ = form.WriteField("workdir", tc.workdir)
			_ = form.WriteField("name", "synthetic")
			_ = form.WriteField("target", "project-root")
			_ = form.WriteField("paths", "synthetic.txt")
			file, err := form.CreateFormFile("files", "synthetic.txt")
			if err != nil {
				t.Fatal(err)
			}
			_, _ = file.Write([]byte("synthetic"))
			_ = form.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req := httptest.NewRequest(http.MethodPost, "http://review.local"+tc.path, body).WithContext(ctx)
			req.Header.Set("Content-Type", form.FormDataContentType())
			fixture.authorizeHTTP(t, req)
			recorder := httptest.NewRecorder()
			handler := gatewayserver.NewHTTPServer(newV2TestConfig(), sm, fixture.service)
			if !tc.forward {
				handler.ServeHTTP(recorder, req)
				if recorder.Code != http.StatusForbidden {
					t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
				}
				select {
				case env := <-agent.Outbound():
					t.Fatalf("outside selection forwarded %T", env.GetPayload())
				default:
				}
				return
			}
			done := make(chan struct{})
			go func() { defer close(done); handler.ServeHTTP(recorder, req) }()
			select {
			case env := <-agent.Outbound():
				if tc.path == "/api/files/import" && env.GetUploadReadableFiles() == nil {
					t.Fatalf("unexpected %T", env.GetPayload())
				}
				if tc.path == "/api/files/import-directory" && env.GetImportDirectory() == nil {
					t.Fatalf("unexpected %T", env.GetPayload())
				}
				env.Ack(nil)
			case <-time.After(time.Second):
				t.Fatal("valid import was not forwarded")
			}
			agent.Close()
			cancel()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("request cleanup timed out")
			}
		})
	}
}

func TestAccountWorkspaceHandoffKeepsBytesAndScope(t *testing.T) {
	fixture := newSelectionDispatchFixture(t, account.SelectionScopeWorkspace)
	sm := session.NewManager()
	sm.RecordAuthentication(fixture.device.ID, "1", "owned")
	agent := session.NewAgentSession(sm.LatestAuthSnapshot(fixture.device.ID))
	sm.SetSession(agent)
	defer agent.Close()
	handler := gatewayserver.NewHTTPServer(newV2TestConfig(), sm, fixture.service)
	id := "c1e38fb0-5387-4e4b-9802-ebaeecbfcc96"
	data := []byte{0x00, 0xFF, 0x03}
	request := func(workspace string) *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/api/files/handoff?workspace_id="+workspace+"&name=fixture.pdf&operation_id="+id, bytes.NewReader(data))
		fixture.authorizeHTTP(t, req)
		return req
	}

	rejected := httptest.NewRecorder()
	handler.ServeHTTP(rejected, request("workspace-2"))
	if rejected.Code != http.StatusForbidden {
		t.Fatalf("outside selection: %d", rejected.Code)
	}
	select {
	case env := <-agent.Outbound():
		t.Fatalf("outside selection forwarded %T", env.GetPayload())
	default:
	}

	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		handler.ServeHTTP(recorder, request("workspace-1"))
	}()
	path := "ZA-" + id + "/ZA-fixture.pdf"
	select {
	case env := <-agent.Outbound():
		handoff := env.GetWorkspaceHandoff()
		if handoff == nil || handoff.GetOperationId() != id || handoff.GetWorkspaceId() != "workspace-1" || !bytes.Equal(handoff.GetContent(), data) {
			t.Fatalf("incorrect workspace transfer: %v", handoff)
		}
		env.Ack(nil)
		sm.DispatchFromAgentForSession(agent, &gatewayv2.AgentEnvelope{
			RequestId: env.GetRequestId(),
			Payload: &gatewayv2.AgentEnvelope_WorkspaceHandoffResp{WorkspaceHandoffResp: &gatewayv2.WorkspaceHandoffResponse{
				RelativePath: path,
			}},
		})
	case <-time.After(time.Second):
		t.Fatal("handoff was not forwarded")
	}
	select {
	case <-done:
		if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), path) {
			t.Fatalf("incorrect handoff receipt: %d %s", recorder.Code, recorder.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("handoff receipt timed out")
	}
}

func TestAccountDeviceScheduleSummaryIsScopedAndRedacted(t *testing.T) {
	fixture := newSelectionDispatchFixture(t, account.SelectionScopeWorkspace)
	sm := session.NewManager()
	sm.RecordAuthentication(fixture.device.ID, "1", "owned")
	agent := session.NewAgentSession(sm.LatestAuthSnapshot(fixture.device.ID))
	sm.SetSession(agent)
	defer agent.Close()
	handler := gatewayserver.NewHTTPServer(newV2TestConfig(), sm, fixture.service)
	request := func(id string) *http.Request {
		req := httptest.NewRequest(http.MethodGet, "/api/web-chat/device-schedules/"+id, nil)
		req.AddCookie(&http.Cookie{Name: account.SessionCookieName, Value: fixture.controller.ID})
		return req
	}
	rejected := httptest.NewRecorder()
	handler.ServeHTTP(rejected, request("unregistered"))
	if rejected.Code != http.StatusNotFound {
		t.Fatalf("unregistered device was not rejected: %d", rejected.Code)
	}
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		handler.ServeHTTP(recorder, request(fixture.device.ID))
	}()
	for _, item := range []struct{ action, result string }{
		{"snapshot", `{"cron":{"tasks":[{"id":"daily","name":"Daily","enabled":true,"prompt":"private-device-prompt"}]}}`},
		{"occurrences", fmt.Sprintf(`{"occurrences":[{"taskId":"daily","at":%d}]}`, time.Now().Add(time.Hour).UnixMilli())},
	} {
		select {
		case env := <-agent.Outbound():
			if env.GetCronManage().GetAction() != item.action {
				t.Fatalf("expected read-only action %s, got %v", item.action, env.GetPayload())
			}
			env.Ack(nil)
			sm.DispatchFromAgentForSession(agent, &gatewayv2.AgentEnvelope{
				RequestId: env.GetRequestId(),
				Payload: &gatewayv2.AgentEnvelope_CronManageResp{CronManageResp: &gatewayv2.CronManageResponse{
					ResultJson: item.result,
				}},
			})
		case <-time.After(time.Second):
			t.Fatalf("schedule summary did not request %s", item.action)
		}
	}
	select {
	case <-done:
		body := recorder.Body.String()
		if recorder.Code != http.StatusOK || !strings.Contains(body, `"status":"enabled"`) ||
			!strings.Contains(body, `"next_at"`) || strings.Contains(body, "private-device-prompt") {
			t.Fatalf("incorrect summary projection: %d %s", recorder.Code, body)
		}
	case <-time.After(time.Second):
		t.Fatal("device schedule summary timed out")
	}
}

func requireNoControllerOutput(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	_, raw, err := conn.ReadMessage()
	if err == nil {
		t.Fatalf("invalid controller received user data (%d bytes)", len(raw))
	}
	if netErr, ok := err.(interface{ Timeout() bool }); ok && netErr.Timeout() {
		t.Fatalf("invalid controller socket stayed open: %v", err)
	}
}
func TestAccountControllerRevalidatesSubscribedOutput(t *testing.T) {
	for _, kind := range []string{"logout", "lease-expiry", "session-expiry", "device-revocation", "workspace-removal"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newSelectionDispatchFixture(t, account.SelectionScopeWorkspace)
			sm := session.NewManager()
			sm.RecordAuthentication(fixture.device.ID, "1", "owned")
			agent := session.NewAgentSession(sm.LatestAuthSnapshot(fixture.device.ID))
			sm.SetSession(agent)
			defer agent.Close()
			gateway := pbws.NewServer(newV2TestConfig(), sm, fixture.service)
			defer gateway.Close()
			conn := dialSelectionDispatch(t, gateway.BrowserHandler(), fixture.header())
			sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{RequestId: "hello", Payload: &gatewayv2.WebClientFrame_Hello{Hello: selectionHello(fixture)}})
			if hello := receiveWebFrameRaw(t, conn).GetHello(); hello == nil || !hello.GetOk() {
				t.Fatalf("hello: %v", hello)
			}
			publish := func() {
				sm.DispatchFromAgentForSession(agent, &gatewayv2.AgentEnvelope{Payload: &gatewayv2.AgentEnvelope_SettingsSync{SettingsSync: &gatewayv2.SettingsSyncEvent{SettingsJson: "{}"}}})
			}
			publish()
			received := false
			for i := 0; i < 8; i++ {
				if receiveWebFrameRaw(t, conn).GetSettingsEvent() != nil {
					received = true
					break
				}
			}
			if !received {
				t.Fatal("valid settings subscription did not receive output")
			}
			// Drain the initial reconnect replay through the same FIFO response lane.
			// Only output produced after revocation belongs to the rejection assertion.
			sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{RequestId: "before-revoke", AgentId: fixture.device.ID,
				Payload: &gatewayv2.WebClientFrame_StatusGet{StatusGet: &gatewayv2.StatusGetRequest{}},
			})
			if frame := receiveWebFrameWithID(t, conn, "before-revoke"); frame.GetStatus() == nil {
				t.Fatal("valid selection barrier rejected")
			}
			fixture.invalidate(t, kind)
			publish()
			requireNoControllerOutput(t, conn)
		})
	}
}
func TestAccountTerminalRevalidatesSubscribedOutput(t *testing.T) {
	for _, kind := range []string{"logout", "lease-expiry", "session-expiry", "device-revocation", "workspace-removal"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newSelectionDispatchFixture(t, account.SelectionScopeWorkspace)
			sm := session.NewManager()
			sm.ApplySettingsJSON(fixture.device.ID, `{"remote":{"enableWebTerminal":true}}`)
			frames := make(chan *gatewayv2.TerminalStreamFrame, 4)
			cleanup, ok := sm.RegisterTerminalStreamToAgentIfCurrent(fixture.device.ID, frames, func() {}, func() bool { return true })
			if !ok {
				t.Fatal("terminal registration")
			}
			defer cleanup()
			gateway := pbws.NewServer(newV2TestConfig(), sm, fixture.service)
			defer gateway.Close()
			conn := dialSelectionDispatch(t, gateway.TerminalHandler(), fixture.header())
			sendTerminalFrameV := func(frame *gatewayv2.TerminalClientFrame) {
				raw, err := proto.Marshal(frame)
				if err != nil {
					t.Fatal(err)
				}
				if err := conn.WriteMessage(websocket.BinaryMessage, raw); err != nil {
					t.Fatal(err)
				}
			}
			sendTerminalFrameV(&gatewayv2.TerminalClientFrame{Payload: &gatewayv2.TerminalClientFrame_Hello{Hello: selectionHello(fixture)}})
			_, raw, err := conn.ReadMessage()
			if err != nil {
				t.Fatal(err)
			}
			var hello gatewayv2.TerminalServerFrame
			if err := proto.Unmarshal(raw, &hello); err != nil || !hello.GetHello().GetOk() {
				t.Fatalf("hello: %v %v", err, &hello)
			}
			sendTerminalFrameV(&gatewayv2.TerminalClientFrame{Payload: &gatewayv2.TerminalClientFrame_Frame{Frame: &gatewayv2.TerminalStreamFrame{Kind: "attach", SessionId: "synthetic"}}})
			select {
			case <-frames:
			case <-time.After(time.Second):
				t.Fatal("attach not forwarded")
			}
			publish := func() {
				sm.BroadcastTerminalStreamFrame(fixture.device.ID, &gatewayv2.TerminalStreamFrame{Kind: "output", SessionId: "synthetic", Data: []byte("synthetic")})
			}
			publish()
			if _, _, err := conn.ReadMessage(); err != nil {
				t.Fatal("valid output not received", err)
			}
			fixture.invalidate(t, kind)
			publish()
			requireNoControllerOutput(t, conn)
		})
	}
}
func TestDesktopBoundSelectionAvoidsPerFrameAccountRequests(t *testing.T) {
	fixture := newSelectionDispatchFixture(t, account.SelectionScopeDevice)
	var meRequests atomic.Int64
	usa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		meRequests.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"code":0,"message":"success","data":{"id":7,"email":"synthetic@example.invalid"}}`)
	}))
	defer usa.Close()
	fixture.service = account.NewService(fixture.store, account.NewUSAClientWithHTTPClient(usa.URL, usa.Client()), time.Hour, time.Hour)
	fixture.controller = nil // Desktop hello has no account cookie.
	sm := session.NewManager()
	sm.ApplySettingsJSON(fixture.device.ID, `{"remote":{"enableWebTerminal":true}}`)
	frames := make(chan *gatewayv2.TerminalStreamFrame, 20)
	cleanup, ok := sm.RegisterTerminalStreamToAgentIfCurrent(fixture.device.ID, frames, func() {}, func() bool { return true })
	if !ok {
		t.Fatal("terminal registration")
	}
	defer cleanup()
	gateway := pbws.NewServer(newV2TestConfig(), sm, fixture.service)
	defer gateway.Close()
	conn := dialSelectionDispatch(t, gateway.TerminalHandler(), make(http.Header))
	send := func(frame *gatewayv2.TerminalClientFrame) {
		raw, err := proto.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		if err := conn.WriteMessage(websocket.BinaryMessage, raw); err != nil {
			t.Fatal(err)
		}
	}
	send(&gatewayv2.TerminalClientFrame{Payload: &gatewayv2.TerminalClientFrame_Hello{Hello: &gatewayv2.ClientHello{ProtocolVersion: pbws.ProtocolVersion, Role: gatewayv2.ClientRole_CLIENT_ROLE_BROWSER, Token: "synthetic-access", SelectionLease: fixture.lease.ID}}})
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var hello gatewayv2.TerminalServerFrame
	if err := proto.Unmarshal(raw, &hello); err != nil || !hello.GetHello().GetOk() {
		t.Fatalf("hello: %v %v", err, &hello)
	}
	send(&gatewayv2.TerminalClientFrame{Payload: &gatewayv2.TerminalClientFrame_Frame{Frame: &gatewayv2.TerminalStreamFrame{Kind: "attach", SessionId: "synthetic"}}})
	select {
	case <-frames:
	case <-time.After(time.Second):
		t.Fatal("attach not forwarded")
	}
	for i := 0; i < 10; i++ {
		send(&gatewayv2.TerminalClientFrame{Payload: &gatewayv2.TerminalClientFrame_Frame{Frame: &gatewayv2.TerminalStreamFrame{Kind: "input", SessionId: "synthetic", Data: []byte("synthetic")}}})
		select {
		case <-frames:
		case <-time.After(time.Second):
			t.Fatal("input not forwarded")
		}
	}
	for i := 0; i < 3; i++ {
		sm.BroadcastTerminalStreamFrame(fixture.device.ID, &gatewayv2.TerminalStreamFrame{Kind: "output", SessionId: "synthetic", Data: []byte("synthetic")})
		if _, _, err := conn.ReadMessage(); err != nil {
			t.Fatal(err)
		}
	}
	if got := meRequests.Load(); got != 1 {
		t.Fatalf("Me requests=%d, want only authenticated hello", got)
	}
	fixture.invalidate(t, "lease-expiry")
	sm.BroadcastTerminalStreamFrame(fixture.device.ID, &gatewayv2.TerminalStreamFrame{Kind: "output", SessionId: "synthetic", Data: []byte("synthetic")})
	requireNoControllerOutput(t, conn)
	if got := meRequests.Load(); got != 1 {
		t.Fatalf("revocation repeated Me: %d", got)
	}
}
