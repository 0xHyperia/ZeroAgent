package account

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestBuiltinWorkflowsShipOnlyCurrentDefinitions(t *testing.T) {
	for _, pkg := range builtinCloudExtensions() {
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
