package account

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

type fileParserHTTPStub struct {
	mu           sync.Mutex
	ops          map[string]cloudexecutor.Receipt
	seen         map[string]int
	requests     map[string]cloudexecutor.Operation
	original     []byte
	output       []byte
	mode         string
	parseEntered chan struct{}
	entered      sync.Once
	acked        map[string]bool
	ackCheck     func(string)
}

func newFileParserHTTPStub(t *testing.T, mode string) (*cloudexecutor.Client, *fileParserHTTPStub) {
	t.Helper()
	stub := &fileParserHTTPStub{ops: map[string]cloudexecutor.Receipt{}, seen: map[string]int{}, requests: map[string]cloudexecutor.Operation{}, acked: map[string]bool{}, mode: mode, parseEntered: make(chan struct{})}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-parser-internal-token-0123456789-abcdef" {
			t.Error("missing executor authentication")
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/health" {
			_ = json.NewEncoder(w).Encode(map[string]any{"service": "zeroagent-cloud-executor", "protocol": 1, "enabled": true})
			return
		}
		stub.mu.Lock()
		defer stub.mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/acknowledge") {
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/operations/"), "/acknowledge")
			receipt, exists := stub.ops[id]
			if !exists || !receipt.Terminal() || receipt.State == cloudexecutor.StateUnknown {
				t.Error("unsafe parser ACK")
			}
			if stub.ackCheck != nil {
				stub.ackCheck(id)
			}
			stub.acked[id] = true
			_ = json.NewEncoder(w).Encode(map[string]any{"operation_id": id, "acknowledged": true})
			return
		}
		if r.Method == http.MethodGet {
			id := strings.TrimPrefix(r.URL.Path, "/v1/operations/")
			receipt, exists := stub.ops[id]
			if !exists {
				w.WriteHeader(404)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": "operation_not_found"}})
				return
			}
			_ = json.NewEncoder(w).Encode(receipt)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/cancel") {
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/operations/"), "/cancel")
			receipt := stub.ops[id]
			receipt.State = cloudexecutor.StateCancelled
			receipt.Result = json.RawMessage(`{"sandbox_terminated":true}`)
			stub.ops[id] = receipt
			_ = json.NewEncoder(w).Encode(receipt)
			return
		}
		var op cloudexecutor.Operation
		if json.NewDecoder(r.Body).Decode(&op) != nil {
			t.Error("bad request")
		}
		stub.seen[op.Action]++
		stub.requests[op.OperationID] = op
		if op.OwnerScope != cloudFileParserOwner(1) || !strings.HasPrefix(op.WorkspaceRef, "file-") {
			t.Error("owner/workspace binding lost")
		}
		if prior, exists := stub.ops[op.OperationID]; exists {
			_ = json.NewEncoder(w).Encode(prior)
			return
		}
		receipt := cloudexecutor.Receipt{OperationID: op.OperationID, Action: op.Action, State: cloudexecutor.StateSucceeded, CreatedAt: time.Now(), UpdatedAt: time.Now()}
		var result any = map[string]any{}
		switch op.Action {
		case "sandbox.create":
			result = map[string]any{"sandbox_id": "owned-parser-vm"}
			if strings.HasPrefix(mode, "create-unknown") {
				receipt.State = cloudexecutor.StateUnknown
				result = map[string]any{}
			}
		case "sandbox.reconcile":
			candidates := []any{}
			createID := op.Input["create_operation_id"]
			if strings.HasPrefix(stub.mode, "create-unknown-reconcile") {
				count := 2
				if stub.mode == "create-unknown-reconcile-overlimit" {
					count = 21
				}
				for index := 0; index < count; index++ {
					id, outbound := fmt.Sprintf("reconciled-parser-vm-%d", index), "denied"
					if stub.mode == "create-unknown-reconcile-invalid" {
						id = "../foreign-vm"
					}
					if strings.HasPrefix(stub.mode, "create-unknown-reconcile-unsafe") {
						outbound = "allowed"
					}
					candidate := map[string]any{"sandbox_id": id, "network": map[string]any{"outbound": outbound, "public_access": false}, "auto_resume": false}
					if strings.HasPrefix(stub.mode, "create-unknown-reconcile-unsafe") {
						candidate["network"] = map[string]any{"outbound": outbound, "public_access": true}
						candidate["auto_resume"] = true
						candidate["envd_version"] = "0.4.0"
					}
					if stub.mode == "create-unknown-reconcile-policy-unknown" {
						delete(candidate, "network")
						delete(candidate, "auto_resume")
					}
					candidates = append(candidates, candidate)
				}
			}
			if stub.mode == "create-unknown-reconcile-foreign-create" {
				createID = "different-allocation"
			}
			resultMap := map[string]any{"create_operation_id": createID, "cleanup_only": true, "automatic_retry_safe": false, "candidates": candidates}
			if stub.mode == "create-unknown-reconcile-missing-cleanup-only" {
				delete(resultMap, "cleanup_only")
			}
			if stub.mode == "create-unknown-reconcile-not-cleanup-only" {
				resultMap["cleanup_only"] = false
			}
			if stub.mode == "create-unknown-reconcile-foreign-scope" {
				receipt.State = cloudexecutor.StateFailed
				receipt.Error = &cloudexecutor.ReceiptError{Code: "sandbox_not_found"}
				resultMap["candidates"] = []any{}
			}
			result = resultMap
		case "file.upload.begin":
			result = map[string]any{"received_bytes": 0}
		case "file.upload.chunk":
			chunk, err := base64.StdEncoding.DecodeString(op.Input["data_base64"].(string))
			if err != nil {
				t.Error(err)
			}
			stub.original = append(stub.original, chunk...)
			result = map[string]any{"received_bytes": len(stub.original)}
		case "file.upload.finalize":
			result = map[string]any{"finalized": true, "total_bytes": op.Input["total_bytes"], "sha256": op.Input["sha256"]}
		case "file.parse":
			stub.entered.Do(func() { close(stub.parseEntered) })
			if mode == "pending" {
				receipt.State = cloudexecutor.StateExecuting
				break
			}
			scope := strings.Repeat("a", 64)
			document := cloudFileParsedDocument{Version: 1, Format: "pdf", SourceSHA256: op.Input["source_sha256"].(string), Scope: scope, SandboxID: "owned-parser-vm", Segments: []CloudFileSegment{{ID: "s00001", Locator: CloudFileLocator{Page: 1}, Text: "收入为10，成本为6，利润为4。"}}, Warnings: []string{}}
			if mode == "foreign-scope" {
				document.Scope = strings.Repeat("b", 64)
			}
			if mode == "bad-locator" {
				document.Segments[0].Locator.Page = 0
			}
			stub.output, _ = json.Marshal(document)
			digest := sha256.Sum256(stub.output)
			result = cloudexecutor.ParseResult{SandboxID: "owned-parser-vm", OutputPath: "derived/text.json", Bytes: int64(len(stub.output)), SHA256: hex.EncodeToString(digest[:]), SegmentCount: 1, ScopeHash: scope}
		case "file.download.chunk":
			offset := int(op.Input["offset"].(float64))
			end := offset + int(op.Input["max_bytes"].(float64))
			if end > len(stub.output) {
				end = len(stub.output)
			}
			data := append([]byte(nil), stub.output[offset:end]...)
			if mode == "corrupt-download" && len(data) > 0 {
				data[0] ^= 1
			}
			digest := sha256.Sum256(stub.output)
			result = map[string]any{"offset": offset, "total_bytes": len(stub.output), "sha256": hex.EncodeToString(digest[:]), "data_base64": base64.StdEncoding.EncodeToString(data), "bytes": len(data), "eof": end == len(stub.output)}
		case "sandbox.kill":
			result = map[string]any{"sandbox_id": op.SandboxID, "sandbox_terminated": true}
			if (stub.mode == "create-unknown-reconcile-kill-unknown" || stub.mode == "create-unknown-reconcile-unsafe-kill-unknown") && op.SandboxID == "reconciled-parser-vm-1" {
				receipt.State = cloudexecutor.StateUnknown
			}
		default:
			t.Errorf("unexpected operation %s", op.Action)
		}
		receipt.Result, _ = json.Marshal(result)
		stub.ops[op.OperationID] = receipt
		_ = json.NewEncoder(w).Encode(receipt)
	}))
	t.Cleanup(server.Close)
	client, err := cloudexecutor.New(cloudexecutor.Config{BaseURL: server.URL, Token: "test-parser-internal-token-0123456789-abcdef", PollInterval: 5 * time.Millisecond, RequestTimeout: time.Second, CancelTimeout: time.Second, MaxWait: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseIdleConnections)
	return client, stub
}
func parserForFixture(t *testing.T, f *cloudFileHTTPFixture, mode string) (*cloudFileParser, *fileParserHTTPStub) {
	client, stub := newFileParserHTTPStub(t, mode)
	provider, err := f.service.cloudFileProvider()
	if err != nil {
		t.Fatal(err)
	}
	p := &cloudFileParser{service: f.service, client: client, provider: provider, instance: "test-parser-instance", active: map[string]context.CancelFunc{}, activeDone: map[string]chan struct{}{}}
	return p, stub
}

