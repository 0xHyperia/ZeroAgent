package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
	"github.com/liveagent/agent-gateway/internal/cloudsite"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

// Actual Linux build/production packager + real explicitly selected SeaweedFS.
// Model and executor HTTP peers are scripted test transports; no paid provider
// is called and this does not stand in for a live E2B acceptance.
func TestCloudRunSiteActualGuestSeaweedFSDelivery(t *testing.T) {
	privatePath := os.Getenv("ZEROAGENT_SITE_DELIVERY_TEST_CONFIG")
	if privatePath == "" {
		t.Skip("explicit isolated SeaweedFS site delivery not requested")
	}
	private, err := os.ReadFile(privatePath)
	if err != nil || len(private) > 16<<10 {
		t.Fatal("read private delivery fixture")
	}
	var cfg struct{ Endpoint, Bucket, Region, AccessKeyID, SecretAccessKey, TaskID string }
	if json.Unmarshal(private, &cfg) != nil {
		t.Fatal("invalid delivery fixture")
	}
	endpoint, err := url.Parse(cfg.Endpoint)
	ip := net.ParseIP(endpointHostname(endpoint))
	if err != nil || endpoint.Scheme != "http" || endpoint.User != nil || ip == nil || !ip.IsLoopback() || !regexp.MustCompile("^[a-f0-9]{16}$").MatchString(cfg.TaskID) || cfg.Bucket != "za-seaweed-test-"+cfg.TaskID {
		t.Fatal("delivery must use an explicit isolated loopback test bucket")
	}
	objects, err := objectstore.New(objectstore.Config{Endpoint: cfg.Endpoint, Bucket: cfg.Bucket, Region: cfg.Region, AccessKeyID: cfg.AccessKeyID, SecretAccessKey: cfg.SecretAccessKey, AllowLoopbackHTTP: true, MaxObjectBytes: 32 << 20, TempDir: t.TempDir()})
	if err != nil {
		t.Fatal("construct delivery object adapter")
	}
	t.Cleanup(objects.Close)
	if err = objects.Ready(context.Background()); err != nil {
		t.Fatal("SeaweedFS delivery bucket not ready")
	}
	harness, err := os.ReadFile("../../../cloud-executor/test/site-delivery-fixture.py")
	if err != nil {
		t.Fatal(err)
	}
	bundler, err := os.ReadFile("../../../cloud-executor/sandbox/site_bundle.py")
	if err != nil {
		t.Fatal(err)
	}
	executable, args := "python3", []string{"-I", "-c", string(harness)}
	if runtime.GOOS == "windows" {
		executable = "wsl.exe"
		args = append([]string{"-d", "Ubuntu", "--", "python3"}, args...)
	}
	root, marker := "", ""
	guest := func(input map[string]any) (map[string]any, error) {
		if input["mode"] != "init" {
			input["root"], input["marker"] = root, marker
		}
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, executable, args...)
		cmd.Stdin = bytes.NewReader(cloudJSON(input))
		output, err := cmd.Output()
		if err != nil {
			return nil, fmt.Errorf("Linux delivery fixture failed: %w", err)
		}
		var result map[string]any
		if err = json.Unmarshal(output, &result); err != nil {
			return nil, err
		}
		return result, nil
	}
	initial, err := guest(map[string]any{"mode": "init"})
	if err != nil {
		t.Fatal(err)
	}
	root, marker = fmt.Sprint(initial["root"]), fmt.Sprint(initial["marker"])
	cleaned := false
	t.Cleanup(func() {
		if !cleaned {
			if _, err := guest(map[string]any{"mode": "cleanup"}); err != nil {
				t.Error("remove owned guest workspace", err)
			}
		}
	})
	var rounds, bundles atomic.Int32
	var family atomic.Value
	ids := []string{}
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		step := rounds.Add(1)
		switch (step - 1) % 3 {
		case 0:
			archiveModelCall(w, "execute_command", map[string]any{"command": "python3 build.py", "cwd": "project"})
		case 1:
			args := map[string]any{"path": "project/dist", "name": "site.zip"}
			if value, _ := family.Load().(string); value != "" {
				args["family_id"] = value
			}
			archiveModelCall(w, "publish_site", args)
		case 2:
			result := lastResearchToolResult(t, r)
			a, _ := result["artifact"].(map[string]any)
			if result["durable"] != true || result["shared"] != false || a["state"] != CloudArtifactReady {
				t.Error("site returned before durable private publication")
			}
			family.Store(fmt.Sprint(a["family_id"]))
			ids = append(ids, fmt.Sprint(a["id"]))
			emitCloudDelta(w, "私人站点已保存【成果:"+fmt.Sprint(a["id"])+"】")
			emitModelFinish(w, "stop", 1)
		}
	})
	if err = f.service.SetCloudObjectStore(objects); err != nil {
		t.Fatal(err)
	}
	siteConfig, err := cloudsite.NewConfig("https://{site}.example.net", "https://app.example.com", "127.0.0.1:18081", strings.Repeat("s", 64), false)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.SetCloudSiteConfig(siteConfig); err != nil {
		t.Fatal(err)
	}
	sdk := newCloudSDKFixture(t, f, true)
	sdk.testAction = func(op cloudexecutor.Operation) (json.RawMessage, bool) {
		if op.Action != "command.run" && op.Action != "site.bundle" {
			return nil, false
		}
		input := map[string]any{"mode": "build", "command": op.Input["command"], "cwd": op.Input["cwd"]}
		if op.Action == "site.bundle" {
			bundles.Add(1)
			input = map[string]any{"mode": "bundle", "source_base64": base64.StdEncoding.EncodeToString(bundler), "path": op.Input["path"], "output_path": op.Input["output_path"]}
		}
		result, err := guest(input)
		if err != nil {
			t.Error(err)
			return cloudJSON(map[string]any{"error": "guest_failed"}), true
		}
		if op.Action == "site.bundle" {
			data, err := base64.StdEncoding.DecodeString(fmt.Sprint(result["zip_base64"]))
			if err != nil {
				t.Error(err)
			}
			sdk.files[op.SandboxID+":"+fmt.Sprint(result["path"])] = data
			delete(result, "zip_base64")
			result["sandbox_id"] = op.SandboxID
		}
		return cloudJSON(result), true
	}
	t.Cleanup(func() {
		page, err := f.store.ListCloudArtifacts(context.Background(), 1, f.conversation.ID, "", "", 50)
		if err != nil {
			t.Error(err)
			return
		}
		for _, a := range page.Versions {
			if err = objects.Delete(context.Background(), cloudArtifactObjectKey(1, a.FamilyID, a.ID)); err != nil {
				t.Error("remove only delivery fixture object", err)
			}
		}
	})
	for version := 1; version <= 2; version++ {
		run, _ := f.create(t, fmt.Sprintf("site-guest-%d", version), "构建并保存私人站点")
		var done *CloudRun
		deadline := time.Now().Add(45 * time.Second)
		for time.Now().Before(deadline) {
			done, err = f.store.GetCloudRun(context.Background(), 1, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			if done.Terminal() {
				break
			}
			time.Sleep(25 * time.Millisecond)
		}
		if done == nil || !done.Terminal() {
			t.Fatal("actual storage/guest delivery did not reach a terminal state")
		}
		if done.State != CloudRunCompleted {
			t.Fatal("actual guest delivery failed", done.State, done.ErrorCode)
		}
	}
	if len(ids) != 2 || bundles.Load() != 2 || ids[0] == ids[1] {
		t.Fatal("site versions not immutable")
	}
	if _, err = guest(map[string]any{"mode": "cleanup"}); err != nil {
		t.Fatal(err)
	}
	cleaned = true
	session, err := f.store.GetSession(context.Background(), "synthetic-browser-cookie")
	if err != nil {
		t.Fatal(err)
	}
	content := f.service.CloudSiteContentHandler()
	fetch := func(raw string) *httptest.ResponseRecorder {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatal("parse capability URL")
		}
		req := httptest.NewRequest("GET", u.RequestURI(), nil)
		req.Host = u.Host
		response := httptest.NewRecorder()
		content.ServeHTTP(response, req)
		return response
	}
	for index, id := range ids {
		a, err := f.store.GetCloudArtifactVersion(context.Background(), 1, id)
		if err != nil {
			t.Fatal(err)
		}
		if a.Number != int64(index+1) || a.FamilyID != family.Load().(string) {
			t.Fatal("publication lost family or version")
		}
		release, err := f.store.GetCloudSiteRelease(context.Background(), 1, id)
		if err != nil || len(release.Manifest.Entries) != 3 {
			t.Fatal("selected output manifest incorrect", err)
		}
		for _, entry := range release.Manifest.Entries {
			if strings.Contains(entry.Path, ".env") || strings.Contains(entry.Path, "build.py") || strings.Contains(entry.Path, "unrelated") {
				t.Fatal("workspace source/config escaped into site")
			}
		}
		grant, err := f.service.CreateCloudSiteAccess(context.Background(), session, id, uuid.NewString(), "private", 10*time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		response := fetch(grant.URL)
		if response.Code != 200 || !strings.Contains(response.Body.String(), fmt.Sprintf("资料空间 v%d", index+1)) {
			t.Fatal("site version failed after guest removal", response.Code)
		}
	}
	shares, err := f.store.ListCloudSiteShares(context.Background(), 1, family.Load().(string))
	if err != nil || len(shares) != 0 {
		t.Fatal("delivery auto-created a share")
	}
	share, err := f.service.CreateCloudSiteAccess(context.Background(), session, ids[0], uuid.NewString(), "share", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if response := fetch(share.URL); response.Code != 200 || !strings.Contains(response.Body.String(), "资料空间 v1") {
		t.Fatal("explicit share changed to latest version")
	}
	if _, err = f.store.RevokeCloudSiteGrant(context.Background(), 1, share.ID, share.Version); err != nil {
		t.Fatal(err)
	}
	if fetch(share.URL).Code != 404 {
		t.Fatal("cached site share survived revocation")
	}
	if evidence := os.Getenv("ZEROAGENT_SITE_DELIVERY_TEST_EVIDENCE"); evidence != "" {
		if err = os.WriteFile(evidence, cloudJSON(map[string]any{"actual_linux_build": true, "production_guest_packager": true, "actual_seaweedfs": true, "versions": 2, "guest_removed_before_read": true, "private_default": true, "explicit_share_revoked": true, "model_transport": "scripted", "executor_transport": "scripted", "live_e2b": false}), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func endpointHostname(u *url.URL) string {
	if u == nil {
		return ""
	}
	return u.Hostname()
}
