package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
	"github.com/liveagent/agent-gateway/internal/cloudsite"
)

func TestCloudSitePublicationSourceBindingAndVerifiedManifest(t *testing.T) {
	for _, variant := range []string{"valid", "wrong-output", "wrong-source", "invalid-site"} {
		t.Run(variant, func(t *testing.T) {
			f := newCloudFileHTTPFixture(t)
			pub, sdk := artifactPublicationFixture(t, f)
			enableSiteFixture(t, f)
			pub.Name, pub.MIME, pub.SiteSourcePath = "site.zip", "application/zip", "project/dist"
			op, _, err := f.store.PrepareCloudTool(context.Background(), 1, pub.RunID, pub.LeaseOwner, pub.ExecutionAttempt, &CloudToolOperation{CallKey: uuid.NewString(), Name: "publish_site", Input: cloudJSON(map[string]any{"path": pub.SiteSourcePath, "name": pub.Name})})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.store.StartCloudTool(context.Background(), 1, op.ID, pub.LeaseOwner, pub.ExecutionAttempt); err != nil {
				t.Fatal(err)
			}
			pub.ToolOperationID, pub.Path = op.ID, cloudexecutor.SiteBundlePath(op.ID)
			data, manifest := siteTestZIP(t, "private site")
			if variant == "invalid-site" {
				data = cloudArchiveFixtureBytes(t)
			}
			sdk.mu.Lock()
			sdk.data = data
			sdk.mu.Unlock()
			pub.Size, pub.SHA256 = int64(len(data)), archiveDigest(data)
			if variant == "wrong-output" {
				pub.Path = cloudexecutor.SiteBundlePath("other-operation")
			}
			if variant == "wrong-source" {
				pub.SiteSourcePath = "private/dist"
			}
			result, err := f.service.PublishCloudArtifact(context.Background(), 1, pub)
			if variant != "valid" {
				if err == nil || result != nil && result.State == CloudArtifactReady {
					t.Fatal("invalid site was published", err)
				}
				if variant != "invalid-site" {
					sdk.mu.Lock()
					calls := sdk.calls
					sdk.mu.Unlock()
					if calls != 0 {
						t.Fatal("unbound source reached executor")
					}
				}
				return
			}
			if err != nil || result.State != CloudArtifactReady || result.DownloadPath == "" {
				t.Fatal("site not durably saved", err)
			}
			release, err := f.store.GetCloudSiteRelease(context.Background(), 1, result.ID)
			if err != nil || release.SiteID != result.FamilyID || release.SHA256 != result.SHA256 || release.Manifest.ExpandedBytes != manifest.ExpandedBytes {
				t.Fatal("ready site lost verified manifest", err)
			}
			shares, err := f.store.ListCloudSiteShares(context.Background(), 1, result.FamilyID)
			if err != nil || len(shares) != 0 {
				t.Fatal("AI publication created a public share", err)
			}
			status, body, _ := f.request(t, "GET", result.DownloadPath, "file-owner", nil, nil)
			if status != 200 || !bytes.Equal(body, data) {
				t.Fatal("durable site ZIP changed")
			}
			if _, err = f.store.GetCloudSiteRelease(context.Background(), 2, result.ID); !errors.Is(err, ErrNotFound) {
				t.Fatal("site crossed owner")
			}
		})
	}
}

func TestCloudRunSiteArgumentsAndPublicScope(t *testing.T) {
	for _, args := range []string{
		`{"path":".","name":"site.zip"}`, `{"path":"project/.env","name":"site.zip"}`,
		`{"path":"project/dist","name":"site.html"}`, `{"path":"project/dist","name":"site.zip","public":true}`,
		`{"path":"project/dist","name":"site.zip","sandbox_id":"foreign"}`, `{"path":"project/dist","name":"site.zip","family_id":"invalid"}`,
	} {
		if _, err := parseCloudToolInvocation(cloudModelToolCall{Name: "publish_site", Arguments: args}); err == nil {
			t.Fatal("untrusted site authority accepted", args)
		}
	}
	f, _, e := newCloudResearchScopeFixture(t, &CloudRunPublicResearch{Topic: "approved topic"})
	ctx, err := e.beginPublicResearch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = e.execute(ctx, 0, cloudModelToolCall{Index: 0, ID: "site", Name: "publish_site", Arguments: `{"path":"project/dist","name":"site.zip"}`}); err == nil {
		t.Fatal("public research published private workspace")
	}
	ops, err := f.store.ListCloudToolOperations(context.Background(), 1, e.run.ID, 128)
	if err != nil || len(ops) != 0 {
		t.Fatal("public site call reached effect ledger", err)
	}
}

