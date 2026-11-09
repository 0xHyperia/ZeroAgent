import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const source = (path) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url));

test("a directory outage preserves the authorized remote workbench across device tasks and chat", async (t) => {
  const local = { runtime_kind: "device_agent", device_id: "local", name: "This computer", online: true, workspaces: [] };
  const remote = { ...local, device_id: "remote", name: "Design workstation", workspaces: [{ id: "design", name: "Design" }] };
  const settings = { locale: "en-US", theme: "light", remote: { gatewayUrl: "http://gateway.invalid", gatewayPort: 0 } };
  const runEvent = "fixture:remote-run-progress";
  const counts = { mount: 0, dispose: 0, bridge: 0, close: 0 };
  const mount = (container, host) => {
    counts.mount++;
    // Stand in for the separately bundled device runtime while using the actual host lifecycle.
    container.innerHTML = `<nav data-owned-rail><button>Scheduled tasks</button><button>Chat</button></nav>
      <section data-project="design"><textarea aria-label="Device draft"></textarea><output>Run started</output></section>
      <section data-task-list hidden>Device task list</section>`;
    const [tasks, chat] = container.querySelectorAll("button");
    const project = container.querySelector("[data-project]");
    const taskList = container.querySelector("[data-task-list]");
    assert.equal(host.accountNavigation, undefined);
    tasks.onclick = () => { project.hidden = true; taskList.hidden = false; };
    chat.onclick = () => { project.hidden = false; taskList.hidden = true; };
    const progress = (event) => { project.querySelector("output").textContent = event.detail; };
    window.addEventListener(runEvent, progress);
    return {
      dispose() {
        counts.dispose++;
        window.removeEventListener(runEvent, progress);
        container.replaceChildren();
      },
    };
  };
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    [source("components/WindowsTitleBar.tsx")]: { WindowsTitleBar: () => null },
    [source("lib/relay/desktopRemoteRuntime.ts")]: {
      loadDesktopRemoteRuntime: async () => ({ styles: [], factory: { createDesktopRemoteRuntime: () => ({ mount }) } }),
      attachDesktopRemoteStyles: async () => Object.assign(() => {}, { setEnabled() {} }),
    },
    [source("lib/relay/desktopRemoteHost.ts")]: {
      isDesktopRemoteTargetAuthorized: (device, lease, expiry) => device.online && !!lease && expiry > Date.now(),
      createDesktopRemoteHost: async (host) => {
        counts.bridge++;
        return { host, dispose: () => { counts.close++; } };
      },
    },
  } });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = globalThis.ResizeObserver;
  const { React, act } = env;
  const { RemoteDeviceWorkbench } = env.loadModule("src/pages/RemoteDeviceWorkbench.tsx");
  const state = env.loadModule("src/lib/relay/remoteDeviceState.ts");
  const ready = state.selectDesktopExecutionState(state.localDesktopExecutionState([local, remote], local.device_id), remote);
  const outage = state.unavailableDesktopExecutionState(ready, [local]);
  const offline = state.refreshDesktopExecutionState(ready, [local, { ...remote, online: false }], local.device_id);
  const confirmedMissing = state.refreshDesktopExecutionState(ready, [local], local.device_id);
  const expiresAt = Date.now() + 60_000;
  const parent = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(parent);
  t.after(async () => { await act(async () => root.unmount()); parent.remove(); env.cleanup(); });

  function Harness({ execution, selectionError }) {
    return React.createElement(RemoteDeviceWorkbench, {
      settings, environment: execution.environments.find((item) => item.device_id === execution.selectedDeviceId),
      selectedDeviceMissing: execution.selectedDeviceMissing, environments: execution.environments,
      selectionLease: "fixture-lease", expiresAt, selectionError,
    });
  }
  const render = (execution, selectionError) => act(async () => root.render(React.createElement(Harness, { execution, selectionError })));
  const click = (name) => act(async () => {
    const button = [...parent.querySelectorAll("[data-owned-rail] button")].find((item) => item.textContent === name);
    assert.ok(button, name);
    button.click();
  });

  await render(outage);
  assert.match(parent.textContent, /设备离线/);
  assert.equal(counts.bridge, 0, "an unconfirmed offline target cannot create a new bridge");
  await render(ready);
  const draft = parent.querySelector('textarea[aria-label="Device draft"]');
  const project = draft.closest("[data-project]");
  const rail = parent.querySelector("[data-owned-rail]");
  assert.ok(draft && project && rail);
  draft.value = "Continue this task from the design project";
  draft.setSelectionRange(9, 18);

  await render(outage);
  assert.equal(parent.querySelector("[data-owned-rail]"), rail);
  await click("Scheduled tasks");
  assert.equal(parent.querySelector("[data-task-list]").hidden, false);
  await render(offline);
  assert.equal(parent.querySelector("[data-owned-rail]"), rail);
  assert.equal(parent.querySelector("[data-task-list]").hidden, false);
  await act(async () => window.dispatchEvent(new CustomEvent(runEvent, { detail: "Same run made progress" })));
  await click("Chat");
  assert.equal(project.hidden, false);
  assert.equal(project.dataset.project, "design");
  assert.equal(parent.querySelector("textarea"), draft);
  assert.equal(draft.value, "Continue this task from the design project");
  assert.deepEqual([draft.selectionStart, draft.selectionEnd], [9, 18]);
  assert.equal(project.querySelector("output").textContent, "Same run made progress");
  assert.deepEqual(counts, { mount: 1, dispose: 0, bridge: 1, close: 0 });

  await render(ready);
  assert.equal(parent.querySelector("textarea"), draft);
  await render(confirmedMissing);
  assert.equal(parent.querySelector("textarea"), null);
  assert.deepEqual(counts, { mount: 1, dispose: 1, bridge: 1, close: 1 });
  await render(state.unavailableDesktopExecutionState(confirmedMissing, [local]));
  await render(offline);
  assert.equal(parent.querySelector("textarea"), null);
  assert.deepEqual(counts, { mount: 1, dispose: 1, bridge: 1, close: 1 });
  await render(ready);
  await render(outage, "Device authorization revoked");
  assert.match(parent.textContent, /Device authorization revoked/);
  assert.equal(parent.querySelector("textarea"), null);
  assert.deepEqual(counts, { mount: 2, dispose: 2, bridge: 2, close: 2 });
});

