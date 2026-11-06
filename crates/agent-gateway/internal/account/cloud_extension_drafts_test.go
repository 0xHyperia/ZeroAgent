package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func TestPreparedExtensionReviewSaveAndExport(t *testing.T) {
	f, e := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("preparing a draft invoked an external provider") })
	ctx := context.Background()
	if !strings.Contains(string(cloudJSON(builtinCloudExtensions())), "prototype-workflow.md") {
		t.Fatal("native prototype reference missing")
	}
	result, err := e.execute(ctx, 0, cloudModelToolCall{Name: prepareExtensionTool, Arguments: `{
		"kind":"plugin","name":"review-helper","description":"Review a release","instructions":"Review the notes before sending.",
		"skills":[{"name":"check-output","description":"Check the output","instructions":"Compare the final summary with the original."}],
		"files":[{"path":"references/notes.md","content":"Private project checklist."}]
	}`})
	if err != nil {
		t.Fatal(err)
	}
	id := regexp.MustCompile(`[0-9a-f-]{36}`).FindString(string(result))
	run, err := f.store.GetCloudRun(ctx, 1, e.run.ID)
	if err != nil || id == "" || !strings.Contains(string(run.Presentation), "extension-draft") || strings.Contains(string(run.Presentation), "Private project checklist") {
		t.Fatal("missing or unsafe public draft receipt", err)
	}
	if doc, _ := f.store.GetCloudExtensions(ctx, 1); len(doc.Packages) != 0 {
		t.Fatal("the model installed a draft")
	}
	mux := http.NewServeMux()
	NewHTTPHandler(f.service, false).registerWebChat(mux)
	f.server.Close()
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	const path = "/api/web-chat/extensions"
	status, _, _ := f.request(t, "GET", path+"/drafts/"+id, "file-other", nil, nil)
	if status != http.StatusNotFound {
		t.Fatal("cross-account draft read", status)
	}
	status, body, _ := f.request(t, "GET", path+"/drafts/"+id, "file-owner", nil, nil)
	var draft cloudExtensionDraft
	if status != http.StatusOK || json.Unmarshal(body, &draft) != nil || len(draft.Revision.Skills) != 2 {
		t.Fatal("draft unavailable", status, string(body))
	}
	save := func(version int64, owner string) int {
		payload := cloudJSON(map[string]any{"expected_version": version, "action": "save", "kind": draft.Kind, "draft_id": id, "revision": draft.Revision})
		code, _, _ := f.request(t, "POST", path, owner, bytes.NewReader(payload), nil)
		return code
	}
	if got := save(0, "file-other"); got != http.StatusNotFound {
		t.Fatal("cross-account draft save", got)
	}
	if got := save(0, "file-owner"); got != http.StatusOK {
		t.Fatal("draft save", got)
	}
	if got := save(1, "file-owner"); got != http.StatusConflict {
		t.Fatal("a repeated save created a second plugin", got)
	}
	status, body, _ = f.request(t, "GET", path+"/"+id+"?download=true", "file-owner", nil, nil)
	reopened, err := readCloudSkillArchive(body)
	if status != http.StatusOK || err != nil || len(reopened.Skills) != 2 || reopened.Skills[0].Name != "review-helper" {
		t.Fatal("exported plugin did not round-trip", status, err)
	}
}

func TestExtensionDraftUpdatePreservesFilesAndRejectsChangedBase(t *testing.T) {
	f, e := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("preparing a draft invoked an external provider") })
	ctx := context.Background()
	original := extensionTestRevision("Old instructions.")
	original.Files["references/notes.md"] = "Keep these notes."
	const id = "36e2b5c0-8c13-4f81-825c-f5d8a9a1d021"
	if _, err := f.store.SetCloudExtensions(ctx, 1, 0, CloudExtensions{Packages: []CloudExtension{
		{ID: id, Kind: "skill", Installed: true, Enabled: true, Revisions: []CloudExtensionRevision{original}},
	}}); err != nil {
		t.Fatal(err)
	}
	prepare := func(revision int, index int) string {
		out, err := e.execute(ctx, 0, cloudModelToolCall{Name: prepareExtensionTool, Index: index, Arguments: string(cloudJSON(map[string]any{
			"kind": "skill", "target_id": id, "base_revision": revision, "name": original.Name,
			"description": "Review a week of tasks", "instructions": "Review the updated workflow.",
		}))})
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}
	if got := prepare(2, 0); !strings.Contains(got, "extension_draft_stale") {
		t.Fatal(got)
	}
	draftID := regexp.MustCompile(`[0-9a-f-]{36}`).FindString(prepare(1, 1))
	draft, err := loadCloudExtensionDraft(ctx, f.store, 1, draftID)
	if err != nil || draft.BaseRevision != 1 || draft.TargetID != id || draft.Revision.Files["references/notes.md"] != "Keep these notes." {
		t.Fatal("draft lost original files or identity", err)
	}
}
