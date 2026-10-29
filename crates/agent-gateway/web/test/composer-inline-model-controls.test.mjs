import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, { coarse = false, alwaysOn = false, reasoningOptions = ["off", "low", "medium", "high", "max"] } = {}) {
  let env;
  env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    "@liveagent/ui/components/ProviderBrandIcon": { ProviderBrandIcon: ({ model }) => env.React.createElement("i", { "data-brand-model": model }) },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "zh-CN", t: key => key }) },
  } });
  window.matchMedia = () => ({ matches: coarse, addEventListener() {}, removeEventListener() {} });
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
  const host = document.body.appendChild(document.createElement("div")), root = env.createRoot(host);
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else delete globalThis.localStorage; env.cleanup(); });
  const { ComposerModelControls } = env.loadModule("@liveagent/ui/components/chat/ComposerModelControls.tsx");
  const options = [
    { value: "a::gpt-6.1", model: "gpt-6.1", label: "GPT 6.1", providerId: "a", providerName: "Group A", providerType: "codex" },
    { value: "b::gpt-6.1", model: "gpt-6.1", label: "GPT 6.1", providerId: "b", providerName: "Group B", providerType: "codex" },
    { value: "c::claude-sonnet-4.6", model: "claude-sonnet-4.6", label: "Sonnet", providerId: "c", providerName: "Group C", providerType: "claude_code" },
  ];
  const models = [], patches = [];
  let disabled = false, requestExternalOpen, replaceModel;
  function Harness() {
    const [open, setOpen] = env.React.useState(false);
    requestExternalOpen = setOpen;
    const [value, setValue] = env.React.useState("b::gpt-6.1");
    replaceModel = setValue;
    const [controls, setControls] = env.React.useState({ reasoning: "medium", thinkingEnabled: true, nativeWebSearchEnabled: false });
    return env.React.createElement(ComposerModelControls, { presentation: "inline", open, onOpenChange: setOpen, executionMode: "text", hasModels: true, currentModelLabel: "GPT 6.1", selectedValue: value, modelOptions: options, chatRuntimeControls: controls, reasoningOptions, thinkingAlwaysOn: alwaysOn, disabled,
      onSelectModel: next => { models.push(next); setValue(`${next.customProviderId}::${next.model}`); }, onSelectExecutionMode: () => assert.fail("inline controls must not change execution mode"), onOpenSettings: () => {}, onChatRuntimeControlsChange: patch => { patches.push(patch); setControls(old => ({ ...old, ...patch })); },
    });
  }
  async function render() { await env.act(async () => { root.render(env.React.createElement(Harness)); await tick(); }); }
  async function click(node) { assert.ok(node); await env.act(async () => { node.click(); await tick(); }); }
  async function slide(index, event = "keyup", key = "ArrowRight") {
    await env.act(async () => {
      const input = document.querySelector('input[type="range"]');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, String(index));
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await tick();
    });
    if (event) await env.act(async () => { document.querySelector('input[type="range"]').dispatchEvent(event === "keyup" ? new window.KeyboardEvent(event, { key, bubbles: true }) : new window.Event(event, { bubbles: true })); await tick(); });
  }
  await render();
  return { env, host, models, patches, click, render, slide, disable() { disabled = true; }, async externalOpen() { await env.act(async () => { requestExternalOpen(true); await tick(); }); }, async replaceModel(value) { await env.act(async () => { replaceModel(value); await tick(); }); }, trigger: () => host.querySelector('[aria-label^="chat.selectModel:"]'), effortTrigger: () => host.querySelector('[aria-label^="chat.runtime.reasoning:"]'), modelLink: () => document.querySelector(".composer-reasoning-model") };
}

test("the model area directly opens the current group; model browsing reveals the current group and vendor route without changing either selection", async t => {
  const app = await setup(t);
  assert.equal(app.host.querySelectorAll("button").length, 2);
  assert.equal(app.trigger().querySelector("[data-brand-model]").getAttribute("data-brand-model"), "gpt-6.1");
  await app.click(app.trigger());
  assert.equal(document.querySelector('input[type="range"]'), null);
  const group = () => document.querySelector('[data-model-group="b"]');
  assert.equal(group().getAttribute("aria-expanded"), "true");
  assert.equal(document.querySelector('[data-model-option][aria-pressed="true"]').getAttribute("data-model-id"), "gpt-6.1");
  assert.equal(document.querySelector('[data-model-group="a"]').getAttribute("aria-expanded"), "false");
  await app.click(group()); await app.render();
  assert.equal(group().getAttribute("aria-expanded"), "false", "re-rendering does not override manual collapse");
  await app.click([...document.querySelectorAll("button")].find(item => item.textContent === "chat.modelPickerByVendor"));
  assert.equal(document.querySelector('[data-model-group="OpenAI"]').getAttribute("aria-expanded"), "true");
  await app.click(document.querySelector('[data-model-id="gpt-6.1"]'));
  assert.equal(document.querySelectorAll("[data-model-route]").length, 2);
  assert.equal(document.querySelector('[data-model-route="b::gpt-6.1"]').getAttribute("aria-pressed"), "true");
  assert.deepEqual(app.models, []);
  await app.click(document.querySelector('[data-model-route="a::gpt-6.1"]'));
  assert.deepEqual(app.models, [{ customProviderId: "a", model: "gpt-6.1" }]);
  assert.deepEqual(app.patches, []);
  assert.equal(document.querySelector("[data-model-picker-content]"), null);
});

