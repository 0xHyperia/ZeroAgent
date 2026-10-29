package account

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

type artifactSDKFixture struct {
	mu       sync.Mutex
	data     []byte
	calls    int
	corrupt  bool
	acked    int
	ackCheck func(string)
}

func artifactPublicationFixture(t *testing.T, f *cloudFileHTTPFixture) (CloudArtifactPublication, *artifactSDKFixture) {
	t.Helper()
	ctx := context.Background()
	session, err := f.store.GetSession(ctx, "file-owner")
	if err != nil {
		t.Fatal(err)
	}
	ref, err := f.store.BindCloudRunSession(ctx, session)
	if err != nil {
		t.Fatal(err)
	}
	base := cloudRunTestFixture{store: f.store, runs: f.store}
	input := cloudRunTestInput(t, base, 1, f.conversation.ID, uuid.NewString(), "export CSV")
	input.SessionRef = ref
	if _, _, err = f.store.CreateCloudRun(ctx, input); err != nil {
		t.Fatal(err)
	}
	run, err := f.store.ClaimCloudRun(ctx, "artifact-http-worker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	binding, _, err := f.store.ReserveCloudWorkspace(ctx, 1, run.ID, run.LeaseOwner, run.Attempt, 300, 3600)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	binding, err = f.store.RecordCloudWorkspaceReceipt(ctx, 1, binding.ID, binding.CreateOperationID, binding.Version, CloudWorkspaceReceipt{State: CloudWorkspaceReady, SandboxID: "artifact-owned-vm", StartedAt: started, ExpiresAt: started.Add(299 * time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	pub := CloudArtifactPublication{ConversationID: run.ConversationID, RunID: run.ID, LeaseOwner: run.LeaseOwner, ExecutionAttempt: run.Attempt, Name: "report.csv", Path: "results/report.csv", SandboxID: binding.SandboxID, WorkspaceRef: binding.WorkspaceRef}
	op, _, err := f.store.PrepareCloudTool(ctx, 1, run.ID, run.LeaseOwner, run.Attempt, &CloudToolOperation{CallKey: "artifact-call-one", Name: "publish_artifact", Input: cloudJSON(map[string]any{"path": pub.Path, "name": pub.Name})})
	if err != nil {
		t.Fatal(err)
	}
	op, err = f.store.StartCloudTool(ctx, 1, op.ID, run.LeaseOwner, run.Attempt)
	if err != nil {
		t.Fatal(err)
	}
	pub.ToolOperationID = op.ID
	fixture := &artifactSDKFixture{data: []byte("item,value\nprofit,4\n")}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer artifact-test-internal-token-0123456789abcdef" {
			t.Error("missing internal auth")
		}
		if strings.HasSuffix(r.URL.Path, "/acknowledge") {
			id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/operations/"), "/acknowledge")
			fixture.mu.Lock()
			fixture.acked++
			check := fixture.ackCheck
			fixture.mu.Unlock()
			if check != nil {
				check(id)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"operation_id": id, "acknowledged": true})
			return
		}
		var operation cloudexecutor.Operation
		if json.NewDecoder(r.Body).Decode(&operation) != nil {
			t.Error("invalid operation")
		}
		if operation.Action != "file.download.chunk" || operation.OwnerScope != binding.OwnerScope || operation.WorkspaceRef != binding.WorkspaceRef || operation.SandboxID != binding.SandboxID {
			t.Error("artifact transport ownership lost")
		}
		fixture.mu.Lock()
		fixture.calls++
		data := append([]byte(nil), fixture.data...)
		corrupt := fixture.corrupt
		fixture.mu.Unlock()
		offset := int(operation.Input["offset"].(float64))
		end := offset + int(operation.Input["max_bytes"].(float64))
		if end > len(data) {
			end = len(data)
		}
		chunk := append([]byte(nil), data[offset:end]...)
		if corrupt && len(chunk) > 1 {
			chunk[0] ^= 1
		}
		digest := sha256.Sum256(data)
		result := map[string]any{"offset": offset, "total_bytes": len(data), "sha256": hex.EncodeToString(digest[:]), "data_base64": base64.StdEncoding.EncodeToString(chunk), "bytes": len(chunk), "eof": end == len(data)}
		encoded, _ := json.Marshal(result)
		receipt := cloudexecutor.Receipt{OperationID: operation.OperationID, Action: operation.Action, State: cloudexecutor.StateSucceeded, CreatedAt: time.Now(), UpdatedAt: time.Now(), Result: encoded}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(receipt)
	}))
	t.Cleanup(server.Close)
	client, err := cloudexecutor.New(cloudexecutor.Config{BaseURL: server.URL, Token: "artifact-test-internal-token-0123456789abcdef", PollInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseIdleConnections)
	if err = f.service.SetCloudExecutor(client); err != nil {
		t.Fatal(err)
	}
	return pub, fixture
}
func nextArtifactPublication(t *testing.T, f *cloudFileHTTPFixture, pub CloudArtifactPublication, familyID string) CloudArtifactPublication {
	t.Helper()
	pub.FamilyID = familyID
	pub.Name = "report-v2.csv"
	op, _, err := f.store.PrepareCloudTool(context.Background(), 1, pub.RunID, pub.LeaseOwner, pub.ExecutionAttempt, &CloudToolOperation{CallKey: uuid.NewString(), Name: "publish_artifact", Input: cloudJSON(map[string]any{"path": pub.Path, "name": pub.Name, "family_id": familyID})})
	if err != nil {
		t.Fatal(err)
	}
	op, err = f.store.StartCloudTool(context.Background(), 1, op.ID, pub.LeaseOwner, pub.ExecutionAttempt)
	if err != nil {
		t.Fatal(err)
	}
	pub.ToolOperationID = op.ID
	return pub
}

