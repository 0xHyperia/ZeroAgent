package session

import (
	"testing"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestHistoryObserverFollowsAcceptedSnapshotAndMutations(t *testing.T) {
	m := NewManager()
	routes := map[string]string{}
	calls := 0
	m.SetHistoryObserver(func(agent string, event *gatewayv2.HistorySyncEvent) {
		if agent != "owned" {
			t.Fatalf("wrong observer owner: %s", agent)
		}
		calls++
		if event.GetKind() == "delete" {
			delete(routes, event.GetConversationId())
			return
		}
		routes[event.GetConversationId()] = event.GetConversation().GetTitle()
		event.Conversation.Title = "observer copy"
	})
	m.IngestRemoteHistorySnapshot("owned", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "generation", CutDeliverySeq: 1,
		Conversations: []*gatewayv2.ConversationSummary{{Id: "one", Title: "One"}, {Id: "two", Title: "Two"}},
	})
	if len(routes) != 2 || routes["one"] != "One" {
		t.Fatalf("initial routes: %v", routes)
	}
	m.IngestRemoteHistoryEvent("owned", &gatewayv2.HistorySyncEvent{
		SourceId: "source", Generation: "generation", DeliverySeq: 2, Kind: "upsert", ConversationId: "one",
		Conversation: &gatewayv2.ConversationSummary{Id: "one", Title: "Renamed"},
	})
	if calls != 3 || routes["one"] != "Renamed" {
		t.Fatalf("mutation routes: %v (%d)", routes, calls)
	}
	m.IngestRemoteHistoryEvent("owned", &gatewayv2.HistorySyncEvent{
		SourceId: "source", Generation: "generation", DeliverySeq: 1, Kind: "delete", ConversationId: "one",
	})
	if calls != 3 {
		t.Fatal("stale event reached account catalog")
	}
	snapshot, ok := m.HistorySyncSnapshot("owned", "")
	if !ok || snapshot.GetConversations()[0].GetTitle() == "observer copy" {
		t.Fatal("observer mutated authority")
	}
	m.IngestRemoteHistorySnapshot("owned", &gatewayv2.HistorySyncSnapshot{
		SourceId: "source", Generation: "generation", CutDeliverySeq: 3,
		Conversations: []*gatewayv2.ConversationSummary{{Id: "one", Title: "Final"}},
	})
	if len(routes) != 1 || routes["one"] != "Final" {
		t.Fatalf("reconciled routes: %v", routes)
	}
}
