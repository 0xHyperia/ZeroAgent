package account

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

type cloudSDKFixture struct {
	// Test-only seam for executing the real bounded guest in a temporary Linux workspace.
	testAction func(cloudexecutor.Operation) (json.RawMessage, bool)

	mu                                                                               sync.Mutex
	server                                                                           *httptest.Server
	operations                                                                       map[string]cloudexecutor.Operation
	receipts                                                                         map[string]cloudexecutor.Receipt
	files                                                                            map[string][]byte
	transfers                                                                        map[string]*cloudSDKTestTransfer
	infos                                                                            map[string]map[string]any
	workspaceSandbox                                                                 map[string]string
	retired                                                                          map[string]bool
	info                                                                             map[string]any
	enabled                                                                          bool
	block, drop                                                                      atomic.Bool
	killUnknown, cancelUnknown                                                       atomic.Bool
	ackFailure                                                                       atomic.Bool
	entered                                                                          chan struct{}
	enterOnce                                                                        sync.Once
	created, code, command, reads, writes, killed, cancelled, uploaded, acknowledged atomic.Int64
}

type cloudSDKTestTransfer struct {
	path, sha string
	size      int
	data      []byte
}

func newCloudSDKFixture(t *testing.T, f *cloudHTTPFixture, enabled bool) *cloudSDKFixture {
	t.Helper()
	return newCloudSDKFixtureWithTimeout(t, f, enabled, time.Second)
}