func TestCloudArtifactSDKToVerifiedObjectVersionedHTTP(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	pub, sdk := artifactPublicationFixture(t, f)
	first, err := f.service.PublishCloudArtifact(context.Background(), 1, pub)
	if err != nil || first.State != CloudArtifactReady || first.DownloadPath == "" || first.Number != 1 {
		t.Fatalf("publish=%+v err=%v", first, err)
	}
	again, err := f.service.PublishCloudArtifact(context.Background(), 1, pub)
	if err != nil || again.ID != first.ID {
		t.Fatal("retry created new version")
	}
	changed := pub
	changed.Name = "different.csv"
	if _, err = f.service.PublishCloudArtifact(context.Background(), 1, changed); err == nil {
		t.Fatal("same operation changed request")
	}
	status, download, _ := f.request(t, "GET", first.DownloadPath, "file-owner", nil, nil)
	if status != 200 || !bytes.Equal(download, []byte("item,value\nprofit,4\n")) {
		t.Fatalf("verified download %d %s", status, download)
	}
	sdk.mu.Lock()
	sdk.data = []byte("item,value\nprofit,9\n")
	sdk.mu.Unlock()
	secondPub := nextArtifactPublication(t, f, pub, first.FamilyID)
	second, err := f.service.PublishCloudArtifact(context.Background(), 1, secondPub)
	if err != nil || second.Number != 2 || second.ID == first.ID {
		t.Fatalf("new version %+v %v", second, err)
	}
	status, download, _ = f.request(t, "GET", first.DownloadPath, "file-owner", nil, nil)
	if status != 200 || !bytes.Contains(download, []byte("profit,4")) {
		t.Fatal("old immutable version overwritten")
	}
	status, _, _ = f.request(t, "GET", first.DownloadPath, "file-other", nil, nil)
	if status != 404 {
		t.Fatal("foreign artifact downloaded")
	}
	status, list, _ := f.request(t, "GET", "/api/web-chat/artifacts?family_id="+first.FamilyID, "file-owner", nil, nil)
	if status != 200 || !bytes.Contains(list, []byte(first.ID)) || !bytes.Contains(list, []byte(second.ID)) || bytes.Contains(list, []byte("journal")) {
		t.Fatal("version listing incomplete/private")
	}
	status, _, _ = f.request(t, "DELETE", "/api/web-chat/artifacts/"+first.FamilyID, "file-owner", nil, nil)
	if status != 200 {
		t.Fatal("artifact deletion failed")
	}
	status, _, _ = f.request(t, "GET", first.DownloadPath, "file-owner", nil, nil)
	if status != 404 {
		t.Fatal("deleted version downloadable")
	}
}

