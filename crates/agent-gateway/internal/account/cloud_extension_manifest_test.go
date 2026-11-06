package account

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestBuiltinManifestMembership(t *testing.T) {
	packages := builtinCloudExtensions()
	if len(packages) != 4 {
		t.Fatal("builtin manifest missing", len(packages))
	}
	want := map[string]struct {
		kind, primary string
		count         int
	}{"product-design": {"plugin", "index", 10}, "plugin-creator": {"plugin", "create-plugin", 3}, "imagegen": {"skill", "imagegen", 1}, "skill-creator": {"skill", "skill-creator", 1}}
	for _, pkg := range packages {
		expect, ok := want[pkg.ID]
		if !ok {
			t.Fatal(pkg.ID)
		}
		latest := pkg.Revisions[len(pkg.Revisions)-1]
		if cloudExtensionKind(pkg) != expect.kind || len(latest.Skills) != expect.count || latest.Skills[0].Name != expect.primary || len(pkg.Revisions) < 3 || pkg.Revisions[2].Number != 3 {
			t.Fatal("incorrect builtin membership", pkg.ID, latest.Skills)
		}
		for _, skill := range latest.Skills {
			if strings.HasPrefix(skill.Entry, "references/") || pkg.ID == "product-design" && skill.Name == "skill-creator" {
				t.Fatal("helper or unrelated workflow registered", skill)
			}
		}
		if pkg.ID == "product-design" {
			pkg.DisabledSkills = []string{"design-audit"}
			if cloudExtensionSkillEnabled(pkg, "audit") || cloudExtensionSkillEnabled(pkg, "design-audit") {
				t.Fatal("existing disable choice lost during alias rename")
			}
		}
	}
}

func TestManifestInstructionImport(t *testing.T) {
	skill := "---\nname: workflow\ndescription: A specific reusable workflow\n---\n\n# Workflow\n"
	for _, manifestPath := range []string{"plugin.json", ".codex-plugin/plugin.json"} {
		t.Run(manifestPath, func(t *testing.T) {
			raw := skillZip(t, [][2]string{{manifestPath, `{"name":"my-plugin","description":"Personal methods","skills":"./skills","extensions":{"top.usa0":{"primarySkill":"workflow"}}}`}, {"skills/workflow/SKILL.md", skill}, {"references/quality.md", "# Helper"}, {"skills/workflow/references/steps.md", "# More help"}})
			rev, err := readCloudSkillArchive(raw)
			if err != nil || len(rev.Skills) != 1 || rev.Skills[0].Entry != "skills/workflow/SKILL.md" || rev.Files["references/quality.md"] == "" {
				t.Fatal(rev, err)
			}
		})
	}
	for _, manifest := range []string{
		`{"name":"bad","skills":"../outside"}`, `{"name":"bad","skills":"C:/outside"}`,
		`{"name":"bad","mcpServers":{"remote":{"url":"https://example.test"}}}`,
		`{"name":"bad","extensions":{"com.openai":{"apps":{"a":{}}}}}`,
		`{"name":"bad","extensions":{"top.usa0":{"primarySkill":"missing"}}}`,
		`{"name":"bad","extensions":{"top.usa0":{"aliases":{"old":"missing"}}}}`,
	} {
		if _, err := readCloudSkillArchive(skillZip(t, [][2]string{{"plugin.json", manifest}, {"skills/workflow/SKILL.md", skill}})); !errors.Is(err, ErrCloudRunInvalid) {
			t.Fatal("unsafe or inconsistent manifest accepted", manifest, err)
		}
	}
	if _, err := readCloudSkillArchive(skillZip(t, [][2]string{{"plugin.json", `{"name":"duplicate"}`}, {"skills/a/SKILL.md", skill}, {"skills/b/SKILL.md", skill}})); !errors.Is(err, ErrCloudRunInvalid) {
		t.Fatal("duplicate skill registered", err)
	}
}

func TestManifestAliasResolutionAndArchivedRemoval(t *testing.T) {
	_, e := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("read invoked provider") })
	ctx := context.Background()
	for old, current := range map[string]string{"design-audit": "audit", "design-research": "research", "design-implement": "image-to-code", "product-design": "index"} {
		value, err := e.resolveSkill(ctx, "product-design", old, "")
		if err != nil || value["path"] != "skills/"+current+"/SKILL.md" {
			t.Fatal("renamed workflow failed", value, err)
		}
	}
	if _, err := e.resolveSkill(ctx, "product-design", "skill-creator", ""); err == nil {
		t.Fatal("removed workflow still discoverable")
	}
	e.run.RequestContent = cloudJSON("zeroagent-skill:product-design/2/product-design")
	old, err := e.resolveSkill(ctx, "product-design", "skill-creator", "")
	bytes, _ := cloudBuiltinSkills.ReadFile("skills-releases/v2/product-design/skill-creator.md")
	if err != nil || old["instructions"] != string(bytes) || old["version"] != int64(2) {
		t.Fatal("old fixed release lost exact content", err)
	}
}