func TestCloudFileIsolatedParserHTTPPipelineAndOwnedSegments(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	original := []byte("%PDF-1.7\nverified synthetic original")
	file := f.upload(t, "finance.pdf", original)
	p, stub := parserForFixture(t, f, "success")
	if err := p.process(context.Background(), 1, file.ID); err != nil {
		t.Fatal(err)
	}
	stored, err := f.store.GetCloudFile(context.Background(), 1, file.ID)
	if err != nil || stored.State != CloudFileReady || stored.ParseTask == nil || !stored.ParseTask.VMStopped || len(stored.Segments) != 1 || !strings.Contains(stored.Text, "利润") {
		t.Fatalf("file=%+v err=%v", stored, err)
	}
	stub.mu.Lock()
	if string(stub.original) != string(original) || stub.seen["sandbox.create"] != 1 || stub.seen["sandbox.kill"] != 1 {
		t.Fatal("original or cleanup not applied once")
	}
	stub.mu.Unlock()
	status, body, _ := f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/segments", "file-owner", nil, nil)
	if status != 200 || !strings.Contains(string(body), `"page":1`) {
		t.Fatalf("segments %d %s", status, body)
	}
	status, _, _ = f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/segments", "file-other", nil, nil)
	if status != 404 {
		t.Fatal("foreign segment access")
	}
	if err = p.process(context.Background(), 1, file.ID); err != nil {
		t.Fatal(err)
	}
	stub.mu.Lock()
	createCount := stub.seen["sandbox.create"]
	stub.mu.Unlock()
	if createCount != 1 {
		t.Fatal("completed parser reallocated VM")
	}
	status, _, _ = f.request(t, "DELETE", "/api/web-chat/files/"+file.ID, "file-owner", nil, nil)
	if status != 200 {
		t.Fatal("ready deletion failed")
	}
	stored, _ = f.store.GetCloudFile(context.Background(), 1, file.ID)
	if stored.Text != "" || len(stored.Segments) != 0 {
		t.Fatal("deleted parsed body retained")
	}
	for _, operation := range stored.ParseTask.Operations {
		if operation.Receipt.Action == "file.download.chunk" && strings.Contains(string(operation.Receipt.Result), "data_base64") {
			t.Fatal("deleted content-bearing receipt retained")
		}
	}
}

