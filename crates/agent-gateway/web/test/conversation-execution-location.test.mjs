import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test("workbench switcher keeps its selection on failure and permits retry", async (t) => {
  const env = await createWebDomTestEnv();
  const { React, act, createRoot } = env;
  const { ConversationExecutionLocation } = env.loadModule(
    "@liveagent/ui/components/chat/ConversationExecutionLocation.tsx",
  );
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  });
  const current = { kind: "device", name: "Device A", workspace: "Project A" };
  let resolve;
  let reject;
  let attempts = 0;
  const cloud = {
    id: "cloud",
    kind: "cloud",
    name: "Cloud",
    choose: () => {
      attempts++;
      return new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
    },
  };
  const render = async (choices) =>
    act(async () => root.render(React.createElement(ConversationExecutionLocation, { current, choices })));
  const tick = () => new Promise((done) => setTimeout(done, 15));
  await render([{ id: "selected", ...current, selected: true }, cloud, {
    id: "offline",
    kind: "device",
    name: "Offline device",
    offline: true,
    choose: () => assert.fail("offline device invoked"),
  }]);
  const trigger = host.querySelector("button");
  const item = (label) => [...document.querySelectorAll('[role="menuitem"]')]
    .find((entry) => entry.textContent.includes(label));
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await tick();
  });
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(item("Device A").getAttribute("aria-current"), "true");
  assert.equal(item("Offline device").getAttribute("aria-disabled"), "true");
  await act(async () => {
    item("Cloud").click();
    item("Cloud").click();
  });
  assert.equal(attempts, 1);
  await act(async () => reject(new Error("Connection unavailable")));
  assert.match(document.querySelector('[role="alert"]').textContent, /Cloud.*Connection unavailable/);
  assert.match(trigger.textContent, /Device A/);
  const retry = document.querySelector('[role="menuitem"][aria-label$="Cloud"]');
  assert.ok(retry, "retry identifies the same choice for assistive technology");
  await act(async () => retry.click());
  await act(async () => {
    resolve();
    await tick();
  });
  assert.equal(attempts, 2);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  await render(undefined);
  assert.equal(host.querySelector("button"), null);
  assert.match(host.querySelector('[data-conversation-execution-location="bound"]').textContent, /Project A/);
});

