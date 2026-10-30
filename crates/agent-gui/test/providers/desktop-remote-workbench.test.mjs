import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const source = (name) => new URL(`../../src/${name}`, import.meta.url).pathname;
const icons = new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url).pathname;

async function fixture(t, options = {}) {
  const calls = [];
  const invalidations = [];
  const stages = { ...options };
  const session = { sessionHandle: "native-session", accountScope: "synthetic-account", user: { id: 7 }, authKind: "oauth" };
  const env = await createDomTestEnv({ mocks: {
    [icons]: new Proxy({}, { get: () => () => null }),
    [source("components/WindowsTitleBar.tsx")]: { WindowsTitleBar: () => null },
    [source("lib/relay/client.ts")]: { RELAY_ORIGIN: "http://account.invalid" },
    [source("lib/relay/nativeSession.ts")]: { requireNativeSession: async () => session, nativeSessionHandle: () => session.sessionHandle },
    [source("lib/relay/desktopExecution.ts")]: { desktopGatewayOrigin: () => "http://gateway.invalid" },
    "@tauri-apps/api/core": { invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "account_remote_close") return;
      assert.equal(command, "account_remote_open");
      if (stages.native) throw stages.native;
      return { bridgeId: `bridge-${calls.length}`, selection: { runtime_kind: "device_agent", device_id: args.request.deviceId, selection_lease: "handoff-lease" } };
    } },
    [source("lib/relay/desktopRemoteRuntime.ts")]: {
      loadDesktopRemoteRuntime: async () => {
        if (stages.load) throw stages.load;
        if (stages.pending) return stages.pending;
        return { styles: [], factory: { createDesktopRemoteRuntime: () => ({ mount(container, host) {
          if (stages.mount) throw stages.mount;
          calls.push({ command: "mount", host });
          const workbench = document.createElement("main");
          workbench.textContent = `Full workbench: ${host.environment.device_id}`;
          container.append(workbench);
          return { dispose() { calls.push({ command: "unmount" }); workbench.remove(); } };
        } }) } };
      },
      attachDesktopRemoteStyles: async (_styles, signal) => {
        if (stages.styles) throw stages.styles;
        calls.push({ command: "styles", signal });
        return () => calls.push({ command: "remove-styles" });
      },
    },
  } });
  const { React, act, createRoot } = env;
  const { RemoteDeviceWorkbench } = env.loadModule("src/pages/RemoteDeviceWorkbench.tsx");
  const target = document.body.appendChild(document.createElement("div"));
  const root = createRoot(target);
  let input = {
    settings: { remote: { enabled: true, gatewayUrl: "http://gateway.invalid", gatewayPort: 80 } },
    environment: { runtime_kind: "device_agent", device_id: "device-a", name: "Remote A", online: true, workspaces: [] },
    environments: [], selectionLease: "source-lease", expiresAt: Date.now() + 60_000,
  };
  let setSelection;
  let reconnects = 0;
  function Shell() {
    const [selection, setState] = React.useState(input);
    setSelection = setState;
    return React.createElement(RemoteDeviceWorkbench, {
      ...selection,
      onSelectionInvalid(reason) {
        invalidations.push(reason);
        setState((previous) => ({ ...previous, selectionError: reason }));
      },
      async onReconnect() {
        reconnects++;
        if (stages.reconnect) throw stages.reconnect;
        setState((previous) => ({ ...previous, selectionError: undefined, selectionLease: `renewed-${reconnects}`, expiresAt: Date.now() + 60_000 }));
      },
    });
  }
  t.after(async () => { await act(async () => root.unmount()); target.remove(); env.cleanup(); });
  const render = async (changes = {}) => {
    input = { ...input, ...changes };
    await act(async () => root.render(React.createElement(Shell)));
    if (Object.keys(changes).length) await act(async () => setSelection(input));
  };
  const retry = async () => act(async () => [...target.querySelectorAll("button")].find((button) => button.textContent.includes("重新连接")).click());
  return { env, render, retry, calls, stages, invalidations, target, input, reconnects: () => reconnects };
}

