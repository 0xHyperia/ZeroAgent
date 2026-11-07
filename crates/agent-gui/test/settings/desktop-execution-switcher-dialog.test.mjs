import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("device confirmation uses the shared top-level modal outside header and composer stacking contexts", async () => {
  const icons = new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url).pathname;
  const env = await createDomTestEnv({ mocks: { [icons]: new Proxy({}, { get: () => () => null }) } });
  const { React, act, createRoot } = env;
  HTMLElement.prototype.getAnimations = () => [];
  const { DesktopExecutionSwitcher } = env.loadModule("src/components/DesktopExecutionSwitcher.tsx");
  const shell = document.body.appendChild(document.createElement("div"));
  const header = shell.appendChild(document.createElement("header"));
  header.style.cssText = "position:relative;z-index:20";
  const composer = shell.appendChild(document.createElement("textarea"));
  composer.style.cssText = "position:relative;z-index:50";
  composer.setAttribute("aria-label", "聊天输入框");
  const root = createRoot(header);
  const local = { runtime_kind: "device_agent", device_id: "local", name: "Local", online: true, workspaces: [] };
  const remote = { ...local, device_id: "remote", name: "Remote" };
  const switches = [];
  let finish;
  let fail = false;
  const props = { environments: [local, remote], localDeviceId: "local", selectedDeviceId: "local", onSwitch: async (device) => {
    switches.push(device.device_id);
    if (fail) throw new Error("synthetic switch failure");
    return new Promise((resolve) => { finish = resolve; });
  } };
  const click = (node) => act(async () => node.click());
  const open = async () => {
    await click(header.querySelector("button[aria-expanded]"));
    await click([...header.querySelectorAll("button")].find((button) => button.textContent.includes("Remote")));
  };
  const button = (label) => [...document.querySelectorAll('[role="dialog"] button')].find((node) => node.textContent.trim() === label);
  try {
    await act(async () => root.render(React.createElement(DesktopExecutionSwitcher, props)));
    await open();
    const popup = document.querySelector('[role="dialog"]');
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    const viewport = document.querySelector('[data-slot="dialog-viewport"]');
    assert.ok(popup && overlay && viewport, "shared Dialog owns all modal layers");
    assert.equal(shell.contains(popup), false);
    assert.equal(shell.contains(overlay), false, "overlay must escape the entire workbench stacking context");
    assert.ok(overlay.classList.contains("layer-modal"));
    assert.ok(overlay.classList.contains("fixed") && overlay.classList.contains("inset-0"));
    assert.ok(viewport.classList.contains("layer-modal"));
    assert.equal(document.getElementById(popup.getAttribute("aria-labelledby")).textContent, "确认切换设备");
    assert.ok(popup.contains(document.activeElement), "shared modal moves keyboard focus inside");
    await click(button("取消"));
    assert.deepEqual(switches, []);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await open();
    await click(button("确认切换"));
    assert.deepEqual(switches, ["remote"]);
    assert.equal(button("取消").disabled, true);
    assert.equal(document.querySelector('[data-slot="dialog-close-button"]').disabled, true);
    await act(async () => finish());
    assert.equal(document.querySelector('[role="dialog"]'), null);
    fail = true;
    await open();
    await click(button("确认切换"));
    assert.equal(document.querySelector('[role="alert"]').textContent, "synthetic switch failure");
    assert.equal(button("确认切换").disabled, false);
    await click(button("取消"));
  } finally {
    await act(async () => root.unmount()); shell.remove(); env.cleanup();
  }
});
