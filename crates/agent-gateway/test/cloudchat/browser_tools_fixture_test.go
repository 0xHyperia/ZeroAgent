package cloudchat_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

// This deterministic protocol peer makes browser checks reproducible. It does
// not execute code and cannot demonstrate model quality or real E2B behavior.
type browserToolFixture struct {
	mu       sync.Mutex
	client   *cloudexecutor.Client
	ops      map[string]cloudexecutor.Operation
	receipts map[string]cloudexecutor.Receipt
	files    map[string][]byte
	infos    map[string]map[string]any
	transfer map[string]*browserTransfer
	created  int
	loaded   int
	killed   int
	codeRuns int
	chartPNG []byte
}

type browserTransfer struct {
	path, sha string
	size      int
	data      []byte
}

func browserJSON(value any) json.RawMessage {
	data, _ := json.Marshal(value)
	return data
}

func newBrowserToolFixture(t *testing.T) *browserToolFixture {
	t.Helper()
	f := &browserToolFixture{ops: map[string]cloudexecutor.Operation{}, receipts: map[string]cloudexecutor.Receipt{}, files: map[string][]byte{}, infos: map[string]map[string]any{}, transfer: map[string]*browserTransfer{}, chartPNG: browserFixtureChartPNG(t)}
	peer := httptest.NewServer(http.HandlerFunc(f.serveSDK))
	t.Cleanup(peer.Close)
	client, err := cloudexecutor.New(cloudexecutor.Config{BaseURL: peer.URL, Token: strings.Repeat("b", 48), PollInterval: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseIdleConnections)
	f.client = client
	return f
}

func (f *browserToolFixture) snapshot() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	digest := sha256.Sum256(f.chartPNG)
	return map[string]any{"synthetic": true, "created": f.created, "loaded": f.loaded, "killed": f.killed, "operations": len(f.ops), "code_runs": f.codeRuns, "chart_bytes": len(f.chartPNG), "chart_sha256": hex.EncodeToString(digest[:])}
}

