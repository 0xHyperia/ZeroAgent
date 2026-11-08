import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("model picker variants preserve selection, search, and clearing", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => icon }),
    "@liveagent/ui/components/ProviderBrandIcon": { ProviderBrandIcon: icon },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key }) },
  } });
  const { ModelPicker } = env.loadModule("@liveagent/ui/pages/settings/modelPicker.tsx");
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  const values = [];
  function Harness() {
    const [value, setValue] = env.React.useState("a");
    return env.React.createElement(ModelPicker, {
      options: [
        { value: "a", label: "Alpha", providerName: "One" },
        { value: "b", label: "Beta", providerName: "Two" },
      ], value, onChange: next => { values.push(next); setValue(next); },
      variant: "quiet", placeholder: "Current", noneLabel: "Current", ariaLabel: "Model",
    });
  }
  try {
    await env.act(async () => root.render(env.React.createElement(Harness)));
    const trigger = () => document.querySelector('[aria-label="Model"]');
    assert.ok(trigger().classList.contains("shadow-none"));
    assert.ok(trigger().classList.contains("border"));
    await env.act(async () => trigger().click());
    const input = document.querySelector("input");
    await env.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "Beta");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const item = [...document.querySelectorAll('[data-model-option]')].find(n => n.textContent === "Beta");
    assert.ok(item, "search expands the matching provider");
    await env.act(async () => item.click());
    assert.deepEqual(values, ["b"]);
    assert.equal(document.querySelector('[data-slot="popover-content"]'), null);
    assert.match(trigger().textContent, /Beta/);
    await env.act(async () => trigger().click());
    const clear = [...document.querySelectorAll('[data-model-option]')].find(n => n.textContent === "Current");
    await env.act(async () => clear.click());
    assert.deepEqual(values, ["b", ""]);
  } finally {
    await env.act(async () => root.unmount()); env.cleanup();
  }
});

test("vendor view waits for a concrete group and shares its preference across model pickers", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => icon }),
    "@liveagent/ui/components/ProviderBrandIcon": { ProviderBrandIcon: icon },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key }) },
  } });
  const { ModelPicker } = env.loadModule("@liveagent/ui/pages/settings/modelPicker.tsx");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
  const { toModelValue } = env.loadModule("@liveagent/ui/lib/models/modelValue.ts");
  const a = toModelValue("group-a", "kimi-k2.5");
  const b = toModelValue("group-b", "kimi-k2.5");
  const options = [
    { value: a, model: "kimi-k2.5", label: "Kimi", providerId: "group-a", providerName: "Group A", providerType: "codex" },
    { value: b, model: "kimi-k2.5", label: "Fast Kimi", providerId: "group-b", providerName: "Group B", providerType: "claude_code" },
    { value: toModelValue("group-a", "glm-5"), model: "glm-5", label: "GLM", providerId: "group-a", providerName: "Group A", providerType: "codex" },
  ];
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const selected = [];
  const button = text => Array.from(document.querySelectorAll("button")).find(node => node.textContent.trim() === text);
  function Harness({ instance = "first" }) {
    const [value, setValue] = env.React.useState(a);
    return env.React.createElement(ModelPicker, { key: instance, options, value, onChange: next => { selected.push(next); setValue(next); }, placeholder: "Current", ariaLabel: "Model" });
  }
  try {
    await env.act(async () => root.render(env.React.createElement(Harness)));
    await env.act(async () => host.querySelector("button").click());
    assert.ok(Array.from(document.querySelectorAll("[data-model-group]")).every(node => node.getAttribute("aria-expanded") === "false"));
    assert.equal(document.querySelectorAll("[data-model-option]").length, 0);
    await env.act(async () => button("chat.modelPickerByVendor").click());
    assert.deepEqual(Array.from(document.querySelectorAll("[data-model-group]")).map(node => node.getAttribute("data-model-group")), ["智谱", "Moonshot"], "actual model vendors override the key's transport protocol");
    await env.act(async () => document.querySelector('[data-model-group="Moonshot"]').click());
    assert.equal(document.querySelectorAll('[data-model-id="kimi-k2.5"]').length, 1, "same model is deduplicated across groups");
    await env.act(async () => document.querySelector('[data-model-id="kimi-k2.5"]').click());
    assert.deepEqual(selected, [], "choosing a model never silently chooses a key/group");
    assert.equal(document.querySelectorAll("[data-model-route]").length, 2);
    await env.act(async () => document.querySelector("[data-model-route-back]").click());
    assert.deepEqual(selected, [], "going back does not change the selected model");
    await env.act(async () => document.querySelector('[data-model-id="kimi-k2.5"]').click());
    const route = Array.from(document.querySelectorAll("[data-model-route]")).find(node => node.getAttribute("data-model-route") === b);
    await env.act(async () => route.click());
    assert.deepEqual(selected, [b]);
    assert.match(host.querySelector("button").textContent, /Fast Kimi/);
    await env.act(async () => root.render(env.React.createElement(Harness, { instance: "second" })));
    await env.act(async () => host.querySelector("button").click());
    assert.equal(document.querySelector("[data-model-picker-content]").getAttribute("data-model-picker-view"), "vendor");
    assert.ok(Array.from(document.querySelectorAll("[data-model-group]")).every(node => node.getAttribute("aria-expanded") === "false"), "opening another picker keeps the view but resets expansion");
  } finally {
    await env.act(async () => root.unmount());
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else delete globalThis.localStorage;
    env.cleanup();
  }
});

