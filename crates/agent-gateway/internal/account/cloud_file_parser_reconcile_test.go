package account

import (
	"context"
	"testing"
	"time"
)

func runCloudParserReconcileContract(t *testing.T, p *cloudFileParser, stub *fileParserHTTPStub, files CloudFileStore, file *CloudFile) {
	t.Helper()
	ctx := context.Background()
	userID := int64(1)
	stub.ackCheck = func(id string) {
		stored, err := files.GetCloudFile(ctx, userID, file.ID)
		if err != nil || stored.ParseTask == nil {
			t.Error("ACK preceded durable parser task")
			return
		}
		fact, exists := stored.ParseTask.Operations[id]
		if !exists && stored.ParseTask.ReconcileOperationID == id {
			if !stored.ParseTask.ReconcileReceipt.Terminal() {
				t.Error("ACK preceded durable reconcile receipt")
			}
			return
		}
		if !exists || !fact.Receipt.Terminal() {
			t.Error("ACK preceded durable terminal step")
		}
	}
	if err := p.process(ctx, userID, file.ID); err == nil {
		t.Fatal("unknown create pretended to parse successfully")
	}
	stored, err := files.GetCloudFile(ctx, userID, file.ID)
	if err != nil || stored.ParseTask == nil || !stored.ParseTask.VMStopped || len(stored.ParseTask.CleanupSandboxIDs) != 2 || stored.State != CloudFileFailed || stored.ErrorCode != "parse_unknown" {
		t.Fatalf("metadata cleanup result not durable: %+v %v", stored, err)
	}
	stub.mu.Lock()
	if stub.seen["sandbox.create"] != 1 || stub.seen["sandbox.reconcile"] != 1 || stub.seen["sandbox.kill"] != 2 || len(stub.acked) != 3 {
		t.Error("create repeated or scoped candidates/ACKs were lost")
	}
	if stub.acked[parserOperationID(stored.ParseTask.ID, "create")] {
		t.Error("unknown create was acknowledged")
	}
	for _, operation := range stub.requests {
		if operation.OwnerScope != stored.ParseTask.OwnerScope || operation.WorkspaceRef != stored.ParseTask.WorkspaceRef {
			t.Error("cleanup operation lost original SDK owner/workspace scope")
		}
		if operation.Action != "sandbox.create" && operation.Action != "sandbox.reconcile" && operation.Action != "sandbox.kill" {
			t.Error("cleanup-only reconciliation resumed file/code execution")
		}
		if operation.Action == "sandbox.reconcile" && operation.Input["create_operation_id"] != parserOperationID(stored.ParseTask.ID, "create") {
			t.Error("reconcile changed original allocation identity")
		}
	}
	stub.mu.Unlock()
	if err = p.process(ctx, userID, file.ID); err != nil {
		t.Fatal(err)
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if stub.seen["sandbox.kill"] != 2 || stub.seen["sandbox.create"] != 1 {
		t.Error("finished cleanup repeated remote mutations")
	}
}

func TestCloudFileParserReconcilesOriginalAllocationAndAllOwnedCandidates(t *testing.T) {
	for _, mode := range []string{"create-unknown-reconcile", "create-unknown-reconcile-unsafe", "create-unknown-reconcile-policy-unknown"} {
		t.Run(mode, func(t *testing.T) {
			f := newCloudFileHTTPFixture(t)
			file := f.upload(t, "unknown.pdf", []byte("%PDF-1.7\nsynthetic"))
			p, stub := parserForFixture(t, f, mode)
			runCloudParserReconcileContract(t, p, stub, f.store, file)
		})
	}
}

func TestCloudFileParserReconcilePostgresContract(t *testing.T) {
	for _, mode := range []string{"create-unknown-reconcile", "create-unknown-reconcile-unsafe", "create-unknown-reconcile-policy-unknown"} {
		t.Run(mode, func(t *testing.T) {
			f := newCloudFileHTTPFixture(t)
			uploaded := f.upload(t, "unknown.pdf", []byte("%PDF-1.7\nsynthetic"))
			source, _ := f.store.GetCloudFile(context.Background(), 1, uploaded.ID)
			fixture := cloudRunPostgresFixture(t)
			store := fixture.store.(*PersistentStore)
			if _, err := store.db.Exec(CloudFileSchema + CloudAllocationSchema); err != nil {
				t.Fatal(err)
			}
			if err := store.PutCloudConversation(context.Background(), f.conversation); err != nil {
				t.Fatal(err)
			}
			source.State = CloudFileUploading
			file, err := store.CreateCloudFile(context.Background(), source)
			if err != nil {
				t.Fatal(err)
			}
			file, err = store.UpdateCloudFile(context.Background(), 1, file.ID, file.Version, CloudFileUpdate{State: CloudFileUploaded, MarkUploaded: true, ProcessingStage: "awaiting_isolated_parser"})
			if err != nil {
				t.Fatal(err)
			}
			p, stub := parserForFixture(t, f, mode)
			p.provider = &cloudFileService{metadata: store, objects: f.objects}
			runCloudParserReconcileContract(t, p, stub, store, file)
		})
	}
}

func TestCloudFileParserReconcileEmptyInvalidOrUnconfirmedNeverClaimsStopped(t *testing.T) {
	for _, mode := range []string{"create-unknown", "create-unknown-reconcile-overlimit", "create-unknown-reconcile-invalid", "create-unknown-reconcile-foreign-create", "create-unknown-reconcile-foreign-scope", "create-unknown-reconcile-missing-cleanup-only", "create-unknown-reconcile-not-cleanup-only", "create-unknown-reconcile-kill-unknown", "create-unknown-reconcile-unsafe-kill-unknown"} {
		t.Run(mode, func(t *testing.T) {
			f := newCloudFileHTTPFixture(t)
			file := f.upload(t, "unknown.pdf", []byte("%PDF-1.7\nsynthetic"))
			p, stub := parserForFixture(t, f, mode)
			_ = p.process(context.Background(), 1, file.ID)
			stored, _ := f.store.GetCloudFile(context.Background(), 1, file.ID)
			if stored.ParseTask == nil || stored.ParseTask.VMStopped || stored.ErrorCode != "parse_unknown" || stored.ParseTask.ReconcileOperationID == "" {
				t.Fatal("unverified cleanup claimed success")
			}
			_ = p.process(context.Background(), 1, file.ID)
			stub.mu.Lock()
			defer stub.mu.Unlock()
			if stub.seen["sandbox.create"] != 1 || stub.seen["sandbox.reconcile"] != 1 {
				t.Fatal("unknown result caused fresh allocation or unbounded immediate queries")
			}
			if mode == "create-unknown-reconcile-kill-unknown" || mode == "create-unknown-reconcile-unsafe-kill-unknown" {
				if stub.seen["sandbox.kill"] != 2 || len(stored.ParseTask.CleanupSandboxIDs) != 2 {
					t.Fatal("cleanup did not attempt both owned VMs before preserving unknown termination")
				}
			} else if stub.seen["sandbox.kill"] != 0 || len(stored.ParseTask.CleanupSandboxIDs) != 0 {
				t.Fatal("unverified identity or missing cleanup-only authority permitted VM mutation")
			}
		})
	}
}

func TestCloudFileParserReconcileCanObserveLaterWithoutAllocatingAgain(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	file := f.upload(t, "unknown.pdf", []byte("%PDF-1.7\nsynthetic"))
	p, stub := parserForFixture(t, f, "create-unknown")
	_ = p.process(context.Background(), 1, file.ID)
	stored, _ := f.store.GetCloudFile(context.Background(), 1, file.ID)
	task := cloneCloudFileParse(stored.ParseTask)
	task.ReconcileAfter = time.Now().Add(-time.Second)
	_, err := f.store.UpdateCloudFile(context.Background(), 1, file.ID, stored.Version, CloudFileUpdate{State: stored.State, ErrorCode: stored.ErrorCode, ParseTask: task})
	if err != nil {
		t.Fatal(err)
	}
	stub.mu.Lock()
	stub.mode = "create-unknown-reconcile"
	stub.mu.Unlock()
	if err = p.process(context.Background(), 1, file.ID); err != nil {
		t.Fatal(err)
	}
	stored, _ = f.store.GetCloudFile(context.Background(), 1, file.ID)
	if !stored.ParseTask.VMStopped {
		t.Fatal("later scoped metadata was not reconciled")
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if stub.seen["sandbox.create"] != 1 || stub.seen["sandbox.reconcile"] != 2 || stub.seen["sandbox.kill"] != 2 {
		t.Fatal("later observation recreated sandbox or lost candidate")
	}
}
