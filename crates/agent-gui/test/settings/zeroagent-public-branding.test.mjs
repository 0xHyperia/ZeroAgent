import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseTypeScriptSource, walkSyntaxTree, staticStringValue } from "../../../../scripts/typescript-source-tools.mjs";

test("public translated messages use ZeroAgent while internal translation keys stay stable", () => {
  const root = new URL("../../../../", import.meta.url);
  for (const path of [
    "crates/agent-gui/src/i18n/config.ts",
    "crates/agent-ui/src/i18n/planningTranslations.ts",
    ...["enUSCommon", "enUSSettings", "zhCNCommon", "zhCNSettings"].map(name => `crates/agent-ui/src/i18n/translations/${name}.ts`),
  ]) {
    const source = readFileSync(new URL(path, root), "utf8");
    walkSyntaxTree(parseTypeScriptSource(source, path), node => {
      if (node.type !== "ObjectProperty") return;
      const value = staticStringValue(node.value);
      if (typeof value === "string") assert.doesNotMatch(value, /live[ -]?agent|k-brain|~\/\.liveagent/i, `${path}:${node.loc.start.line}`);
    });
  }
  const settings = readFileSync(new URL("crates/agent-ui/src/i18n/translations/zhCNSettings.ts", root), "utf8");
  assert.match(settings, /settings\.kbrainLoading/, "internal keys remain compatible with upstream components");
});


test("public frontend backend overrides use the ZeroAgent namespace", () => {
  const root = new URL("../../../../", import.meta.url);
  for (const path of [
    "crates/agent-gui/src/lib/kbrain/bootstrap.ts",
    "crates/agent-gui/src/lib/kbrain/runtimeConnection.ts",
  ]) {
    const source = readFileSync(new URL(path, root), "utf8");
    assert.match(source, /VITE_ZEROAGENT_BACKEND_URL/);
    assert.match(source, /VITE_ZEROAGENT_BACKEND_TOKEN/);
    assert.doesNotMatch(source, /VITE_(?:LIVEAGENT|KBRAIN)_/);
  }
});