func newCloudSDKFixtureWithTimeout(t *testing.T, f *cloudHTTPFixture, enabled bool, requestTimeout time.Duration) *cloudSDKFixture {
	t.Helper()
	sdk := &cloudSDKFixture{operations: map[string]cloudexecutor.Operation{}, receipts: map[string]cloudexecutor.Receipt{}, files: map[string][]byte{}, transfers: map[string]*cloudSDKTestTransfer{}, infos: map[string]map[string]any{}, workspaceSandbox: map[string]string{}, retired: map[string]bool{}, enabled: enabled, entered: make(chan struct{})}
	now := time.Now().UTC()
	sdk.info = map[string]any{"sandbox_id": "owned-cloud-fixture-vm", "state": "running", "started_at": now, "expires_at": now.Add(300 * time.Second), "network": map[string]any{"outbound": "denied", "public_access": false}, "auto_resume": false}
	sdk.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("f", 48) || r.Header.Get("Origin") != "" {
			t.Error("SDK request escaped internal authority boundary")
			w.WriteHeader(403)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/health" {
			_ = json.NewEncoder(w).Encode(map[string]any{"service": "zeroagent-cloud-executor", "protocol": 1, "enabled": sdk.enabled, "limits": map[string]any{"max_timeout_ms": 120000, "max_file_bytes": 1 << 20, "max_output_bytes": 256 << 10}})
			return
		}
		sdk.mu.Lock()
		defer sdk.mu.Unlock()
		if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/acknowledge") {
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/operations/"), "/acknowledge")
			operation, exists := sdk.operations[id]
			var scope cloudexecutor.Scope
			_ = json.NewDecoder(r.Body).Decode(&scope)
			if !exists || scope != operation.Scope() {
				w.WriteHeader(404)
				return
			}
			receipt := sdk.receipts[id]
			if receipt.State != cloudexecutor.StateSucceeded && receipt.State != cloudexecutor.StateFailed && receipt.State != cloudexecutor.StateCancelled {
				t.Error("uncertain SDK effect was acknowledged")
				w.WriteHeader(409)
				return
			}
			if op, err := f.store.GetCloudToolOperation(r.Context(), 1, id); err == nil {
				if op.State != CloudToolSucceeded && op.State != CloudToolFailed && op.State != CloudToolCancelled {
					t.Error("SDK result retired before its durable execution fact")
				}
				if operation.Action == "sandbox.create" {
					binding, err := f.store.GetCloudWorkspace(r.Context(), 1, op.ConversationID)
					if err != nil || binding.SandboxID == "" {
						t.Error("create receipt retired before durable sandbox observation")
					}
				}
			}
			sdk.acknowledged.Add(1)
			if sdk.ackFailure.Load() {
				w.WriteHeader(503)
				_, _ = io.WriteString(w, `{"error":{"code":"receipt_write_failed"}}`)
				return
			}
			sdk.retired[id] = true
			receipt.Result = nil
			sdk.receipts[id] = receipt
			_ = json.NewEncoder(w).Encode(map[string]any{"operation_id": id, "acknowledged": true})
			return
		}
		if r.Method == "POST" && r.URL.Path == "/v1/operations" {
			var op cloudexecutor.Operation
			if json.NewDecoder(r.Body).Decode(&op) != nil {
				w.WriteHeader(400)
				return
			}
			for _, secret := range []string{"synthetic-model-key", "synthetic-access-token", "synthetic-refresh-token", "synthetic-browser-cookie"} {
				if strings.Contains(string(cloudJSON(op)), secret) {
					t.Error("model/account credential reached SDK")
				}
			}
			if known, ok := sdk.operations[op.OperationID]; ok {
				if string(cloudJSON(known)) != string(cloudJSON(op)) {
					t.Error("operation identity changed")
				}
				if sdk.retired[op.OperationID] {
					w.WriteHeader(410)
					_, _ = io.WriteString(w, `{"error":{"code":"operation_result_retired"}}`)
					return
				}
				_ = json.NewEncoder(w).Encode(sdk.receipts[op.OperationID])
				return
			}
			sdk.operations[op.OperationID] = op
			receipt := cloudexecutor.Receipt{OperationID: op.OperationID, Action: op.Action, State: cloudexecutor.StateSucceeded, CreatedAt: time.Now(), UpdatedAt: time.Now()}
			switch op.Action {
			case "sandbox.create":
				generation := sdk.created.Add(1)
				if len(op.Input) != 0 || op.SandboxID != "" {
					t.Error("model selected creation config")
				}
				info := make(map[string]any, len(sdk.info))
				for key, value := range sdk.info {
					info[key] = value
				}
				id := fmt.Sprintf("owned-cloud-fixture-vm-%d", generation)
				info["sandbox_id"] = id
				sdk.infos[id], sdk.workspaceSandbox[op.WorkspaceRef] = info, id
				receipt.Result = cloudJSON(info)
			case "sandbox.info":
				receipt.Result = cloudJSON(sdk.infos[op.SandboxID])
			case "sandbox.kill":
				sdk.killed.Add(1)
				if sdk.killUnknown.Load() {
					receipt.State = cloudexecutor.StateUnknown
					break
				}
				for path := range sdk.files {
					if strings.HasPrefix(path, op.SandboxID+":") {
						delete(sdk.files, path)
					}
				}
				receipt.Result = cloudJSON(map[string]any{"sandbox_id": op.SandboxID, "sandbox_terminated": true})
			case "sandbox.reconcile":
				receipt.Result = cloudJSON(map[string]any{"create_operation_id": op.Input["create_operation_id"], "candidates": []any{sdk.infos[sdk.workspaceSandbox[op.WorkspaceRef]]}, "cleanup_only": true, "automatic_retry_safe": false})
			case "code.run":
				sdk.code.Add(1)
				sdk.enterOnce.Do(func() { close(sdk.entered) })
				receipt.Result = cloudJSON(map[string]any{"logs": map[string]any{"stdout": []string{"42"}, "stderr": []string{}}, "results": []any{}, "error": nil})
				if sdk.testAction != nil {
					if result, ok := sdk.testAction(op); ok {
						receipt.Result = result
					}
				}
				if sdk.block.Load() || sdk.drop.Load() {
					receipt.State = cloudexecutor.StateExecuting
				}
			case "command.run":
				sdk.command.Add(1)
				receipt.Result = cloudJSON(map[string]any{"stdout": "command result", "stderr": "", "exit_code": 0})
				if sdk.testAction != nil {
					if result, ok := sdk.testAction(op); ok {
						receipt.Result = result
					}
				}
			case "file.write":
				sdk.writes.Add(1)
				encoded, _ := op.Input["data_base64"].(string)
				data, err := base64.StdEncoding.DecodeString(encoded)
				if err != nil {
					t.Error("invalid write payload")
				}
				sdk.files[op.SandboxID+":"+fmt.Sprint(op.Input["path"])] = data
				receipt.Result = cloudJSON(map[string]any{"bytes": len(data)})
			case "file.read":
				sdk.reads.Add(1)
				data := sdk.files[op.SandboxID+":"+fmt.Sprint(op.Input["path"])]
				receipt.Result = cloudJSON(map[string]any{"data_base64": base64.StdEncoding.EncodeToString(data), "bytes": len(data)})
			case "file.download.chunk":
				data := sdk.files[op.SandboxID+":"+fmt.Sprint(op.Input["path"])]
				offset := int(op.Input["offset"].(float64))
				end := offset + int(op.Input["max_bytes"].(float64))
				if offset < 0 || offset > len(data) {
					w.WriteHeader(400)
					return
				}
				if end > len(data) {
					end = len(data)
				}
				digest := sha256.Sum256(data)
				part := data[offset:end]
				receipt.Result = cloudJSON(map[string]any{"offset": offset, "total_bytes": len(data), "sha256": hex.EncodeToString(digest[:]), "data_base64": base64.StdEncoding.EncodeToString(part), "bytes": len(part), "eof": end == len(data)})
			case "file.upload.begin":
				key := op.SandboxID + ":" + fmt.Sprint(op.Input["transfer_id"])
				sdk.transfers[key] = &cloudSDKTestTransfer{path: fmt.Sprint(op.Input["path"]), sha: fmt.Sprint(op.Input["sha256"]), size: int(op.Input["total_bytes"].(float64))}
				receipt.Result = cloudJSON(map[string]any{"received_bytes": 0})
			case "file.upload.chunk":
				key := op.SandboxID + ":" + fmt.Sprint(op.Input["transfer_id"])
				transfer := sdk.transfers[key]
				data, decodeErr := base64.StdEncoding.DecodeString(fmt.Sprint(op.Input["data_base64"]))
				if transfer == nil || decodeErr != nil || len(transfer.data) != int(op.Input["offset"].(float64)) {
					t.Error("upload was not ordered or scoped to its VM")
					w.WriteHeader(400)
					return
				}
				transfer.data = append(transfer.data, data...)
				receipt.Result = cloudJSON(map[string]any{"received_bytes": len(transfer.data)})
			case "file.upload.finalize":
				key := op.SandboxID + ":" + fmt.Sprint(op.Input["transfer_id"])
				transfer := sdk.transfers[key]
				if transfer == nil {
					t.Error("upload finalized without a scoped begin")
					w.WriteHeader(400)
					return
				}
				digest := sha256.Sum256(transfer.data)
				if len(transfer.data) != transfer.size || hex.EncodeToString(digest[:]) != transfer.sha {
					t.Error("upload finalized before size/hash verification")
					w.WriteHeader(400)
					return
				}
				sdk.uploaded.Add(1)
				sdk.files[op.SandboxID+":"+transfer.path] = append([]byte(nil), transfer.data...)
				receipt.Result = cloudJSON(map[string]any{"finalized": true, "total_bytes": transfer.size, "sha256": transfer.sha})
			default:
				if sdk.testAction != nil {
					if result, ok := sdk.testAction(op); ok {
						receipt.Result = result
						break
					}
				}
				t.Errorf("unexpected SDK action %s", op.Action)
				w.WriteHeader(400)
				return
			}
			sdk.receipts[op.OperationID] = receipt
			if op.Action == "code.run" && sdk.drop.Load() {
				connection, _, err := w.(http.Hijacker).Hijack()
				if err == nil {
					_ = connection.Close()
				}
				return
			}
			_ = json.NewEncoder(w).Encode(receipt)
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/v1/operations/")
		cancel := strings.HasSuffix(id, "/cancel")
		id = strings.TrimSuffix(id, "/cancel")
		op, exists := sdk.operations[id]
		if !exists {
			w.WriteHeader(404)
			_, _ = io.WriteString(w, `{"error":{"code":"operation_not_found"}}`)
			return
		}
		if sdk.retired[id] {
			w.WriteHeader(410)
			_, _ = io.WriteString(w, `{"error":{"code":"operation_result_retired"}}`)
			return
		}
		if cancel {
			sdk.cancelled.Add(1)
			if sdk.drop.Load() || sdk.cancelUnknown.Load() {
				w.WriteHeader(503)
				_, _ = io.WriteString(w, `{"error":{"code":"unavailable"}}`)
				return
			}
			receipt := sdk.receipts[id]
			receipt.State = cloudexecutor.StateCancelled
			receipt.Result = cloudJSON(map[string]any{"sandbox_id": op.SandboxID, "sandbox_terminated": true})
			sdk.receipts[id] = receipt
		}
		_ = json.NewEncoder(w).Encode(sdk.receipts[id])
	}))
	t.Cleanup(sdk.server.Close)
	client, err := cloudexecutor.New(cloudexecutor.Config{BaseURL: sdk.server.URL, Token: strings.Repeat("f", 48), RequestTimeout: requestTimeout, CancelTimeout: 300 * time.Millisecond, PollInterval: 5 * time.Millisecond, MaxWait: max(2*time.Second, requestTimeout)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseIdleConnections)
	if err = f.service.SetCloudExecutor(client); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.service.CloseCloudRuns)
	return sdk
}

