import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("desktop uses the shared model/effort surface and preserves explicit execution controls", async () => {
  let env;
  const icon = () => null;
  env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => icon }),
    "@liveagent/ui/components/ProviderBrandIcon": { ProviderBrandIcon: icon },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: key => key }) },
  } });
  window.HTMLElement.prototype.getAnimations ??= () => [];
  const { ComposerModelControls } = env.loadModule("@liveagent/ui/components/chat/ComposerModelControls.tsx");
  const patches = [], modes = [], selections = [];
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  function Harness() {
    const [mode, setMode] = env.React.useState("tools");
    const [runtime, setRuntime] = env.React.useState({ reasoning: "low", thinkingEnabled: true, nativeWebSearchEnabled: false });
    return env.React.createElement(ComposerModelControls, {
      executionMode: mode, hasModels: true, currentModelLabel: "Alpha", selectedValue: "one::Alpha",
      modelOptions: [{ model: "Alpha", label: "Alpha", providerId: "one", providerName: "First", providerType: "openai", value: "one::Alpha", nativeWebSearchSupported: true }],
      chatRuntimeControls: runtime, reasoningOptions: ["low", "high"], thinkingAlwaysOn: false,
      onSelectModel: value => selections.push(value), onOpenSettings() {},
      onSelectExecutionMode: value => { modes.push(value); setMode(value); },
      onChatRuntimeControlsChange: patch => { patches.push(patch); setRuntime(old => ({ ...old, ...patch })); },
    });
  }
  try {
    await env.act(async () => root.render(env.React.createElement(Harness)));
    assert.equal(document.querySelectorAll(".composer-model-capsule").length, 1);
    await env.act(async () => document.querySelector('.composer-inline-model-trigger').click());
    assert.ok(document.querySelector('input[placeholder="chat.searchModel"]'), "model target opens the list directly");
    assert.equal(document.querySelector('[data-model-group="one"]').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(modes, []); assert.deepEqual(patches, []);
    await env.act(async () => document.querySelector('.composer-model-toolbar [data-segment="text"]').click());
    assert.deepEqual(modes, ["text"]); assert.deepEqual(selections, []); assert.deepEqual(patches, []);
    await env.act(async () => document.querySelector('[role="switch"]').click());
    assert.deepEqual(patches, [{ nativeWebSearchEnabled: true }]);
    await env.act(async () => document.querySelector('.composer-inline-effort-trigger').click());
    assert.ok(document.querySelector('input[type="range"]'), "effort uses the same continuous shared slider");
    assert.equal(document.querySelectorAll('.composer-config-popup').length, 1);
    assert.equal(document.querySelector('.composer-model-toolbar'), null, "effort only presents reasoning controls");
    assert.deepEqual(modes, ["text"], "opening effort never changes execution mode");
    assert.deepEqual(selections, [], "opening effort never changes model or provider");
  } finally { await env.act(async () => root.unmount()); env.cleanup(); }
});
test("composer reflects selected protocol capability without rewriting the search preference", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : icon) }),
    "@liveagent/ui/components/ProviderBrandIcon": { ProviderBrandIcon: icon },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key }) },
  } });
  window.HTMLElement.prototype.getAnimations ??= () => [];
  const { ComposerModelControls } = env.loadModule("@liveagent/ui/components/chat/ComposerModelControls.tsx");
  const { buildModelOptions } = env.loadModule("@liveagent/ui/lib/models/modelOptions.ts");
  const { normalizeCustomProvider, DEFAULT_CHAT_RUNTIME_CONTROLS } = env.loadModule("@liveagent/ui/lib/settings/index.ts");
  const modelOptions = buildModelOptions({ customProviders: [
    ["compatible", "codex", "openai-completions"],
    ["responses", "codex", "openai-responses"],
    ["gemini", "gemini", undefined],
  ].map(([id, type, requestFormat]) => normalizeCustomProvider({ id, name: id, type, requestFormat, models: ["model"], activeModels: ["model"] })) });
  const patches = [];
  const controls = Object.freeze({ ...DEFAULT_CHAT_RUNTIME_CONTROLS, nativeWebSearchEnabled: true });
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  const render = async (index) => env.act(async () => root.render(env.React.createElement(ComposerModelControls, {
    executionMode: "text", hasModels: true, currentModelLabel: "model", selectedValue: modelOptions[index].value,
    modelOptions, chatRuntimeControls: controls, reasoningOptions: [], thinkingAlwaysOn: false,
    onSelectModel() {}, onSelectExecutionMode() {}, onOpenSettings() {}, onChatRuntimeControlsChange: (patch) => patches.push(patch),
  })));
  try {
    await render(1);
    await env.act(async () => document.querySelector('[data-slot="popover-trigger"]').click());
    for (const index of [1, 0, 2, 0, 1]) {
      await render(index);
      const control = document.querySelector('[role="switch"][aria-label="chat.runtime.webSearch"]');
      assert.ok(control);
      assert.equal(control.getAttribute("aria-checked"), index === 0 ? "false" : "true");
      assert.equal(control.disabled, index === 0);
      if (index === 0) await env.act(async () => control.click());
      assert.equal(controls.nativeWebSearchEnabled, true);
      assert.deepEqual(patches, []);
    }
    await env.act(async () => document.querySelector('[role="switch"][aria-label="chat.runtime.webSearch"]').click());
    assert.deepEqual(patches, [{ nativeWebSearchEnabled: false }]);
  } finally { await env.act(async () => root.unmount()); env.cleanup(); }
});
