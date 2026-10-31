package account

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A provider reconnect must not silently extend the already reserved lifetime.
// Reject the next operation before publication, while preserving the successful
// first operation and its canonical public presentation.
func TestCloudRunRejectsExtendedWorkspaceBeforePublication(t *testing.T) {
	var rounds atomic.Int32
	var sdk *cloudSDKFixture
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch rounds.Add(1) {
		case 1:
			emitToolCalls(w, map[string]any{"index": 0, "id": "calculate", "type": "function", "function": map[string]any{"name": "execute_code", "arguments": `{"code":"print(42)","language":"python"}`}})
			emitModelFinish(w, "tool_calls", 1)
		case 2:
			sdk.mu.Lock()
			for _, info := range sdk.infos {
				info["expires_at"] = info["expires_at"].(time.Time).Add(time.Second)
			}
			sdk.mu.Unlock()
			emitCloudDelta(w, "计算已完成。")
			emitToolCalls(w, map[string]any{"index": 0, "id": "publish", "type": "function", "function": map[string]any{"name": "publish_artifact", "arguments": `{"path":"result.md","name":"result.md"}`}})
			emitModelFinish(w, "tool_calls", 1)
		default:
			t.Error("policy failure automatically continued the model")
			emitModelFinish(w, "stop", 1)
		}
	})
	storage := newCloudFileHTTPFixture(t)
	if err := f.service.SetCloudObjectStore(storage.objects); err != nil {
		t.Fatal(err)
	}
	sdk = newCloudSDKFixture(t, f, true)
	run, _ := f.create(t, "workspace-expiry-changed", "计算并保存成果")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool {
		if !run.Terminal() {
			return false
		}
		binding, err := f.store.GetCloudWorkspace(context.Background(), 1, run.ConversationID)
		return err == nil && binding.State == CloudWorkspaceClosed
	})
	if finished.State != CloudRunFailed || finished.ErrorCode != "cloud_workspace_policy_invalid" || finished.Output != "计算已完成。" {
		t.Fatalf("policy failure lost the canonical outcome: state=%s code=%s", finished.State, finished.ErrorCode)
	}
	if sdk.created.Load() != 1 || sdk.code.Load() != 1 || sdk.killed.Load() != 1 || rounds.Load() != 2 {
		t.Fatal("policy rejection repeated execution/allocation or failed to clean up")
	}
	operations, err := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
	if err != nil {
		t.Fatal(err)
	}
	var executed, rejected bool
	for _, operation := range operations {
		switch operation.Name {
		case "execute_code":
			executed = operation.State == CloudToolSucceeded && strings.Contains(string(operation.Result), "42")
		case "publish_artifact":
			rejected = operation.State == CloudToolFailed
			if _, err := f.store.GetCloudArtifactByOperation(context.Background(), 1, operation.ID); !errors.Is(err, ErrNotFound) {
				t.Fatal("untrusted workspace was published as an artifact")
			}
		}
	}
	if !executed || !rejected {
		t.Fatal("policy rejection overwrote prior success or lost the failed publication")
	}
	presentation, err := cloudPresentation(finished)
	if err != nil {
		t.Fatal(err)
	}
	var visibleSuccess bool
	for _, block := range presentation.Blocks {
		if block.Type == "tool" && block.Name == "execute_code" {
			visibleSuccess = block.State == CloudToolSucceeded
		}
		if len(block.Resources) != 0 {
			t.Fatal("rejected publication invented a public artifact card")
		}
	}
	messages, err := f.store.ListCloudMessages(context.Background(), 1, run.ConversationID)
	if err != nil || len(messages) != 2 || !visibleSuccess || string(messages[1].Presentation) != string(finished.Presentation) {
		t.Fatal("reload lost the successful tool fact or canonical terminal presentation")
	}
	storage.mu.Lock()
	defer storage.mu.Unlock()
	if storage.calls != 0 {
		t.Fatal("policy rejection accessed object storage before validating the workspace")
	}
}
