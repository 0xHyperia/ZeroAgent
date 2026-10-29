package account

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

func cloudArchiveFixtureBytes(t *testing.T) []byte {
	t.Helper()
	var out bytes.Buffer
	w := zip.NewWriter(&out)
	for _, file := range []struct{ name, text string }{
		{"total.py", "from decimal import Decimal\ndef total(rows):\n    return sum(Decimal(r['quantity']) * Decimal(r['unit_price']) for r in rows)\n"},
		{"test_total.py", "import unittest\nfrom decimal import Decimal\nfrom total import total\nclass Totals(unittest.TestCase):\n    def test_unique_valid_orders_and_refund(self):\n        rows = [dict(order_id=i, quantity=q, unit_price=p) for i,q,p in [('A','1','19.50'),('B','2','15.00'),('B','2','15.00'),('C','','8.00'),('D','1','-5.25')]]\n        self.assertEqual(total(rows), Decimal('44.25'))\n    def test_empty(self):\n        self.assertEqual(total([]), Decimal('0'))\n"},
		{"README.txt", "Run python3 -m unittest -v. All data is synthetic.\n"},
	} {
		part, err := w.Create(file.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write([]byte(file.text)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func uploadCloudArchive(t *testing.T, f *cloudHTTPFixture, data []byte) *CloudFile {
	t.Helper()
	body, headers := cloudFileMultipart(t, f.conversation.ID, "code-task.zip", data)
	req, _ := http.NewRequest(http.MethodPost, f.server.URL+"/api/web-chat/files", body)
	req.Header = headers
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "synthetic-browser-cookie"})
	response, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var uploaded struct {
		File *CloudFile `json:"file"`
	}
	if response.StatusCode != 201 || json.NewDecoder(response.Body).Decode(&uploaded) != nil || uploaded.File == nil {
		t.Fatal("ZIP upload failed")
	}
	return uploaded.File
}

func createCloudArchiveRun(t *testing.T, f *cloudHTTPFixture, file *CloudFile, id string) *CloudRun {
	t.Helper()
	input := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: id, Model: "test-model", ProviderKeyID: 41, Content: cloudJSON([]any{map[string]any{"type": "text", "text": "修复代码资料，运行测试并交付补丁及新版ZIP"}, map[string]any{"type": "file_reference", "file_id": file.ID}})}
	status, data := f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	var accepted struct {
		Run *CloudRun `json:"run"`
	}
	if status != 202 || json.Unmarshal([]byte(data), &accepted) != nil || accepted.Run == nil {
		t.Fatalf("ZIP reference status %d", status)
	}
	return accepted.Run
}

func archiveModelCall(w http.ResponseWriter, name string, args any) {
	emitToolCalls(w, map[string]any{"index": 0, "id": "call_" + name, "type": "function", "function": map[string]any{"name": name, "arguments": string(cloudJSON(args))}})
	emitModelFinish(w, "tool_calls", 1)
}

func TestCloudFileArchiveOpaqueVerifiedOriginal(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	original := cloudArchiveFixtureBytes(t)
	file := f.upload(t, "code-task.zip", original)
	if file.State != CloudFileUploaded || file.ProcessingStage != "workspace_only" || file.TextBytes != 0 || file.WorkspaceLoadable || file.MIME != "application/zip" || file.UploadedAt == nil {
		t.Fatal("ZIP was parsed, unverified, or falsely advertised as executable")
	}
	stored, err := f.store.GetCloudFile(context.Background(), 1, file.ID)
	if err != nil || stored.Text != "" || stored.ParseTask != nil || len(stored.Segments) != 0 {
		t.Fatal("opaque ZIP entered parser state")
	}
	candidates, err := f.store.ListCloudFileParserCandidates(context.Background(), 100)
	if err != nil || len(candidates) != 0 {
		t.Fatal("ZIP was selected for document parsing")
	}
	status, body, _ := f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/download", "file-owner", nil, nil)
	if status != 200 || !bytes.Equal(body, original) {
		t.Fatal("ZIP original did not round trip")
	}
	status, _, _ = f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/download", "file-other", nil, nil)
	if status != 404 {
		t.Fatal("ZIP original crossed owner scope")
	}
	bodyInput, headers := cloudFileMultipart(t, f.conversation.ID, "fake.zip", []byte("not a ZIP"))
	status, _, _ = f.request(t, "POST", "/api/web-chat/files", "file-owner", bodyInput, headers)
	if status != 400 {
		t.Fatal("invalid ZIP signature was accepted")
	}
}

func TestCloudRunArchiveUnknownNeverReexecutesOrClaimsSuccess(t *testing.T) {
	var rounds atomic.Int32
	var fileID atomic.Value
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch rounds.Add(1) {
		case 1:
			archiveModelCall(w, "load_uploaded_file", map[string]any{"file_id": fileID.Load().(string), "path": "source.zip"})
		case 2:
			archiveModelCall(w, "extract_archive", map[string]any{"path": "source.zip", "destination": "project"})
		default:
			t.Error("unknown archive effect reentered model")
			emitModelFinish(w, "stop", 1)
		}
	})
	storage := newCloudFileHTTPFixture(t)
	if err := f.service.SetCloudObjectStore(storage.objects); err != nil {
		t.Fatal(err)
	}
	sdk := newCloudSDKFixture(t, f, true)
	var extracts atomic.Int32
	sdk.testAction = func(op cloudexecutor.Operation) (json.RawMessage, bool) {
		if op.Action != "archive.extract" {
			return nil, false
		}
		extracts.Add(1)
		// A success envelope with an unverifiable receipt is an uncertain effect.
		return cloudJSON(map[string]any{"sandbox_id": op.SandboxID, "source_sha256": op.Input["source_sha256"], "destination": "wrong", "files": []any{}, "file_count": 0, "total_bytes": 0}), true
	}
	file := uploadCloudArchive(t, f, cloudArchiveFixtureBytes(t))
	fileID.Store(file.ID)
	if !file.WorkspaceLoadable {
		t.Fatal("verified ZIP lacks enabled workspace capability")
	}
	run := createCloudArchiveRun(t, f, file, "archive-unknown")
	finished := f.wait(t, run.ID, func(r *CloudRun) bool { return r.Terminal() })
	if finished.State != CloudRunInterrupted || finished.ErrorCode != "cloud_tool_outcome_unknown" || rounds.Load() != 2 || extracts.Load() != 1 {
		t.Fatalf("archive uncertainty state=%s code=%s", finished.State, finished.ErrorCode)
	}
	ops, err := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, op := range ops {
		if op.Name == "extract_archive" {
			found = true
			if op.State != CloudToolUnknown {
				t.Fatal("uncertain effect lost its durable state")
			}
		}
	}
	if !found {
		t.Fatal("archive identity not durably retained")
	}
	retry := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: "archive-unknown", Model: "test-model", ProviderKeyID: 41, Content: cloudJSON([]any{map[string]any{"type": "text", "text": "修复代码资料，运行测试并交付补丁及新版ZIP"}, map[string]any{"type": "file_reference", "file_id": file.ID}})}
	status, data := f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(retry)))
	var replay struct {
		Run *CloudRun `json:"run"`
	}
	if status != 200 || json.Unmarshal([]byte(data), &replay) != nil || replay.Run == nil || replay.Run.ID != run.ID || extracts.Load() != 1 || rounds.Load() != 2 {
		t.Fatal("retry of an uncertain ZIP task created new work or lost its original run")
	}
	status, _ = f.request(t, "GET", "/api/web-chat/runs/"+run.ID, "synthetic-other-account", "")
	if status != 404 {
		t.Fatal("archive run crossed owner")
	}
}

