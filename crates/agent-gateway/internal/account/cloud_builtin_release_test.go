package account

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"testing"
)

func TestBuiltinWorkflowsShipOnlyCurrentDefinitions(t *testing.T) {
	for _, pkg := range builtinCloudExtensions() {
		if slices.Contains(cloudFileSkillIDs, pkg.ID) {
			if len(pkg.Revisions) != 1 || pkg.Revisions[0].Number != 1 {
				t.Fatalf("%s does not ship exactly one current workflow", pkg.ID)
			}
			continue
		}
		if len(pkg.Revisions) != 1 || pkg.Revisions[0].Native == nil {
			t.Fatalf("%s does not ship exactly one current workflow", pkg.ID)
		}
		for _, retired := range []int64{1, 2, 3, 4} {
			if cloudExtensionRevisionAt(pkg, retired) != nil {
				t.Fatalf("%s still resolves development revision %d", pkg.ID, retired)
			}
		}
	}
}

func TestBuiltinFileSkillsResolveInCloud(t *testing.T) {
	_, execution := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("reading a skill called a provider") })
	references := map[string]string{
		"documents": "tasks/verify_render.md", "pdf": "SKILL.md",
		"spreadsheet": "artifact_tool_docs/DATA_TABLES.md", "presentations": "references/finalization.md",
	}
	for _, id := range cloudFileSkillIDs {
		got, err := execution.resolveSkill(context.Background(), id, id, "")
		if err != nil || got["package_id"] != id || got["version"] != int64(1) ||
			got["path"] != "SKILL.md" || !strings.Contains(got["instructions"].(string), "ZEROAGENT_FILE_SKILL_ROOT") {
			t.Fatalf("%s does not resolve its file runtime instructions: %v", id, err)
		}
		files := got["files"].([]string)
		if !slices.Contains(files, "LICENSE.md") || slices.Contains(files, "original/SKILL.md") {
			t.Fatalf("%s does not expose the canonical package", id)
		}
		ref, err := execution.resolveSkill(context.Background(), id, id, references[id])
		if err != nil || ref["path"] != references[id] || ref["instructions"] == "" {
			t.Fatalf("%s cannot load its task guide: %v", id, err)
		}
	}
	_, err := execution.resolveSkill(context.Background(), "zeroagent-word-revision", "zeroagent-word-revision", "")
	if err != ErrNotFound {
		t.Fatalf("retired file skill is still resolvable: %v", err)
	}
}

func TestCurrentProductDesignIncludesQARubric(t *testing.T) {
	_, execution := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("reading QA called a provider") })
	ctx := context.Background()
	current, err := execution.resolveSkill(ctx, "product-design", "design-qa", "")
	if err != nil || current["version"] != int64(cloudProductDesignQARevision) || !strings.Contains(current["instructions"].(string), "final result: blocked") {
		t.Fatal("Design QA has no handoff gate", err)
	}
	rubric, err := execution.resolveSkill(ctx, "product-design", "design-qa", "references/design-qa-rubric.md")
	if err != nil || rubric["version"] != current["version"] {
		t.Fatal("rubric did not resolve from the same workflow", err)
	}
}
