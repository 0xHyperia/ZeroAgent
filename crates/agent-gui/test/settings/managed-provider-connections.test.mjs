import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("managed groups connect individually, exclude active connections and reject duplicate submissions", async () => {
  const env = await createDomTestEnv({ mocks: {
    "./ProviderPresentation": { ProviderBrandIcon: () => null },
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url))]: new Proxy({}, { get: () => () => null }),
  } });
  const { ManagedProvidersView } = env.loadModule("@liveagent/ui/pages/settings/ManagedProvidersView.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const groups = [1, 2, 3].map(id => ({ id, name: `Group ${id}`, protocol: "codex", protocolLabel: "OpenAI" }));
  const key = (id, groupId, status = "active") => ({ id, groupId, status, name: `Key ${id}`, maskedKey: "••••••", groupName: `Group ${groupId}`, protocol: "codex", protocolLabel: "OpenAI", canEditModels: status === "active", enabledModels: 2 });
  const keys = [key(10, 1), key(11, 1), key(30, 3, "disabled")];
  const calls = [];
  let complete;
  const pending = new Promise(resolve => { complete = resolve; });
  let preferenceClicks = 0;
  const props = { keys, groups, loading: false, busy: false, onCreate: (...args) => { calls.push(args); return pending; }, onCopy() {}, onOpenModels() {}, onRefresh() {}, onOpenPreferences: () => preferenceClicks++ };
  const connectButtons = () => Array.from(host.querySelectorAll("button")).filter(button => button.textContent.trim() === "连接");
  try {
    await env.act(async () => root.render(env.React.createElement(ManagedProvidersView, props)));
    assert.equal(calls.length, 0, "rendering never creates credentials");
    assert.equal(connectButtons().length, 2, "active groups are omitted; disabled credentials allow reconnection");
    assert.ok(connectButtons()[0].parentElement.textContent.includes("Group 2"));
    assert.ok(connectButtons()[1].parentElement.textContent.includes("Group 3"));
    assert.equal(host.querySelectorAll("[data-managed-providers] section:first-of-type > div.space-y-4 > div").length, 2, "existing keys are grouped without deleting duplicates");
    const advanced = Array.from(host.querySelectorAll("button")).find(button => button.textContent.includes("高级设置"));
    await env.act(async () => advanced.click());
    assert.equal(preferenceClicks, 1);
    await env.act(async () => connectButtons()[0].click());
    const input = document.getElementById("managed-key-name");
    assert.ok(input);
    await env.act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.deepEqual(calls, [[2, "ZeroAgent"]], "double Enter creates exactly one key for the chosen group");
    await env.act(async () => { complete(); await pending; });
    await env.act(async () => root.render(env.React.createElement(ManagedProvidersView, { ...props, keys: [...keys, key(20, 2)] })));
    assert.equal(connectButtons().length, 1, "a newly connected group leaves the available list");
    assert.ok(connectButtons()[0].parentElement.textContent.includes("Group 3"));
  } finally {
    await env.act(async () => root.unmount());
    env.cleanup();
  }
});