func emitToolCalls(w http.ResponseWriter, calls ...map[string]any) {
	w.Header().Set("Content-Type", "text/event-stream")
	_, _ = fmt.Fprintf(w, "data: %s\n\n", cloudJSON(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": calls}}}}))
	if flush, ok := w.(http.Flusher); ok {
		flush.Flush()
	}
}
func emitModelFinish(w http.ResponseWriter, reason string, tokens int) {
	_, _ = fmt.Fprintf(w, "data: %s\n\ndata: %s\n\ndata: [DONE]\n\n", cloudJSON(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": reason}}}), cloudJSON(map[string]any{"choices": []any{}, "usage": map[string]any{"total_tokens": tokens}}))
}

func TestCloudRunToolsFragmentedMultipleCallsAndUsage(t *testing.T) {
	var rounds atomic.Int32
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Error("invalid model request")
		}
		round := rounds.Add(1)
		if round == 1 {
			if len(request["tools"].([]any)) < 4 {
				t.Error("enabled SDK did not declare tools")
			}
			emitToolCalls(w, map[string]any{"index": 0, "id": "call_code", "type": "function", "function": map[string]any{"name": "execute_", "arguments": `{"code":"print(`}}, map[string]any{"index": 1, "id": "call_cmd", "type": "function", "function": map[string]any{"name": "execute_command", "arguments": `{"command":"echo result"}`}})
			emitToolCalls(w, map[string]any{"index": 0, "function": map[string]any{"name": "code", "arguments": `42)","language":"python"}`}})
			emitModelFinish(w, "tool_calls", 3)
			return
		}
		data := string(cloudJSON(request))
		if !strings.Contains(data, "42") || !strings.Contains(data, "command result") || !strings.Contains(data, `"role":"tool"`) {
			t.Error("tool results not included in next model request")
		}
		for _, private := range []string{"owned-cloud-fixture-vm", "owner_scope", "workspace_ref"} {
			if strings.Contains(data, private) {
				t.Error("private workspace binding reached model")
			}
		}
		emitCloudDelta(w, "完成分析")
		emitModelFinish(w, "stop", 5)
	})
	sdk := newCloudSDKFixture(t, f, true)
	run, _ := f.create(t, "multi-tools", "分析数据")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || finished.Output != "完成分析" || string(finished.Usage) != `{"total_tokens":8}` {
		t.Fatalf("tool run state=%s code=%s output=%s usage=%s", finished.State, finished.ErrorCode, finished.Output, finished.Usage)
	}
	if sdk.created.Load() != 1 || sdk.code.Load() != 1 || sdk.command.Load() != 1 || rounds.Load() != 2 {
		t.Fatal("tool loop duplicated effects or allocation")
	}
	messages, _ := f.store.ListCloudMessages(context.Background(), 1, f.conversation.ID)
	if len(messages) != 2 || messages[1].Role != "assistant" {
		t.Fatal("tool rounds wrote extra canonical assistant messages")
	}
	events, _ := f.store.ListCloudRunEvents(context.Background(), 1, run.ID, 0, 256)
	public := string(cloudJSON(events))
	for _, private := range []string{"print(42)", "command result", "owned-cloud-fixture-vm", "data_base64"} {
		if strings.Contains(public, private) {
			t.Fatal("tool progress exposed private input/result")
		}
	}
	if !strings.Contains(public, "tool.started") || !strings.Contains(public, "tool.completed") {
		t.Fatal("durable tool progress missing")
	}
}

func TestCloudRunToolsWriteThenReadRemainsTemporary(t *testing.T) {
	var rounds atomic.Int32
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		round := rounds.Add(1)
		switch round {
		case 1:
			emitToolCalls(w, map[string]any{"index": 0, "id": "write", "type": "function", "function": map[string]any{"name": "write_file", "arguments": `{"path":"result.txt","content":"hello workspace"}`}})
			emitModelFinish(w, "tool_calls", 1)
		case 2:
			emitToolCalls(w, map[string]any{"index": 0, "id": "read", "type": "function", "function": map[string]any{"name": "read_file", "arguments": `{"path":"result.txt"}`}})
			emitModelFinish(w, "tool_calls", 1)
		default:
			data, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(data), "hello workspace") || !strings.Contains(string(data), `\"durable\":false`) {
				t.Error("temporary file semantics missing")
			}
			emitCloudDelta(w, "文件仅保存在临时工作区")
			emitModelFinish(w, "stop", 1)
		}
	})
	sdk := newCloudSDKFixture(t, f, true)
	run, _ := f.create(t, "file-tools", "写入后读取")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || sdk.writes.Load() != 1 || sdk.reads.Load() != 1 {
		t.Fatalf("file run state=%s code=%s", finished.State, finished.ErrorCode)
	}
}

