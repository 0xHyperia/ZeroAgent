package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestCloudRunCancellationUnknownRemoteFactsRemainInterrupted(t *testing.T) {
	for _, kind := range []string{"kill_unknown", "operation_unknown"} {
		t.Run(kind, func(t *testing.T) {
			f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				emitCloudDelta(w, "保留的执行前说明")
				emitToolCalls(w, map[string]any{"index": 0, "id": "pending-code", "type": "function", "function": map[string]any{"name": "execute_code", "arguments": `{"code":"while True: pass","timeout_ms":120000}`}})
				emitModelFinish(w, "tool_calls", 1)
			})
			sdk := newCloudSDKFixture(t, f, true)
			sdk.block.Store(true)
			sdk.killUnknown.Store(kind == "kill_unknown")
			sdk.cancelUnknown.Store(kind == "operation_unknown")
			run, requestBody := f.create(t, "cancel-unknown-"+kind, "执行但允许停止")
			select {
			case <-sdk.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("isolated operation not started")
			}
			status, _ := f.request(t, http.MethodPost, "/api/web-chat/runs/"+run.ID+"/cancel", "synthetic-browser-cookie", "")
			if status != http.StatusOK {
				t.Fatalf("cancel status=%d", status)
			}
			finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
			if finished.State != CloudRunInterrupted || finished.ErrorCode != cloudCancellationOutcomeUnknown || finished.Output != "保留的执行前说明" {
				t.Fatalf("uncertainty erased: state=%s code=%s output=%q", finished.State, finished.ErrorCode, finished.Output)
			}
			binding, err := f.store.GetCloudWorkspace(context.Background(), 1, f.conversation.ID)
			if err != nil {
				t.Fatal(err)
			}
			if (kind == "kill_unknown" && binding.State != CloudWorkspaceCleanupPending) || (kind == "operation_unknown" && binding.State != CloudWorkspaceClosed) {
				t.Fatalf("cleanup fact was overwritten: %s", binding.State)
			}
			ops, _ := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
			for _, op := range ops {
				if op.Name == "execute_code" && ((kind == "kill_unknown" && op.State != CloudToolCancelled) || (kind == "operation_unknown" && op.State != CloudToolUnknown)) {
					t.Fatalf("remote operation fact was overwritten: %s", op.State)
				}
			}
			status, snapshot := f.request(t, http.MethodGet, "/api/web-chat/runs/"+run.ID, "synthetic-browser-cookie", "")
			if status != 200 || !strings.Contains(snapshot, cloudCancellationOutcomeUnknown) || strings.Contains(snapshot, "synthetic-model-key") {
				t.Fatal("public snapshot did not preserve safe unknown state")
			}
			events, _ := f.store.ListCloudRunEvents(context.Background(), 1, run.ID, 0, 100)
			last := events[len(events)-1]
			var data struct {
				Message string `json:"message"`
			}
			if last.Type != "run.interrupted" || json.Unmarshal(last.Payload, &data) != nil || data.Message != cloudCancellationOutcomeNotice {
				t.Fatal("terminal event omitted the honest cancellation notice")
			}
			status, _ = f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", requestBody)
			if status != 200 || f.calls.Load() != 1 || sdk.code.Load() != 1 || sdk.killed.Load() != 1 {
				t.Fatal("unknown cancellation replay re-executed model or remote effect")
			}
			messages, _ := f.store.ListCloudMessages(context.Background(), 1, f.conversation.ID)
			if len(messages) != 2 || messages[1].ID != run.AssistantMessageID {
				t.Fatal("partial canonical history duplicated or lost")
			}
		})
	}
}

func TestCloudRunCancellationFactsMemory(t *testing.T) {
	testCloudRunCancellationFacts(t, memoryCloudToolFixture)
}
func TestCloudRunCancellationFactsPostgres(t *testing.T) {
	testCloudRunCancellationFacts(t, postgresCloudToolFixture)
}

func testCloudRunCancellationFacts(t *testing.T, factory func(*testing.T) cloudToolFixture) {
	f := factory(t)
	ctx := context.Background()
	first := toolRunningRun(t, f, 7, "")
	op, _, err := f.tools.PrepareCloudTool(ctx, 7, first.ID, first.LeaseOwner, first.Attempt, toolInput("uncertain"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.tools.StartCloudTool(ctx, 7, op.ID, first.LeaseOwner, first.Attempt); err != nil {
		t.Fatal(err)
	}
	if _, err = f.tools.CommitCloudTool(ctx, 7, op.ID, first.LeaseOwner, first.Attempt, CloudToolUnknown, nil, "unknown_result"); err != nil {
		t.Fatal(err)
	}
	binding, _, err := f.tools.ReserveCloudWorkspace(ctx, 7, first.ID, first.LeaseOwner, first.Attempt, 300, 3600)
	if err != nil {
		t.Fatal(err)
	}
	binding, err = f.tools.RecordCloudWorkspaceReceipt(ctx, 7, binding.ID, binding.CreateOperationID, binding.Version, workspaceReceipt("cancel-owned-vm"))
	if err != nil {
		t.Fatal(err)
	}
	second := toolRunningRun(t, f, 7, "")
	store := f.runs.(cloudRunCancellationStore)
	if uncertain, err := store.HasUncertainCloudRunOperations(ctx, 7, second.ID); err != nil || uncertain {
		t.Fatal("another conversation's operation affected cancellation")
	}
	if _, err := store.GetCloudRunCancellationWorkspace(ctx, 7, second.ID, binding.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("another conversation workspace crossed scope")
	}
	if _, err := store.HasUncertainCloudRunOperations(ctx, 8, first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign account facts disclosed")
	}
	runtime := &cloudRunRuntime{store: f.runs}
	if state, code := runtime.cancelledOutcome(ctx, second, &cloudRunExecutionFacts{}); state != CloudRunCancelled || code != "" {
		t.Fatal("unrelated pending cleanup made a clean cancellation unknown")
	}
	if uncertain, err := store.HasUncertainCloudRunOperations(ctx, 7, first.ID); err != nil || !uncertain {
		t.Fatal("owned unknown operation lost")
	}
	if _, err = f.runs.CancelCloudRun(ctx, 7, first.ID); err != nil {
		t.Fatal(err)
	}
	items, err := f.tools.RequestCloudWorkspaceCleanup(ctx, 7, binding.ID)
	if err != nil || len(items) != 1 {
		t.Fatal("missing durable cleanup")
	}
	if err = f.tools.CommitCloudWorkspaceCleanup(ctx, 7, items[0].ID, items[0].Version, true, ""); err != nil {
		t.Fatal(err)
	}
	if state, code := runtime.cancelledOutcome(ctx, first, &cloudRunExecutionFacts{workspace: binding, cleanupAttempted: true}); state != CloudRunInterrupted || code != cloudCancellationOutcomeUnknown {
		t.Fatal("closed VM hid unknown operation effects")
	}
	if _, err = f.tools.CommitCloudTool(ctx, 7, op.ID, first.LeaseOwner, first.Attempt, CloudToolCancelled, nil, ""); err != nil {
		t.Fatal(err)
	}
	if state, code := runtime.cancelledOutcome(ctx, first, &cloudRunExecutionFacts{workspace: binding, cleanupAttempted: true}); state != CloudRunCancelled || code != "" {
		t.Fatal("confirmed terminal facts were not accepted")
	}
}
