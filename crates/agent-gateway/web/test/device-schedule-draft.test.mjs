import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test("a task draft stays open on failed device selection and arrives at the authorized device editor once", async (t) => {
  const env = await createWebDomTestEnv();
  const { React, act, createRoot } = env;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const storage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: window.sessionStorage });
  const { CloudScheduleWorkspace } = env.loadModule("src/components/cloudchat/CloudScheduleWorkspace.tsx");
  const { SidebarProvider } = env.loadModule("../../agent-ui/src/components/ui/sidebar.tsx");
  const { receiveDeviceScheduleDraft } = env.loadModule("src/lib/deviceScheduleDraft.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (storage) Object.defineProperty(globalThis, "sessionStorage", storage);
    else delete globalThis.sessionStorage;
    env.cleanup();
  });
  const selected = { id: "device-a", label: "Device A", online: true };
  const environment = {
    runtime_kind: "device_agent", device_id: selected.id, name: selected.label,
    online: selected.online, workspaces: [{ id: "workspace", name: "Workspace" }],
  };
  const base = {
    owner: 42, locale: "en-US", route: { page: "tasks" },
    onNavigate: () => {}, onBack: () => {}, environments: [],
    models: [{ model: "fixture", name: "Fixture", keyId: 7 }],
    currentModel: { model: "fixture", name: "Fixture", keyId: 7 },
  };
  const schedules = {
    list: async () => ({ enabled: true, tasks: [] }),
    deviceSummary: async () => ({ tasks: [] }),
    preview: async () => ({ next: new Date(Date.now() + 3600_000).toISOString() }),
    save: async () => assert.fail("choosing a device must not save a Cloud task"),
  };
  let attempts = 0;
  let arrived;
  const source = React.createElement(CloudScheduleWorkspace, {
    ...base, key: "source", schedules, environments: [environment],
    onOpenDevice: async (target, route) => {
      assert.equal(target.device_id, selected.id);
      assert.equal(route.id, undefined);
      if (++attempts === 1) throw new Error("device offline");
    },
  });
  const device = {
    targetId: selected.id, label: selected.label,
    list: async () => ({ tasks: [], next: {}, timeZone: "Asia/Hong_Kong" }),
    preview: async () => assert.fail("mounting the handoff fixture must not preview or save"),
    save: async () => assert.fail("mounting must not save a device task"),
  };
  const destination = (owner, sidebarOnly = false, scheduleHost = device) => React.createElement(CloudScheduleWorkspace, {
    ...base, owner, sidebarOnly, key: `device-${owner}-${sidebarOnly}`, device: scheduleHost,
    schedules: null, includeCloud: false, onOpenDevice: async () => undefined,
    renderDeviceEditor: (props) => {
      arrived = props;
      return React.createElement("div", { "data-destination-editor": "" }, props.prompt);
    },
  });
  const render = (...children) => act(async () => root.render(React.createElement(SidebarProvider, null, children)));
  const button = (label) => [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === label);
  async function choose(label) {
    const trigger = document.querySelector('button[id$="-target"]');
    assert.ok(trigger);
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    const item = [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent === label);
    assert.ok(item, label);
    await act(async () => item.click());
  }
  async function change(selector, value) {
    await act(async () => {
      const field = document.querySelector(selector);
      assert.ok(field, selector);
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, value);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }

  await render(source);
  await act(async () => button("New task").click());
  await change('textarea[id$="-prompt"]', "Draft instructions");
  await change('input[id$="-name"]', "My task name");
  await choose(selected.label);
  await act(async () => button("Continue to task editor").click());
  assert.match(document.body.textContent, /Couldn't open the device/);
  assert.equal(receiveDeviceScheduleDraft(42, selected.id), undefined);
  await choose("Cloud");
  assert.equal(document.querySelector('textarea[id$="-prompt"]').value, "Draft instructions");
  assert.equal(document.querySelector('input[id$="-name"]').value, "My task name");

  await choose(selected.label);
  await act(async () => button("Continue to task editor").click());
  assert.ok(button("Continue to task editor"), "the source stays until the device receives the draft");
  assert.equal(receiveDeviceScheduleDraft(42, "other-device"), undefined);
  await render(source, destination(99), destination(42, true));
  assert.equal(arrived, undefined, "other accounts and sidebar previews cannot consume the draft");
  await render(source, destination(42, false, { ...device, targetId: "other-device" }));
  let resolveDeviceRead;
  const deviceRead = new Promise((resolve) => { resolveDeviceRead = resolve; });
  await render(source, destination(42, false, { ...device, list: () => deviceRead }));
  assert.equal(arrived, undefined, "the previous device snapshot cannot admit the new editor");
  await act(async () => resolveDeviceRead(await device.list()));
  assert.equal(arrived.name, "My task name");
  assert.equal(arrived.prompt, "Draft instructions");
  assert.equal(arrived.target, selected.label);
  assert.equal(arrived.timeZone, "Asia/Hong_Kong");
  assert.equal(receiveDeviceScheduleDraft(42, selected.id), undefined);
  assert.equal(button("Continue to task editor"), undefined);

  const { CronTaskModal } = env.loadModule("../../agent-ui/src/pages/settings/CronTaskModal.tsx");
  const { LocaleContext, t: translate } = env.loadModule("../../agent-ui/src/i18n/index.ts");
  let devicePreviewReads = 0;
  let closed = 0;
  await render(React.createElement(LocaleContext.Provider, {
    key: "actual-device-editor",
    value: { locale: "en-US", t: (key) => translate(key, "en-US") },
  }, React.createElement(CronTaskModal, {
    mode: "add", executionMode: "text", workspaceOptions: [], providers: [],
    modelOptions: [{ value: "fixture::fixture", label: "Fixture", providerId: "fixture", providerName: "Fixture" }],
    workbench: { ...arrived, modelValue: "fixture::fixture", preview: async () => {
      devicePreviewReads++;
      return { status: "valid", nextAt: Date.now() + 3600_000, utcOffsetSeconds: 28800, timeZone: arrived.timeZone };
    } },
    onSave: () => assert.fail("a text-mode device cannot create the transferred prompt"),
    onClose: () => { closed++; },
  })));
  assert.equal(document.querySelector('textarea[aria-label="Task instructions"]').value, "Draft instructions");
  assert.ok([...document.querySelectorAll('input')].some((input) => input.value === "My task name"));
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Agent Mode/);
  await env.waitFor(() => !dialog.textContent.includes("Calculating"), "confirmed device preview");
  assert.equal(button("Create").disabled, true);
  const prompt = dialog.querySelector('textarea[aria-label="Task instructions"]');
  const preview = dialog.querySelector('[role="status"]')?.textContent;
  const confirm = () => document.querySelector('[role="alertdialog"][data-open]');
  await act(async () => button("Cancel").click());
  assert.match(confirm().textContent, /Discard task changes/);
  assert.equal(closed, 0, "a transferred draft is already unsaved before further edits");
  await act(async () => button("Keep editing").click());
  assert.equal(confirm(), null);
  assert.equal(dialog.querySelector('textarea[aria-label="Task instructions"]'), prompt);
  assert.equal(prompt.value, "Draft instructions");
  assert.equal(dialog.querySelector('[role="status"]')?.textContent, preview);
  assert.equal(devicePreviewReads, 1);
  await act(async () => dialog.querySelector('button[aria-label="Close"]').click());
  assert.ok(confirm());
  await act(async () => button("Discard changes").click());
  assert.equal(closed, 1);
});