func TestCloudRunToolsRejectSecretsAndAuthorityArgumentsBeforeSDK(t *testing.T) {
	for _, args := range []string{`{"code":"print('synthetic-model-key')"}`, `{"code":"print(1)","owner_scope":"foreign"}`} {
		t.Run(args[:10], func(t *testing.T) {
			f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				middle := len(args) / 2
				emitToolCalls(w, map[string]any{"index": 0, "id": "secret_call", "type": "function", "function": map[string]any{"name": "execute_code", "arguments": args[:middle]}})
				emitToolCalls(w, map[string]any{"index": 0, "function": map[string]any{"arguments": args[middle:]}})
				emitModelFinish(w, "tool_calls", 1)
			})
			sdk := newCloudSDKFixture(t, f, true)
			run, _ := f.create(t, "reject-tools", "work")
			finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
			if finished.State != CloudRunFailed || sdk.created.Load() != 0 || sdk.code.Load() != 0 {
				t.Fatalf("unsafe tool executed: state=%s code=%s", finished.State, finished.ErrorCode)
			}
			operations, _ := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
			if len(operations) != 0 {
				t.Fatal("unsafe model arguments reached private ledger")
			}
		})
	}
}

func TestCloudRunToolCancellationRequestsRemoteStopAndKillsWorkspace(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		emitCloudDelta(w, "正在执行")
		emitToolCalls(w, map[string]any{"index": 0, "id": "long_code", "type": "function", "function": map[string]any{"name": "execute_code", "arguments": `{"code":"while True: pass","timeout_ms":120000}`}})
		emitModelFinish(w, "tool_calls", 1)
	})
	sdk := newCloudSDKFixture(t, f, true)
	sdk.block.Store(true)
	run, _ := f.create(t, "cancel-tools", "执行计算")
	select {
	case <-sdk.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("SDK code not reached")
	}
	status, _ := f.request(t, "POST", "/api/web-chat/runs/"+run.ID+"/cancel", "synthetic-browser-cookie", "")
	if status != 200 {
		t.Fatalf("cancel status=%d", status)
	}
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCancelled || sdk.cancelled.Load() < 1 || sdk.killed.Load() < 1 || sdk.code.Load() != 1 {
		t.Fatalf("cancel state=%s cancel=%d kill=%d effects=%d", finished.State, sdk.cancelled.Load(), sdk.killed.Load(), sdk.code.Load())
	}
}

func TestCloudRunUnknownToolEffectIsNeverResubmitted(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		emitToolCalls(w, map[string]any{"index": 0, "id": "uncertain", "type": "function", "function": map[string]any{"name": "execute_code", "arguments": `{"code":"print('once')"}`}})
		emitModelFinish(w, "tool_calls", 1)
	})
	sdk := newCloudSDKFixture(t, f, true)
	sdk.drop.Store(true)
	run, _ := f.create(t, "unknown-tools", "执行一次")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunInterrupted || finished.ErrorCode != "cloud_tool_outcome_unknown" || sdk.code.Load() != 1 || f.calls.Load() != 1 {
		t.Fatalf("unknown effect state=%s code=%s count=%d", finished.State, finished.ErrorCode, sdk.code.Load())
	}
	ops, _ := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
	found := false
	for _, op := range ops {
		if op.Name == "execute_code" {
			found = op.State == CloudToolUnknown
		}
	}
	if !found {
		t.Fatal("unknown effect not durably recorded")
	}
}

