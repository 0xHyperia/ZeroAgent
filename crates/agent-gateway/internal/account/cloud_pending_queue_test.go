package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func pendingTestItem() *CloudPendingItem {
	return &CloudPendingItem{ClientItemID: uuid.NewString(), Model: "test-model", Content: cloudJSON("not sent"),
		Presentation: "work", ReasoningEffort: "high", Composer: cloudJSON(map[string]any{"segments": []any{map[string]string{"type": "text", "text": "not sent"}}, "text": "not sent"})}
}

func TestCloudPendingEquivalentIgnoresJSONBKeyOrderWithoutRoundingNumbers(t *testing.T) {
	left := *pendingTestItem()
	right := left
	left.Composer = json.RawMessage(`{"segments":[{"type":"text","text":"draft"}],"position":9007199254740993}`)
	right.Composer = json.RawMessage(`{ "position": 9007199254740993, "segments": [{"text":"draft", "type":"text"}] }`)
	if !cloudPendingEquivalent(left, right) {
		t.Fatal("JSONB formatting changed enqueue identity")
	}
	right.Composer = json.RawMessage(`{"position":9007199254740992,"segments":[{"text":"draft","type":"text"}]}`)
	if cloudPendingEquivalent(left, right) {
		t.Fatal("distinct editor numbers were rounded into the same receipt")
	}
}

func TestCloudPendingMemoryContract(t *testing.T) { runCloudPendingContract(t, cloudRunMemoryFixture) }
func TestCloudPendingPostgresContract(t *testing.T) {
	runCloudPendingContract(t, cloudRunPostgresFixture)
}

