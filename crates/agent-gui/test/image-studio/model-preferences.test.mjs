import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("image preferences show provider-derived models, preserve explicit empty defaults and keep known options on read failure", async () => {
  let env, settings, fail = false, reads = 0, writes = 0;
  const target = { id: "it_provider_stable", providerId: "group", modelId: "gpt-image-2.5", remoteId: "gpt-image-2.5", name: "生图分组 · 模型别名", connectionId: "derived", enabled: true, capabilities: { operations: ["generate"] } };
  env = await createDomTestEnv({ mocks: {
    "../../components/IconSet": new Proxy({}, { get: () => () => null }),
    [fileURLToPath(new URL("../../../agent-ui/src/pages/settings/modelPicker.tsx", import.meta.url))]: {
      ModelPicker: props => env.React.createElement(env.React.Fragment, null, env.React.createElement("button", { "aria-label": "目录刷新", onClick: props.onRefresh }, "目录刷新"), env.React.createElement("select", { "aria-label": props.ariaLabel, value: props.value, disabled: props.disabled, onChange: event => props.onChange(event.target.value) },
        env.React.createElement("option", { value: "" }, props.noneLabel),
        props.options.map(option => env.React.createElement("option", { key: option.value, value: option.value }, `${option.providerName} · ${option.label}`)))),
    },
  } });
  const { DeviceImageModelPreferences } = env.loadModule("@liveagent/ui/pages/settings/DeviceImageModelPreferences.tsx");
  const { getDefaultSettings } = env.loadModule("@liveagent/ui/lib/settings");
  settings = { ...getDefaultSettings(), customProviders: [{ id: "group", name: "生图分组", type: "codex", activeModels: ["gpt-image-2.5"], models: [{ id: "gpt-image-2.5", displayName: "模型别名" }] }] };
  const client = {
    getSettings() { throw Error("manual targets are not the model catalog"); },
    async listTargets() { reads++; if (fail) throw Error("catalog unavailable"); return [target, { ...target, id: "disabled", enabled: false }, { ...target, id: "edit-only", capabilities: { operations: ["edit"] } }]; },
  };
  const host = document.body.appendChild(document.createElement("div")), root = env.createRoot(host);
  function Harness() {
    const [value, setValue] = env.React.useState(settings);
    return env.React.createElement(DeviceImageModelPreferences, { settings: value, client, setSettings(update) { writes++; setValue(previous => { settings = update(previous); return settings; }); } });
  }
  try {
    await env.act(async () => { root.render(env.React.createElement(Harness)); await new Promise(resolve => setImmediate(resolve)); });
    const select = host.querySelector("select");
    assert.equal(reads, 1); assert.equal(writes, 0); assert.equal(select.value, "");
    assert.deepEqual([...select.options].map(option => option.textContent), ["未配置", "生图分组 · 模型别名"]);
    assert.doesNotMatch(host.textContent, /图像目标与参数|第一个可用|刷新模型/);
    await env.act(async () => { select.value = target.id; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
    assert.equal(settings.customSettings.imageGenerationTargetId, target.id);
    await env.act(async () => { select.value = ""; select.dispatchEvent(new window.Event("change", { bubbles: true })); });
    assert.equal(settings.customSettings.imageGenerationTargetId, undefined);
    fail = true;
    await env.act(async () => { [...host.querySelectorAll("button")].find(button => button.textContent === "目录刷新").click(); await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(select.options.length, 2); assert.equal(select.value, ""); assert.match(host.querySelector('[role="alert"]').textContent, /catalog unavailable/);
  } finally { await env.act(async () => root.unmount()); env.cleanup(); }
});
