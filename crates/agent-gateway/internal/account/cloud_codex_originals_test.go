package account

import (
	"context"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestCloudCodexOriginalSources(t *testing.T) {
	_, e := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("reading source called a provider") })
	for _, tc := range []struct{ id, name, script string }{
		{"imagegen", "Image Gen", "scripts/image_gen.py"},
		{"skill-creator", "Skill Creator", "scripts/init_skill.py"},
	} {
		t.Run(tc.id, func(t *testing.T) {
			e.run.RequestContent = cloudJSON("zeroagent-skill:" + tc.id + "/4/" + tc.id)
			for _, file := range []string{"SKILL.md", tc.script} {
				body, err := cloudCodexOriginals.ReadFile("codex-packages/" + tc.id + "/" + file)
				if err != nil {
					t.Fatal(err)
				}
				result, err := e.resolveSkill(context.Background(), tc.id, tc.id, file)
				if err != nil || result["instructions"] != string(body) || result["version"] != int64(codexOriginalRevision) || result["host_guidance"] != cloudCodexHostGuidance {
					t.Fatal("original bytes or host binding did not reach the CloudChat tool", err)
				}
			}
			for _, card := range cloudExtensionCards(&CloudExtensions{}) {
				if card.ID == tc.id && (card.Name != tc.name || !card.Native || card.Version != cloudNativeWorkflowRevision) {
					t.Fatal("catalog does not present the native release", card.Name)
				}
			}
		})
	}
}

func TestLocalCodexOriginals(t *testing.T) {
	if dir := os.Getenv("ZEROAGENT_CODEX_ORIGINALS_DIR"); dir == "" {
		t.Skip("the development-only Codex snapshot is not configured")
	}
	_, e := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("reading source called a provider") })
	for _, tc := range []struct{ pkg, skill, file string }{
		{"product-design", "index", "scripts/bootstrap-prototype.mjs"},
		{"plugin-creator", "create-plugin", "assets/starter-plugin/skills/starter-workflow/SKILL.md"},
		{"plugin-creator", "create-plugin", ".app.json"},
	} {
		e.run.RequestContent = cloudJSON("zeroagent-skill:" + tc.pkg + "/4/" + tc.skill)
		got, err := e.resolveSkill(context.Background(), tc.pkg, tc.skill, tc.file)
		if err != nil || got["version"] != int64(codexOriginalRevision) {
			t.Fatal("local original was not resolved", tc, err)
		}
		want, err := os.ReadFile(os.Getenv("ZEROAGENT_CODEX_ORIGINALS_DIR") + "/" + tc.pkg + "/" + got["path"].(string))
		if err != nil || got["instructions"] != string(want) {
			t.Fatal("local source was changed", tc, err)
		}
	}
	if _, err := e.resolveSkill(context.Background(), "plugin-creator", "starter-workflow", ""); err == nil {
		t.Fatal("a nested starter became a registered skill")
	}
	archived := cachedCodexOriginals()["plugin-creator"]
	if archived.Codex == nil || len(archived.Codex.Apps) != 1 || archived.Codex.Apps[0].Name != "Plugin Creator" || len(archived.Codex.Examples) != 3 || !strings.HasPrefix(archived.Codex.Examples[0], "Create a plugin") {
		t.Fatal("incorrect archived plugin or hosted app metadata")
	}
}
