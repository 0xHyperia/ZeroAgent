package account

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDeviceSkillSnapshotUsesDesktopAccountAndSameRevisionAsCloud(t *testing.T) {
	token := func(owner int64) string {
		body := cloudJSON(map[string]any{
			"token_use": "app", "client_id": "zeroagent-desktop", "sub": strconv.FormatInt(owner, 10),
			"grant_id": "grant", "session_id": "session", "family_id": "family", "exp": time.Now().Add(time.Hour).Unix(),
		})
		return "header." + base64.RawURLEncoding.EncodeToString(body) + ".signature"
	}
	owner, stranger := token(1), token(2)
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/app/me" {
			t.Errorf("unexpected platform path %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		switch r.Header.Get("Authorization") {
		case "Bearer " + owner:
			_, _ = io.WriteString(w, `{"success":true,"data":{"id":1}}`)
		case "Bearer " + stranger:
			_, _ = io.WriteString(w, `{"success":true,"data":{"id":2}}`)
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer platform.Close()
	store := NewMemoryStore()
	service := NewService(store, NewUSAClientWithHTTPClient(platform.URL, platform.Client(), ""), time.Hour, time.Hour)
	service.EnableCloudWorkspace()
	mux := http.NewServeMux()
	NewHTTPHandler(service, true).Register(mux)
	ctx := context.Background()
	id := uuid.NewString()
	old := extensionTestRevision("fixed original device and cloud source")
	old.Files["references/note.md"] = "fixed resource"
	newer := extensionTestRevision("new source")
	newer.Number = 2
	executable := extensionTestRevision("requires script")
	executable.Number = 3
	executable.Files["scripts/tool.py"] = "raise RuntimeError()"
	withConnector := extensionTestRevision("Requires a declared remote connection")
	withConnector.Number = 4
	withConnector.Files["agents/openai.yaml"] = `interface:
  display_name: Weekly Review
dependencies:
  tools:
    - type: mcp
      value: calendar
`
	cosmetic := extensionTestRevision("Portable instructions with an interface")
	cosmetic.Number = 5
	cosmetic.Files["agents/openai.yaml"] = `interface:
  display_name: Weekly Review
dependencies: { tools: [] }
`
	doc, err := store.SetCloudExtensions(ctx, 1, 0, CloudExtensions{Packages: []CloudExtension{{
		ID: id, Kind: "skill", Installed: true, Enabled: true,
		Revisions: []CloudExtensionRevision{old, newer, executable, withConnector, cosmetic},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	call := func(access string, refs ...cloudDeviceSkillRef) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "https://gateway.test"+cloudDeviceSkillSnapshotPath,
			bytes.NewReader(cloudJSON(map[string]any{"references": refs})))
		req.Header.Set("Authorization", "Bearer "+access)
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, req)
		return recorder
	}
	ref := cloudDeviceSkillRef{id, 1, "weekly-review"}
	res := call(owner, ref)
	compatibility := func(access string, revision int) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet,
			"https://gateway.test/api/web-chat/extensions/device-compatibility/"+id+"?revision="+strconv.Itoa(revision)+"&skill=weekly-review", nil)
		if access != "" {
			req.Header.Set("Authorization", "Bearer "+access)
		}
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, req)
		return recorder
	}
	if result := compatibility(owner, 1); result.Code != http.StatusNoContent || result.Body.Len() != 0 {
		t.Fatalf("device compatibility disclosed source or refused fixed revision: %d %s", result.Code, result.Body.String())
	}
	if result := compatibility(stranger, 1); result.Code != http.StatusNotFound ||
		strings.Contains(result.Body.String(), "fixed original") {
		t.Fatalf("device compatibility revealed another account's package: %d %s", result.Code, result.Body.String())
	}
	if result := compatibility(owner, 3); result.Code != http.StatusUnprocessableEntity {
		t.Fatalf("device compatibility accepted script: %d %s", result.Code, result.Body.String())
	}
	if result := compatibility(owner, 4); result.Code != http.StatusUnprocessableEntity {
		t.Fatalf("device compatibility accepted sidecar dependency: %d %s", result.Code, result.Body.String())
	}
	if result := compatibility(owner, 5); result.Code != http.StatusNoContent {
		t.Fatalf("device compatibility refused cosmetic sidecar: %d %s", result.Code, result.Body.String())
	}
	var payload struct{ Skills []cloudDeviceSkill }
	if res.Code != http.StatusOK || res.Header().Get("Cache-Control") != "no-store" ||
		json.Unmarshal(res.Body.Bytes(), &payload) != nil || len(payload.Skills) != 1 {
		t.Fatalf("device revision unavailable: %d %s", res.Code, res.Body.String())
	}
	device := payload.Skills[0]
	execution := cloudRunToolExecution{
		run:           &CloudRun{RequestContent: cloudJSON("zeroagent-skill:" + id + "/1/weekly-review")},
		skillPackages: effectiveCloudExtensions(doc),
	}
	for _, file := range []string{"SKILL.md", "references/note.md"} {
		cloud, err := execution.resolveSkill(ctx, id, ref.Name, file)
		if err != nil || cloud["version"] != int64(1) || cloud["instructions"] != device.Files[file] {
			t.Fatalf("different version or bytes for %s: %#v, %#v, %v", file, cloud, device.Files, err)
		}
	}
	if device.cloudDeviceSkillRef != ref || device.Entry != "SKILL.md" || len(device.Files) != 2 {
		t.Fatalf("unexpected device identity or paths: %#v", device)
	}
	for _, tc := range []struct {
		access string
		refs   []cloudDeviceSkillRef
		want   int
	}{
		{stranger, []cloudDeviceSkillRef{ref}, http.StatusNotFound},
		{owner, []cloudDeviceSkillRef{{id, 99, ref.Name}}, http.StatusNotFound},
		{owner, []cloudDeviceSkillRef{ref, {id, 2, ref.Name}}, http.StatusConflict},
		{owner, []cloudDeviceSkillRef{{id, 3, ref.Name}}, http.StatusUnprocessableEntity},
		{owner, []cloudDeviceSkillRef{{id, 4, ref.Name}}, http.StatusUnprocessableEntity},
		{owner, []cloudDeviceSkillRef{{"imagegen", cloudNativeWorkflowRevision, "imagegen"}}, http.StatusUnprocessableEntity},
	} {
		res = call(tc.access, tc.refs...)
		if res.Code != tc.want || strings.Contains(res.Body.String(), "fixed original") {
			t.Errorf("unexpected response %d for %#v: %s", res.Code, tc.refs, res.Body.String())
		}
	}
	res = call(owner, cloudDeviceSkillRef{"product-design", cloudProductDesignQARevision, "audit"})
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "Audit the experience") ||
		strings.Contains(res.Body.String(), "prototype.html") {
		t.Fatalf("portable built-in did not isolate its own files: %d %s", res.Code, res.Body.String())
	}
	doc.Packages[0].Enabled = false
	if _, err := store.SetCloudExtensions(ctx, 1, doc.Version, *doc); err != nil {
		t.Fatal(err)
	}
	if res = call(owner, ref); res.Code != http.StatusNotFound {
		t.Fatalf("disabled revision resolved: %d %s", res.Code, res.Body.String())
	}
}

