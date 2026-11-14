package account

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

// This executes the production bounded guest Python, actual unittest and diff
// generation against synthetic files. Model/SDK/S3 transports are local HTTP
// protocol fixtures; this is not evidence of live E2B or paid model quality.
func TestCloudRunArchiveActualGuestCodePatchAndDurableZIP(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("production archive guest requires Linux renameat2/resource limits")
	}
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal("actual guest acceptance requires python3")
	}
	guest, err := filepath.Abs("../../../cloud-executor/sandbox/archive_extract.py")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(guest); err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	var rounds atomic.Int32
	var fileID atomic.Value
	urls := map[string]string{}
	fixed := "from decimal import Decimal\ndef total(rows):\n    seen = set()\n    result = Decimal('0')\n    for row in rows:\n        if row['order_id'] in seen or not row['quantity'].strip():\n            continue\n        seen.add(row['order_id'])\n        result += Decimal(row['quantity']) * Decimal(row['unit_price'])\n    return result\n"
	fixCode := "from pathlib import Path\nimport difflib, zipfile\np = Path('project/total.py')\nold = p.read_text()\nnew = " + fmt.Sprintf("%q", fixed) + "\np.write_text(new)\nPath('fix.patch').write_text(''.join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), fromfile='a/total.py', tofile='b/total.py')))\nwith zipfile.ZipFile('fixed-code.zip','w',zipfile.ZIP_DEFLATED) as z:\n    for name in ('total.py','test_total.py','README.txt'):\n        z.write('project/'+name, name)\nprint('Patch and revised source ZIP created')\n"
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		step := rounds.Add(1)
		switch step {
		case 1:
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			messages := string(cloudJSON(payload["messages"]))
			if !strings.Contains(messages, "extract_archive") || strings.Contains(messages, "def total(rows)") {
				t.Error("ZIP raw body entered model or lacked extraction guidance")
			}
			archiveModelCall(w, "load_uploaded_file", map[string]any{"file_id": fileID.Load().(string), "path": "source.zip"})
		case 2:
			archiveModelCall(w, "extract_archive", map[string]any{"path": "source.zip", "destination": "project"})
		case 3:
			result := lastResearchToolResult(t, r)
			if result["destination"] != "project" || result["file_count"] != float64(3) || result["durable"] != false || result["manifest_truncated"] != false {
				t.Error("verified guest manifest lost")
			}
			archiveModelCall(w, "execute_command", map[string]any{"command": "python3 -m unittest -v", "cwd": "project"})
		case 4:
			result := lastResearchToolResult(t, r)
			if result["exit_code"] != float64(1) || !strings.Contains(fmt.Sprint(result["stderr"]), "FAILED") {
				t.Error("original buggy code did not actually fail tests")
			}
			archiveModelCall(w, "execute_code", map[string]any{"language": "python", "code": fixCode})
		case 5:
			archiveModelCall(w, "execute_command", map[string]any{"command": "python3 -m unittest -v", "cwd": "project"})
		case 6:
			result := lastResearchToolResult(t, r)
			if result["exit_code"] != float64(0) || !strings.Contains(fmt.Sprint(result["stderr"]), "OK") {
				t.Error("revised code did not actually pass tests")
			}
			emitToolCalls(w, map[string]any{"index": 0, "id": "publish_patch", "type": "function", "function": map[string]any{"name": "publish_artifact", "arguments": `{"path":"fix.patch","name":"fix.patch","mime":"text/plain"}`}}, map[string]any{"index": 1, "id": "publish_zip", "type": "function", "function": map[string]any{"name": "publish_artifact", "arguments": `{"path":"fixed-code.zip","name":"fixed-code.zip","mime":"application/zip"}`}})
			emitModelFinish(w, "tool_calls", 1)
		case 7:
			var payload struct {
				Messages []map[string]any `json:"messages"`
			}
			_ = json.NewDecoder(r.Body).Decode(&payload)
			for _, message := range payload.Messages {
				if message["role"] != "tool" {
					continue
				}
				var value struct {
					Artifact *CloudArtifactVersion `json:"artifact"`
				}
				text, _ := message["content"].(string)
				if json.Unmarshal([]byte(text), &value) == nil && value.Artifact != nil {
					a := value.Artifact
					if a.State != CloudArtifactReady || a.DownloadPath == "" {
						t.Error("unverified artifact advertised")
					}
					urls[a.Name] = a.DownloadPath
					emitCloudDelta(w, "【成果:"+a.ID+"】")
				}
			}
			emitModelFinish(w, "stop", 1)
		default:
			t.Error("unexpected extra model round")
			emitModelFinish(w, "stop", 1)
		}
	})
	storage := newCloudFileHTTPFixture(t)
	if err = f.service.SetCloudObjectStore(storage.objects); err != nil {
		t.Fatal(err)
	}
	// The fixture runs Python synchronously in its HTTP handler, unlike the live SDK.
	sdk := newCloudSDKFixtureWithTimeout(t, f, true, 7*time.Second)
	var extracts atomic.Int32
	sdk.testAction = func(op cloudexecutor.Operation) (json.RawMessage, bool) {
		if op.Action != "archive.extract" && op.Action != "code.run" && op.Action != "command.run" {
			return nil, false
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var cmd *exec.Cmd
		switch op.Action {
		case "archive.extract":
			extracts.Add(1)
			path := fmt.Sprint(op.Input["path"])
			data := sdk.files[op.SandboxID+":"+path]
			if archiveDigest(data) != op.Input["source_sha256"] {
				t.Error("Go did not derive digest from verified uploaded bytes")
			}
			if err := os.WriteFile(filepath.Join(workspace, path), data, 0600); err != nil {
				t.Error(err)
			}
			cmd = exec.CommandContext(ctx, python, "-I", guest)
			cmd.Stdin = bytes.NewReader(cloudJSON(map[string]any{"root": workspace, "path": path, "destination": op.Input["destination"], "source_sha256": op.Input["source_sha256"]}))
		case "code.run":
			cmd = exec.CommandContext(ctx, python, "-c", fmt.Sprint(op.Input["code"]))
			cmd.Dir = workspace
		default:
			cmd = exec.CommandContext(ctx, "sh", "-c", fmt.Sprint(op.Input["command"]))
			cmd.Dir = filepath.Join(workspace, fmt.Sprint(op.Input["cwd"]))
		}
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		err := cmd.Run()
		exit := 0
		if err != nil {
			exit = 1
			if status, ok := err.(*exec.ExitError); ok {
				exit = status.ExitCode()
			} else {
				t.Error(err)
			}
		}
		var result map[string]any
		if op.Action == "archive.extract" {
			if err != nil || json.Unmarshal(stdout.Bytes(), &result) != nil || result["error"] != nil {
				t.Errorf("actual guest rejected valid archive: %s %s", stdout.String(), stderr.String())
			}
			result["sandbox_id"] = op.SandboxID
		} else {
			result = map[string]any{"stdout": stdout.String(), "stderr": stderr.String(), "exit_code": exit}
		}
		if err := filepath.WalkDir(workspace, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.Type().IsRegular() {
				data, err := os.ReadFile(path)
				if err != nil {
					return err
				}
				relative, _ := filepath.Rel(workspace, path)
				sdk.files[op.SandboxID+":"+filepath.ToSlash(relative)] = data
			}
			return nil
		}); err != nil {
			t.Error(err)
		}
		return cloudJSON(result), true
	}
	file := uploadCloudArchive(t, f, cloudArchiveFixtureBytes(t))
	fileID.Store(file.ID)
	run := createCloudArchiveRun(t, f, file, "actual-guest-code-zip")
	finished := f.wait(t, run.ID, func(r *CloudRun) bool { return r.Terminal() })
	if finished.State != CloudRunCompleted || rounds.Load() != 7 || extracts.Load() != 1 || sdk.command.Load() != 2 || sdk.code.Load() != 1 {
		operations, err := f.store.ListCloudToolOperations(context.Background(), run.UserID, run.ID, 128)
		if err == nil {
			for _, operation := range operations {
				t.Logf("fixture operation %s: %s (%s)", operation.Name, operation.State, operation.ErrorCode)
			}
		}
		t.Fatalf("actual code loop state=%s code=%s rounds=%d", finished.State, finished.ErrorCode, rounds.Load())
	}
	if len(urls) != 2 {
		t.Fatal("patch and revised ZIP were not both published")
	}
	status, patch := f.request(t, "GET", urls["fix.patch"], "synthetic-browser-cookie", "")
	if status != 200 || !strings.Contains(patch, "--- a/total.py") || !strings.Contains(patch, "+    seen = set()") {
		t.Fatal("durable patch did not contain actual code diff")
	}
	status, archive := f.request(t, "GET", urls["fixed-code.zip"], "synthetic-browser-cookie", "")
	if status != 200 {
		t.Fatal("durable code ZIP unavailable")
	}
	reader, err := zip.NewReader(strings.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	matched := false
	for _, entry := range reader.File {
		if entry.Name == "total.py" {
			r, err := entry.Open()
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(r)
			r.Close()
			if err != nil || string(data) != fixed {
				t.Fatal("published ZIP code differs from tested revision")
			}
			matched = true
		}
	}
	if !matched {
		t.Fatal("published ZIP omitted revised code")
	}
	status, _ = f.request(t, "GET", urls["fixed-code.zip"], "synthetic-other-account", "")
	if status != 404 {
		t.Fatal("code artifact crossed owner")
	}
	canonical, err := f.store.ListCloudMessages(context.Background(), 1, run.ConversationID)
	if err != nil || len(canonical) != 2 || canonical[1].Role != "assistant" {
		t.Fatal("tool rounds duplicated canonical answer")
	}
	t.Logf("actual Linux guest: one extract, original unittest exit=1, fixed unittest exit=0, rounds=%d, durable patch=%d bytes, durable ZIP=%d bytes; local model/SDK/S3 protocols", rounds.Load(), len(patch), len(archive))
}
