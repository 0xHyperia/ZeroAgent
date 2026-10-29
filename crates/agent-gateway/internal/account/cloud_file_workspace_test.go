package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

// Real local HTTP model/SDK/S3 fixtures exercise the Go Agent loop. This is not
// a live E2B allocation, paid model request or acceptance of remote execution.
func TestCloudRunLargeOriginalLoadsVerifiedBytesWithoutPromptExpansion(t *testing.T) {
	pattern := []byte("private-raw-csv-row,123456789\n")
	original := bytes.Repeat(pattern, (CloudFileMaxTextBytes+65536)/len(pattern)+1)
	var fileID atomic.Value
	var rounds atomic.Int32
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch rounds.Add(1) {
		case 1:
			var request map[string]any
			if json.NewDecoder(r.Body).Decode(&request) != nil {
				t.Error("invalid model request")
			}
			messages := string(cloudJSON(request["messages"]))
			if strings.Contains(messages, string(pattern)) || !strings.Contains(messages, "uploaded_source") || !strings.Contains(messages, fileID.Load().(string)) || len(messages) > 16<<10 {
				t.Error("large raw original entered prompt or lacked controlled reference")
			}
			emitToolCalls(w, map[string]any{"index": 0, "id": "load_large_csv", "type": "function", "function": map[string]any{"name": "load_uploaded_file", "arguments": string(cloudJSON(map[string]any{"file_id": fileID.Load().(string), "path": "inputs/large.csv"}))}})
			emitModelFinish(w, "tool_calls", 1)
		case 2:
			result := lastResearchToolResult(t, r)
			file, _ := result["file"].(map[string]any)
			if file["file_id"] != fileID.Load().(string) || file["size"] != float64(len(original)) || file["path"] != "inputs/large.csv" || result["durable"] != false {
				t.Error("tool result lost verified source metadata")
			}
			emitToolCalls(w, map[string]any{"index": 0, "id": "analyze_csv_in_vm", "type": "function", "function": map[string]any{"name": "execute_code", "arguments": `{"language":"python","code":"import csv; print(sum(1 for _ in csv.reader(open('inputs/large.csv'))))"}`}})
			emitModelFinish(w, "tool_calls", 1)
		default:
			emitCloudDelta(w, "已在隔离沙箱处理上传的原件。")
			emitModelFinish(w, "stop", 1)
		}
	})
	storage := newCloudFileHTTPFixture(t)
	if err := f.service.SetCloudObjectStore(storage.objects); err != nil {
		t.Fatal(err)
	}
	sdk := newCloudSDKFixture(t, f, true)
	body, headers := cloudFileMultipart(t, f.conversation.ID, "large.csv", original)
	request, _ := http.NewRequest(http.MethodPost, f.server.URL+"/api/web-chat/files", body)
	request.Header = headers
	request.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "synthetic-browser-cookie"})
	response, err := f.server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	var uploaded struct {
		File *CloudFile `json:"file"`
	}
	if response.StatusCode != 201 || json.NewDecoder(response.Body).Decode(&uploaded) != nil || uploaded.File == nil {
		response.Body.Close()
		t.Fatal("large HTTP upload failed")
	}
	response.Body.Close()
	fileID.Store(uploaded.File.ID)
	if uploaded.File.State != CloudFileUploaded || !uploaded.File.WorkspaceLoadable || uploaded.File.TextBytes != 0 {
		t.Fatal("large original was marked parsed or unavailable")
	}
	input := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: "large-csv-real-protocol", Model: "test-model", ProviderKeyID: 41, Content: cloudJSON([]any{map[string]any{"type": "text", "text": "统计这个CSV"}, map[string]any{"type": "file_reference", "file_id": uploaded.File.ID}})}
	status, data := f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	var accepted struct {
		Run *CloudRun `json:"run"`
	}
	if status != 202 || json.Unmarshal([]byte(data), &accepted) != nil || accepted.Run == nil {
		t.Fatalf("large original reference refused: %d %s", status, data)
	}
	run := f.wait(t, accepted.Run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if run.State != CloudRunCompleted || rounds.Load() != 3 || sdk.uploaded.Load() != 1 || sdk.code.Load() != 1 {
		t.Fatalf("load/analyze loop failed: state=%s code=%s", run.State, run.ErrorCode)
	}
	binding, err := f.store.GetCloudWorkspace(context.Background(), 1, run.ConversationID)
	if err != nil {
		t.Fatal(err)
	}
	sdk.mu.Lock()
	defer sdk.mu.Unlock()
	if !bytes.Equal(sdk.files[binding.SandboxID+":inputs/large.csv"], original) {
		t.Fatal("sandbox upload bytes differ from verified canonical original")
	}
	chunks := 0
	for _, operation := range sdk.operations {
		if operation.Action == "file.upload.chunk" {
			chunks++
		}
	}
	if chunks < 3 {
		t.Fatal("large source bypassed bounded chunk transfer")
	}
}
