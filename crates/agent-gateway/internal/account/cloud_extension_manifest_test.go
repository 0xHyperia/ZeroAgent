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
	type membership struct {
		kind, primary string
		count         int
	}
	want := map[string]membership{"product-design": {"plugin", "index", 10}, "plugin-creator": {"plugin", "create-plugin", 3}, "imagegen": {"skill", "imagegen", 1}, "skill-creator": {"skill", "skill-creator", 1}}
	for _, id := range []string{"documents", "pdf", "spreadsheet", "presentations"} {
		want[id] = membership{"skill", id, 1}
	}
	if len(packages) != len(want) {
		t.Fatal("unexpected number of builtin packages", len(packages))
	}
	for _, pkg := range packages {
		expect, ok := want[pkg.ID]
		if !ok {
			t.Fatal(pkg.ID)
		}
		latest := pkg.Revisions[len(pkg.Revisions)-1]
		if pkg.Kind != expect.kind || len(latest.Skills) != expect.count || latest.Skills[0].Name != expect.primary || len(pkg.Revisions) != 1 {
			t.Fatal("incorrect builtin membership", pkg.ID, latest.Skills)
		}
		for _, skill := range latest.Skills {
			if strings.HasPrefix(skill.Entry, "references/") || pkg.ID == "product-design" && skill.Name == "skill-creator" {
				t.Fatal("helper or unrelated workflow registered", skill)
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

func TestBuiltinManifestUsesCurrentSkillNames(t *testing.T) {
	_, e := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("read invoked provider") })
	ctx := context.Background()
	for _, name := range []string{"audit", "research", "image-to-code", "index"} {
		value, err := e.resolveSkill(ctx, "product-design", name, "")
		if err != nil || value["path"] != "skills/"+name+"/SKILL.md" {
			t.Fatal("current workflow unavailable", value, err)
		}
	}
	for _, name := range []string{"design-audit", "design-research", "design-implement", "skill-creator"} {
		if _, err := e.resolveSkill(ctx, "product-design", name, ""); err == nil {
			t.Fatal("retired workflow still discoverable", name)
		}
	}
}
