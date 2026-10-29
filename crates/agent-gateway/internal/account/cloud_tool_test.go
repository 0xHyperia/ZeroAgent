package account

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

type cloudToolFixture struct {
	cloudRunTestFixture
	tools CloudToolStore
}

func memoryCloudToolFixture(t *testing.T) cloudToolFixture {
	base := cloudRunMemoryFixture(t)
	if err := base.store.(CloudRunAdmissionStore).ConfigureCloudRunAdmission(context.Background(), CloudRunAdmissionLimits{MaxExecutingPerAccount: 8, MaxQueuedPerAccount: 200}); err != nil {
		t.Fatal(err)
	}
	return cloudToolFixture{base, base.store.(*MemoryStore)}
}
func postgresCloudToolFixture(t *testing.T) cloudToolFixture {
	base := cloudRunPostgresFixture(t)
	store := base.store.(*PersistentStore)
	if _, err := store.db.Exec(CloudToolSchema); err != nil {
		t.Fatalf("create durable cloud tool schema: %v", err)
	}
	if err := store.ConfigureCloudRunAdmission(context.Background(), CloudRunAdmissionLimits{MaxExecutingPerAccount: 8, MaxQueuedPerAccount: 200}); err != nil {
		t.Fatal(err)
	}
	return cloudToolFixture{base, store}
}