test("workbench retry follows the original device across an outage", async (t) => {
  const env = await createWebDomTestEnv();
  const { React, act, createRoot } = env;
  const { ExecutionEnvironmentSwitcher } = env.loadModule("src/components/ExecutionEnvironmentSwitcher.tsx");
  const { LocaleContext, t: translate } = env.loadModule("@liveagent/ui/i18n/index.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  });
  const calls = [];
  const cloud = { runtime_kind: "web_chat", name: "Cloud", online: true, workspaces: [] };
  const office = { runtime_kind: "device_agent", device_id: "office", agent_id: "office-agent", name: "Office", online: true, workspaces: [
    { id: "alpha", name: "Alpha", path: "D:/alpha" }, { id: "beta", name: "Beta", path: "D:/beta" },
  ] };
  let connected = false;
  async function render(device) {
    await act(async () => root.render(React.createElement(
      LocaleContext.Provider, { value: { locale: "en-US", t: (key) => translate(key, "en-US") } },
      React.createElement(ExecutionEnvironmentSwitcher, {
        environments: [cloud, device], selection: cloud,
        onSwitch: async (target, workspace) => {
          calls.push({ target, workspace });
          if (!connected) throw Error("Device connection unavailable");
        },
      }),
    )));
  }
  await render(office);
  const trigger = host.querySelector("button");
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  const menu = () => document.querySelector('[role="menu"]');
  const rows = () => [...menu().querySelectorAll('[role="menuitem"]')];
  const officeRow = () => rows().find((node) => node.textContent.includes("Office"));
  const retry = () => menu().querySelector('[aria-label="Retry Office"]');
  const alert = () => menu().querySelector('[role="alert"]');
  await act(async () => officeRow().click());
  assert.match(alert().textContent, /Office.*Device connection unavailable/);
  assert.equal(rows()[0], retry(), "the explicit retry precedes the long list of choices");
  await act(async () => {
    officeRow().focus();
    officeRow().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
  });
  assert.equal(document.activeElement, retry());

  await render({ ...office, online: false });
  assert.equal(rows().filter((node) => node.textContent.includes("Office")).length, 1);
  assert.equal(rows().find((node) => node.textContent.includes("Office")).getAttribute("aria-disabled"), "true");
  assert.equal(retry(), null);
  assert.match(alert().textContent, /Device offline/);

  const reconnected = { ...office, workspaces: office.workspaces.map((workspace) => ({ ...workspace })) };
  await render(reconnected);
  await act(async () => retry().click());
  assert.equal(calls.length, 2);
  assert.equal(calls[1].target, reconnected);
  assert.equal(calls[1].workspace, reconnected.workspaces[0]);

  const changed = { ...office, agent_id: "replacement-agent" };
  await render(changed);
  assert.equal(retry(), null);
  assert.match(alert().textContent, /execution location changed/i);
  connected = true;
  await act(async () => officeRow().click());
  assert.equal(calls.length, 3);
  assert.equal(calls[2].target, changed);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("the workbench menu selects a device without requiring a workspace choice", async (t) => {
  const env = await createWebDomTestEnv();
  const { React, act, createRoot } = env;
  const { ExecutionEnvironmentSwitcher } = env.loadModule("src/components/ExecutionEnvironmentSwitcher.tsx");
  const { LocaleContext, t: translate } = env.loadModule("@liveagent/ui/i18n/index.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); env.cleanup(); });
  const calls = [];
  const cloud = { runtime_kind: "web_chat", name: "Cloud", online: true, workspaces: [] };
  const office = { runtime_kind: "device_agent", device_id: "office", agent_id: "office-agent", name: "Office", online: true, workspaces: [
    { id: "alpha", name: "Alpha", path: "D:/alpha" }, { id: "beta", name: "Beta", path: "D:/beta" },
  ] };
  const empty = { runtime_kind: "device_agent", device_id: "empty", name: "Empty", online: true, workspaces: [] };
  await act(async () => root.render(React.createElement(LocaleContext.Provider, { value: { locale: "en-US", t: (key) => translate(key, "en-US") } }, React.createElement(ExecutionEnvironmentSwitcher, {
    environments: [cloud, office, empty], selection: cloud,
    onSwitch: async (device, workspace) => calls.push({ device, workspace }),
  }))));
  const trigger = host.querySelector("button");
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  const item = (text) => [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes(text));
  assert.ok(item("Office"));
  assert.equal(item("Alpha"), undefined);
  assert.equal(item("Empty").getAttribute("aria-disabled"), null);
  await act(async () => item("Empty").click());
  assert.deepEqual(calls, [{ device: empty, workspace: { id: "", name: "" } }]);
});

test("device draft preflight verifies the exact project and disposes its candidate connection", async (t) => {
  const alpha = { id: "alpha", name: "Alpha", path: "D:/alpha" };
  const beta = { id: "beta", name: "Beta", path: "D:/beta" };
  const system = { workspaceProjects: [alpha, beta], archivedWorkspaceProjectPaths: [], missingWorkspaceProjectPaths: [] };
  const events = [];
  let directoryError = false;
  const env = await createWebDomTestEnv({ mocks: { "@/lib/gatewaySocket": { GatewayWebSocketClient: class {
    constructor(token) { events.push(["candidate", token.startsWith("selection.")]); }
    setActiveAgent(agent) { events.push(["agent", agent]); }
    async getSettings() { events.push(["settings"]); return { system }; }
    async listDirs(path) { events.push(["directory", path]); if (directoryError) throw new Error("offline"); }
    dispose() { events.push(["disposed"]); }
  } } } });
  t.after(() => env.cleanup());
  const { findDeviceDraftProject, prepareDeviceDraftWorkspace } = env.loadModule("src/app/gatewayDeviceDraftWorkspace.ts");
  const selection = { runtime_kind: "device_agent", device_id: "office", agent_id: "office", workspace_id: "", scope: "device", selection_lease: "fixture" };
  assert.equal(findDeviceDraftProject(system, { id: beta.id, path: alpha.path }), undefined);
  assert.equal(findDeviceDraftProject({ ...system, archivedWorkspaceProjectPaths: [beta.path] }, beta), undefined);
  assert.equal(findDeviceDraftProject({ ...system, missingWorkspaceProjectPaths: [beta.path] }, beta), undefined);
  assert.deepEqual(await prepareDeviceDraftWorkspace(selection, beta, () => {}), { id: beta.id, path: beta.path });
  assert.deepEqual(events, [["candidate", true], ["agent", "office"], ["settings"], ["directory", beta.path], ["disposed"]]);
  directoryError = true;
  await assert.rejects(prepareDeviceDraftWorkspace(selection, beta, () => {}), /offline/);
  assert.deepEqual(events.at(-1), ["disposed"]);
  let guardCalls = 0;
  await assert.rejects(prepareDeviceDraftWorkspace(selection, beta, () => { if (++guardCalls === 2) throw new Error("retired"); }), /retired/);
  assert.deepEqual(events.slice(-2), [["settings"], ["disposed"]]);
});
