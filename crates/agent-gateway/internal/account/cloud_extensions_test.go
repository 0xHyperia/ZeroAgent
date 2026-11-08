package account

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

func extensionTestRevision(text string) CloudExtensionRevision {
	return CloudExtensionRevision{Number: 1, Name: "weekly-review", Description: "Review a week", Files: map[string]string{"SKILL.md": "---\nname: weekly-review\ndescription: \"Review a week\"\n---\n\n" + text}, Skills: []CloudExtensionSkill{{Name: "weekly-review", Description: "Review a week", Entry: "SKILL.md"}}}
}
func TestCloudExtensionsAccountCAS(t *testing.T) {
	for _, kind := range []string{"memory", "postgres"} {
		t.Run(kind, func(t *testing.T) {
			var store cloudExtensionsStore
			if kind == "memory" {
				store = NewMemoryStore()
			} else {
				f := cloudRunPostgresFixture(t)
				p := f.store.(*PersistentStore)
				if _, err := p.db.Exec(CloudExtensionsSchema); err != nil {
					t.Fatal(err)
				}
				store = p
			}
			ctx := context.Background()
			id := uuid.NewString()
			doc := CloudExtensions{Packages: []CloudExtension{{ID: id, Kind: "skill", Installed: true, Enabled: true, Revisions: []CloudExtensionRevision{extensionTestRevision("private instructions")}}}}
			var wg sync.WaitGroup
			var winners atomic.Int64
			for range 8 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					_, err := store.SetCloudExtensions(ctx, 7, 0, doc)
					if err == nil {
						winners.Add(1)
					} else if !errors.Is(err, ErrCloudRunConflict) {
						t.Error(err)
					}
				}()
			}
			wg.Wait()
			if winners.Load() != 1 {
				t.Fatal("CAS accepted competing writers", winners.Load())
			}
			result, err := store.GetCloudExtensions(ctx, 7)
			if err != nil || result.Version != 1 {
				t.Fatal(result, err)
			}
			result.Packages[0].Revisions[0].Files["SKILL.md"] = "mutated copy"
			fresh, _ := store.GetCloudExtensions(ctx, 7)
			if !strings.Contains(fresh.Packages[0].Revisions[0].Files["SKILL.md"], "private instructions") {
				t.Fatal("caller mutated stored files")
			}
			other, _ := store.GetCloudExtensions(ctx, 8)
			if len(other.Packages) != 0 {
				t.Fatal("cross-account data")
			}
			doc.Packages = append(doc.Packages, doc.Packages[0])
			if _, err := store.SetCloudExtensions(ctx, 7, 1, doc); !errors.Is(err, ErrCloudRunInvalid) {
				t.Fatal("duplicate identity accepted", err)
			}
		})
	}
}
func skillZip(t *testing.T, entries [][2]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for _, entry := range entries {
		f, err := w.Create(entry[0])
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(f, entry[1])
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
func TestCloudSkillArchiveValidation(t *testing.T) {
	valid := "---\nname: review\ndescription: \"Review \\\"quotes\\\" and 中文\\nnext line\"\n---\n\n# Review"
	rev, err := readCloudSkillArchive(skillZip(t, [][2]string{{"SKILL.md", valid}, {"references/notes.md", "Notes"}}))
	if err != nil || rev.Description != "Review \"quotes\" and 中文\nnext line" || len(rev.Files) != 2 {
		t.Fatal(rev, err)
	}
	for _, tc := range []struct {
		name    string
		entries [][2]string
	}{
		{"traversal", [][2]string{{"../SKILL.md", valid}}}, {"absolute", [][2]string{{"/SKILL.md", valid}}},
		{"duplicate", [][2]string{{"SKILL.md", valid}, {"SKILL.md", valid}}}, {"binary", [][2]string{{"SKILL.md", valid}, {"payload", "\x00binary"}}},
		{"large", [][2]string{{"SKILL.md", valid}, {"huge.txt", strings.Repeat("a", 65537)}}}, {"no entry", [][2]string{{"README.md", valid}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := readCloudSkillArchive(skillZip(t, tc.entries)); err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
}
func TestCloudSkillResolutionPinsAndSeparatesNames(t *testing.T) {
	f, e := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("skill invoked provider") })
	ctx := context.Background()
	id, other := uuid.NewString(), uuid.NewString()
	first := extensionTestRevision("first immutable version")
	second := extensionTestRevision("second version")
	second.Number = 2
	doc := CloudExtensions{Packages: []CloudExtension{{ID: id, Kind: "skill", Installed: true, Enabled: true, Revisions: []CloudExtensionRevision{first, second}}, {ID: other, Kind: "skill", Installed: true, Enabled: true, Revisions: []CloudExtensionRevision{first}}}}
	if _, err := f.store.SetCloudExtensions(ctx, 1, 0, doc); err != nil {
		t.Fatal(err)
	}
	if _, err := e.resolveSkill(ctx, "", "weekly-review", ""); !errors.Is(err, ErrCloudRunConflict) {
		t.Fatal("ambiguous name silently resolved", err)
	}
	e.run.RequestContent = cloudJSON("Use [weekly-review](zeroagent-skill:" + id + "/1/weekly-review)")
	result, err := e.resolveSkill(ctx, "", "weekly-review", "")
	if err != nil || result["version"] != int64(1) || !strings.Contains(result["instructions"].(string), "first immutable") {
		t.Fatal(result, err)
	}
	e.run.RequestContent = cloudJSON([]map[string]any{
		{"type": "text", "text": "Use [weekly-review](zeroagent-skill:" + id + "/1/weekly-review)."},
		{"type": "image_url", "image_url": map[string]any{"url": "https://example.test/zeroagent-skill:" + id + "/2/weekly-review"}},
	})
	result, err = e.resolveSkill(ctx, "", "weekly-review", "")
	if err != nil || result["version"] != int64(1) {
		t.Fatal("media metadata changed the user-selected revision", result, err)
	}
	e.run.RequestContent = cloudJSON("Unrelated zeroagent-skill:" + id + "/1/weekly-review_other")
	if _, err = e.resolveSkill(ctx, "", "weekly-review", ""); !errors.Is(err, ErrCloudRunConflict) {
		t.Fatal("a longer invalid reference silently pinned a valid prefix", err)
	}
	e.run.RequestContent = cloudJSON("zeroagent-skill:" + id + "/99/weekly-review")
	if _, err = e.resolveSkill(ctx, "", "weekly-review", ""); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing pin fell back", err)
	}
	e.run.RequestContent = cloudJSON("zeroagent-skill:" + id + "/1/weekly-review zeroagent-skill:" + other + "/1/weekly-review")
	if _, err = e.resolveSkill(ctx, "", "weekly-review", ""); !errors.Is(err, ErrCloudRunConflict) {
		t.Fatal("conflicting pins accepted", err)
	}
	doc.Packages[0].Enabled = false
	_, _ = f.store.SetCloudExtensions(ctx, 1, 1, doc)
	e.run.RequestContent = cloudJSON("continue")
	if _, err = e.resolveSkill(ctx, id, "weekly-review", ""); err != nil {
		t.Fatal("ongoing execution snapshot changed", err)
	}
	e.skillPackages = nil
	if _, err = e.resolveSkill(ctx, id, "weekly-review", ""); !errors.Is(err, ErrNotFound) {
		t.Fatal("disabled skill available to new execution", err)
	}
}

func TestCloudExtensionImportKeepsBundledSkillsTogether(t *testing.T) {
	f, _ := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("import invoked model") })
	mux := http.NewServeMux()
	NewHTTPHandler(f.service, false).registerWebChat(mux)
	f.server.Close()
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	archive := skillZip(t, [][2]string{
		{"SKILL.md", extensionTestRevision("main workflow").Files["SKILL.md"]},
		{"skills/check-output/SKILL.md", "---\nname: check-output\ndescription: Check the output\n---\n\nCheck user-provided content."},
		{"references/notes.md", "Reference content, not another skill."},
	})
	for _, kind := range []string{"skill", "plugin"} {
		status, _, _ := f.request(t, "POST", "/api/web-chat/extensions/import", "file-owner", bytes.NewReader(cloudJSON(map[string]any{"expected_version": 0, "archive": archive, "kind": kind})), nil)
		if (kind == "skill" && status != 400) || (kind == "plugin" && status != http.StatusCreated) {
			t.Fatal("wrong import classification", kind, status)
		}
	}
	doc, _ := f.store.GetCloudExtensions(context.Background(), 1)
	if len(doc.Packages) != 1 || doc.Packages[0].Kind != "plugin" || len(doc.Packages[0].Revisions[0].Skills) != 2 {
		t.Fatal("bundled skills were split or references became a skill", doc)
	}
	personal := 0
	for _, card := range cloudExtensionCards(doc) {
		if card.Visibility == "personal" {
			personal++
			if card.Kind != "plugin" {
				t.Fatal("plugin imported as an independent skill", card)
			}
		}
	}
	if personal != 1 {
		t.Fatal("plugin import created extra directory entries", personal)
	}
}
func TestCloudExtensionsHTTPAuthorityAndLifecycle(t *testing.T) {
	f, _ := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("catalog invoked model") })
	mux := http.NewServeMux()
	NewHTTPHandler(f.service, false).registerWebChat(mux)
	f.server.Close()
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	path := "/api/web-chat/extensions"
	status, body, headers := f.request(t, "GET", path, "file-owner", nil, nil)
	if status != 200 || headers.Get("Cache-Control") != "no-store" || !strings.Contains(string(body), "design-qa") {
		t.Fatal(status, string(body))
	}
	mutation := cloudJSON(map[string]any{"expected_version": 0, "action": "save", "kind": "skill", "revision": extensionTestRevision("private user workflow")})
	status, _, _ = f.request(t, "POST", path, "file-owner", bytes.NewReader(mutation), http.Header{"Origin": {"https://evil.invalid"}})
	if status != 403 {
		t.Fatal("CSRF", status)
	}
	status, _, _ = f.request(t, "POST", path, "file-owner", bytes.NewReader(mutation), nil)
	if status != 200 {
		t.Fatal(status)
	}
	status, _, _ = f.request(t, "POST", path, "file-owner", bytes.NewReader(mutation), nil)
	if status != 409 {
		t.Fatal("stale editor overwrote", status)
	}
	saved, _ := f.store.GetCloudExtensions(context.Background(), 1)
	id := saved.Packages[0].ID
	status, body, _ = f.request(t, "GET", path+"/"+id, "file-other", nil, nil)
	if status != 404 || strings.Contains(string(body), "private user workflow") {
		t.Fatal("foreign read", status)
	}
	status, body, headers = f.request(t, "GET", path+"/"+id+"?download=true", "file-owner", nil, nil)
	if status != 200 || headers.Get("Content-Type") != "application/zip" {
		t.Fatal("download", status)
	}
	if _, err := readCloudSkillArchive(body); err != nil {
		t.Fatal("download cannot be re-imported", err)
	}
	mutation = cloudJSON(map[string]any{"expected_version": 1, "action": "uninstall", "id": id})
	status, _, _ = f.request(t, "POST", path, "file-owner", bytes.NewReader(mutation), nil)
	if status != 200 {
		t.Fatal(status)
	}
	status, _, _ = f.request(t, "GET", path+"/"+id, "file-owner", nil, nil)
	if status != 200 {
		t.Fatal("uninstall removed the owner's readable content", status)
	}
	saved, _ = f.store.GetCloudExtensions(context.Background(), 1)
	if len(saved.Packages[0].Revisions) != 1 {
		t.Fatal("uninstall destroyed immutable history")
	}
	_, e := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("uninstalled instructions invoked provider") })
	e.skillPackages = effectiveCloudExtensions(saved)
	if _, err := e.resolveSkill(context.Background(), id, "weekly-review", ""); !errors.Is(err, ErrNotFound) {
		t.Fatal("uninstalled instructions executable", err)
	}
}

