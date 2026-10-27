import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
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

test("the first-paint boot shell uses ZeroAgent before React starts in every startup locale", () => {
  const source = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  for (const locale of [null, "zh-CN", "en", "en-US"]) {
    const dom = new JSDOM(source, {
      url: "http://localhost",
      runScripts: "dangerously",
      beforeParse(window) {
        if (locale) window.localStorage.setItem("liveagent.ui-settings.v1", JSON.stringify({ locale }));
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.requestAnimationFrame = (callback) => { callback(0); return 1; };
        window.__TAURI_INTERNALS__ = { invoke: async () => undefined };
      },
    });
    try {
      const doc = dom.window.document;
      const english = locale === "en" || locale === "en-US";
      assert.equal(doc.title, "ZeroAgent");
      assert.equal(doc.querySelector("[data-boot-title]").textContent, english ? "Starting ZeroAgent" : "正在启动 ZeroAgent");
      assert.equal(doc.querySelector("[data-static-boot-shell]").getAttribute("aria-label"), english ? "ZeroAgent startup progress" : "正在加载 ZeroAgent");
      assert.equal(JSON.parse(dom.window.localStorage.getItem("liveagent.ui-settings.v1"))?.locale ?? null, locale);
    } finally { dom.window.close(); }
  }
});