func TestDeviceSkillChecksDeclaredCapabilitiesForSelectedEntry(t *testing.T) {
	const entry = "skills/weekly-review/SKILL.md"
	const plain = "---\nname: weekly-review\ndescription: Review the week\n---\nReview the week."
	for _, tc := range []struct {
		name, source string
		other        map[string]string
		unsupported  bool
	}{
		{name: "empty frontmatter", source: "---\n---\nReview the week."},
		{name: "multiline description is prose", source: "---\nname: weekly-review\ndescription: |\n  Explain dependencies: in the report.\n---\nReview the week."},
		{name: "quoted frontmatter declaration", source: "\uFEFF---\r\nname: weekly-review\r\n'dependencies': {tools: [calendar]}\r\n---\r\nReview the week.", unsupported: true},
		{name: "unterminated capability header", source: "---\nname: weekly-review\nrequires: calendar", unsupported: true},
		{name: "selected entry sidecar", source: plain, other: map[string]string{"skills/weekly-review/agents/openai.yml": "{dependencies: {tools: [calendar]}}"}, unsupported: true},
		{name: "malformed selected sidecar", source: plain, other: map[string]string{"skills/weekly-review/agents/openai.yaml": "dependencies: {"}, unsupported: true},
		{name: "sibling entry remains separate", source: plain, other: map[string]string{"skills/another/agents/openai.yaml": "dependencies: {tools: [calendar]}"}},
		{name: "shared package sidecar", source: plain, other: map[string]string{"agents/openai.yaml": "dependencies: {tools: [calendar]}"}, unsupported: true},
		{name: "standalone package connection config", source: plain, other: map[string]string{"mcp.json": `{"servers":{"calendar":{"url":"https://example.invalid"}}}`}, unsupported: true},
		{name: "connection declared in manifest extension", source: plain, other: map[string]string{"plugin.json": `{"name":"review","extensions":{"com.openai":{"mcpServers":"./mcp.json"}}}`}, unsupported: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := map[string]string{entry: tc.source}
			for name, content := range tc.other {
				files[name] = content
			}
			if result := deviceSkillDeclaresDependencies(files, entry); result != tc.unsupported {
				t.Fatalf("unsupported = %t, want %t", result, tc.unsupported)
			}
		})
	}
}