func TestCloudRunArchiveArgumentAndPublicScopeGuards(t *testing.T) {
	for _, args := range []string{`{"path":"../source.zip"}`, `{"path":"source.zip","destination":"/tmp/project"}`, `{"path":"source.zip","source_sha256":"model-hash"}`, `{"path":"source.zip","sandbox_id":"foreign"}`} {
		if _, err := parseCloudToolInvocation(cloudModelToolCall{Name: "extract_archive", Arguments: args}); err == nil {
			t.Fatal("unsafe/model-owned archive parameter accepted")
		}
	}
	f, _, e := newCloudResearchScopeFixture(t, &CloudRunPublicResearch{Topic: "approved topic"})
	ctx, err := e.beginPublicResearch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.execute(ctx, 0, cloudModelToolCall{Index: 0, ID: "archive", Name: "extract_archive", Arguments: `{"path":"private.zip"}`}); err == nil {
		t.Fatal("public phase executed private archive tool")
	}
	ops, err := f.store.ListCloudToolOperations(context.Background(), 1, e.run.ID, 128)
	if err != nil || len(ops) != 0 {
		t.Fatal("public archive call reached durable effect ledger")
	}
}

func archiveDigest(data []byte) string {
	value := sha256.Sum256(data)
	return hex.EncodeToString(value[:])
}