func TestCloudRunToolHealthDisabledStillSupportsPlainText(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		_ = json.NewDecoder(r.Body).Decode(&request)
		guidance := string(cloudJSON(request["messages"]))
		if !strings.Contains(guidance, time.Now().UTC().Format("2006-01-02")) || !strings.Contains(guidance, "Web search available: false") || !strings.Contains(guidance, "never claim you searched") {
			t.Error("text-only model lacked truthful current capability/date guidance")
		}
		if strings.Contains(string(cloudJSON(request["tools"])), "execute_code") || strings.Contains(string(cloudJSON(request["tools"])), "execute_command") {
			t.Error("disabled SDK declared execution tools")
		}
		emitCloudDelta(w, "文本仍然可用")
		emitModelFinish(w, "stop", 1)
	})
	sdk := newCloudSDKFixture(t, f, false)
	run, _ := f.create(t, "no-sdk-tools", "文本任务")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || sdk.created.Load() != 0 {
		t.Fatal("disabled tools broke text chat")
	}
}

func TestCloudRunModelRejectionsNeverRetryOrSwitchEndpoint(t *testing.T) {
	for _, status := range []int{400, 401, 403, 500} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
				_, _ = io.WriteString(w, `{"error":{"message":"do-not-reflect-synthetic-model-key"}}`)
			})
			sdk := newCloudSDKFixture(t, f, true)
			run, _ := f.create(t, "rejected-model", "工作任务")
			finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
			if finished.State != CloudRunFailed || finished.ErrorCode != "model_request_failed" || f.calls.Load() != 1 || sdk.created.Load() != 0 {
				t.Fatalf("model rejection changed route/retried: state=%s calls=%d", finished.State, f.calls.Load())
			}
			if strings.Contains(finished.Output, "synthetic-model-key") {
				t.Fatal("model error reflected provider credentials")
			}
		})
	}
}

func TestCloudRunUnadvertisedToolNeverCreatesWorkspace(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		_ = json.NewDecoder(r.Body).Decode(&request)
		if strings.Contains(string(cloudJSON(request["tools"])), "publish_artifact") {
			t.Error("durable publication advertised without object storage")
		}
		emitToolCalls(w, map[string]any{"index": 0, "id": "unadvertised", "type": "function", "function": map[string]any{"name": "publish_artifact", "arguments": `{"path":"result.csv","name":"result.csv"}`}})
		emitModelFinish(w, "tool_calls", 1)
	})
	sdk := newCloudSDKFixture(t, f, true)
	run, _ := f.create(t, "unadvertised-tools", "生成成果")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	operations, err := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
	if finished.State != CloudRunFailed || finished.ErrorCode != "cloud_tool_unavailable" || sdk.created.Load() != 0 || err != nil || len(operations) != 0 {
		t.Fatalf("unadvertised tool produced work: state=%s code=%s creations=%d", finished.State, finished.ErrorCode, sdk.created.Load())
	}
}

func TestCloudRunPublishArtifactIsDurableBeforeModelDownloadLink(t *testing.T) {
	var rounds atomic.Int32
	var downloadPath atomic.Value
	const csv = "item,value\nprofit,42\n"
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch rounds.Add(1) {
		case 1:
			emitToolCalls(w, map[string]any{"index": 0, "id": "write", "type": "function", "function": map[string]any{"name": "write_file", "arguments": string(cloudJSON(map[string]any{"path": "results/report.csv", "content": csv}))}})
			emitModelFinish(w, "tool_calls", 1)
		case 2:
			emitToolCalls(w, map[string]any{"index": 0, "id": "publish", "type": "function", "function": map[string]any{"name": "publish_artifact", "arguments": `{"path":"results/report.csv","name":"report.csv"}`}})
			emitModelFinish(w, "tool_calls", 1)
		default:
			result := lastResearchToolResult(t, r)
			artifact, ok := result["artifact"].(map[string]any)
			if !ok || artifact["state"] != CloudArtifactReady || result["durable"] != true {
				t.Error("model was told unverified file is durable")
			}
			path, _ := artifact["download_url"].(string)
			downloadPath.Store(path)
			if !strings.HasPrefix(path, "/api/web-chat/artifacts/versions/") {
				t.Error("download path was invented")
			}
			emitCloudDelta(w, "成果已保存：【成果:"+fmt.Sprint(artifact["id"])+"】")
			emitModelFinish(w, "stop", 1)
		}
	})
	storage := newCloudFileHTTPFixture(t)
	if err := f.service.SetCloudObjectStore(storage.objects); err != nil {
		t.Fatal(err)
	}
	newCloudSDKFixture(t, f, true)
	run, _ := f.create(t, "publish-tools", "生成可下载CSV")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	path, _ := downloadPath.Load().(string)
	if finished.State != CloudRunCompleted || path == "" {
		t.Fatalf("publication run state=%s code=%s", finished.State, finished.ErrorCode)
	}
	status, body := f.request(t, "GET", path, "synthetic-browser-cookie", "")
	if status != 200 || body != csv {
		t.Fatalf("durable download status=%d body=%q", status, body)
	}
	status, _ = f.request(t, "GET", path, "synthetic-other-account", "")
	if status != 404 {
		t.Fatal("artifact download crossed account boundary")
	}
}