func TestCloudExtensionEnableReconcilesOnlyStandaloneSkillMemberState(t *testing.T) {
	f, _ := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("catalog invoked model") })
	mux := http.NewServeMux()
	NewHTTPHandler(f.service, false).registerWebChat(mux)
	f.server.Close()
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	ctx := context.Background()
	const resource = "/api/web-chat/extensions"
	var legacy CloudExtensions
	for _, entry := range builtinCloudExtensions() {
		if entry.ID == "imagegen" || entry.ID == "product-design" {
			primary := entry.Revisions[len(entry.Revisions)-1].Skills[0].Name
			legacy.Packages = append(legacy.Packages, CloudExtension{ID: entry.ID, Installed: true, Enabled: false, DisabledSkills: []string{primary}})
		}
	}
	stored, err := f.store.SetCloudExtensions(ctx, 1, 0, legacy)
	if err != nil || len(stored.Packages) != 2 {
		t.Fatal(stored, err)
	}
	for i, entry := range legacy.Packages {
		input := cloudJSON(map[string]any{"expected_version": i + 1, "action": "enable", "id": entry.ID, "enabled": true})
		status, body, _ := f.request(t, "POST", resource, "file-owner", bytes.NewReader(input), nil)
		if status != http.StatusOK {
			t.Fatal(entry.ID, status, string(body))
		}
		status, _, _ = f.request(t, "POST", resource, "file-owner", bytes.NewReader(input), nil)
		if status != http.StatusConflict {
			t.Fatal("stale enable", status)
		}
	}
	stored, err = f.store.GetCloudExtensions(ctx, 1)
	if err != nil || stored.Version != 3 {
		t.Fatal(stored, err)
	}
	for _, entry := range effectiveCloudExtensions(stored) {
		if entry.ID != "imagegen" && entry.ID != "product-design" {
			continue
		}
		primary := entry.Revisions[len(entry.Revisions)-1].Skills[0].Name
		if !entry.Enabled || cloudExtensionSkillEnabled(entry, primary) != (entry.ID == "imagegen") {
			t.Fatalf("wrong effective availability for %s, disabled skills: %v", entry.ID, entry.DisabledSkills)
		}
	}
}