func TestCloudFileArchiveStoreContract(t *testing.T) {
	for _, backend := range []string{"memory", "postgres"} {
		t.Run(backend, func(t *testing.T) {
			var files CloudFileStore
			if backend == "memory" {
				files = NewMemoryStore()
			} else {
				store := cloudRunPostgresFixture(t).store.(*PersistentStore)
				if _, err := store.db.Exec(CloudFileSchema); err != nil {
					t.Fatal(err)
				}
				files = store
			}
			ctx := context.Background()
			conversation := &CloudConversation{ID: uuid.NewString(), UserID: 17, Title: "archive", Model: "test"}
			if err := files.(Store).PutCloudConversation(ctx, conversation); err != nil {
				t.Fatal(err)
			}
			record := newCloudFileRecord(17, conversation.ID)
			record.Name, record.MIME = "source.zip", "application/zip"
			file, err := files.CreateCloudFile(ctx, record)
			if err != nil {
				t.Fatal(err)
			}
			file, err = files.UpdateCloudFile(ctx, 17, file.ID, file.Version, CloudFileUpdate{State: CloudFileUploaded, MarkUploaded: true, ProcessingStage: "workspace_only"})
			if err != nil {
				t.Fatal(err)
			}
			stored, err := files.GetCloudFile(ctx, 17, file.ID)
			if err != nil || stored.ProcessingStage != "workspace_only" || stored.UploadedAt == nil || stored.Text != "" || stored.State != CloudFileUploaded || stored.ParseTask != nil {
				t.Fatal("ZIP metadata contract was not durable")
			}
			if _, err = files.GetCloudFile(ctx, 18, file.ID); !errors.Is(err, ErrNotFound) {
				t.Fatal("foreign opaque archive metadata visible")
			}
			candidates, err := files.(interface {
				ListCloudFileParserCandidates(context.Context, int) ([]CloudFile, error)
			}).ListCloudFileParserCandidates(ctx, 100)
			if err != nil || len(candidates) != 0 {
				t.Fatal("workspace-only archive entered parser queue")
			}
		})
	}
}