func TestCloudFileParserRejectsCorruptScopeLocatorAndUnknown(t *testing.T) {
	for _, mode := range []string{"foreign-scope", "bad-locator", "corrupt-download", "create-unknown"} {
		t.Run(mode, func(t *testing.T) {
			f := newCloudFileHTTPFixture(t)
			file := f.upload(t, "test.pdf", []byte("%PDF-1.7\nsynthetic"))
			p, stub := parserForFixture(t, f, mode)
			if err := p.process(context.Background(), 1, file.ID); err == nil {
				t.Fatal("invalid extraction accepted")
			}
			stored, _ := f.store.GetCloudFile(context.Background(), 1, file.ID)
			if stored.State != CloudFileFailed || len(stored.Segments) != 0 || stored.Text != "" {
				t.Fatalf("false ready: %+v", stored)
			}
			if mode == "create-unknown" {
				if stored.ErrorCode != "parse_unknown" || stored.ParseTask.VMStopped {
					t.Fatal("unknown falsely resolved")
				}
				_ = p.process(context.Background(), 1, file.ID)
				stub.mu.Lock()
				defer stub.mu.Unlock()
				if stub.seen["sandbox.create"] != 1 {
					t.Fatal("unknown create retried")
				}
			}
		})
	}
}

func TestCloudFileDeleteCancelsIsolatedParseAndRejectsLateReady(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	file := f.upload(t, "test.pdf", []byte("%PDF-1.7\nsynthetic"))
	p, stub := parserForFixture(t, f, "pending")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	p.active[file.ID] = cancel
	p.activeDone[file.ID] = done
	f.service.cloudFileParser = p
	f.service.cloudExecutor = p.client
	go func() { defer close(done); _ = p.process(ctx, 1, file.ID) }()
	select {
	case <-stub.parseEntered:
	case <-time.After(3 * time.Second):
		t.Fatal("parser did not reach external operation")
	}
	status, body, _ := f.request(t, "DELETE", "/api/web-chat/files/"+file.ID, "file-owner", nil, nil)
	if status != 200 {
		t.Fatalf("delete=%d %s", status, body)
	}
	stored, _ := f.store.GetCloudFile(context.Background(), 1, file.ID)
	if stored.State != CloudFileDeleted || stored.DeletedAt == nil || stored.ParseTask == nil || !stored.ParseTask.VMStopped || len(stored.Segments) != 0 {
		t.Fatalf("deletion not fenced: %+v", stored)
	}
	text := "late output"
	if _, err := f.store.UpdateCloudFile(context.Background(), 1, file.ID, stored.Version, CloudFileUpdate{State: CloudFileReady, Text: &text}); !errors.Is(err, ErrCloudFileConflict) {
		t.Fatal("late ready resurrected deleted file")
	}
}