func TestCloudRunPublicationAfterObjectPutKeepsUnknownOutcome(t *testing.T) {
	var rounds atomic.Int32
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch rounds.Add(1) {
		case 1:
			emitToolCalls(w, map[string]any{"index": 0, "id": "write", "type": "function", "function": map[string]any{"name": "write_file", "arguments": `{"path":"result.csv","content":"a,b\n1,2\n"}`}})
			emitModelFinish(w, "tool_calls", 1)
		case 2:
			emitToolCalls(w, map[string]any{"index": 0, "id": "publish", "type": "function", "function": map[string]any{"name": "publish_artifact", "arguments": `{"path":"result.csv","name":"result.csv"}`}})
			emitModelFinish(w, "tool_calls", 1)
		default:
			t.Error("unknown publication automatically reentered the model")
			emitModelFinish(w, "stop", 1)
		}
	})
	storage := newCloudFileHTTPFixture(t)
	storage.mu.Lock()
	storage.corruptGet = true
	storage.mu.Unlock()
	if err := f.service.SetCloudObjectStore(storage.objects); err != nil {
		t.Fatal(err)
	}
	newCloudSDKFixture(t, f, true)
	run, _ := f.create(t, "uncertain-publication", "生成文件")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunInterrupted || finished.ErrorCode != "cloud_artifact_publication_unknown" || rounds.Load() != 2 || strings.Contains(finished.Output, "/download") {
		t.Fatalf("uncertain object write misreported: state=%s code=%s rounds=%d", finished.State, finished.ErrorCode, rounds.Load())
	}
	operations, err := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range operations {
		if operation.Name != "publish_artifact" {
			continue
		}
		version, err := f.store.GetCloudArtifactByOperation(context.Background(), 1, operation.ID)
		if err != nil || operation.State != CloudToolUnknown || version.State != CloudArtifactUnknown || version.DownloadPath != "" {
			t.Fatal("unknown publication lost its durable receipt or exposed a download")
		}
		return
	}
	t.Fatal("publication operation was not durably recorded")
}

func TestCloudRunArtifactContinuesInFreshWorkspaceAndConversation(t *testing.T) {
	const original = "item,value\nprofit,42\n"
	const edited = "item,value\nprofit,84\n"
	var phase, rounds atomic.Int32
	var firstID, secondID, familyID atomic.Value
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		round := rounds.Add(1)
		if phase.Load() == 0 {
			switch round {
			case 1:
				emitToolCalls(w, map[string]any{"index": 0, "id": "write_original", "type": "function", "function": map[string]any{"name": "write_file", "arguments": string(cloudJSON(map[string]any{"path": "results/report.csv", "content": original}))}})
				emitModelFinish(w, "tool_calls", 1)
			case 2:
				emitToolCalls(w, map[string]any{"index": 0, "id": "publish_original", "type": "function", "function": map[string]any{"name": "publish_artifact", "arguments": `{"path":"results/report.csv","name":"report.csv"}`}})
				emitModelFinish(w, "tool_calls", 1)
			default:
				artifact := lastResearchToolResult(t, r)["artifact"].(map[string]any)
				firstID.Store(artifact["id"].(string))
				familyID.Store(artifact["family_id"].(string))
				emitCloudDelta(w, "已保存【成果:"+artifact["id"].(string)+"】")
				emitModelFinish(w, "stop", 1)
			}
			return
		}
		switch round {
		case 1:
			var request map[string]any
			_ = json.NewDecoder(r.Body).Decode(&request)
			if !strings.Contains(string(cloudJSON(request["messages"])), firstID.Load().(string)) {
				t.Error("ready artifact reference was not resolved into current model context")
			}
			emitToolCalls(w, map[string]any{"index": 0, "id": "load_old_version", "type": "function", "function": map[string]any{"name": "load_uploaded_file", "arguments": string(cloudJSON(map[string]any{"artifact_version_id": firstID.Load().(string), "path": "inputs/report.csv"}))}})
			emitModelFinish(w, "tool_calls", 1)
		case 2:
			result := lastResearchToolResult(t, r)
			loaded, _ := result["file"].(map[string]any)
			if loaded["family_id"] != familyID.Load().(string) || loaded["artifact_version_id"] != firstID.Load().(string) || loaded["path"] != "inputs/report.csv" || result["durable"] != false {
				t.Error("loaded artifact lost its immutable identity or claimed VM durability")
			}
			emitToolCalls(w, map[string]any{"index": 0, "id": "edit_new_workspace", "type": "function", "function": map[string]any{"name": "write_file", "arguments": string(cloudJSON(map[string]any{"path": "inputs/report.csv", "content": edited}))}})
			emitModelFinish(w, "tool_calls", 1)
		case 3:
			emitToolCalls(w, map[string]any{"index": 0, "id": "publish_next_version", "type": "function", "function": map[string]any{"name": "publish_artifact", "arguments": string(cloudJSON(map[string]any{"path": "inputs/report.csv", "name": "report.csv", "family_id": familyID.Load().(string)}))}})
			emitModelFinish(w, "tool_calls", 1)
		default:
			artifact := lastResearchToolResult(t, r)["artifact"].(map[string]any)
			secondID.Store(artifact["id"].(string))
			if artifact["family_id"] != familyID.Load().(string) || artifact["number"] != float64(2) {
				t.Error("continued artifact did not preserve family/version history")
			}
			emitCloudDelta(w, "已更新【成果:"+artifact["id"].(string)+"】，原版本仍保留。")
			emitModelFinish(w, "stop", 1)
		}
	})
	storage := newCloudFileHTTPFixture(t)
	if err := f.service.SetCloudObjectStore(storage.objects); err != nil {
		t.Fatal(err)
	}
	sdk := newCloudSDKFixture(t, f, true)
	first, _ := f.create(t, "publish-before-new-vm", "生成表格")
	if finished := f.wait(t, first.ID, func(run *CloudRun) bool { return run.Terminal() }); finished.State != CloudRunCompleted {
		t.Fatalf("first run failed: state=%s code=%s", finished.State, finished.ErrorCode)
	}
	oldBinding, err := f.store.GetCloudWorkspace(context.Background(), 1, first.ConversationID)
	if err != nil {
		t.Fatal(err)
	}
	cleanup, err := f.store.RequestCloudWorkspaceCleanup(context.Background(), 1, oldBinding.ID)
	if err != nil || len(cleanup) != 1 {
		t.Fatal("could not terminate original workspace")
	}
	f.service.cloudRuntime.cleanupWorkspace(context.Background(), f.service.CloudExecutor(), f.store, cleanup[0])
	if sdk.killed.Load() != 1 {
		t.Fatal("original VM remained alive")
	}
	conversation, err := f.service.CreateCloudConversation(context.Background(), 1, "test-model")
	if err != nil {
		t.Fatal(err)
	}
	phase.Store(1)
	rounds.Store(0)
	input := CreateCloudRunInput{ConversationID: conversation.ID, ClientRequestID: "continue-in-new-vm", Model: "test-model", ProviderKeyID: 41, Content: cloudJSON([]any{map[string]any{"type": "text", "text": "继续修改这份成果"}, map[string]any{"type": "artifact_reference", "version_id": firstID.Load().(string)}})}
	status, body := f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	var response struct {
		Run *CloudRun `json:"run"`
	}
	if json.Unmarshal([]byte(body), &response) != nil || status != 202 || response.Run == nil {
		t.Fatalf("artifact continuation refused: status=%d body=%s", status, body)
	}
	finished := f.wait(t, response.Run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || sdk.created.Load() != 2 || sdk.uploaded.Load() != 1 || rounds.Load() != 4 {
		t.Fatalf("fresh VM continuation failed: state=%s code=%s created=%d uploaded=%d rounds=%d", finished.State, finished.ErrorCode, sdk.created.Load(), sdk.uploaded.Load(), rounds.Load())
	}
	current, err := f.store.GetCloudWorkspace(context.Background(), 1, conversation.ID)
	if err != nil || current.SandboxID == oldBinding.SandboxID || current.ID == oldBinding.ID {
		t.Fatal("continuation reused the terminated VM")
	}
	sdk.mu.Lock()
	uploadedOriginal := false
	for key, transfer := range sdk.transfers {
		if strings.HasPrefix(key, current.SandboxID+":") && string(transfer.data) == original {
			uploadedOriginal = true
		}
	}
	sdk.mu.Unlock()
	if !uploadedOriginal {
		t.Fatal("new VM did not receive verified canonical original bytes")
	}
	for _, expected := range []struct{ id, content, conversationID, runID string }{{firstID.Load().(string), original, first.ConversationID, first.ID}, {secondID.Load().(string), edited, conversation.ID, response.Run.ID}} {
		version, err := f.store.GetCloudArtifactVersion(context.Background(), 1, expected.id)
		if err != nil || version.ConversationID != expected.conversationID || version.SourceRunID != expected.runID {
			t.Fatal("artifact version has incorrect conversation/run provenance")
		}
		status, body = f.request(t, "GET", "/api/web-chat/artifacts/versions/"+expected.id+"/download", "synthetic-browser-cookie", "")
		if status != 200 || body != expected.content {
			t.Fatal("artifact revision overwrote old bytes or lost the new version")
		}
	}
}