func (f *browserToolFixture) serveSDK(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("b", 48) || r.Header.Get("Origin") != "" {
		http.Error(w, "internal authority required", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.Method == "GET" && r.URL.Path == "/v1/health" {
		_ = json.NewEncoder(w).Encode(map[string]any{"service": "zeroagent-cloud-executor", "protocol": 1, "enabled": true})
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Method != "POST" || r.URL.Path != "/v1/operations" {
		id := strings.TrimPrefix(r.URL.Path, "/v1/operations/")
		if receipt, ok := f.receipts[id]; ok {
			_ = json.NewEncoder(w).Encode(receipt)
			return
		}
		http.Error(w, "operation not found", 404)
		return
	}
	var op cloudexecutor.Operation
	if json.NewDecoder(io.LimitReader(r.Body, 1500001)).Decode(&op) != nil {
		http.Error(w, "invalid operation", 400)
		return
	}
	for _, secret := range []string{"fixture-model-key-only", "fixture-app-access-only", "fixture-s3-secret-only"} {
		if strings.Contains(string(browserJSON(op)), secret) {
			http.Error(w, "credential boundary failed", http.StatusForbidden)
			return
		}
	}
	if known, ok := f.ops[op.OperationID]; ok {
		if string(browserJSON(known)) != string(browserJSON(op)) {
			http.Error(w, "operation changed", http.StatusConflict)
			return
		}
		_ = json.NewEncoder(w).Encode(f.receipts[op.OperationID])
		return
	}
	f.ops[op.OperationID] = op
	receipt := cloudexecutor.Receipt{OperationID: op.OperationID, Action: op.Action, State: cloudexecutor.StateSucceeded, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	var result any
	key := op.SandboxID + ":" + fmt.Sprint(op.Input["path"])
	switch op.Action {
	case "sandbox.create":
		f.created++
		id := fmt.Sprintf("browser-fixture-vm-%d", f.created)
		info := map[string]any{"sandbox_id": id, "state": "running", "started_at": time.Now(), "expires_at": time.Now().Add(300 * time.Second), "network": map[string]any{"outbound": "denied", "public_access": false}, "auto_resume": false}
		f.infos[id] = info
		result = info
	case "sandbox.info":
		result = f.infos[op.SandboxID]
	case "sandbox.kill":
		f.killed++
		for path := range f.files {
			if strings.HasPrefix(path, op.SandboxID+":") {
				delete(f.files, path)
			}
		}
		result = map[string]any{"sandbox_id": op.SandboxID, "sandbox_terminated": true}
	case "code.run":
		// A single explicit test marker materializes predetermined PNG bytes.
		// No code supplied by a model or browser is evaluated on the host.
		if op.Input["code"] != browserFixtureChartCode || op.Input["language"] != "python" || f.infos[op.SandboxID] == nil {
			delete(f.ops, op.OperationID)
			http.Error(w, "unsupported synthetic code", 400)
			return
		}
		f.codeRuns++
		f.files[op.SandboxID+":"+browserFixtureChartPath] = append([]byte(nil), f.chartPNG...)
		result = map[string]any{"logs": map[string]any{"stdout": []string{"Synthetic UI protocol fixture PNG materialized; code was not executed."}, "stderr": []string{}}, "results": []any{}, "error": nil}
	case "file.write":
		data, err := base64.StdEncoding.Strict().DecodeString(fmt.Sprint(op.Input["data_base64"]))
		if err != nil {
			http.Error(w, "invalid bytes", 400)
			return
		}
		f.files[key] = data
		result = map[string]any{"bytes": len(data)}
	case "file.download.chunk":
		data, ok := f.files[key]
		offset, _ := op.Input["offset"].(float64)
		maximum, _ := op.Input["max_bytes"].(float64)
		if !ok || offset < 0 || int(offset) > len(data) || maximum <= 0 {
			http.Error(w, "invalid file range", 400)
			return
		}
		end := min(len(data), int(offset+maximum))
		part := data[int(offset):end]
		digest := sha256.Sum256(data)
		result = map[string]any{"offset": int(offset), "total_bytes": len(data), "sha256": hex.EncodeToString(digest[:]), "bytes": len(part), "data_base64": base64.StdEncoding.EncodeToString(part), "eof": end == len(data)}
	case "file.upload.begin":
		transferKey := op.SandboxID + ":" + fmt.Sprint(op.Input["transfer_id"])
		f.transfer[transferKey] = &browserTransfer{path: fmt.Sprint(op.Input["path"]), sha: fmt.Sprint(op.Input["sha256"]), size: int(op.Input["total_bytes"].(float64))}
		result = map[string]any{"received_bytes": 0}
	case "file.upload.chunk", "file.upload.finalize":
		transferKey := op.SandboxID + ":" + fmt.Sprint(op.Input["transfer_id"])
		transfer := f.transfer[transferKey]
		if transfer == nil {
			http.Error(w, "missing transfer", http.StatusConflict)
			return
		}
		if op.Action == "file.upload.chunk" {
			data, err := base64.StdEncoding.Strict().DecodeString(fmt.Sprint(op.Input["data_base64"]))
			if err != nil || int(op.Input["offset"].(float64)) != len(transfer.data) {
				http.Error(w, "invalid transfer offset", http.StatusConflict)
				return
			}
			transfer.data = append(transfer.data, data...)
			result = map[string]any{"received_bytes": len(transfer.data)}
		} else {
			digest := sha256.Sum256(transfer.data)
			if transfer.size != len(transfer.data) || transfer.sha != hex.EncodeToString(digest[:]) {
				http.Error(w, "invalid transfer hash", http.StatusConflict)
				return
			}
			f.files[op.SandboxID+":"+transfer.path] = append([]byte(nil), transfer.data...)
			f.loaded++
			result = map[string]any{"finalized": true, "total_bytes": transfer.size, "sha256": transfer.sha}
		}
	default:
		http.Error(w, "unsupported synthetic action", 400)
		return
	}
	receipt.Result = browserJSON(result)
	f.receipts[op.OperationID] = receipt
	// A bounded delay lets the real progress UI be observed during publication.
	if op.Action == "file.write" || op.Action == "file.upload.finalize" {
		time.Sleep(400 * time.Millisecond)
	}
	_ = json.NewEncoder(w).Encode(receipt)
}

var browserArtifactPattern = regexp.MustCompile(`<artifact_source version_id="([0-9a-f-]{36})" family_id="([0-9a-f-]{36})"`)

func (f *browserToolFixture) respondModel(w http.ResponseWriter, body []byte) bool {
	var request struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if json.Unmarshal(body, &request) != nil {
		return false
	}
	lastUser := -1
	for index, message := range request.Messages {
		if message.Role == "user" {
			lastUser = index
		}
	}
	if lastUser < 0 {
		return false
	}
	user := string(request.Messages[lastUser].Content)
	if !strings.Contains(user, "验收表格") && !strings.Contains(user, "联网研究验收") && !strings.Contains(user, "图表验收") {
		return false
	}
	var plain string
	if json.Unmarshal(request.Messages[lastUser].Content, &plain) != nil {
		var parts []struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(request.Messages[lastUser].Content, &parts)
		for _, part := range parts {
			plain += part.Text
		}
	}
	reference := browserArtifactPattern.FindStringSubmatch(plain)
	toolResults := 0
	var lastResult map[string]any
	for _, message := range request.Messages[lastUser+1:] {
		if message.Role == "tool" {
			toolResults++
			var content string
			_ = json.Unmarshal(message.Content, &content)
			_ = json.Unmarshal([]byte(content), &lastResult)
		}
	}
	if strings.Contains(user, "联网研究验收") {
		return respondBrowserResearch(w, toolResults, lastResult)
	}
	if strings.Contains(user, "图表验收") {
		return respondBrowserChart(w, toolResults, lastResult)
	}
	path := "results/browser-report.csv"
	content := "item,value\nprofit,42\n"
	if len(reference) > 0 {
		path, content = "inputs/browser-report.csv", "item,value\nprofit,84\n"
	}
	name := "write_file"
	arguments := map[string]any{"path": path, "content": content}
	switch {
	case len(reference) > 0 && toolResults == 0:
		name, arguments = "load_uploaded_file", map[string]any{"artifact_version_id": reference[1], "path": path}
	case toolResults == 1 && len(reference) == 0 || toolResults == 2 && len(reference) > 0:
		name, arguments = "publish_artifact", map[string]any{"path": path, "name": "browser-report.csv"}
		if len(reference) > 0 {
			arguments["family_id"] = reference[2]
		}
	case toolResults >= 2 && len(reference) == 0 || toolResults >= 3 && len(reference) > 0:
		artifact, _ := lastResult["artifact"].(map[string]any)
		id, _ := artifact["id"].(string)
		if id == "" {
			http.Error(w, "synthetic publication did not succeed", http.StatusBadGateway)
			return true
		}
		text := "合成协议验收成果已保存，可下载并继续修改。\n\n【成果:" + id + "】\n\n此回复由本地夹具生成，尚未验证真实模型内容质量。"
		_, _ = fmt.Fprintf(w, "data: %s\n\n", browserJSON(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": text}}}}))
		browserModelFinish(w, "stop")
		return true
	}
	call := map[string]any{"index": 0, "id": fmt.Sprintf("browser_call_%d", toolResults), "type": "function", "function": map[string]any{"name": name, "arguments": string(browserJSON(arguments))}}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", browserJSON(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{call}}}}}))
	browserModelFinish(w, "tool_calls")
	return true
}

func browserModelFinish(w http.ResponseWriter, reason string) {
	_, _ = fmt.Fprintf(w, "data: %s\n\ndata: {\"choices\":[],\"usage\":{\"total_tokens\":12}}\n\ndata: [DONE]\n\n", browserJSON(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": reason}}}))
}