func TestCloudRunSiteReadyPrivateAndUnknownNoReplay(t *testing.T) {
	for _, uncertain := range []bool{false, true} {
		t.Run(fmt.Sprint(uncertain), func(t *testing.T) {
			var rounds, bundles atomic.Int32
			var versionID atomic.Value
			f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if rounds.Add(1) == 1 {
					archiveModelCall(w, "publish_site", map[string]any{"path": "project/dist", "name": "site.zip"})
					return
				}
				if uncertain {
					t.Error("uncertain site effect reentered model")
					emitModelFinish(w, "stop", 1)
					return
				}
				result := lastResearchToolResult(t, r)
				artifact, _ := result["artifact"].(map[string]any)
				site, _ := result["site"].(map[string]any)
				if artifact["state"] != CloudArtifactReady || result["durable"] != true || result["shared"] != false || site["release_id"] != artifact["id"] || site["site_id"] != artifact["family_id"] {
					t.Error("model received an unverified site success")
				}
				versionID.Store(fmt.Sprint(artifact["id"]))
				emitCloudDelta(w, "私人站点已保存：【成果:"+fmt.Sprint(artifact["id"])+"】")
				emitModelFinish(w, "stop", 1)
			})
			storage := newCloudFileHTTPFixture(t)
			if err := f.service.SetCloudObjectStore(storage.objects); err != nil {
				t.Fatal(err)
			}
			cfg, err := cloudsite.NewConfig("https://{site}.example.net", "https://app.example.com", "127.0.0.1:18081", strings.Repeat("s", 64), false)
			if err != nil {
				t.Fatal(err)
			}
			if err = f.service.SetCloudSiteConfig(cfg); err != nil {
				t.Fatal(err)
			}
			sdk := newCloudSDKFixture(t, f, true)
			data, manifest := siteTestZIP(t, "model site")
			sdk.testAction = func(op cloudexecutor.Operation) (json.RawMessage, bool) {
				if op.Action != "site.bundle" {
					return nil, false
				}
				bundles.Add(1)
				path := fmt.Sprint(op.Input["output_path"])
				sdk.files[op.SandboxID+":"+path] = append([]byte(nil), data...)
				result := cloudexecutor.SiteBundleResult{SandboxID: op.SandboxID, SourcePath: fmt.Sprint(op.Input["path"]), Path: path, EntryPoint: "index.html", Size: int64(len(data)), SHA256: archiveDigest(data), FileCount: len(manifest.Entries), ExpandedBytes: manifest.ExpandedBytes}
				if uncertain {
					result.Path = "wrong-output.zip"
				}
				return cloudJSON(result), true
			}
			run, requestBody := f.create(t, "private-site", "制作可交互站点并保存到我的资料空间")
			done := f.wait(t, run.ID, func(r *CloudRun) bool { return r.Terminal() })
			ops, err := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
			if err != nil {
				t.Fatal(err)
			}
			parent, child := false, false
			for _, op := range ops {
				if op.Name != "publish_site" && op.Name != "site.bundle" {
					continue
				}
				if op.Name == "publish_site" {
					parent = true
				} else {
					child = true
				}
				expected := CloudToolSucceeded
				if uncertain {
					expected = CloudToolUnknown
				}
				if op.State != expected {
					t.Fatalf("site effect %s state=%s expected=%s", op.Name, op.State, expected)
				}
			}
			if !parent || !child || bundles.Load() != 1 {
				t.Fatal("site operation identities were not durable")
			}
			if uncertain {
				if done.State != CloudRunInterrupted || done.ErrorCode != "cloud_site_publication_unknown" || rounds.Load() != 1 {
					t.Fatal("unknown site falsely completed", done.State, done.ErrorCode)
				}
				status, body := f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", requestBody)
				var replay struct {
					Run *CloudRun `json:"run"`
				}
				if status != 200 || json.Unmarshal([]byte(body), &replay) != nil || replay.Run == nil || replay.Run.ID != run.ID || bundles.Load() != 1 {
					t.Fatal("uncertain site was repackaged")
				}
				return
			}
			if done.State != CloudRunCompleted || rounds.Load() != 2 {
				t.Fatal("site run incomplete", done.State, done.ErrorCode)
			}
			id, _ := versionID.Load().(string)
			a, err := f.store.GetCloudArtifactVersion(context.Background(), 1, id)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.store.GetCloudSiteRelease(context.Background(), 1, id); err != nil {
				t.Fatal("ready model site lacks durable manifest", err)
			}
			shares, err := f.store.ListCloudSiteShares(context.Background(), 1, a.FamilyID)
			if err != nil || len(shares) != 0 {
				t.Fatal("site was automatically shared", err)
			}
			status, body := f.request(t, "GET", publicCloudArtifact(a).DownloadPath, "synthetic-browser-cookie", "")
			if status != 200 || !bytes.Equal([]byte(body), data) {
				t.Fatal("site bundle not downloadable")
			}
			// Session-bound private access is issued only through the explicit UI API.
			session, err := f.store.GetSession(context.Background(), "synthetic-browser-cookie")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.service.CreateCloudSiteAccess(context.Background(), session, id, uuid.NewString(), "private", 10*time.Minute); err != nil {
				t.Fatal("saved site cannot be privately previewed", err)
			}
		})
	}
}