func TestCloudRunArchiveManifestModelBudget(t *testing.T) {
	result := cloudexecutor.ArchiveExtractResult{SandboxID: "private-vm-id", SourceSHA256: strings.Repeat("a", 64), Destination: "project", Files: []cloudexecutor.ArchiveFile{}, FileCount: 128, TotalBytes: 128}
	for index := 0; index < 128; index++ {
		result.Files = append(result.Files, cloudexecutor.ArchiveFile{Path: fmt.Sprintf("project/%03d%s", index, strings.Repeat("\"", 400)), Size: 1, SHA256: strings.Repeat("b", 64)})
	}
	projected := cloudArchiveModelResult(result)
	var value map[string]any
	if len(projected) > cloudToolResultBytes || json.Unmarshal(projected, &value) != nil || value["manifest_truncated"] != true || value["file_count"] != float64(128) || value["total_bytes"] != float64(128) || value["durable"] != false || value["manifest_sha256"] == "" || strings.Contains(string(projected), result.SandboxID) {
		t.Fatal("archive manifest exceeded model budget or misstated extraction/storage")
	}
	files, _ := value["files"].([]any)
	if len(files) < 1 || len(files) >= len(result.Files) {
		t.Fatal("abbreviated manifest was not a useful bounded prefix")
	}
}

func TestCloudRunArchiveFullManifestSurvivesSDKRetirement(t *testing.T) {
	var rounds atomic.Int32
	var fileID atomic.Value
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch rounds.Add(1) {
		case 1:
			archiveModelCall(w, "load_uploaded_file", map[string]any{"file_id": fileID.Load().(string), "path": "source.zip"})
		case 2:
			archiveModelCall(w, "extract_archive", map[string]any{"path": "source.zip"})
		default:
			result := lastResearchToolResult(t, r)
			if len(cloudJSON(result)) > cloudToolResultBytes || result["manifest_truncated"] != true || result["file_count"] != float64(128) {
				t.Error("full private manifest leaked into model projection")
			}
			emitCloudDelta(w, "已解包，文件清单较长，仅显示部分；完整私有清单已保存。")
			emitModelFinish(w, "stop", 1)
		}
	})
	storage := newCloudFileHTTPFixture(t)
	if err := f.service.SetCloudObjectStore(storage.objects); err != nil {
		t.Fatal(err)
	}
	sdk := newCloudSDKFixture(t, f, true)
	sdk.testAction = func(op cloudexecutor.Operation) (json.RawMessage, bool) {
		if op.Action != "archive.extract" {
			return nil, false
		}
		destination := fmt.Sprint(op.Input["destination"])
		if !strings.HasPrefix(destination, "extract-") {
			t.Error("default directory was not stable operation-derived")
		}
		files := []cloudexecutor.ArchiveFile{}
		for index := 0; index < 128; index++ {
			files = append(files, cloudexecutor.ArchiveFile{Path: fmt.Sprintf("%s/%03d%s", destination, index, strings.Repeat("\"", 400)), Size: 1, SHA256: strings.Repeat("b", 64)})
		}
		return cloudJSON(cloudexecutor.ArchiveExtractResult{SandboxID: op.SandboxID, SourceSHA256: fmt.Sprint(op.Input["source_sha256"]), Destination: destination, Files: files, FileCount: 128, TotalBytes: 128}), true
	}
	file := uploadCloudArchive(t, f, cloudArchiveFixtureBytes(t))
	fileID.Store(file.ID)
	run := createCloudArchiveRun(t, f, file, "archive-full-private-manifest")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || rounds.Load() != 3 {
		t.Fatalf("manifest run state=%s code=%s", finished.State, finished.ErrorCode)
	}
	ops, err := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
	if err != nil {
		t.Fatal(err)
	}
	var semantic, external *CloudToolOperation
	for index := range ops {
		if ops[index].Name == "extract_archive" {
			semantic = &ops[index]
		}
		if ops[index].Name == "archive.extract" {
			external = &ops[index]
		}
	}
	if semantic == nil || external == nil || semantic.State != CloudToolSucceeded || external.State != CloudToolSucceeded || len(semantic.Result) > cloudToolResultBytes || len(external.Result) <= cloudToolResultBytes {
		t.Fatal("full SDK fact was replaced by its abbreviated model result")
	}
	var complete cloudexecutor.ArchiveExtractResult
	if json.Unmarshal(external.Result, &complete) != nil || len(complete.Files) != 128 || complete.FileCount != 128 || complete.Files[127].Path == "" {
		t.Fatal("private complete manifest was not durable")
	}
	sdk.mu.Lock()
	retired := sdk.retired[external.ID]
	sdk.mu.Unlock()
	if !retired {
		t.Fatal("persisted SDK manifest was not eligible for retirement")
	}
	public, err := f.store.ListCloudRunEvents(context.Background(), 1, run.ID, 0, 256)
	if err != nil || strings.Contains(string(cloudJSON(public)), complete.Files[127].Path) {
		t.Fatal("private manifest entered public progress")
	}
}

