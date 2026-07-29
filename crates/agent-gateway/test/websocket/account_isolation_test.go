package websocket_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
	"github.com/liveagent/agent-gateway/test/testutil"
)

func TestAccountBrowserIsBoundToOwnedAgent(t *testing.T) {
	sm := session.NewManager()
	fixture := testutil.NewAccountFixture(t, sm)
	sm.RecordAuthentication(fixture.Device.ID, "1.0.0", "owned-session")
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot(fixture.Device.ID)))
	foreignAgentID := "agent-00000000-0000-4000-8000-000000000002"
	sm.RecordAuthentication(foreignAgentID, "1.0.0", "foreign-session")
	sm.SetSession(session.NewAgentSession(sm.LatestAuthSnapshot(foreignAgentID)))

	handler := pbws.NewServer(newV2TestConfig(), sm, fixture.Service).BrowserHandler()
	server := httptest.NewServer(handler)
	defer server.Close()
	dialer := websocket.Dialer{Subprotocols: []string{pbws.Subprotocol}}
	conn, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), http.Header{
		"Origin": []string{server.URL},
		"Cookie": []string{"zeroagent_session=" + fixture.ControllerSession.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "hello-account",
		Payload: &gatewayv2.WebClientFrame_Hello{Hello: &gatewayv2.ClientHello{
			ProtocolVersion: pbws.ProtocolVersion,
			Role:            gatewayv2.ClientRole_CLIENT_ROLE_BROWSER,
			SelectionLease:  fixture.Selection.ID,
		}},
	})
	if hello := receiveWebFrameRaw(t, conn).GetHello(); hello == nil || !hello.GetOk() {
		t.Fatalf("account hello rejected: %#v", hello)
	}

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "owned-list",
		Payload:   &gatewayv2.WebClientFrame_AgentList{AgentList: &gatewayv2.AgentListRequest{}},
	})
	list := receiveWebFrameWithID(t, conn, "owned-list").GetAgentList()
	if list == nil || len(list.GetAgents()) != 1 || list.GetAgents()[0].GetAgentId() != fixture.Device.ID {
		t.Fatalf("account-scoped list leaked another agent: %#v", list)
	}

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "foreign-status", AgentId: foreignAgentID,
		Payload: &gatewayv2.WebClientFrame_StatusGet{StatusGet: &gatewayv2.StatusGetRequest{}},
	})
	if localError := receiveWebFrameWithID(t, conn, "foreign-status").GetLocalError(); localError == nil || !strings.Contains(localError.GetMessage(), "outside") {
		t.Fatalf("foreign agent request was not rejected: %#v", localError)
	}

	sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{
		RequestId: "legacy-default",
		Payload:   &gatewayv2.WebClientFrame_StatusGet{StatusGet: &gatewayv2.StatusGetRequest{}},
	})
	status := receiveWebFrameWithID(t, conn, "legacy-default").GetStatus()
	if status == nil || status.GetAgentId() != fixture.Device.ID {
		t.Fatalf("legacy request did not use bound agent: %#v", status)
	}
}
