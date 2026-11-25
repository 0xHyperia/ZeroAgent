import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { useDevicePluginList } = env.loadModule("@liveagent/ui/lib/plugins/useDevicePluginList.ts");
const { RightDockPluginPanels } = env.loadModule("@liveagent/ui/components/project-tools/RightDockPluginPanels.tsx");
const {
  shouldAdoptDevicePluginList,
  subscribeDeviceTrust,
  workspaceTrustFromDevicePlugins,
} = env.loadModule("@liveagent/ui/lib/plugins/devicePlugins.ts");

const pluginList = (workdir, revision = 1) => ({
  available: true, trustAvailable: true, installAvailable: true, workdir, trusted: false, revision, plugins: [], errors: [],
});

function mount(t, client) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  let current;
  function Probe({ workdir }) {
    current = useDevicePluginList(client, workdir);
    return null;
  }
  t.after(async () => {
    await env.act(async () => root.unmount());
    container.remove();
  });
  return {
    state: () => current,
    open: (workdir) => env.act(async () => root.render(env.React.createElement(Probe, { workdir }))),
  };
}

test("a lower plugin revision from a restarted backend replaces the previous list", () => {
  assert.equal(shouldAdoptDevicePluginList(pluginList("/work", 20), pluginList("/work", 1)), true);
  assert.equal(shouldAdoptDevicePluginList(pluginList("/work"), pluginList("/work")), false);
  assert.equal(shouldAdoptDevicePluginList(pluginList("/work"), pluginList("/other")), true);
  assert.equal(shouldAdoptDevicePluginList(pluginList("/work"), { ...pluginList("/work"), installAvailable: false }), true);
  const changed = {
    ...pluginList("/work"),
    plugins: [{
      id: "notes",
      name: "Notes",
      version: "1",
      description: "",
      source: "user",
      enabled: false,
      contributes: { tools: [], hooks: [], prompt: false, ui: [] },
    }],
  };
  assert.equal(shouldAdoptDevicePluginList(pluginList("/work"), changed), true);
  assert.equal(shouldAdoptDevicePluginList(changed, structuredClone(changed)), false);
});

test("switching workspaces discards the previous workspace’s late plugin list", async (t) => {
  let completeFirst;
  const probe = mount(t, {
    installSource: "native",
    operation({ workdir }) {
      return workdir === "/first"
        ? new Promise((resolve) => { completeFirst = resolve; })
        : Promise.resolve(pluginList(workdir));
    },
  });
  await probe.open("/first");
  assert.equal(probe.state().loading, true);
  await probe.open("/second");
  assert.equal(probe.state().list.workdir, "/second");
  await env.act(async () => completeFirst(pluginList("/first", 42)));
  assert.equal(probe.state().list.workdir, "/second");
});

test("an unconfirmed plugin change triggers a read and never retries the mutation", async (t) => {
  const requests = [];
  const probe = mount(t, {
    installSource: "workspace",
    async operation(request) {
      requests.push(request);
      if (request.action !== "list") throw new Error("DEVICE_PLUGIN_RESPONSE_FAILED");
      return pluginList(request.workdir, requests.length);
    },
  });
  await probe.open("/workspace");
  await env.act(() => probe.state().perform({ action: "remove", pluginId: "test" }));
  assert.deepEqual(requests.map(({ action }) => action), ["list", "remove", "list"]);
  assert.equal(requests[1].workdir, "/workspace");
  assert.equal(probe.state().list.revision, 3);
  assert.equal(probe.state().actionError, "DEVICE_PLUGIN_RESPONSE_FAILED");
  assert.equal(probe.state().busy, null);
});

test("only successful trust changes invalidate the command catalog for the same device", async () => {
  const backend = {
    installSource: "workspace",
    async operation({ action, workdir }) {
      if (action === "revokeTrust") throw new Error("DEVICE_PLUGIN_SCOPE_CHANGED");
      return { ...pluginList(workdir), trusted: true, trustInherited: true };
    },
  };
  const trust = workspaceTrustFromDevicePlugins(backend, "/workspace/project");
  let refreshes = 0;
  const stop = subscribeDeviceTrust(backend, () => refreshes++);
  const stopOther = subscribeDeviceTrust({ ...backend }, () => assert.fail("wrong device"));
  assert.equal(await trust.supported(), true);
  assert.equal((await trust.get()).inherited, true);
  assert.equal((await trust.get()).source, undefined);
  assert.equal(refreshes, 0);
  await trust.trust();
  assert.equal(refreshes, 1);
  await assert.rejects(trust.revoke(), /DEVICE_PLUGIN_SCOPE_CHANGED/);
  assert.equal(refreshes, 1);
  stop();
  stopOther();
  await trust.trust();
  assert.equal(refreshes, 1);
});

test("dock opens a declared panel for its exact project and version and discards late results", async (t) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  t.after(async () => {
    await env.act(async () => root.unmount());
    container.remove();
  });
  let settle;
  const requests = [];
  const client = {
    installSource: "workspace",
    async operation({ workdir }) {
      return {
        ...pluginList(workdir), trusted: true,
        plugins: workdir === "/first" ? [{
          id: "notes", name: "Notes", version: "1.2.0", source: "workspace", enabled: true,
          contributes: { tools: [], hooks: [], prompt: false, ui: [
            { id: "status", title: "Project status", placement: "sidePane" },
            { id: "settings", title: "Configure notes", placement: "settings" },
          ] },
        }] : [],
      };
    },
    readSurface(request) {
      requests.push(request);
      return new Promise((resolve) => { settle = resolve; });
    },
  };
  const show = (workdir) => env.act(async () => root.render(env.React.createElement(
    RightDockPluginPanels, { key: workdir, client, workdir, onClose() {} },
  )));
  await show("/first");
  assert.doesNotMatch(container.textContent, /Configure notes/);
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent.includes("Project status"));
  assert.ok(button);
  await env.act(async () => button.click());
  assert.deepEqual(requests, [{ action: "panel", workdir: "/first", pluginId: "notes", pluginVersion: "1.2.0", resourceId: "status" }]);
  await show("/second");
  await env.act(async () => settle({ html: "<p>First workspace output</p>" }));
  assert.doesNotMatch(container.textContent, /Project status|First workspace output/);
  assert.equal(container.querySelector("iframe"), null);
});

test.after(() => env.cleanup());