func TestCloudRunConfiguredLoopCompletesMoreThanFourModelRounds(t *testing.T) {
	var rounds atomic.Int32
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		round := rounds.Add(1)
		if round <= 5 {
			emitCloudDelta(w, fmt.Sprintf("第%d步", round))
			emitToolCalls(w, map[string]any{"index": 0, "id": fmt.Sprintf("step_%d", round), "type": "function", "function": map[string]any{"name": "execute_code", "arguments": `{"code":"print(42)"}`}})
			emitModelFinish(w, "tool_calls", 1)
			return
		}
		emitCloudDelta(w, "全部完成")
		emitModelFinish(w, "stop", 1)
	})
	if err := f.service.SetCloudRuntimeConfig(CloudRuntimeConfig{WorkerCount: 1, RunTimeout: 30 * time.Second, MaxModelRounds: 7, MaxToolCalls: 6}); err != nil {
		t.Fatal(err)
	}
	sdk := newCloudSDKFixture(t, f, true)
	run, _ := f.create(t, "configured-many-rounds", "完成多步工作")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || rounds.Load() != 6 || sdk.code.Load() != 5 || !strings.HasSuffix(finished.Output, "全部完成") {
		t.Fatalf("configured loop stopped prematurely: state=%s code=%s rounds=%d effects=%d", finished.State, finished.ErrorCode, rounds.Load(), sdk.code.Load())
	}
}