test("provider-only selectors keep their raw provider values and omit the model view switch", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => icon }),
    "@liveagent/ui/components/ProviderBrandIcon": { ProviderBrandIcon: icon },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key }) },
  } });
  const { ModelPicker } = env.loadModule("@liveagent/ui/pages/settings/modelPicker.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const selected = [];
  try {
    await env.act(async () => root.render(env.React.createElement(ModelPicker, {
      options: [{ value: "relay-key-9", label: "Backup group", description: "Platform connection", providerId: "codex", providerName: "OpenAI", providerType: "codex" }],
      value: "", onChange: value => selected.push(value), placeholder: "Add provider", selectionKind: "provider", collapsibleGroups: false,
    })));
    await env.act(async () => host.querySelector("button").click());
    assert.equal(Array.from(document.querySelectorAll("button")).some(button => button.textContent === "chat.modelPickerByVendor"), false);
    const option = document.querySelector("[data-model-option]");
    assert.ok(option.textContent.includes("Platform connection"));
    await env.act(async () => option.click());
    assert.deepEqual(selected, ["relay-key-9"]);
  } finally {
    await env.act(async () => root.unmount());
    env.cleanup();
  }
});

test("model type filters stay within the caller's output scope when searching", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => icon }),
    "@liveagent/ui/components/ProviderBrandIcon": { ProviderBrandIcon: icon },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key }) },
  } });
  const { ModelPicker } = env.loadModule("@liveagent/ui/pages/settings/modelPicker.tsx");
  const { buildModelOptions } = env.loadModule("@liveagent/ui/lib/models/modelOptions.ts");
  const { readModelTypes } = env.loadModule("@liveagent/ui/lib/models/modelTypes.ts");
  const options = buildModelOptions({ customProviders: [{
    id: "group", name: "Managed", type: "codex",
    activeModels: ["vision-chat", "gpt-image-2", "custom-movie", "mixed"],
    models: [
      { id: "vision-chat", inputModalities: ["text", "image", "video"] },
      { id: "custom-movie", modelTypes: readModelTypes({ supported_endpoints: ["/v1/videos"] }) },
      { id: "mixed", modelTypes: readModelTypes({ output_modalities: ["text", "image"] }) },
    ],
  }] });
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const values = [];
  const modelIds = () => [...document.querySelectorAll("[data-model-id]")].map(row => row.dataset.modelId);
  const menuItem = label => [...document.querySelectorAll('[role="menuitemradio"]')]
    .find(row => row.textContent.trim().startsWith(label));
  async function open(modelType) {
    await env.act(async () => root.render(env.React.createElement(ModelPicker, {
      key: modelType ?? "all", options, modelType, value: "", placeholder: "Model",
      collapsibleGroups: false, onChange: value => values.push(value),
    })));
    await env.act(async () => host.querySelector("button").click());
  }
  async function search(value) {
    const input = document.querySelector("input");
    await env.act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }
  try {
    await open("text");
    assert.deepEqual(modelIds(), ["vision-chat", "mixed"]);
    await search("gpt-image");
    assert.deepEqual(modelIds(), []);
    await env.act(async () => document.querySelector('[aria-label="chat.modelPickerFilters"]').click());
    assert.equal(menuItem("chat.modelPickerTypeText")?.getAttribute("aria-checked"), "true");
    assert.equal(menuItem("chat.modelPickerTypeAll"), undefined);
    assert.equal(menuItem("chat.modelPickerTypeImage"), undefined);
    await open("image");
    assert.deepEqual(modelIds(), ["gpt-image-2", "mixed"]);
    await search("vision-chat");
    assert.deepEqual(modelIds(), []);
    await open();
    await env.act(async () => document.querySelector('[aria-label="chat.modelPickerFilters"]').click());
    await env.act(async () => menuItem("chat.modelPickerTypeVideo").click());
    assert.deepEqual(modelIds(), ["custom-movie"]);
    assert.deepEqual(values, [], "changing a filter never changes the selected model");
  } finally {
    await env.act(async () => root.unmount());
    env.cleanup();
  }
});