for (const stage of ["load", "native", "styles", "mount"]) {
  test(`remote ${stage} failure preserves its real cause and retries with a renewed lease`, async (t) => {
    // Tauri rejects with strings; JS loading/mounting rejects with Error objects.
    const message = `${stage}: synthetic connection failure`;
    const f = await fixture(t, { [stage]: stage === "native" ? message : new Error(message) });
    await f.render();
    assert.equal(f.target.querySelector('[role="status"] .app-status-message').textContent, message);
    assert.deepEqual(f.invalidations, [], "initialization failures must not invalidate authorization");
    await f.render({ environments: [{ ...f.input.environment, name: "Updated directory" }] });
    assert.equal(f.target.querySelector('[role="status"] .app-status-message').textContent, message);
    if (["styles", "mount"].includes(stage))
      assert.equal(f.calls.filter((call) => call.command === "account_remote_close").length, 1);
    if (stage === "mount")
      assert.equal(f.calls.filter((call) => call.command === "remove-styles").length, 1);
    delete f.stages[stage];
    await f.retry();
    assert.equal(f.reconnects(), 1);
    assert.equal(f.target.querySelector('[role="status"]'), null);
    assert.match(f.target.textContent, /Full workbench: device-a/);
    const opened = f.calls.filter((call) => call.command === "account_remote_open").at(-1);
    assert.equal(opened.args.request.selectionLease, "renewed-1");
  });
}

test("a failed explicit reconnect preserves its new error and remains retryable", async (t) => {
  const f = await fixture(t, { load: new Error("initial failure"), reconnect: "Gateway 连接失败，请稍后重试。" });
  await f.render();
  await f.retry();
  assert.equal(f.target.querySelector('[role="status"] .app-status-message').textContent, "Gateway 连接失败，请稍后重试。");
  assert.equal(f.target.querySelector("button").disabled, false);
  assert.deepEqual(f.invalidations, []);
  delete f.stages.reconnect;
  delete f.stages.load;
  await f.retry();
  assert.match(f.target.textContent, /Full workbench: device-a/);
});

test("remote authorization rejection keeps its reason through the parent rerender and can reconnect", async (t) => {
  const f = await fixture(t);
  await f.render();
  const host = f.calls.find((call) => call.command === "mount").host;
  const reason = "此设备已撤销控制权限，请重新验证。";
  await f.env.act(async () => host.onSelectionInvalid(reason));
  assert.deepEqual(f.invalidations, [reason]);
  assert.equal(f.target.querySelector('[role="status"] .app-status-message').textContent, reason);
  assert.equal(host.isCurrent(), false);
  assert.equal(f.calls.filter((call) => call.command === "unmount").length, 1);
  assert.equal(f.calls.filter((call) => call.command === "account_remote_close").length, 1);
  await f.retry();
  assert.equal(f.target.querySelector('[role="status"]'), null);
  assert.equal(f.calls.filter((call) => call.command === "mount").length, 2);
});

test("actual expiry closes the mounted remote workbench and initial expired/offline targets never open Native", async (t) => {
  const f = await fixture(t);
  let expire;
  const timer = t.mock.method(window, "setTimeout", (callback) => { expire = callback; return 1; });
  await f.render();
  assert.ok(expire);
  await f.env.act(async () => expire());
  assert.match(f.target.querySelector('[role="status"]').textContent, /控制权限已过期/);
  assert.equal(f.calls.filter((call) => call.command === "account_remote_close").length, 1);
  timer.mock.restore();
  const opened = f.calls.length;
  await f.render({ expiresAt: Date.now() - 1 });
  await f.render({ environment: { ...f.input.environment, online: false } });
  assert.match(f.target.querySelector('[role="status"]').textContent, /设备离线/);
  assert.equal(f.calls.length, opened);
});

test("a late failure from an abandoned initialization cannot replace the next device", async (t) => {
  let rejectOld;
  const pending = new Promise((_resolve, reject) => { rejectOld = reject; });
  const f = await fixture(t, { pending });
  await f.render();
  delete f.stages.pending;
  await f.render({ environment: { ...f.input.environment, device_id: "device-b" }, selectionLease: "lease-b" });
  await f.env.act(async () => rejectOld(new Error("old device failure")));
  assert.equal(f.target.querySelector('[role="status"]'), null);
  assert.match(f.target.textContent, /Full workbench: device-b/);
  assert.deepEqual(f.invalidations, []);
});
