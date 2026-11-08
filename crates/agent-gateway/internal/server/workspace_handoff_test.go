package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/proto"
)

func TestWorkspaceHandoffLoopbackKeepsScopeAndRecoversLostReceipt(t *testing.T) {
	ctx := context.Background()
	store := account.NewMemoryStore()
	accounts := account.NewService(store, nil, time.Hour, time.Hour)
	newSession := func(owner int64) *account.Session {
		t.Helper()
		login := &account.Session{
			ID: uuid.NewString(), UserID: owner, AccessToken: "fixture",
			AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour),
		}
		if err := store.PutSession(ctx, login); err != nil {
			t.Fatal(err)
		}
		return login
	}
	owner, other := newSession(7), newSession(9)
	device, token, err := accounts.RegisterDevice(ctx, owner.UserID, account.RegisterDeviceInput{
		InstallationID: "handoff-fixture", Name: "Fixture", Platform: "windows", Version: "1.0.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	root, otherRoot := t.TempDir(), t.TempDir()
	manager := session.NewManager()
	server := httptest.NewServer(NewHTTPServer(&config.Config{RequestTimeout: time.Second}, manager, accounts))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/v2/agent"
	dialer := websocket.Dialer{Subprotocols: []string{"liveagent.v2.pb"}}
	conn, _, err := dialer.Dial(wsURL, http.Header{"Origin": []string{server.URL}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	writeAgent := func(frame *gatewayv2.AgentClientFrame) {
		t.Helper()
		data, err := proto.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
			t.Fatal(err)
		}
	}
	readAgent := func() *gatewayv2.AgentServerFrame {
		t.Helper()
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		var frame gatewayv2.AgentServerFrame
		if err := proto.Unmarshal(data, &frame); err != nil {
			t.Fatal(err)
		}
		return &frame
	}
	writeAgent(&gatewayv2.AgentClientFrame{Payload: &gatewayv2.AgentClientFrame_Hello{Hello: &gatewayv2.ClientHello{
		ProtocolVersion: 2, Role: gatewayv2.ClientRole_CLIENT_ROLE_AGENT,
		Token: token, AgentId: device.ID, AgentVersion: "1.0.0",
		Capabilities: []string{gatewayv2.WorkspaceHandoffPathV1Capability},
		Workspaces: []*gatewayv2.DeviceWorkspace{
			{Id: "chosen", Name: "Chosen", Path: filepath.ToSlash(root)},
			{Id: "other", Name: "Other", Path: filepath.ToSlash(otherRoot)},
		},
	}}})
	if hello := readAgent().GetHello(); !hello.GetOk() {
		t.Fatalf("agent handshake rejected: %s", hello.GetMessage())
	}
	selectTarget := func(scope, workspace string) string {
		t.Helper()
		input := account.SelectTargetInput{RuntimeKind: account.RuntimeKindDeviceAgent, DeviceID: device.ID,
			WorkspaceID: workspace, Scope: scope,
			Target: account.TargetFingerprint(account.RuntimeKindDeviceAgent, device.ID, workspace)}
		body, _ := json.Marshal(input)
		request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/execution-target/select", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", server.URL)
		request.AddCookie(&http.Cookie{Name: account.SessionCookieName, Value: owner.ID})
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			data, _ := io.ReadAll(response.Body)
			t.Fatalf("select target: HTTP %d %s", response.StatusCode, data)
		}
		var selection struct {
			Lease string `json:"selection_lease"`
		}
		if err := json.NewDecoder(response.Body).Decode(&selection); err != nil || selection.Lease == "" {
			t.Fatalf("selection did not return a lease: %v", err)
		}
		credential, _ := json.Marshal(selectionCredentialPayload{
			Lease: selection.Lease, RuntimeKind: account.RuntimeKindDeviceAgent,
			DeviceID: device.ID, AgentID: device.ID, WorkspaceID: workspace,
		})
		return "selection." + base64.RawURLEncoding.EncodeToString(credential)
	}
	credential := selectTarget(account.SelectionScopeWorkspace, "chosen")
	deviceCredential := selectTarget(account.SelectionScopeDevice, "")
	operation := uuid.NewString()
	contents := []byte{0, 255, '\n', 'Z', 'A'}
	sendTo := func(method, login, credential, workspace, expectedPath, route string) (*http.Response, error) {
		query := url.Values{"workspace_id": {workspace}, "operation_id": {operation}}
		var body io.Reader
		if method == http.MethodPost {
			query.Set("name", "fixture.bin")
			body = bytes.NewReader(contents)
		}
		request, err := http.NewRequest(method, server.URL+route+"?"+query.Encode(), body)
		if err != nil {
			return nil, err
		}
		request.AddCookie(&http.Cookie{Name: account.SessionCookieName, Value: login})
		request.Header.Set("Authorization", "Bearer "+credential)
		request.Header.Set("Content-Type", "application/octet-stream")
		if expectedPath != "" {
			request.Header.Set(handler.WorkspaceHandoffPathHeader, base64.RawURLEncoding.EncodeToString([]byte(expectedPath)))
		}
		return server.Client().Do(request)
	}
	const confirmedRoute = "/api/files/confirmed-handoff"
	send := func(method, login, credential, workspace string) (*http.Response, error) {
		return sendTo(method, login, credential, workspace, filepath.ToSlash(root), confirmedRoute)
	}
	for _, blocked := range []struct {
		path, route string
		status      int
	}{
		{"", confirmedRoute, http.StatusBadRequest},
		{filepath.ToSlash(otherRoot), confirmedRoute, http.StatusPreconditionFailed},
		{filepath.ToSlash(root), "/api/files/handoff", http.StatusNotFound},
	} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			response, err := sendTo(method, owner.ID, credential, "chosen", blocked.path, blocked.route)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != blocked.status {
				t.Fatalf("unsafe %s transfer: HTTP %d, want %d", method, response.StatusCode, blocked.status)
			}
		}
	}
	for _, rejected := range []struct {
		login, credential, workspace string
		status                       int
	}{
		{owner.ID, credential, "other", http.StatusForbidden},
		{owner.ID, deviceCredential, "chosen", http.StatusForbidden},
		{other.ID, credential, "chosen", http.StatusUnauthorized},
	} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			response, err := send(method, rejected.login, rejected.credential, rejected.workspace)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != rejected.status {
				t.Fatalf("rejected %s transfer: HTTP %d, want %d", method, response.StatusCode, rejected.status)
			}
		}
	}
	response, err := send(http.MethodHead, owner.ID, credential, "chosen")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("HEAD must not dispatch a transfer: HTTP %d", response.StatusCode)
	}
	var fixtureCopies int
	receipt := "ZA-" + operation + "/ZA-fixture.bin"
	file := filepath.Join(root, filepath.FromSlash(receipt))
	for _, attempt := range []struct {
		method string
		status int
		found  bool
	}{
		{http.MethodGet, http.StatusOK, false},
		{http.MethodPost, http.StatusPreconditionFailed, false},
		{http.MethodPost, http.StatusGatewayTimeout, false},
		{http.MethodGet, http.StatusOK, true},
		{http.MethodPost, http.StatusOK, true},
		{http.MethodPost, http.StatusBadGateway, false},
	} {
		type outcome struct {
			response *http.Response
			err      error
		}
		result := make(chan outcome, 1)
		go func() {
			response, err := send(attempt.method, owner.ID, credential, "chosen")
			result <- outcome{response, err}
		}()
		envelope := readAgent().GetEnvelope()
		for envelope.GetWorkspaceHandoff() == nil {
			// The server also requests device status on connection.
			envelope = readAgent().GetEnvelope()
		}
		handoff := envelope.GetWorkspaceHandoff()
		check := attempt.method == http.MethodGet
		if handoff.GetWorkspaceId() != "chosen" || handoff.GetOperationId() != operation || handoff.GetCheckOnly() != check {
			t.Fatalf("forwarded incorrect transfer: %v", handoff)
		}
		if handoff.GetExpectedWorkspacePath() != filepath.ToSlash(root) {
			t.Fatal("device did not receive the originally confirmed directory")
		}
		if check && (handoff.GetFileName() != "" || len(handoff.GetContent()) != 0) {
			t.Fatal("read-only receipt lookup carried copy data")
		}
		if !check && (handoff.GetFileName() != "fixture.bin" || !bytes.Equal(handoff.GetContent(), contents)) {
			t.Fatal("copy did not carry the original name and bytes")
		}
		// The socket fixture writes once and deliberately drops the first reply.
		// Native's production file writer is tested in workspace_handoff.rs.
		if !check && fixtureCopies == 0 && attempt.status != http.StatusPreconditionFailed {
			if err := os.Mkdir(filepath.Dir(file), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(file, handoff.GetContent(), 0600); err != nil {
				t.Fatal(err)
			}
			fixtureCopies++
		}
		if attempt.status == http.StatusBadGateway {
			if err := accounts.UpdateAgentWorkspaces(ctx, device.ID, []account.Workspace{
				{ID: "chosen", Name: "Chosen", Path: filepath.ToSlash(otherRoot)},
			}); err != nil {
				t.Fatal(err)
			}
		}
		if attempt.status == http.StatusOK || attempt.status == http.StatusBadGateway {
			relativePath := ""
			if attempt.found || attempt.status == http.StatusBadGateway {
				relativePath = receipt
			}
			writeAgent(&gatewayv2.AgentClientFrame{Payload: &gatewayv2.AgentClientFrame_Envelope{Envelope: &gatewayv2.AgentEnvelope{
				RequestId: envelope.GetRequestId(),
				Payload: &gatewayv2.AgentEnvelope_WorkspaceHandoffResp{WorkspaceHandoffResp: &gatewayv2.WorkspaceHandoffResponse{
					RelativePath: relativePath,
				}},
			}}})
		}
		if attempt.status == http.StatusPreconditionFailed {
			writeAgent(&gatewayv2.AgentClientFrame{Payload: &gatewayv2.AgentClientFrame_Envelope{Envelope: &gatewayv2.AgentEnvelope{
				RequestId: envelope.GetRequestId(),
				Payload:   &gatewayv2.AgentEnvelope_Error{Error: &gatewayv2.ErrorResponse{Code: 412, Message: "workspace_target_changed"}},
			}}})
		}
		resolved := <-result
		if resolved.err != nil {
			t.Fatal(resolved.err)
		}
		data, err := io.ReadAll(resolved.response.Body)
		resolved.response.Body.Close()
		if err != nil || resolved.response.StatusCode != attempt.status {
			t.Fatalf("transfer result: HTTP %d %s, want %d (%v)", resolved.response.StatusCode, data, attempt.status, err)
		}
		if attempt.found && !strings.Contains(string(data), receipt) {
			t.Fatalf("changed receipt: %s", data)
		}
		if check && !attempt.found && !strings.Contains(string(data), `"status":"not_found"`) {
			t.Fatalf("missing receipt should remain distinct: %s", data)
		}
		if attempt.status == http.StatusBadGateway {
			if !strings.Contains(string(data), "transfer result is unknown") || strings.Contains(string(data), receipt) {
				t.Fatalf("post-dispatch path change must withhold the receipt without implying rejection: %s", data)
			}
			if err := accounts.UpdateAgentWorkspaces(ctx, device.ID, []account.Workspace{
				{ID: "chosen", Name: "Chosen", Path: filepath.ToSlash(root)},
				{ID: "other", Name: "Other", Path: filepath.ToSlash(otherRoot)},
			}); err != nil {
				t.Fatal(err)
			}
		}
	}
	actual, err := os.ReadFile(file)
	if err != nil || !bytes.Equal(actual, contents) || fixtureCopies != 1 {
		t.Fatalf("wrong file or repeated copy: %v, copies=%d, error=%v", actual, fixtureCopies, err)
	}
	otherFiles, err := os.ReadDir(otherRoot)
	if err != nil || len(otherFiles) != 0 {
		t.Fatalf("a different workspace was changed: %v (%v)", otherFiles, err)
	}
	legacy := session.NewAgentSession(session.AuthSnapshot{AgentID: device.ID, SessionID: "legacy-handoff"})
	manager.SetSession(legacy)
	t.Cleanup(func() { manager.ClearSession(legacy) })
	response, err = send(http.MethodPost, owner.ID, credential, "chosen")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUpgradeRequired {
		t.Fatalf("old agent accepted a path-bound transfer: HTTP %d", response.StatusCode)
	}
	select {
	case <-legacy.Outbound():
		t.Fatal("forwarded transfer to an agent without directory-check support")
	default:
	}
}
