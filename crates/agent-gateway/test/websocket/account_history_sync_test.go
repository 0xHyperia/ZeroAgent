package websocket_test

import (
	"bytes"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/account"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
	"google.golang.org/protobuf/proto"
)

func TestAccountHistorySyncScopesSnapshotAndLiveEvents(t *testing.T) {
	for _, scope := range []string{account.SelectionScopeWorkspace, account.SelectionScopeDevice} {
		t.Run(scope, func(t *testing.T) {
			fixture := newSelectionDispatchFixture(t, scope)
			sm := session.NewManager()
			foreign := "agent-00000000-0000-4000-8000-000000000002"
			for _, id := range []string{fixture.device.ID, foreign} {
				sm.RecordAuthentication(id, "1", id)
				agent := session.NewAgentSession(sm.LatestAuthSnapshot(id))
				sm.SetSession(agent)
				t.Cleanup(agent.Close)
			}
			sm.IngestRemoteHistorySnapshot(foreign, &gatewayv2.HistorySyncSnapshot{
				SourceId: "foreign-source", Generation: "foreign-generation",
				Conversations: []*gatewayv2.ConversationSummary{{Id: "foreign-secret", Title: "foreign-secret"}},
			})
			sm.IngestRemoteHistorySnapshot(fixture.device.ID, &gatewayv2.HistorySyncSnapshot{
				SourceId: "owned-source", Generation: "owned-generation", CutDeliverySeq: 4,
				Conversations: []*gatewayv2.ConversationSummary{
					{Id: "project", Cwd: "/workspace/project"}, {Id: "second", Cwd: "/workspace/second"},
					{Id: "plain"}, {Id: "unpublished-secret", Cwd: "/unpublished-secret"},
				},
				Workdirs: []*gatewayv2.HistoryWorkdirSummary{
					{Path: "/workspace/project"}, {Path: "/workspace/second"}, {Path: "/unpublished-secret"},
				},
			})
			gateway := pbws.NewServer(newV2TestConfig(), sm, fixture.service)
			t.Cleanup(gateway.Close)
			conn := dialSelectionDispatch(t, gateway.BrowserHandler(), fixture.header())
			sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{RequestId: "hello", Payload: &gatewayv2.WebClientFrame_Hello{Hello: selectionHello(fixture)}})
			if hello := receiveWebFrameRaw(t, conn).GetHello(); hello == nil || !hello.GetOk() {
				t.Fatalf("hello: %v", hello)
			}
			readSafe := func() *gatewayv2.WebServerFrame {
				t.Helper()
				frame := receiveWebFrameRaw(t, conn)
				raw, err := proto.Marshal(frame)
				if err != nil {
					t.Fatal(err)
				}
				if frame.GetAgentId() == foreign || bytes.Contains(raw, []byte("foreign-secret")) || bytes.Contains(raw, []byte("unpublished-secret")) {
					t.Fatalf("selection leaked history: %v", frame)
				}
				return frame
			}
			var recovery *gatewayv2.HistorySyncStatus
			for i := 0; i < 12 && recovery == nil; i++ {
				recovery = readSafe().GetHistorySyncStatus()
			}
			if recovery == nil {
				t.Fatal("initial recovery status missing")
			}
			sendProtoFrame(t, conn, &gatewayv2.WebClientFrame{RequestId: "snapshot", AgentId: fixture.device.ID,
				Payload: &gatewayv2.WebClientFrame_HistoryResync{HistoryResync: &gatewayv2.HistoryResyncRequest{Limit: 1, ResyncToken: recovery.GetResyncToken()}},
			})
			var snapshot *gatewayv2.HistorySyncSnapshot
			for i := 0; i < 12 && snapshot == nil; i++ {
				if frame := readSafe(); frame.GetRequestId() == "snapshot" {
					snapshot = frame.GetHistorySyncSnapshot()
					if snapshot == nil {
						t.Fatalf("snapshot rejected: %v", frame)
					}
				}
			}
			expectedRows, expectedWorkdirs := uint32(1), 1
			if scope == account.SelectionScopeDevice {
				expectedRows, expectedWorkdirs = 3, 2
			}
			if snapshot == nil || snapshot.GetTotalCount() != expectedRows || len(snapshot.GetWorkdirs()) != expectedWorkdirs || len(snapshot.GetConversations()) != 1 {
				t.Fatalf("scoped first page: %v", snapshot)
			}
			sm.IngestRemoteHistoryEvent(foreign, &gatewayv2.HistorySyncEvent{Kind: "upsert", ConversationId: "foreign-secret", SourceId: "foreign-source", Generation: "foreign-generation", DeliverySeq: 1,
				Conversation: &gatewayv2.ConversationSummary{Id: "foreign-secret", Title: "foreign-secret"}})
			sm.IngestRemoteHistoryEvent(fixture.device.ID, &gatewayv2.HistorySyncEvent{Kind: "upsert", ConversationId: "unpublished-secret", SourceId: "owned-source", Generation: "owned-generation", DeliverySeq: 5,
				Conversation: &gatewayv2.ConversationSummary{Id: "unpublished-secret", Cwd: "/unpublished-secret"}})
			sm.IngestRemoteHistoryEvent(fixture.device.ID, &gatewayv2.HistorySyncEvent{Kind: "upsert", ConversationId: "project", SourceId: "owned-source", Generation: "owned-generation", DeliverySeq: 6,
				Conversation: &gatewayv2.ConversationSummary{Id: "project", Title: "visible update", Cwd: "/workspace/project"}})
			seen := false
			for i := 0; i < 12 && !seen; i++ {
				seen = readSafe().GetHistoryEvent().GetConversation().GetTitle() == "visible update"
			}
			if !seen {
				t.Fatal("visible incremental update missing")
			}
			fixture.invalidate(t, "logout")
			sm.IngestRemoteHistoryStatus(fixture.device.ID, &gatewayv2.HistorySyncStatus{SourceId: "owned-source", Generation: "owned-generation", LatestDeliverySeq: 6, Available: true})
			_ = conn.SetReadDeadline(time.Now().Add(time.Second))
			requireControllerSocketClosed(t, conn)
		})
	}
}