func toolRunningRun(t *testing.T, f cloudToolFixture, userID int64, conversationID string) *CloudRun {
	t.Helper()
	input := cloudRunTestInput(t, f.cloudRunTestFixture, userID, conversationID, "tool-"+uuid.NewString(), "work")
	accepted, _, err := f.runs.CreateCloudRun(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.runs.ClaimCloudRun(context.Background(), "tool-worker", time.Minute)
	if err != nil || run == nil || run.ID != accepted.ID {
		t.Fatalf("claim tool Run: %v", err)
	}
	return run
}

func toolInput(call string) *CloudToolOperation {
	return &CloudToolOperation{CallKey: call, Name: "code.execute", Input: json.RawMessage(`{"code":"print(1)","timeout_ms":1000}`)}
}
func workspaceReceipt(id string) CloudWorkspaceReceipt {
	now := time.Now().UTC()
	return CloudWorkspaceReceipt{SandboxID: id, State: CloudWorkspaceReady, StartedAt: now, ExpiresAt: now.Add(time.Minute)}
}

func TestCloudToolContractMemory(t *testing.T)   { testCloudToolContract(t, memoryCloudToolFixture) }
func TestCloudToolContractPostgres(t *testing.T) { testCloudToolContract(t, postgresCloudToolFixture) }

func testCloudToolContract(t *testing.T, factory func(*testing.T) cloudToolFixture) {
	ctx := context.Background()
	t.Run("atomic prepare dedup and semantic request hash conflict", func(t *testing.T) {
		f := factory(t)
		run := toolRunningRun(t, f, 7, "")
		var created atomic.Int32
		var wg sync.WaitGroup
		ids := make(chan string, 8)
		for range 8 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				op, fresh, err := f.tools.PrepareCloudTool(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, toolInput("round:0:call:0"))
				if err != nil {
					t.Error(err)
					return
				}
				if fresh {
					created.Add(1)
				}
				ids <- op.ID
			}()
		}
		wg.Wait()
		close(ids)
		first := ""
		for id := range ids {
			if first == "" {
				first = id
			} else if first != id {
				t.Fatal("one call generated multiple operation IDs")
			}
		}
		if created.Load() != 1 {
			t.Fatal("prepare did not atomically deduplicate")
		}
		changed := toolInput("round:0:call:0")
		changed.Input = json.RawMessage(`{"code":"print(2)"}`)
		if _, _, err := f.tools.PrepareCloudTool(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, changed); !errors.Is(err, ErrCloudToolConflict) {
			t.Fatal("payload hash conflict accepted")
		}
		if _, err := f.tools.GetCloudToolOperation(ctx, 8, first); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign operation exposed")
		}
		op, err := f.tools.GetCloudToolOperation(ctx, 7, first)
		if err != nil {
			t.Fatal(err)
		}
		public, _ := json.Marshal(op)
		if strings.Contains(string(public), "print(1)") || strings.Contains(string(public), "request_hash") || strings.Contains(string(public), "execution_attempt") {
			t.Fatal("private operation data exposed by progress JSON")
		}
	})
	t.Run("execution fenced, terminal idempotent and unknown never restarted", func(t *testing.T) {
		f := factory(t)
		run := toolRunningRun(t, f, 7, "")
		op, _, err := f.tools.PrepareCloudTool(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, toolInput("round:0:call:0"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.tools.StartCloudTool(ctx, 7, op.ID, "other-worker", run.Attempt); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatal("foreign lease started operation")
		}
		op, err = f.tools.StartCloudTool(ctx, 7, op.ID, run.LeaseOwner, run.Attempt)
		if err != nil || op.State != CloudToolExecuting {
			t.Fatal(err)
		}
		op, err = f.tools.CommitCloudTool(ctx, 7, op.ID, run.LeaseOwner, run.Attempt, CloudToolUnknown, nil, "execution_unknown")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.tools.StartCloudTool(ctx, 7, op.ID, run.LeaseOwner, run.Attempt); !errors.Is(err, ErrCloudToolConflict) {
			t.Fatal("unknown operation restarted")
		}
		result := json.RawMessage(`{"stdout":"private result"}`)
		op, err = f.tools.CommitCloudTool(ctx, 7, op.ID, run.LeaseOwner, run.Attempt, CloudToolSucceeded, result, "")
		if err != nil {
			t.Fatal(err)
		}
		version := op.Version
		op, err = f.tools.CommitCloudTool(ctx, 7, op.ID, run.LeaseOwner, run.Attempt, CloudToolSucceeded, result, "")
		if err != nil || op.Version != version {
			t.Fatal("duplicate commit changed terminal operation")
		}
		if _, err = f.tools.CommitCloudTool(ctx, 7, op.ID, run.LeaseOwner, run.Attempt, CloudToolFailed, nil, "execution_failed"); !errors.Is(err, ErrCloudToolConflict) {
			t.Fatal("terminal result overwritten")
		}
		f.expire(run.ID)
		if _, _, err = f.tools.PrepareCloudTool(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, toolInput("late")); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatal("expired worker prepared new operation")
		}
	})
	t.Run("cancel blocks new effects but allows same lease cancellation facts", func(t *testing.T) {
		f := factory(t)
		run := toolRunningRun(t, f, 7, "")
		op, _, err := f.tools.PrepareCloudTool(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, toolInput("first"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.CancelCloudRun(ctx, 7, run.ID); err != nil {
			t.Fatal(err)
		}
		if _, err = f.tools.StartCloudTool(ctx, 7, op.ID, run.LeaseOwner, run.Attempt); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatal("cancelled run started a prepared operation")
		}
		if _, _, err = f.tools.PrepareCloudTool(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, toolInput("second")); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatal("cancelled run prepared another operation")
		}
		if _, err = f.tools.CommitCloudTool(ctx, 7, op.ID, run.LeaseOwner, run.Attempt, CloudToolCancelled, nil, "cancelled"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("workspace reservation is durable bounded and unknown does not refund", func(t *testing.T) {
		f := factory(t)
		run := toolRunningRun(t, f, 7, "")
		binding, created, err := f.tools.ReserveCloudWorkspace(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, 60, 60)
		if err != nil || !created {
			t.Fatal(err)
		}
		unknown, err := f.tools.RecordCloudWorkspaceReceipt(ctx, 7, binding.ID, binding.CreateOperationID, binding.Version, CloudWorkspaceReceipt{State: CloudWorkspaceUnknown})
		if err != nil || unknown.State != CloudWorkspaceUnknown {
			t.Fatal(err)
		}
		reused, created, err := f.tools.ReserveCloudWorkspace(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, 60, 60)
		if err != nil || created || reused.ID != binding.ID || reused.CreateOperationID != binding.CreateOperationID {
			t.Fatal("unknown allocation created another operation")
		}
		other := toolRunningRun(t, f, 7, "")
		if _, _, err = f.tools.ReserveCloudWorkspace(ctx, 7, other.ID, other.LeaseOwner, other.Attempt, 60, 60); !errors.Is(err, ErrCloudToolQuota) {
			t.Fatal("unknown allocation released its seconds budget")
		}
		foreign := toolRunningRun(t, f, 8, "")
		if _, _, err = f.tools.ReserveCloudWorkspace(ctx, 8, foreign.ID, foreign.LeaseOwner, foreign.Attempt, 60, 60); err != nil {
			t.Fatal("one account consumed another's allocation budget")
		}
		if _, err = f.runs.CancelCloudRun(ctx, 7, run.ID); err != nil {
			t.Fatal(err)
		}
		cleanup, err := f.tools.ListCloudWorkspaceCleanup(ctx, 100)
		if err != nil || len(cleanup) != 1 || cleanup[0].SandboxID != "" || cleanup[0].CreateOperationID != binding.CreateOperationID {
			t.Fatal("unknown creation lost its reconciliation identity")
		}
		if err = f.tools.CommitCloudWorkspaceCleanup(ctx, 7, cleanup[0].ID, cleanup[0].Version, true, ""); err != nil {
			t.Fatal(err)
		}
		if _, _, err = f.tools.ReserveCloudWorkspace(ctx, 7, other.ID, other.LeaseOwner, other.Attempt, 60, 60); !errors.Is(err, ErrCloudToolQuota) {
			t.Fatal("cleanup falsely refunded full allocation")
		}
	})
	t.Run("ready reuse and every late distinct VM keeps cleanup facts", func(t *testing.T) {
		f := factory(t)
		run := toolRunningRun(t, f, 7, "")
		binding, _, err := f.tools.ReserveCloudWorkspace(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, 60, 180)
		if err != nil {
			t.Fatal(err)
		}
		receipt := workspaceReceipt("sandbox-primary")
		ready, err := f.tools.RecordCloudWorkspaceReceipt(ctx, 7, binding.ID, binding.CreateOperationID, binding.Version, receipt)
		if err != nil || ready.State != CloudWorkspaceReady {
			t.Fatal(err)
		}
		if _, err = f.runs.CommitCloudRun(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, CloudRunCommit{OperationID: "tool-run-finish", State: CloudRunCompleted}); err != nil {
			t.Fatal(err)
		}
		next := toolRunningRun(t, f, 7, run.ConversationID)
		reused, created, err := f.tools.ReserveCloudWorkspace(ctx, 7, next.ID, next.LeaseOwner, next.Attempt, 60, 180)
		if err != nil || created || reused.ID != ready.ID {
			t.Fatal("ready conversation workspace was not reused")
		}
		duplicate, err := f.tools.RecordCloudWorkspaceReceipt(ctx, 7, binding.ID, binding.CreateOperationID, binding.Version, receipt)
		if err != nil || duplicate.State != CloudWorkspaceReady {
			t.Fatal("late immutable receipt downgraded an active workspace")
		}
		if _, err = f.tools.RecordCloudWorkspaceReceipt(ctx, 7, binding.ID, binding.CreateOperationID, binding.Version, workspaceReceipt("sandbox-late-duplicate")); !errors.Is(err, ErrCloudToolConflict) {
			t.Fatal("duplicate VM overwrote canonical binding")
		}
		cleanup, err := f.tools.ListCloudWorkspaceCleanup(ctx, 100)
		if err != nil || len(cleanup) != 1 || cleanup[0].SandboxID != "sandbox-late-duplicate" {
			t.Fatal("late duplicate VM was orphaned")
		}
		if err = f.tools.CommitCloudWorkspaceCleanup(ctx, 7, cleanup[0].ID, cleanup[0].Version, true, ""); err != nil {
			t.Fatal(err)
		}
		current, err := f.tools.GetCloudWorkspace(ctx, 7, run.ConversationID)
		if err != nil || current.State != CloudWorkspaceReady || current.SandboxID != "sandbox-primary" {
			t.Fatal("cleanup of duplicate closed the canonical live workspace")
		}
		if err = f.store.DeleteCloudConversation(ctx, 7, run.ConversationID); err != nil {
			t.Fatal(err)
		}
		if _, err = f.tools.GetCloudWorkspace(ctx, 7, run.ConversationID); !errors.Is(err, ErrNotFound) {
			t.Fatal("deleted conversation still exposed workspace")
		}
		cleanup, err = f.tools.ListCloudWorkspaceCleanup(ctx, 100)
		if err != nil || len(cleanup) != 1 || cleanup[0].SandboxID != "sandbox-primary" {
			t.Fatal("conversation deletion lost owned VM cleanup facts")
		}
	})
	t.Run("late creation after cancel only records cleanup, not execution authority", func(t *testing.T) {
		f := factory(t)
		run := toolRunningRun(t, f, 7, "")
		binding, _, err := f.tools.ReserveCloudWorkspace(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, 60, 120)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.CancelCloudRun(ctx, 7, run.ID); err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.CommitCloudRun(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, CloudRunCommit{OperationID: "cancel-finish", State: CloudRunCancelled}); err != nil {
			t.Fatal(err)
		}
		observed, err := f.tools.RecordCloudWorkspaceReceipt(ctx, 7, binding.ID, binding.CreateOperationID, binding.Version, workspaceReceipt("sandbox-after-cancel"))
		if err != nil || observed.State != CloudWorkspaceCleanupPending {
			t.Fatal("late create became executable or was lost")
		}
		items, err := f.tools.ListCloudWorkspaceCleanup(ctx, 100)
		if err != nil || len(items) != 1 || items[0].SandboxID != "sandbox-after-cancel" {
			t.Fatal("late VM missing from durable cleanup")
		}
		if _, err = f.tools.RecordCloudWorkspaceReceipt(ctx, 8, binding.ID, binding.CreateOperationID, binding.Version, workspaceReceipt("foreign-vm")); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign account added workspace facts")
		}
	})
	t.Run("new generation survives old receipts and reservation duration is enforced", func(t *testing.T) {
		f := factory(t)
		run := toolRunningRun(t, f, 7, "")
		old, _, err := f.tools.ReserveCloudWorkspace(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, 60, 180)
		if err != nil {
			t.Fatal(err)
		}
		closed, err := f.tools.RecordCloudWorkspaceReceipt(ctx, 7, old.ID, old.CreateOperationID, old.Version, CloudWorkspaceReceipt{State: CloudWorkspaceClosed})
		if err != nil || closed.State != CloudWorkspaceClosed {
			t.Fatal(err)
		}
		fresh, created, err := f.tools.ReserveCloudWorkspace(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, 60, 180)
		if err != nil || !created || fresh.ID == old.ID {
			t.Fatal("closed binding did not produce distinct generation")
		}
		if _, err = f.tools.RecordCloudWorkspaceReceipt(ctx, 7, old.ID, old.CreateOperationID, old.Version, workspaceReceipt("old-late-vm")); !errors.Is(err, ErrCloudToolConflict) {
			t.Fatal("old generation accepted a late VM as active")
		}
		current, err := f.tools.GetCloudWorkspace(ctx, 7, run.ConversationID)
		if err != nil || current.ID != fresh.ID || current.State != CloudWorkspacePrepared {
			t.Fatal("old receipt clobbered newer workspace")
		}
		tooLong := workspaceReceipt("overlong-vm")
		tooLong.ExpiresAt = tooLong.StartedAt.Add(2 * time.Minute)
		current, err = f.tools.RecordCloudWorkspaceReceipt(ctx, 7, fresh.ID, fresh.CreateOperationID, fresh.Version, tooLong)
		if err != nil || current.State != CloudWorkspaceCleanupPending {
			t.Fatal("VM exceeded its reserved allocation duration")
		}
		cleanup, err := f.tools.ListCloudWorkspaceCleanup(ctx, 100)
		if err != nil || len(cleanup) != 2 {
			t.Fatal("old/overlong VM cleanup facts lost")
		}
	})
	t.Run("concurrent account reservations cannot overspend allocation seconds", func(t *testing.T) {
		f := factory(t)
		first := toolRunningRun(t, f, 7, "")
		second := toolRunningRun(t, f, 7, "")
		var success atomic.Int32
		var quota atomic.Int32
		var wg sync.WaitGroup
		for _, run := range []*CloudRun{first, second} {
			wg.Add(1)
			go func(run *CloudRun) {
				defer wg.Done()
				if _, _, err := f.tools.ReserveCloudWorkspace(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, 60, 60); err == nil {
					success.Add(1)
				} else if errors.Is(err, ErrCloudToolQuota) {
					quota.Add(1)
				} else {
					t.Error(err)
				}
			}(run)
		}
		wg.Wait()
		if success.Load() != 1 || quota.Load() != 1 {
			t.Fatal("concurrent allocation overran the account/day budget")
		}
	})
	t.Run("explicit safety cleanup is owned durable and idempotent", func(t *testing.T) {
		f := factory(t)
		run := toolRunningRun(t, f, 7, "")
		binding, _, err := f.tools.ReserveCloudWorkspace(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, 60, 120)
		if err != nil {
			t.Fatal(err)
		}
		binding, err = f.tools.RecordCloudWorkspaceReceipt(ctx, 7, binding.ID, binding.CreateOperationID, binding.Version, workspaceReceipt("cleanup-owned-vm"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.tools.RequestCloudWorkspaceCleanup(ctx, 8, binding.ID); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign cleanup accepted")
		}
		rows, err := f.tools.RequestCloudWorkspaceCleanup(ctx, 7, binding.ID)
		if err != nil || len(rows) != 1 || rows[0].SandboxID != "cleanup-owned-vm" {
			t.Fatal("explicit cleanup lost canonical sandbox")
		}
		again, err := f.tools.RequestCloudWorkspaceCleanup(ctx, 7, binding.ID)
		if err != nil || len(again) != 1 || again[0].ID != rows[0].ID || again[0].Version != rows[0].Version || again[0].CleanupOperationID != rows[0].CleanupOperationID {
			t.Fatal("cleanup retry changed external operation identity")
		}
		if err = f.tools.CommitCloudWorkspaceCleanup(ctx, 7, rows[0].ID, rows[0].Version, true, ""); err != nil {
			t.Fatal(err)
		}
		remaining, err := f.tools.RequestCloudWorkspaceCleanup(ctx, 7, binding.ID)
		if err != nil || len(remaining) != 0 {
			t.Fatal("confirmed closed VM returned to cleanup")
		}
	})
	t.Run("operation payload quota and private deletion boundary", func(t *testing.T) {
		f := factory(t)
		run := toolRunningRun(t, f, 7, "")
		oversize := toolInput("oversize")
		oversize.Input, _ = json.Marshal(strings.Repeat("x", CloudToolMaxInput))
		if _, _, err := f.tools.PrepareCloudTool(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, oversize); !errors.Is(err, ErrCloudToolInvalid) {
			t.Fatal("oversized operation input accepted")
		}
		var first *CloudToolOperation
		for index := range CloudToolMaxRunOperations {
			op, _, err := f.tools.PrepareCloudTool(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, toolInput("capacity:"+strconv.Itoa(index)))
			if err != nil {
				t.Fatal(err)
			}
			if first == nil {
				first = op
			}
		}
		if _, _, err := f.tools.PrepareCloudTool(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, toolInput("capacity:overflow")); !errors.Is(err, ErrCloudToolQuota) {
			t.Fatal("operation count exceeded run quota")
		}
		if _, err := f.tools.ListCloudToolOperations(ctx, 7, run.ID, CloudToolMaxRunOperations+1); !errors.Is(err, ErrCloudToolInvalid) {
			t.Fatal("unbounded operation list accepted")
		}
		if err := f.store.DeleteCloudConversation(ctx, 7, run.ConversationID); err != nil {
			t.Fatal(err)
		}
		if _, err := f.tools.GetCloudToolOperation(ctx, 7, first.ID); !errors.Is(err, ErrNotFound) {
			t.Fatal("deleted history retained readable private tool bodies")
		}
	})
}

func TestCloudToolRequestHashPreservesIntegerPrecision(t *testing.T) {
	left, err := CloudToolRequestHash("code.execute", json.RawMessage(`{"n":9007199254740992,"a":1}`))
	if err != nil {
		t.Fatal(err)
	}
	same, err := CloudToolRequestHash("code.execute", json.RawMessage(`{"a": 1, "n": 9007199254740992}`))
	if err != nil || same != left {
		t.Fatal("object formatting changed request identity")
	}
	right, err := CloudToolRequestHash("code.execute", json.RawMessage(`{"n":9007199254740993,"a":1}`))
	if err != nil || right == left {
		t.Fatal("large integers collapsed into one operation identity")
	}
}