func TestCloudRunSiteUnavailableCreatesNoWorkspace(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Error("invalid model request")
		}
		if strings.Contains(string(cloudJSON(request["tools"])), "publish_site") {
			t.Error("site publication advertised without configured hosting")
		}
		archiveModelCall(w, "publish_site", map[string]any{"path": "project/dist", "name": "site.zip"})
	})
	storage := newCloudFileHTTPFixture(t)
	if err := f.service.SetCloudObjectStore(storage.objects); err != nil {
		t.Fatal(err)
	}
	sdk := newCloudSDKFixture(t, f, true)
	run, _ := f.create(t, "unavailable-site", "制作私人站点")
	done := f.wait(t, run.ID, func(r *CloudRun) bool { return r.Terminal() })
	ops, err := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
	if done.State != CloudRunFailed || done.ErrorCode != "cloud_tool_unavailable" || sdk.created.Load() != 0 || err != nil || len(ops) != 0 {
		t.Fatal("unadvertised site tool produced effects", done.State, done.ErrorCode, err)
	}
}

func TestCloudSiteCapabilityGuidanceAndArtifactFingerprint(t *testing.T) {
	now := time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)
	tools := []map[string]any{cloudToolFunction("publish_site", "", nil)}
	guidance := cloudCapabilityGuidance(now, CloudRunModelParameters{}, tools)
	for _, expected := range []string{"durable publication available: true", "publish_artifact or publish_site", "private", "network egress remains denied", "user explicitly controls sharing"} {
		if !strings.Contains(guidance, expected) {
			t.Fatal("site capabilities misrepresented", expected)
		}
	}
	without := cloudCapabilityGuidance(now, CloudRunModelParameters{}, nil)
	if strings.Contains(without, "publish_site") || strings.Contains(without, "durable publication available: true") {
		t.Fatal("unavailable site capability invented")
	}
	pub := CloudArtifactPublication{ConversationID: "conversation", RunID: "run", ToolOperationID: "operation", FamilyID: "family", Name: "file.zip", MIME: "application/zip", WorkspaceRef: "workspace", SandboxID: "sandbox", Path: "result.zip"}
	old := archiveDigest(cloudJSON([]any{pub.ConversationID, pub.RunID, pub.ToolOperationID, pub.FamilyID, pub.Name, pub.MIME, pub.WorkspaceRef, pub.SandboxID, pub.Path}))
	if artifactPublicationHash(pub) != old {
		t.Fatal("existing artifact request identity changed")
	}
	pub.SiteSourcePath = "project/dist"
	first := artifactPublicationHash(pub)
	pub.SiteSourcePath = "other/dist"
	if first == old || artifactPublicationHash(pub) == first {
		t.Fatal("site source not bound into durable request identity")
	}
}