func TestCloudFileParserPostgresPipeline(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	uploaded := f.upload(t, "test.pdf", []byte("%PDF-1.7\nsynthetic"))
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
	p, stub := parserForFixture(t, f, "success")
	p.provider = &cloudFileService{metadata: store, objects: f.objects}
	if err = p.process(context.Background(), 1, file.ID); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetCloudFile(context.Background(), 1, file.ID)
	if err != nil || stored.State != CloudFileReady || len(stored.Segments) != 1 || stored.ParseTask == nil || !stored.ParseTask.VMStopped || len(stored.ParseTask.Operations) < 5 {
		t.Fatalf("SQL facts not persisted: %+v %v", stored, err)
	}
	listed, err := store.ListCloudFiles(context.Background(), 1, "", "", 10)
	if err != nil || len(listed) != 1 || listed[0].TextBytes == 0 || listed[0].Text != "" || listed[0].ParseTask != nil || len(listed[0].Segments) != 0 {
		t.Fatal("SQL metadata page leaked parsed data or lost size")
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if stub.seen["sandbox.create"] != 1 {
		t.Fatal("duplicate SQL allocation")
	}
}

func TestCloudFileParserRestartQueriesOriginalDispatchAndNeverReallocates(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	file := f.upload(t, "test.pdf", []byte("%PDF-1.7\nsynthetic"))
	p, stub := parserForFixture(t, f, "success")
	taskID := "01a19ccc-4f00-7000-8000-000000000001"
	task := &CloudFileParseTask{ID: taskID, FileID: file.ID, SourceSHA256: file.SHA256, OwnerScope: cloudFileParserOwner(1), WorkspaceRef: cloudFileParserWorkspace(file.ID, taskID), State: "running", Stage: "creating_sandbox", LeaseOwner: "old-process", LeaseUntil: time.Now().Add(-time.Minute), Operations: map[string]CloudFileParseOperation{}}
	op := cloudexecutor.Operation{OperationID: parserOperationID(taskID, "create"), OwnerScope: task.OwnerScope, WorkspaceRef: task.WorkspaceRef, Action: "sandbox.create"}
	encoded, _ := json.Marshal(op)
	digest := sha256.Sum256(encoded)
	task.Operations[op.OperationID] = CloudFileParseOperation{RequestHash: hex.EncodeToString(digest[:]), Dispatched: true, Receipt: cloudexecutor.Receipt{OperationID: op.OperationID, Action: op.Action, State: cloudexecutor.StateExecuting}}
	if _, err := f.store.UpdateCloudFile(context.Background(), 1, file.ID, file.Version, CloudFileUpdate{State: CloudFileProcessing, ProcessingStage: task.Stage, ParseTask: task}); err != nil {
		t.Fatal(err)
	}
	// Adapter has no receipt (lost/corrupt journal or request never observed).
	// The database's dispatch fact remains authoritative: no new create POST.
	if err := p.process(context.Background(), 1, file.ID); err == nil {
		t.Fatal("missing receipt was treated as success")
	}
	stored, _ := f.store.GetCloudFile(context.Background(), 1, file.ID)
	if stored.ErrorCode != "parse_unknown" || stored.ParseTask.State != "unknown" {
		t.Fatal("lost dispatch not marked unknown")
	}
	stub.mu.Lock()
	defer stub.mu.Unlock()
	if stub.seen["sandbox.create"] != 0 {
		t.Fatal("restart blindly reallocated VM")
	}
}

func TestCloudFileParserPostgresFailureFacts(t *testing.T) {
	for _, mode := range []string{"create-unknown", "foreign-scope", "corrupt-download"} {
		t.Run(mode, func(t *testing.T) {
			f := newCloudFileHTTPFixture(t)
			uploaded := f.upload(t, "test.pdf", []byte("%PDF-1.7\nsynthetic"))
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
			if err = p.process(context.Background(), 1, file.ID); err == nil {
				t.Fatal("invalid SQL parse accepted")
			}
			stored, err := store.GetCloudFile(context.Background(), 1, file.ID)
			if err != nil || stored.State != CloudFileFailed || stored.Text != "" || len(stored.Segments) != 0 || stored.ParseTask == nil || len(stored.ParseTask.Operations) == 0 {
				t.Fatalf("failure facts not persisted: %+v %v", stored, err)
			}
			if mode == "create-unknown" {
				if stored.ErrorCode != "parse_unknown" || stored.ParseTask.VMStopped {
					t.Fatal("unknown cleanup falsely confirmed")
				}
				_ = p.process(context.Background(), 1, file.ID)
				stub.mu.Lock()
				defer stub.mu.Unlock()
				if stub.seen["sandbox.create"] != 1 {
					t.Fatal("unknown SQL create resubmitted")
				}
			}
		})
	}
}

func TestCloudFileParserDisabledAndLifecycleAreExplicit(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	file := f.upload(t, "test.pdf", []byte("%PDF-1.7\nsynthetic"))
	if err := f.service.SetCloudExecutor(nil); err != nil {
		t.Fatal(err)
	}
	if err := f.service.StartCloudFileParser(context.Background()); err != nil {
		t.Fatal(err)
	}
	stored, _ := f.store.GetCloudFile(context.Background(), 1, file.ID)
	if stored.State != CloudFileUploaded || stored.ProcessingStage != "awaiting_isolated_parser" {
		t.Fatal("disabled parser claimed ready")
	}
	client, _ := newFileParserHTTPStub(t, "success")
	if err := f.service.SetCloudExecutor(client); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := f.service.StartCloudFileParser(ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.service.SetCloudExecutor(nil); !errors.Is(err, ErrCloudFileConflict) {
		t.Fatal("live executor replaced")
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		stored, _ = f.store.GetCloudFile(context.Background(), 1, file.ID)
		if stored.State == CloudFileReady {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("background parser did not publish")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	f.service.CloseCloudFileParser()
	if err := f.service.SetCloudExecutor(nil); err != nil {
		t.Fatal(err)
	}
}
