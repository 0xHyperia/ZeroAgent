import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../../agent-gateway/test/helpers/dom-test-env.mjs";

const source = (path) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url));

test("desktop scheduled tasks use the local device and restore only their owner's route", async (t) => {
  const device = { targetId: "local" };
  let props;
  const env = await createWebDomTestEnv({ mocks: {
    "@/components/cloudchat/CloudScheduleWorkspace": {
      CloudScheduleWorkspace(value) { props = value; return null; },
    },
    "@/components/cloudchat/DeviceScheduleEditor": { DeviceScheduleEditor: () => null },
    [source("lib/relay/desktopDeviceSchedules.ts")]: { desktopDeviceSchedules: () => device },
    "@tauri-apps/api/core": { invoke: () => assert.fail("Local task navigation must not open an account bridge") },
  } });
  const storedSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: window.sessionStorage });
  const { DesktopScheduledTasks } = env.loadModule(source("pages/DesktopScheduledTasks.tsx"));
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  t.after(async () => {
    await env.act(async () => root.unmount());
    if (storedSession) Object.defineProperty(globalThis, "sessionStorage", storedSession);
    else delete globalThis.sessionStorage;
    container.remove();
    env.cleanup();
  });

  const settings = { locale: "en-US", customSettings: { fontScale: { sidebar: 1 } } };
  const render = (owner) => env.act(async () => root.render(
    env.React.createElement(DesktopScheduledTasks, { key: owner, owner, settings }),
  ));
  await render(42);
  assert.equal(props.device, device);
  assert.equal(props.defaultCreationTarget, "local");
  assert.equal(props.includeCloud, false);
  assert.equal(props.schedules, null);
  assert.deepEqual(props.environments, []);

  await env.act(async () => props.onNavigate({ page: "tasks", id: "task-1", target: "local" }));
  assert.equal(props.route.id, "task-1");
  await render(43);
  assert.deepEqual(props.route, { page: "tasks" });
  await render(42);
  assert.equal(props.route.id, "task-1");
  assert.equal(props.route.target, "local");
});