func TestCloudRunConfiguredLimitsKeepPartialAndStopFurtherEffects(t *testing.T) {
	for _, tc := range []struct {
		name, code    string
		rounds, calls int
	}{{"rounds", "cloud_tool_round_limit", 3, 10}, {"calls", "cloud_tool_call_limit", 12, 2}} {
		t.Run(tc.name, func(t *testing.T) {
			var rounds atomic.Int32
			f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				round := rounds.Add(1)
				var request map[string]any
				_ = json.NewDecoder(r.Body).Decode(&request)
				if round == 3 && request["tools"] != nil {
					t.Error("exhausted tool limit still advertised more execution")
				}
				emitCloudDelta(w, fmt.Sprintf("保留第%d步进度", round))
				emitToolCalls(w, map[string]any{"index": 0, "id": fmt.Sprintf("step_%d", round), "type": "function", "function": map[string]any{"name": "execute_code", "arguments": `{"code":"print(42)"}`}})
				emitModelFinish(w, "tool_calls", 1)
			})
			if err := f.service.SetCloudRuntimeConfig(CloudRuntimeConfig{WorkerCount: 1, RunTimeout: 30 * time.Second, MaxModelRounds: tc.rounds, MaxToolCalls: tc.calls}); err != nil {
				t.Fatal(err)
			}
			sdk := newCloudSDKFixture(t, f, true)
			run, _ := f.create(t, "configured-limit", "受控多步工作")
			finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
			if finished.State != CloudRunInterrupted || finished.ErrorCode != tc.code || rounds.Load() != 3 || sdk.code.Load() != 2 || !strings.Contains(finished.Output, "保留第3步进度") {
				t.Fatalf("limit lost progress or exceeded effects: state=%s code=%s rounds=%d effects=%d", finished.State, finished.ErrorCode, rounds.Load(), sdk.code.Load())
			}
			operations, err := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
			if err != nil {
				t.Fatal(err)
			}
			semantic := 0
			for _, operation := range operations {
				if operation.Name == "execute_code" {
					semantic++
				}
			}
			if semantic != 2 {
				t.Fatal("limit created another execution identity")
			}
		})
	}
}

type failingCloudToolCommitStore struct{ *MemoryStore }

func (s failingCloudToolCommitStore) CommitCloudTool(ctx context.Context, uid int64, id, owner string, attempt int64, state string, result json.RawMessage, code string) (*CloudToolOperation, error) {
	op, err := s.GetCloudToolOperation(ctx, uid, id)
	if err != nil {
		return nil, err
	}
	if op.Name == "execute_code" && state == CloudToolSucceeded {
		return nil, ErrCloudToolConflict
	}
	return s.MemoryStore.CommitCloudTool(ctx, uid, id, owner, attempt, state, result, code)
}

func TestCloudRunSDKResultAcknowledgedOnlyAfterDurableCommit(t *testing.T) {
	for _, failCommit := range []bool{false, true} {
		t.Run(fmt.Sprint(failCommit), func(t *testing.T) {
			var rounds atomic.Int32
			f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if rounds.Add(1) == 1 {
					emitToolCalls(w, map[string]any{"index": 0, "id": "code", "type": "function", "function": map[string]any{"name": "execute_code", "arguments": `{"code":"print(42)"}`}})
					emitModelFinish(w, "tool_calls", 1)
					return
				}
				emitCloudDelta(w, "已完成计算")
				emitModelFinish(w, "stop", 1)
			})
			if failCommit {
				f.service.store = failingCloudToolCommitStore{f.store}
			}
			sdk := newCloudSDKFixture(t, f, true)
			run, _ := f.create(t, "ack-durable-fact", "执行计算")
			finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
			if failCommit {
				if finished.State != CloudRunInterrupted || finished.ErrorCode != "cloud_tool_result_persistence_failed" || rounds.Load() != 1 {
					t.Fatalf("failed commit misreported: state=%s code=%s", finished.State, finished.ErrorCode)
				}
			} else if finished.State != CloudRunCompleted || rounds.Load() != 2 {
				t.Fatal("ack changed successful task outcome")
			}
			operations, err := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, operation := range operations {
				if operation.Name != "execute_code" {
					continue
				}
				found = true
				sdk.mu.Lock()
				retired, retainedBytes := sdk.retired[operation.ID], len(sdk.receipts[operation.ID].Result)
				sdk.mu.Unlock()
				if failCommit {
					if retired || retainedBytes == 0 || operation.State != CloudToolExecuting {
						t.Fatal("failed durable commit destroyed the only execution result")
					}
				} else if !retired || retainedBytes != 0 || operation.State != CloudToolSucceeded || len(operation.Result) == 0 {
					t.Fatal("successful durable commit did not release the adapter payload")
				}
			}
			if !found || sdk.code.Load() != 1 {
				t.Fatal("ack retried the effect or lost its original identity")
			}
		})
	}
}

func TestCloudRunSDKACKFailureDoesNotChangeDurableSuccessOrRepeatEffect(t *testing.T) {
	var rounds atomic.Int32
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if rounds.Add(1) == 1 {
			emitToolCalls(w, map[string]any{"index": 0, "id": "code", "type": "function", "function": map[string]any{"name": "execute_code", "arguments": `{"code":"print(42)"}`}})
			emitModelFinish(w, "tool_calls", 1)
			return
		}
		emitCloudDelta(w, "计算完成")
		emitModelFinish(w, "stop", 1)
	})
	sdk := newCloudSDKFixture(t, f, true)
	sdk.ackFailure.Store(true)
	run, _ := f.create(t, "ack-unavailable", "执行计算")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || rounds.Load() != 2 || sdk.code.Load() != 1 || sdk.acknowledged.Load() < 6 {
		t.Fatalf("ACK availability changed task result: state=%s code=%s effects=%d acks=%d", finished.State, finished.ErrorCode, sdk.code.Load(), sdk.acknowledged.Load())
	}
}