test("cloud connection failure leaves the desktop switcher available and retry keeps the workbench isolated", async (t) => {
  const calls = { open: 0, mount: 0, dispose: 0 };
  const snapshots = [];
  let mountHost;
  const env = await createDomTestEnv({ mocks: {
    [source("lib/relay/desktopCloudHost.ts")]: {
      openDesktopCloudHost: async () => {
        calls.open++;
        if (calls.open === 1) throw new Error("Gateway unavailable");
        return { host: { accountUser: { id: 42 } }, dispose() {} };
      },
    },
    [source("lib/relay/desktopRemoteRuntime.ts")]: {
      loadDesktopRemoteRuntime: async () => ({ styles: [], factory: { createDesktopRemoteRuntime: () => ({
        mount(container, host) {
          calls.mount++;
          mountHost = host;
          const surface = container.appendChild(document.createElement("main"));
          return {
            setActive(active) { snapshots.push([active, host.getHandoffEnvironments()]); },
            dispose() { calls.dispose++; surface.remove(); },
          };
        },
      }) } }),
      attachDesktopRemoteStyles: async () => Object.assign(() => {}, { setEnabled() {} }),
    },
  } });
  const { React, act } = env;
  const { DesktopCloudWorkbench } = env.loadModule("src/pages/DesktopCloudWorkbench.tsx");
  const parent = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(parent);
  t.after(async () => { await act(async () => root.unmount()); parent.remove(); env.cleanup(); });
  const settings = { locale: "en-US", theme: "light" };
  const headerLeadingActions = React.createElement("button", null, "Switch workbench");
  const render = (targets, active = true) => act(async () => root.render(React.createElement(DesktopCloudWorkbench, {
    accountId:42, active, settings, headerLeadingActions, getHandoffEnvironments:()=>targets,
  })));
  const target = { runtime_kind:"device_agent", device_id:"design", name:"Design workstation", online:true, workspaces:[{id:"workspace",name:"Project"}] };
  const offline = [{...target,online:false}];
  await render(offline);
  assert.match(parent.textContent, /Account content is temporarily unavailable/);
  assert.match(parent.querySelector("[data-app-workbench-chrome]").textContent, /Switch workbench/);
  const retry = () => act(async () =>
    [...parent.querySelectorAll("button")].find((button) => button.textContent === "Reconnect").click()
  );
  await retry();
  assert.match(parent.textContent, /Opening the cloud workbench/);
  assert.ok(parent.querySelector("main").closest(".hidden"));
  const failedHost = mountHost;
  await act(async () => failedHost.onMountError());
  assert.match(parent.textContent, /Account content is temporarily unavailable/);
  assert.match(parent.querySelector("[data-app-workbench-chrome]").textContent, /Switch workbench/);
  await retry();
  await act(async () => failedHost.onMountReady());
  assert.match(parent.textContent, /Opening the cloud workbench/);
  await act(async () => mountHost.onMountReady());
  const surface = parent.querySelector("main");
  assert.ok(surface);
  assert.equal(surface.closest(".hidden"), null);
  assert.deepEqual(snapshots.at(-1), [true,offline]);
  await render([target]);
  assert.deepEqual(snapshots.at(-1), [true,[target]]);
  assert.equal(parent.querySelector("main"), surface);
  await render([{...target,workspaces:[]}]);
  assert.deepEqual(snapshots.at(-1), [true,[{...target,workspaces:[]}]]);
  assert.equal(parent.querySelector("main"), surface);
  await render([target], false);
  assert.ok(surface.closest("[inert][hidden]"), "leaving cloud hides the entire account workbench");
  await render([target]);
  assert.equal(parent.querySelector("main"), surface, "returning to cloud restores the same runtime");
  assert.deepEqual(calls, {open:3,mount:2,dispose:1});
});