test("the discrete slider previews while dragging, commits once on release, supports off/reset, and never invents an Ultra level", async t => {
  const app = await setup(t);
  await app.click(app.effortTrigger());
  await app.slide(4, null);
  assert.deepEqual(app.patches, [], "dragging previews without patching every input event");
  assert.equal(document.querySelector('input[type="range"]').getAttribute("aria-valuetext"), "最高 · GPT 6.1");
  assert.equal(document.querySelector("[data-maximum]"), null, "maximum effort does not impersonate Ultra execution");
  await app.slide(4, "pointerup");
  assert.deepEqual(app.patches, [{ thinkingEnabled: true, reasoning: "max" }]);
  assert.ok(document.querySelector('input[type="range"]'), "adjustment keeps the popup open");
  await app.click(document.querySelector(".composer-reasoning-reset"));
  assert.deepEqual(app.patches.at(-1), { thinkingEnabled: true, reasoning: "high" });
  await app.slide(0, "keyup", "Home");
  assert.deepEqual(app.patches.at(-1), { thinkingEnabled: false });
  assert.equal(document.querySelector('input[type="range"]').getAttribute("aria-valuetext"), "直接 · GPT 6.1");
  assert.deepEqual(app.models, []);
  await app.click(app.modelLink());
  await app.click(document.querySelector(".composer-popup-effort-link"));
  assert.equal(document.querySelector('input[type="range"]').getAttribute("aria-valuetext"), "直接 · GPT 6.1");
  app.disable(); await app.render();
  assert.equal(app.trigger().disabled, true);
  assert.equal(document.querySelector('input[type="range"]').disabled, true);
});

test("Escape cancels a slider preview; mandatory thinking omits off and touch model navigation avoids the search keyboard", async t => {
  const app = await setup(t, { coarse: true, alwaysOn: true, reasoningOptions: ["off", "medium", "high"] });
  await app.click(app.effortTrigger());
  assert.notEqual(document.activeElement?.tagName, "INPUT");
  const slider = document.querySelector('input[type="range"]');
  assert.equal(slider.max, "1");
  assert.equal(slider.getAttribute("aria-valuetext"), "标准 · GPT 6.1");
  await app.slide(1, null);
  assert.equal(document.querySelector("[data-maximum]"), null, "high is not presented as max");
  await app.env.act(async () => { slider.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await tick(); });
  assert.deepEqual(app.patches, []);
  await app.click(app.trigger());
  assert.notEqual(document.activeElement?.tagName, "INPUT");
  assert.deepEqual(app.models, []);
});

test("pointer movement keeps fractional visual positions, commits a detent on release, and hovers only the nearest dot", async t => {
  const app = await setup(t);
  await app.click(app.effortTrigger());
  await app.slide(2.65, null);
  const input = document.querySelector('input[type="range"]');
  assert.equal(input.step, 'any');
  assert.equal(input.value, '2.65', 'the visual position must not be rounded to a reasoning step');
  assert.equal(input.getAttribute('aria-valuetext'), '深入 · GPT 6.1');
  assert.deepEqual(app.patches, []);
  input.getBoundingClientRect = () => ({ left: 0, top: 0, width: 260, height: 36 });
  await app.env.act(async () => {
    input.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 72, clientY: 18 }));
    await tick();
  });
  const dots = [...document.querySelectorAll('.composer-reasoning-ticks i')];
  assert.deepEqual(dots.map((dot, index) => dot.hasAttribute('data-hovered') ? index : null).filter(index => index !== null), [1]);
  assert.deepEqual(app.patches, [], 'hovering does not select a level');
  await app.env.act(async () => {
    input.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
    await tick();
  });
  assert.equal(input.value, '3');
  assert.deepEqual(app.patches, [{ thinkingEnabled: true, reasoning: 'high' }]);
});


test("the two targets share one popup, switch directly while open and keep contextual explanation optional", async t => {
  const app = await setup(t);
  await app.click(app.trigger());
  assert.ok(document.querySelector("[data-model-picker-content]"));
  await app.click(app.effortTrigger());
  assert.equal(document.querySelectorAll('[data-slot="popover-content"]').length, 1);
  assert.ok(document.querySelector('input[type="range"]'));
  assert.equal(document.querySelector("[data-model-picker-content]"), null);
  const help = document.querySelector('.composer-reasoning-help');
  assert.equal(help.getAttribute('aria-expanded'), 'false');
  await app.click(help);
  assert.equal(help.getAttribute('aria-expanded'), 'true');
  assert.match(document.querySelector('.composer-reasoning-description').textContent, /兼顾响应速度与分析/);
  assert.doesNotMatch(document.querySelector('.composer-reasoning-description').textContent, /模型和分组保持不变/);
  await app.click(app.trigger());
  assert.ok(document.querySelector("[data-model-picker-content]"));
  await app.click(document.querySelector('.composer-popup-effort-link'));
  assert.ok(document.querySelector('input[type="range"]'));
  await app.click(app.trigger());
  assert.ok(document.querySelector("[data-model-picker-content]"));
  assert.equal(document.querySelectorAll('[data-slot="popover-content"]').length, 1);
  assert.deepEqual(app.models, []);
  assert.deepEqual(app.patches, []);
});


test("an external /model request opens the model list, and a preview cannot leak after its model changes", async t => {
  const app = await setup(t);
  await app.externalOpen();
  assert.ok(document.querySelector('[data-model-picker-content]'));
  assert.equal(document.querySelector('input[type="range"]'), null);
  await app.click(app.effortTrigger());
  await app.slide(4, null);
  await app.replaceModel('a::gpt-6.1');
  await app.env.act(async () => {
    document.querySelector('input[type="range"]').dispatchEvent(new window.Event('pointerup', {bubbles:true}));
    await tick();
  });
  assert.deepEqual(app.patches, []);
  assert.match(document.querySelector('input[type="range"]').getAttribute('aria-valuetext'), /^标准/);
});