func runCloudPendingContract(t *testing.T, factory func(*testing.T) cloudRunTestFixture) {
	t.Run("inert snapshots are isolated mutable and ordered with CAS", func(t *testing.T) {
		f := factory(t)
		ctx := context.Background()
		seed := cloudRunTestInput(t, f, 11, "", "seed-not-admitted", "seed")
		store := f.store.(CloudPendingQueueStore)
		item := pendingTestItem()
		queue, err := store.MutateCloudPendingQueue(ctx, 11, seed.ConversationID, CloudPendingMutation{Kind: "enqueue", Item: item})
		if err != nil || queue.Version != 1 || len(queue.Items) != 1 || queue.Items[0].Version != 1 {
			t.Fatalf("enqueue: %#v %v", queue, err)
		}
		if claimed, err := f.runs.ClaimCloudRun(ctx, "pending-check", time.Second); !errors.Is(err, ErrNotFound) || claimed != nil {
			t.Fatalf("pending was executable: %#v %v", claimed, err)
		}
		if history, err := f.store.ListCloudMessages(ctx, 11, seed.ConversationID); err != nil || len(history) != 0 {
			t.Fatalf("pending wrote history: %v %v", history, err)
		}
		if _, err := store.GetCloudPendingQueue(ctx, 12, seed.ConversationID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("foreign read: %v", err)
		}
		if _, err := store.MutateCloudPendingQueue(ctx, 12, seed.ConversationID, CloudPendingMutation{Kind: "remove", ItemID: item.ClientItemID, ExpectedVersion: 1}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("foreign edit: %v", err)
		}
		replay, err := store.MutateCloudPendingQueue(ctx, 11, seed.ConversationID, CloudPendingMutation{Kind: "enqueue", Item: item})
		if err != nil || replay.Version != 1 || len(replay.Items) != 1 {
			t.Fatalf("enqueue retry duplicated: %#v %v", replay, err)
		}
		otherConversation := cloudRunTestInput(t, f, 11, "", "other-not-admitted", "other")
		if _, err := store.MutateCloudPendingQueue(ctx, 11, otherConversation.ConversationID, CloudPendingMutation{Kind: "enqueue", Item: item}); !errors.Is(err, ErrCloudPendingConflict) {
			t.Fatalf("same identity in another conversation: %v", err)
		}
		changed := *item
		changed.Content = cloudJSON("edited")
		queue, err = store.MutateCloudPendingQueue(ctx, 11, seed.ConversationID, CloudPendingMutation{Kind: "edit", ItemID: item.ClientItemID, ExpectedVersion: 1, Item: &changed})
		if err != nil || queue.Version != 2 || queue.Items[0].Version != 2 {
			t.Fatalf("edit: %#v %v", queue, err)
		}
		if _, err = store.MutateCloudPendingQueue(ctx, 11, seed.ConversationID, CloudPendingMutation{Kind: "remove", ItemID: item.ClientItemID, ExpectedVersion: 1}); !errors.Is(err, ErrCloudPendingConflict) {
			t.Fatalf("stale delete: %v", err)
		}
		second := pendingTestItem()
		queue, err = store.MutateCloudPendingQueue(ctx, 11, seed.ConversationID, CloudPendingMutation{Kind: "enqueue", ExpectedVersion: 2, Item: second})
		if err != nil {
			t.Fatal(err)
		}
		queue, err = store.MutateCloudPendingQueue(ctx, 11, seed.ConversationID, CloudPendingMutation{Kind: "reorder", ExpectedVersion: queue.Version, Order: []string{second.ClientItemID, item.ClientItemID}})
		if err != nil || queue.Items[0].ClientItemID != second.ClientItemID {
			t.Fatalf("reorder: %#v %v", queue, err)
		}
		if _, err = store.MutateCloudPendingQueue(ctx, 11, seed.ConversationID, CloudPendingMutation{Kind: "reorder", ExpectedVersion: queue.Version, Order: []string{second.ClientItemID, second.ClientItemID}}); !errors.Is(err, ErrCloudRunInvalid) {
			t.Fatalf("invalid permutation: %v", err)
		}
		queue.Items[0].Content[0] = 'X'
		fresh, err := store.GetCloudPendingQueue(ctx, 11, seed.ConversationID)
		if err != nil || string(fresh.Items[0].Content) != `"not sent"` {
			t.Fatalf("mutable alias: %#v %v", fresh, err)
		}
	})
	t.Run("admission atomically consumes exact snapshot and ordinary runs cannot bypass it", func(t *testing.T) {
		f := factory(t)
		ctx := context.Background()
		seed := cloudRunTestInput(t, f, 11, "", "seed-not-admitted", "seed")
		store := f.store.(CloudPendingQueueStore)
		item := pendingTestItem()
		queue, err := store.MutateCloudPendingQueue(ctx, 11, seed.ConversationID, CloudPendingMutation{Kind: "enqueue", Item: item})
		if err != nil {
			t.Fatal(err)
		}
		item = &queue.Items[0]
		input := cloudRunTestInput(t, f, 11, seed.ConversationID, item.ClientItemID, "not sent")
		input.ModelParameters = item.ModelParameters
		input.ReasoningEffort = item.ReasoningEffort
		input.RequestHash, err = cloudRunLogicalRequestHash(item.runInput(seed.ConversationID))
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err = f.runs.CreateCloudRun(ctx, input); !errors.Is(err, ErrCloudPendingConflict) {
			t.Fatalf("ordinary admission bypass: %v", err)
		}
		input.pendingVersion = 2
		if _, _, err = f.runs.CreateCloudRun(ctx, input); !errors.Is(err, ErrCloudPendingConflict) {
			t.Fatalf("stale admission: %v", err)
		}
		input.pendingVersion = 1
		busy := cloudRunTestInput(t, f, 11, seed.ConversationID, "other-active", "active")
		active, _, err := f.runs.CreateCloudRun(ctx, busy)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err = f.runs.CreateCloudRun(ctx, input); !errors.Is(err, ErrCloudRunBusy) {
			t.Fatalf("busy admission: %v", err)
		}
		still, err := store.GetCloudPendingQueue(ctx, 11, seed.ConversationID)
		if err != nil || len(still.Items) != 1 || still.Version != 1 {
			t.Fatalf("failed admission consumed: %#v %v", still, err)
		}
		if _, err = f.runs.CancelCloudRun(ctx, 11, active.ID); err != nil {
			t.Fatal(err)
		}
		run, created, err := f.runs.CreateCloudRun(ctx, input)
		if err != nil || !created {
			t.Fatalf("admission: %#v %v %v", run, created, err)
		}
		after, err := store.GetCloudPendingQueue(ctx, 11, seed.ConversationID)
		if err != nil || len(after.Items) != 0 || after.Version != 2 {
			t.Fatalf("accepted pending retained: %#v %v", after, err)
		}
		replayed, created, err := f.runs.CreateCloudRun(ctx, input)
		if err != nil || created || replayed.ID != run.ID {
			t.Fatalf("lost receipt replay: %#v %v %v", replayed, created, err)
		}
		if _, err = store.MutateCloudPendingQueue(ctx, 11, seed.ConversationID, CloudPendingMutation{Kind: "enqueue", ExpectedVersion: after.Version, Item: item}); !errors.Is(err, ErrCloudPendingConflict) {
			t.Fatalf("accepted identity requeued: %v", err)
		}
	})
	t.Run("concurrent enqueue same expected version accepts only one distinct item", func(t *testing.T) {
		f := factory(t)
		ctx := context.Background()
		seed := cloudRunTestInput(t, f, 11, "", "seed", "seed")
		store := f.store.(CloudPendingQueueStore)
		var wg sync.WaitGroup
		outcomes := make(chan error, 2)
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := store.MutateCloudPendingQueue(ctx, 11, seed.ConversationID, CloudPendingMutation{Kind: "enqueue", Item: pendingTestItem()})
				outcomes <- err
			}()
		}
		wg.Wait()
		close(outcomes)
		success, conflict := 0, 0
		for err := range outcomes {
			if err == nil {
				success++
			} else if errors.Is(err, ErrCloudPendingConflict) {
				conflict++
			} else {
				t.Fatal(err)
			}
		}
		if success != 1 || conflict != 1 {
			t.Fatalf("CAS outcomes success=%d conflict=%d", success, conflict)
		}
	})
}

func TestCloudPendingHTTPDoesNotStartWork(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("pending queue called model") })
	base := "/api/web-chat/conversations/" + f.conversation.ID + "/pending"
	item := pendingTestItem()
	status, body := f.request(t, "POST", base, "synthetic-browser-cookie", string(cloudJSON(map[string]any{"expected_version": "0", "item": item})))
	if status != http.StatusOK || !strings.Contains(body, `"client_item_id":"`+item.ClientItemID+`"`) {
		t.Fatalf("enqueue: %d %s", status, body)
	}
	if status, _ := f.request(t, "GET", base, "synthetic-other-account", ""); status != http.StatusNotFound {
		t.Fatalf("foreign read %d", status)
	}
	if status, _ := f.request(t, "PATCH", base+"/"+item.ClientItemID, "synthetic-browser-cookie", string(cloudJSON(map[string]any{"expected_version": "0", "item": item}))); status != http.StatusConflict {
		t.Fatalf("stale edit %d", status)
	}
	if f.calls.Load() != 0 {
		t.Fatal("pending operations dispatched execution")
	}
}
