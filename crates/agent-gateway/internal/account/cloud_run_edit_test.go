package account

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestCloudRunHistoryEdit(t *testing.T) {
	for name, fixture := range map[string]func(*testing.T) cloudRunTestFixture{
		"memory": cloudRunMemoryFixture, "postgres": cloudRunPostgresFixture,
	} {
		t.Run(name, func(t *testing.T) {
			f := fixture(t)
			ctx := context.Background()
			input := cloudRunTestInput(t, f, 11, "", "edit", "replacement")
			conversation := input.ConversationID
			prefix, anchor, tail := uuid.NewString(), uuid.NewString(), uuid.NewString()
			for _, message := range []struct{ id, role string }{
				{prefix, "user"}, {anchor, "user"}, {tail, "assistant"},
			} {
				if err := f.store.AddCloudMessage(ctx, &CloudMessage{
					ID: message.id, UserID: input.UserID, ConversationID: conversation, Role: message.role,
					Content: json.RawMessage("\"original\""),
				}); err != nil {
					t.Fatal(err)
				}
			}
			assertHistory := func(ids ...string) {
				t.Helper()
				messages, err := f.store.ListCloudMessages(ctx, input.UserID, conversation)
				if err != nil || len(messages) != len(ids) {
					t.Fatalf("history = %v, %v", messages, err)
				}
				for i, id := range ids {
					if messages[i].ID != id {
						t.Fatalf("history position %d: got %s, want %s", i, messages[i].ID, id)
					}
				}
			}
			input.historyEdit = &CloudRunHistoryEdit{MessageID: anchor, ExpectedTailID: prefix}
			if _, _, err := f.runs.CreateCloudRun(ctx, input); !errors.Is(err, errCloudHistoryChanged) {
				t.Fatalf("stale rewrite: %v", err)
			}
			input.historyEdit = &CloudRunHistoryEdit{MessageID: tail, ExpectedTailID: tail}
			if _, _, err := f.runs.CreateCloudRun(ctx, input); !errors.Is(err, errCloudHistoryChanged) {
				t.Fatalf("assistant anchor: %v", err)
			}
			assertHistory(prefix, anchor, tail)

			input.historyEdit = &CloudRunHistoryEdit{MessageID: anchor, ExpectedTailID: tail}
			run, created, err := f.runs.CreateCloudRun(ctx, input)
			if err != nil || !created || run.ConversationID != conversation {
				t.Fatalf("edit acceptance: %v, %t, %v", run, created, err)
			}
			assertHistory(prefix, run.UserMessageID)
			replay, created, err := f.runs.CreateCloudRun(ctx, input)
			if err != nil || created || replay.ID != run.ID {
				t.Fatalf("edit retry: %v, %t, %v", replay, created, err)
			}
			assertHistory(prefix, run.UserMessageID)
		})
	}
}