func TestCloudRunArchiveDurableManifestContract(t *testing.T) {
	for _, factory := range []struct {
		name string
		new  func(*testing.T) cloudToolFixture
	}{{"memory", memoryCloudToolFixture}, {"postgres", postgresCloudToolFixture}} {
		t.Run(factory.name, func(t *testing.T) {
			f := factory.new(t)
			ctx := context.Background()
			run := toolRunningRun(t, f, 7, "")
			parent, _, err := f.tools.PrepareCloudTool(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, &CloudToolOperation{CallKey: "round:0:call:0", Name: "extract_archive", Input: cloudJSON(map[string]any{"path": "source.zip"})})
			if err != nil {
				t.Fatal(err)
			}
			child, _, err := f.tools.PrepareCloudTool(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, &CloudToolOperation{CallKey: "archive:" + parent.ID + ":extract", Name: "archive.extract", Input: cloudJSON(map[string]any{"path": "source.zip", "destination": "project", "source_sha256": strings.Repeat("a", 64)})})
			if err != nil {
				t.Fatal(err)
			}
			for _, op := range []*CloudToolOperation{parent, child} {
				if _, err = f.tools.StartCloudTool(ctx, 7, op.ID, run.LeaseOwner, run.Attempt); err != nil {
					t.Fatal(err)
				}
			}
			full := cloudexecutor.ArchiveExtractResult{SandboxID: "private-vm", SourceSHA256: strings.Repeat("a", 64), Destination: "project", Files: []cloudexecutor.ArchiveFile{}, FileCount: 128, TotalBytes: 128}
			for index := 0; index < 128; index++ {
				full.Files = append(full.Files, cloudexecutor.ArchiveFile{Path: fmt.Sprintf("project/%03d%s", index, strings.Repeat("\"", 400)), Size: 1, SHA256: strings.Repeat("b", 64)})
			}
			if _, err = f.tools.CommitCloudTool(ctx, 7, child.ID, run.LeaseOwner, run.Attempt, CloudToolSucceeded, cloudJSON(full), ""); err != nil {
				t.Fatal(err)
			}
			if _, err = f.tools.CommitCloudTool(ctx, 7, parent.ID, run.LeaseOwner, run.Attempt, CloudToolSucceeded, cloudArchiveModelResult(full), ""); err != nil {
				t.Fatal(err)
			}
			stored, err := f.tools.GetCloudToolOperation(ctx, 7, child.ID)
			var restored cloudexecutor.ArchiveExtractResult
			if err != nil || json.Unmarshal(stored.Result, &restored) != nil || !bytes.Equal(cloudJSON(restored), cloudJSON(full)) {
				t.Fatal("complete private manifest was not durably retained")
			}
			stored, err = f.tools.GetCloudToolOperation(ctx, 7, parent.ID)
			if err != nil || len(stored.Result) > cloudToolResultBytes {
				t.Fatal("semantic replay result exceeded bounded model budget")
			}
			if _, err = f.tools.GetCloudToolOperation(ctx, 8, child.ID); !errors.Is(err, ErrNotFound) {
				t.Fatal("foreign account read private manifest")
			}
			if _, err = f.tools.CommitCloudTool(ctx, 7, child.ID, run.LeaseOwner, run.Attempt+1, CloudToolSucceeded, cloudJSON(full), ""); !errors.Is(err, ErrCloudRunLeaseLost) {
				t.Fatal("stale execution altered archive fact")
			}
		})
	}
}