func TestCloudArtifactCorruptSourceOrStorageNeverGetsReadyURL(t *testing.T) {
	for _, mode := range []string{"source", "storage"} {
		t.Run(mode, func(t *testing.T) {
			f := newCloudFileHTTPFixture(t)
			pub, sdk := artifactPublicationFixture(t, f)
			if mode == "source" {
				sdk.mu.Lock()
				sdk.corrupt = true
				sdk.mu.Unlock()
			} else {
				f.mu.Lock()
				f.corruptGet = true
				f.mu.Unlock()
			}
			version, err := f.service.PublishCloudArtifact(context.Background(), 1, pub)
			if err == nil {
				t.Fatal("corrupt artifact accepted")
			}
			if version != nil && (version.State == CloudArtifactReady || version.DownloadPath != "") {
				t.Fatal("corrupt artifact exposed ready")
			}
			stored, getErr := f.store.GetCloudArtifactByOperation(context.Background(), 1, pub.ToolOperationID)
			if getErr == nil && stored.State == CloudArtifactReady {
				t.Fatal("bad artifact marked ready")
			}
		})
	}
}

func TestCloudArtifactDeleteDuringPutDoesNotResurrectLateBytes(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	pub, _ := artifactPublicationFixture(t, f)
	f.putEntered = make(chan struct{})
	f.putRelease = make(chan struct{})
	done := make(chan error, 1)
	go func() { _, err := f.service.PublishCloudArtifact(context.Background(), 1, pub); done <- err }()
	select {
	case <-f.putEntered:
	case <-time.After(3 * time.Second):
		t.Fatal("artifact PUT not reached")
	}
	version, err := f.store.GetCloudArtifactByOperation(context.Background(), 1, pub.ToolOperationID)
	if err != nil {
		t.Fatal(err)
	}
	status, _, _ := f.request(t, "DELETE", "/api/web-chat/artifacts/"+version.FamilyID, "file-owner", nil, nil)
	if status != 202 {
		t.Fatalf("in-flight deletion must remain pending: %d", status)
	}
	close(f.putRelease)
	select {
	case err = <-done:
		if err == nil {
			t.Fatal("late PUT claimed publish success")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("late cleanup did not settle")
	}
	current, err := f.store.GetCloudArtifactVersion(context.Background(), 1, version.ID)
	if err != nil || current.DeletedAt == nil || current.State != CloudArtifactDeleted {
		t.Fatalf("late bytes not cleaned %+v %v", current, err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.data) != 0 {
		t.Fatal("late object bytes resurrected")
	}
}

func TestCloudArtifactRejectsForeignOrExpiredExecutionGrant(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	pub, sdk := artifactPublicationFixture(t, f)
	foreign := pub
	foreign.SandboxID = "foreign-vm"
	if _, err := f.service.PublishCloudArtifact(context.Background(), 1, foreign); err == nil {
		t.Fatal("foreign sandbox accepted")
	}
	if _, err := f.service.PublishCloudArtifact(context.Background(), 2, pub); err == nil {
		t.Fatal("foreign account accepted")
	}
	if _, err := f.store.CancelCloudRun(context.Background(), 1, pub.RunID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.PublishCloudArtifact(context.Background(), 1, pub); err == nil {
		t.Fatal("cancelled run published")
	}
	sdk.mu.Lock()
	defer sdk.mu.Unlock()
	if sdk.calls != 0 {
		t.Fatal("unauthorized execution reached SDK")
	}
}
