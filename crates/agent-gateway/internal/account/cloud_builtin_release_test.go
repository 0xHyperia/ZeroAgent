package account

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestArchivedBuiltinWorkflowBytes(t *testing.T) {
	// These are the original release payloads, including their line endings.
	// An editor or Git checkout must not change instructions behind a pinned reference.
	expected := map[string]string{
		"imagegen/SKILL.md":                  "626f160825b7a839e8d709b2cf1235c9700b79336028c6dfb2925006f528f4cd",
		"plugin-creator/SKILL.md":            "246258fdc2febb6d52b16d2a447b7c9ecc0d18da5cda7004dbc512549aea7bdf",
		"plugin-creator/update-plugin.md":    "af1bea3381f40f4e303eee4d5e2690d0f5a37ab60b531f089dd5adcdfc5d53bc",
		"product-design/SKILL.md":            "6aaa42f46053673854d9e4530ee3c2bbfacdbc90b6df15c6ba646593db23562b",
		"product-design/design-audit.md":     "821712c910ff1883b2b0a879eafd5d1600d3af053fa3940679c29acc60d16c2f",
		"product-design/design-ideate.md":    "b94ccbd5159011fe6eb93657c0206f4d78e52ed78979c0253c3ed56246954578",
		"product-design/design-implement.md": "3a9741c41295db4248812917dc4e99ab60bc1e94a0989f4248fbd1abc454586f",
		"product-design/design-research.md":  "8950825defa6d9a0b46f4aa58e62bd2390a98c9473577b6f450e555875572cf3",
		"product-design/design-share.md":     "8169c376a114a728f03e76351fbc30ffb9b63b6400125a2e24a2aafa4c116d77",
		"product-design/design-verify.md":    "43a925910e170433c7c36ef87367232bb6c0f5877d6494572f536e261bbcb61b",
		"product-design/skill-creator.md":    "446f0fad2e638b26e20efa6f3ed5ca7b82c5d433b44ade5f95fd7f09d67e39dc",
		"skill-creator/SKILL.md":             "446f0fad2e638b26e20efa6f3ed5ca7b82c5d433b44ade5f95fd7f09d67e39dc",
	}
	for name, hash := range expected {
		t.Run(name, func(t *testing.T) {
			content, err := cloudBuiltinSkills.ReadFile("skills-releases/v1/" + name)
			if err != nil {
				t.Fatal(err)
			}
			if actual := fmt.Sprintf("%x", sha256.Sum256(content)); actual != hash {
				t.Fatalf("immutable workflow bytes changed: got %s, want %s", actual, hash)
			}
		})
	}
}

func TestBuiltinRedesignRetainsPinnedReleaseSources(t *testing.T) {
	_, execution := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("reading a workflow must not invoke a provider") })
	ctx := context.Background()
	for _, entry := range []struct{ id, title string }{
		{"product-design", "# 产品设计"}, {"imagegen", "# 生成图像"},
		{"plugin-creator", "# 创建插件"}, {"skill-creator", "# 创建技能"},
	} {
		t.Run(entry.id, func(t *testing.T) {
			execution.run.RequestContent = cloudJSON("zeroagent-skill:" + entry.id + "/1/" + entry.id)
			old, err := execution.resolveSkill(ctx, entry.id, entry.id, "")
			if err != nil {
				t.Fatal(err)
			}
			archived, err := cloudBuiltinSkills.ReadFile("skills-releases/v1/" + entry.id + "/SKILL.md")
			if err != nil || old["version"] != int64(1) || old["instructions"] != string(archived) {
				t.Fatal("old fixed reference did not resolve its exact original source", err)
			}
			execution.run.RequestContent = cloudJSON("zeroagent-skill:" + entry.id + "/2/" + entry.id)
			current, err := execution.resolveSkill(ctx, entry.id, entry.id, "")
			if err != nil || current["version"] != int64(2) || !strings.Contains(current["instructions"].(string), entry.title) || current["instructions"] == old["instructions"] {
				t.Fatal("redesigned workflow did not use its independent Chinese release", err)
			}
			execution.run.RequestContent = cloudJSON("continue")
			latest, err := execution.resolveSkill(ctx, entry.id, entry.id, "")
			if err != nil || latest["instructions"] != current["instructions"] {
				t.Fatal("un-pinned invocation did not select current workflow", err)
			}
		})
	}
}

func TestPluginPrimaryReferencePinsItsBundledWorkflows(t *testing.T) {
	_, execution := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("reading a workflow must not invoke a provider") })
	execution.run.RequestContent = cloudJSON("zeroagent-skill:plugin-creator/1/plugin-creator")
	result, err := execution.resolveSkill(context.Background(), "plugin-creator", "update-plugin", "")
	if err != nil {
		t.Fatal(err)
	}
	original, _ := cloudBuiltinSkills.ReadFile("skills-releases/v1/plugin-creator/update-plugin.md")
	if result["version"] != int64(1) || result["instructions"] != string(original) {
		t.Fatal("a plugin mention mixed releases across bundled workflows")
	}
	execution.run.RequestContent = cloudJSON("zeroagent-skill:plugin-creator/1/plugin-creator zeroagent-skill:plugin-creator/2/update-plugin")
	if _, err := execution.resolveSkill(context.Background(), "plugin-creator", "update-plugin", ""); !errors.Is(err, ErrCloudRunConflict) {
		t.Fatal("conflicting package releases were accepted", err)
	}
}
