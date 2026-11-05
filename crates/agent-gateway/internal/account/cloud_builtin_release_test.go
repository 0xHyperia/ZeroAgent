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
			if err != nil || latest["version"] != int64(3) || !strings.Contains(latest["instructions"].(string), entry.title) {
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

func TestArchivedSecondBuiltinWorkflowBytes(t *testing.T) {
	expected := map[string]string{
		"imagegen/SKILL.md":                  "46242df548a556a2f0080ba0c91c1f9cb8cb27e843898dcf75c9abfdfd1a549d",
		"plugin-creator/SKILL.md":            "5e094ccb1d034ecdad24b994f378905709be7666980503e209d7dba2d7492fc8",
		"plugin-creator/update-plugin.md":    "ca0cc379ee36a636f4edab5fdedc22edb5a54dc2e27050100120a648b5dff8d5",
		"product-design/SKILL.md":            "d0ede3eb39880e3d214eb98b4ee68451a8a20d4380543058e0a3562f4d2e5468",
		"product-design/design-audit.md":     "66c1a125ea008e4772772187f84b241eeef7006568b03de5e10b49d0fdfc4e6f",
		"product-design/design-ideate.md":    "6248ef849838f57dfc98991aa525dc1d594820d734d2a438eb479b6d0b6646de",
		"product-design/design-implement.md": "5d5d52eddfdecbe175ed16af51dfc1ee40d65ea1b713df6c2012929740e7b366",
		"product-design/design-research.md":  "bef748e00d0e68052bc95a0d4f45ce732bf87531bddcf5a966068696d4ebaf26",
		"product-design/design-share.md":     "e4e1d5f82e7b94f54ce24ac5a195b267519e0ece59696e22ae92110d454a0be1",
		"product-design/design-verify.md":    "dc686eec527890eafc843ef5a7926c1c0a65d34f60a654d1a8194a4247ce96ab",
		"product-design/skill-creator.md":    "f6eb470df34d1a900b78fa72b636e4e12ca73ecaa9ce2773e974f60946f167bb",
		"skill-creator/SKILL.md":             "f6eb470df34d1a900b78fa72b636e4e12ca73ecaa9ce2773e974f60946f167bb",
	}
	for name, hash := range expected {
		content, err := cloudBuiltinSkills.ReadFile("skills-releases/v2/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if actual := fmt.Sprintf("%x", sha256.Sum256(content)); actual != hash {
			t.Fatalf("immutable second release changed: %s", name)
		}
	}
}
