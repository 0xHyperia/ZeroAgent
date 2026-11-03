package account

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/cloudsite"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

func TestCloudSitePreviewBridgePreservesDocumentParsing(t *testing.T) {
	for _, body := range []string{
		"<!doctype html><html><head><title>Site</title></head><body><main>Content</main></body></html>",
		"<!doctype html><html><head></head><main>Content</main></html>",
		"<!doctype html><main>Content</main>",
	} {
		got := string(sitePreviewDocument([]byte(body), "https://app.example.com"))
		if !strings.HasPrefix(got, "<!doctype html>") || strings.Index(got, "zeroAgentSitePreview") < strings.Index(got, "</main>") {
			t.Fatal("preview script must follow site content and preserve the doctype")
		}
		if strings.Count(got, "function zeroAgentSitePreview") != 1 {
			t.Fatal("preview bridge must be inserted once")
		}
	}
}

func enableSiteFixture(t *testing.T, f *cloudFileHTTPFixture) {
	t.Helper()
	cfg, err := cloudsite.NewConfig("https://{site}.example.net", "https://app.example.com", "127.0.0.1:18081", strings.Repeat("s", 64), false)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.SetCloudSiteConfig(cfg); err != nil {
		t.Fatal(err)
	}
}
func siteHTTPArtifact(t *testing.T, f *cloudFileHTTPFixture, family string, data []byte) *CloudArtifactVersion {
	t.Helper()
	ctx := context.Background()
	fixture := cloudRunTestFixture{store: f.store, runs: f.store}
	input := cloudRunTestInput(t, fixture, 1, f.conversation.ID, uuid.NewString(), "build static site")
	if _, _, err := f.store.CreateCloudRun(ctx, input); err != nil {
		t.Fatal(err)
	}
	run, err := f.store.ClaimCloudRun(ctx, "site-test-worker", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	source := artifactContractVersion(run)
	if family != "" {
		source.FamilyID = family
	}
	source.Name = "site.zip"
	source.MIME = "application/zip"
	source.Size = int64(len(data))
	digest := sha256.Sum256(data)
	source.SHA256 = hex.EncodeToString(digest[:])
	a, _, err := f.store.ReserveCloudArtifact(ctx, 1, run.LeaseOwner, run.Attempt, source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.objects.Put(ctx, a.ObjectKey, bytes.NewReader(data), a.Size, objectstore.PutOptions{ContentType: a.MIME, SHA256: a.SHA256, Metadata: cloudArtifactObjectMetadata(a)}); err != nil {
		t.Fatal(err)
	}
	a, err = f.store.UpdateCloudArtifact(ctx, 1, a.ID, a.Version, run.LeaseOwner, run.Attempt, CloudArtifactUpdate{State: CloudArtifactReady})
	if err != nil {
		t.Fatal(err)
	}
	finishCloudAdmissionTestRun(t, fixture, run, CloudRunCompleted)
	return a
}
func siteOwnerJSON(t *testing.T, f *cloudFileHTTPFixture, method, path, cookie string, value any, want int) []byte {
	t.Helper()
	data, _ := json.Marshal(value)
	status, body, _ := f.request(t, method, path, cookie, bytes.NewReader(data), http.Header{"Content-Type": {"application/json"}})
	if status != want {
		t.Fatalf("site API %s %s: status %d; body %s", method, path, status, body)
	}
	return body
}
func issueSiteFixture(t *testing.T, f *cloudFileHTTPFixture, a *CloudArtifactVersion, mode string) CloudSiteGrant {
	t.Helper()
	endpoint := "shares"
	if mode == "private" {
		endpoint = "preview"
	}
	body := siteOwnerJSON(t, f, "POST", "/api/web-chat/sites/releases/"+a.ID+"/"+endpoint, "file-owner", map[string]any{"request_id": uuid.NewString()}, 200)
	var result struct {
		Grant CloudSiteGrant `json:"grant"`
	}
	if err := json.Unmarshal(body, &result); err != nil || result.Grant.URL == "" {
		t.Fatal("missing site access URL", err)
	}
	return result.Grant
}
func siteContent(t *testing.T, f *cloudFileHTTPFixture, method, link, host string, headers http.Header) *httptest.ResponseRecorder {
	t.Helper()
	u, err := url.Parse(link)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(method, link, nil)
	r.Host = u.Host
	if host != "" {
		r.Host = host
	}
	r.Header = headers.Clone()
	if r.Header == nil {
		r.Header = make(http.Header)
	}
	w := httptest.NewRecorder()
	f.service.CloudSiteContentHandler().ServeHTTP(w, r)
	return w
}
func TestCloudSiteHTTPPrivateVersionsShareAndRevoke(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	status, body, _ := f.request(t, "GET", "/api/web-chat/sites/config", "file-owner", nil, nil)
	if status != 200 || !strings.Contains(string(body), `"enabled":false`) {
		t.Fatal("site hosting enabled implicitly")
	}
	enableSiteFixture(t, f)
	data, _ := siteTestZIP(t, "version-one")
	a := siteHTTPArtifact(t, f, "", data)
	base := "/api/web-chat/sites/releases/" + a.ID
	siteOwnerJSON(t, f, "POST", base, "", map[string]any{}, 401)
	siteOwnerJSON(t, f, "POST", base, "file-other", map[string]any{}, 404)
	status, _, _ = f.request(t, "POST", base, "file-owner", strings.NewReader(`{}`), http.Header{"Origin": {"https://attacker.invalid"}})
	if status != 403 {
		t.Fatal("cross-origin site registration allowed", status)
	}
	registered := siteOwnerJSON(t, f, "POST", base, "file-owner", map[string]any{}, 200)
	if strings.Contains(string(registered), `"url"`) {
		t.Fatal("saving a release made it public")
	}
	siteOwnerJSON(t, f, "GET", base, "file-other", nil, 404)
	siteOwnerJSON(t, f, "GET", base+"/cover", "file-other", nil, 404)
	cover := siteOwnerJSON(t, f, "GET", base+"/cover", "file-owner", nil, 200)
	var covered struct {
		HTML string `json:"html"`
	}
	if json.Unmarshal(cover, &covered) != nil || !strings.Contains(covered.HTML, "version-one") || strings.Contains(covered.HTML, "<script") {
		t.Fatal("invalid inert site cover")
	}
	list := siteOwnerJSON(t, f, "GET", "/api/web-chat/sites/families/"+a.FamilyID+"/shares", "file-owner", nil, 200)
	if !strings.Contains(string(list), `"shares":[]`) {
		t.Fatal("cover created a sharing grant")
	}
	private := issueSiteFixture(t, f, a, "private")
	share := issueSiteFixture(t, f, a, "share")
	u, _ := url.Parse(share.URL)
	script := *u
	script.Path = strings.TrimSuffix(u.Path, "index.html") + "assets/app.js"
	for _, g := range []CloudSiteGrant{private, share} {
		w := siteContent(t, f, "GET", g.URL, "", nil)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "version-one") || w.Header().Get("Content-Type") != "text/html; charset=utf-8" {
			t.Fatal("canonical site page failed", w.Code, w.Body.String())
		}
		if !strings.Contains(w.Body.String(), "zeroagent-site-command") || !strings.Contains(w.Body.String(), `event.origin!==appOrigin`) {
			t.Fatal("site inspection bridge lacks origin validation")
		}
		if w.Header().Get("Set-Cookie") != "" || w.Header().Get("Referrer-Policy") != "no-referrer" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "worker-src blob:") || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors https://app.example.com") {
			t.Fatal("content isolation headers missing")
		}
	}
	js := siteContent(t, f, "GET", script.String(), "", nil)
	if js.Code != 200 || js.Header().Get("Content-Type") != "text/javascript; charset=utf-8" || !strings.Contains(js.Body.String(), "onclick") {
		t.Fatal("relative JS asset failed", js.Code)
	}
	p, _ := f.service.siteProvider()
	for range cap(p.renders) {
		p.renders <- struct{}{}
	}
	blocked := siteContent(t, f, "GET", script.String(), "", nil)
	for range cap(p.renders) {
		<-p.renders
	}
	if blocked.Code != 429 || blocked.Header().Get("Retry-After") != "1" {
		t.Fatal("cached content bypassed render memory gate", blocked.Code)
	}
	rangeResponse := siteContent(t, f, "GET", script.String(), "", http.Header{"Range": {"bytes=0-7"}})
	if rangeResponse.Code != 206 || rangeResponse.Body.Len() != 8 {
		t.Fatal("site range read failed", rangeResponse.Code)
	}
	head := siteContent(t, f, "HEAD", share.URL, "", nil)
	if head.Code != 200 || head.Body.Len() != 0 || head.Header().Get("Content-Length") == "" {
		t.Fatal("site HEAD failed")
	}
	if siteContent(t, f, "GET", share.URL, "app.example.com", http.Header{"X-Forwarded-Host": {u.Host}}).Code != 404 {
		t.Fatal("main origin accepted content grant")
	}
	if siteContent(t, f, "POST", share.URL, "", nil).Code != 405 {
		t.Fatal("content host accepts writes")
	}
	bad := *u
	parts := strings.SplitN(strings.TrimPrefix(u.Path, "/v/"), "/", 2)
	bad.Path = "/v/" + parts[0] + "x/" + parts[1]
	if siteContent(t, f, "GET", bad.String(), "", nil).Code != 404 {
		t.Fatal("forged token accepted")
	}
	bad.Path = "/v/" + parts[0] + "/../index.html"
	if siteContent(t, f, "GET", bad.String(), "", nil).Code != 404 {
		t.Fatal("traversal accepted")
	}
	unicode := *u
	unicode.Path = "/v/" + parts[0] + "/中文.txt"
	if response := siteContent(t, f, "GET", unicode.String(), "", nil); response.Code != 200 || response.Body.String() != "受控站点资源" {
		t.Fatal("unicode site resource failed", response.Code)
	}
	secondData, _ := siteTestZIP(t, "version-two")
	second := siteHTTPArtifact(t, f, a.FamilyID, secondData)
	siteOwnerJSON(t, f, "POST", "/api/web-chat/sites/releases/"+second.ID, "file-owner", map[string]any{}, 200)
	secondShare := issueSiteFixture(t, f, second, "share")
	if w := siteContent(t, f, "GET", share.URL, "", nil); w.Code != 200 || !strings.Contains(w.Body.String(), "version-one") {
		t.Fatal("new release moved an existing shared URL")
	}
	if w := siteContent(t, f, "GET", secondShare.URL, "", nil); w.Code != 200 || !strings.Contains(w.Body.String(), "version-two") {
		t.Fatal("new version cannot be selected")
	}
	siteOwnerJSON(t, f, "DELETE", "/api/web-chat/sites/grants/"+share.ID, "file-other", map[string]any{"version": share.Version}, 404)
	siteOwnerJSON(t, f, "DELETE", "/api/web-chat/sites/grants/"+share.ID, "file-owner", map[string]any{"version": share.Version + 1}, 409)
	siteOwnerJSON(t, f, "DELETE", "/api/web-chat/sites/grants/"+share.ID, "file-owner", map[string]any{"version": share.Version}, 200)
	if siteContent(t, f, "GET", share.URL, "", nil).Code != 404 || siteContent(t, f, "GET", script.String(), "", nil).Code != 404 {
		t.Fatal("revoked site served from cache")
	}
	listed := siteOwnerJSON(t, f, "GET", "/api/web-chat/sites/families/"+a.FamilyID+"/shares", "file-owner", nil, 200)
	if strings.Contains(string(listed), share.ID) || !strings.Contains(string(listed), secondShare.ID) {
		t.Fatal("share management lost release state")
	}
	if err := f.store.DeleteSession(context.Background(), "file-owner"); err != nil {
		t.Fatal(err)
	}
	if siteContent(t, f, "GET", private.URL, "", nil).Code != 404 {
		t.Fatal("private preview survives logout")
	}
	if siteContent(t, f, "GET", secondShare.URL, "", nil).Code != 200 {
		t.Fatal("explicit share incorrectly needs owner's login")
	}
	if _, err := f.store.DeleteCloudArtifactFamily(context.Background(), 1, a.FamilyID); err != nil {
		t.Fatal(err)
	}
	if siteContent(t, f, "GET", secondShare.URL, "", nil).Code != 404 {
		t.Fatal("deleted canonical source served from cache")
	}
}
func TestCloudSiteHTTPExpiryRetryAndIntegrity(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	enableSiteFixture(t, f)
	data, _ := siteTestZIP(t, "expiry")
	a := siteHTTPArtifact(t, f, "", data)
	base := "/api/web-chat/sites/releases/" + a.ID
	siteOwnerJSON(t, f, "POST", base, "file-owner", map[string]any{}, 200)
	requestID := uuid.NewString()
	input := map[string]any{"request_id": requestID, "expires_in_seconds": 2}
	body := siteOwnerJSON(t, f, "POST", base+"/shares", "file-owner", input, 200)
	var response struct {
		Grant CloudSiteGrant `json:"grant"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	replay := siteOwnerJSON(t, f, "POST", base+"/shares", "file-owner", input, 200)
	if !bytes.Equal(body, replay) {
		t.Fatal("retry changed signed access or expiry")
	}
	input["expires_in_seconds"] = 3
	siteOwnerJSON(t, f, "POST", base+"/shares", "file-owner", input, 409)
	for _, invalid := range []any{map[string]any{"request_id": uuid.NewString(), "expires_in_seconds": -1}, map[string]any{"request_id": uuid.NewString(), "expires_in_seconds": int64(1) << 62}, map[string]any{"request_id": uuid.NewString(), "mode": "public"}} {
		siteOwnerJSON(t, f, "POST", base+"/shares", "file-owner", invalid, 400)
	}
	now := response.Grant.ExpiresAt.Add(time.Second)
	f.service.now = func() time.Time { return now }
	f.store.now = f.service.now
	if siteContent(t, f, "GET", response.Grant.URL, "", nil).Code != 404 {
		t.Fatal("expired share served")
	}
	input["expires_in_seconds"] = 2
	siteOwnerJSON(t, f, "POST", base+"/shares", "file-owner", input, 409)
	// A cold read still verifies the complete original; a corrupt object must
	// not acquire a valid manifest or enter the content cache.
	f2 := newCloudFileHTTPFixture(t)
	enableSiteFixture(t, f2)
	bad := siteHTTPArtifact(t, f2, "", data)
	f2.mu.Lock()
	f2.corruptGet = true
	f2.mu.Unlock()
	siteOwnerJSON(t, f2, "POST", "/api/web-chat/sites/releases/"+bad.ID, "file-owner", map[string]any{}, 502)
	if _, err := f2.store.GetCloudSiteRelease(context.Background(), 1, bad.ID); err == nil {
		t.Fatal("corrupt site was persisted")
	}
}