func TestCloudExtensionHTTPReadsExactArchivedRevision(t *testing.T) {
	f, _ := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("reader invoked model") })
	mux := http.NewServeMux()
	NewHTTPHandler(f.service, false).registerWebChat(mux)
	f.server.Close()
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)

	id := uuid.NewString()
	old := extensionTestRevision("first fixed instructions")
	current := extensionTestRevision("current instructions")
	current.Number = 2
	_, err := f.store.SetCloudExtensions(context.Background(), 1, 0, CloudExtensions{Packages: []CloudExtension{
		{ID: id, Kind: "skill", Installed: true, Enabled: true, Revisions: []CloudExtensionRevision{old, current}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/web-chat/extensions/" + id
	for _, tc := range []struct {
		query, account, contains string
		status                   int
	}{
		{"?revision=1", "file-owner", "first fixed instructions", 200},
		{"", "file-owner", "current instructions", 200},
		{"?revision=3", "file-owner", "", 404},
		{"?revision=01", "file-owner", "", 400},
		{"?revision=1&download=true", "file-owner", "", 400},
		{"?revision=1", "file-other", "", 404},
	} {
		status, body, headers := f.request(t, "GET", path+tc.query, tc.account, nil, nil)
		if status != tc.status || headers.Get("Cache-Control") != "no-store" ||
			(tc.contains != "" && !strings.Contains(string(body), tc.contains)) ||
			(tc.contains == "" && strings.Contains(string(body), "first fixed instructions")) {
			t.Errorf("query %q account %q got %d %s", tc.query, tc.account, status, body)
		}
	}
}

func TestCloudImageExecutionRejectsDisabledPlugin(t *testing.T) {
	f, e := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("disabled plugin invoked provider") })
	ctx := context.Background()
	doc := CloudExtensions{Packages: []CloudExtension{{ID: "imagegen", Installed: true, Enabled: false}}}
	if _, err := f.store.SetCloudExtensions(ctx, 1, 0, doc); err != nil {
		t.Fatal(err)
	}
	_, err := e.executeImage(ctx, 1, cloudModelToolCall{Name: "generate_image", Arguments: `{"prompt":"test","name":"test.png"}`})
	var toolErr *cloudToolRunError
	if !errors.As(err, &toolErr) || toolErr.code != "skill_unavailable" {
		t.Fatal("disabled plugin accepted a direct tool call", err)
	}
	for _, schema := range e.visualSchemas() {
		if strings.Contains(string(cloudJSON(schema)), "generate_image") {
			t.Fatal("disabled image tool advertised")
		}
	}
}

func TestCloudExtensionOwnershipKindsAndReinstall(t *testing.T) {
	f, _ := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("catalog invoked model") })
	mux := http.NewServeMux()
	NewHTTPHandler(f.service, false).registerWebChat(mux)
	f.server.Close()
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	const resource = "/api/web-chat/extensions"
	for _, id := range []string{"product-design", "imagegen", "skill-creator", "plugin-creator"} {
		status, _, _ := f.request(t, "GET", resource+"/"+id+"?download=true", "file-owner", nil, nil)
		if status != 403 {
			t.Fatal("public download allowed", id, status)
		}
		status, _, _ = f.request(t, "POST", resource, "file-owner", bytes.NewReader(cloudJSON(map[string]any{"expected_version": 0, "action": "save", "id": id, "revision": extensionTestRevision("tamper")})), nil)
		if status != 403 {
			t.Fatal("public edit allowed", id, status)
		}
	}
	status, _, _ := f.request(t, "POST", resource, "file-owner", bytes.NewReader(cloudJSON(map[string]any{"expected_version": 0, "action": "save", "kind": "plugin", "revision": extensionTestRevision("my plugin")})), nil)
	if status != 200 {
		t.Fatal("personal plugin create", status)
	}
	doc, _ := f.store.GetCloudExtensions(context.Background(), 1)
	id := doc.Packages[0].ID
	cards := cloudExtensionCards(doc)
	for _, card := range cards {
		if card.ID == id && (card.Kind != "plugin" || card.Visibility != "personal" || !card.Owned) {
			t.Fatal("wrong personal classification", card)
		}
		if card.ID == "product-design" && (card.Kind != "plugin" || card.Visibility != "public" || card.Owned) {
			t.Fatal("wrong public classification", card)
		}
		if card.ID == "skill-creator" && card.Kind != "skill" {
			t.Fatal("standalone skill flattened into plugin", card)
		}
	}
	status, _, _ = f.request(t, "POST", resource, "file-owner", bytes.NewReader(cloudJSON(map[string]any{"expected_version": 1, "action": "save", "id": id, "kind": "skill", "revision": extensionTestRevision("change kind")})), nil)
	if status != 400 {
		t.Fatal("existing kind changed", status)
	}
	for i, action := range []string{"uninstall", "install"} {
		status, _, _ = f.request(t, "POST", resource, "file-owner", bytes.NewReader(cloudJSON(map[string]any{"expected_version": i + 1, "action": action, "id": id})), nil)
		if status != 200 {
			t.Fatal(action, status)
		}
		doc, _ = f.store.GetCloudExtensions(context.Background(), 1)
		found := false
		for _, card := range cloudExtensionCards(doc) {
			if card.ID == id {
				found = true
				if card.Installed != (action == "install") {
					t.Fatal("wrong installation", card)
				}
			}
		}
		if !found {
			t.Fatal("uninstall removed owned directory record")
		}
	}
	status, _, _ = f.request(t, "GET", resource+"/"+id+"?download=true", "file-other", nil, nil)
	if status != 404 {
		t.Fatal("other account downloaded private plugin", status)
	}
}
