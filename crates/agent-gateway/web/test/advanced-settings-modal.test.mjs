import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test("advanced actions open above the current workspace and preserve the settings destination", async () => {
  const env = await createWebDomTestEnv();
  window.matchMedia = () => ({ matches: false });
  const { useGatewaySettingsOverlay } = env.loadModule("src/app/hooks/useGatewaySettingsOverlay.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  let state;
  const sidebar = [];
  const setSidebar = open => sidebar.push(open);
  function Harness() {
    state = useGatewaySettingsOverlay(setSidebar);
    return env.React.createElement("textarea", { defaultValue: "保留当前输入" });
  }
  try {
    await env.act(async () => root.render(env.React.createElement(Harness)));
    for (const action of ["model-preferences", "image-studio"]) {
      await env.act(async () => state.openSettings(action));
      assert.equal(state.modelPreferencesOpen, true);
      assert.equal(state.settingsOpen, false, "an advanced action must not open a settings page");
      assert.equal(state.settingsSection, "system");
      await env.act(async () => state.setModelPreferencesOpen(false));
      assert.equal(host.querySelector("textarea").value, "保留当前输入");
    }
    await env.act(async () => state.openSettings("providers", "relay-7"));
    assert.equal(state.settingsOpen, true);
    await env.act(async () => state.openSettings("model-preferences"));
    assert.equal(state.settingsSection, "providers");
    assert.equal(state.settingsProviderId, "relay-7");
    await env.act(async () => state.setModelPreferencesOpen(false));
    assert.equal(state.settingsOpen, true, "closing advanced settings leaves the provider page open");
    await env.act(async () => state.openSettings("image-studio"));
    await env.act(async () => state.resetSettingsOverlay());
    assert.equal(state.modelPreferencesOpen, false, "identity reset also closes the old device modal");
    assert.equal(state.settingsOpen, false);
  } finally {
    await env.act(async () => root.unmount());
    env.cleanup();
  }
});

test("settings registry contains neither new category and its provider action opens advanced settings", async () => {
  const env = await createWebDomTestEnv();
  const { createSettingsExtension } = env.loadModule("src/agent-ui-adapters/settingsExtension.tsx");
  let opened = 0;
  const props = { settings: {}, relayUser: { id: 7 }, onOpenModelPreferences: () => opened++ };
  try {
    for (const runtimeKind of ["web_chat", "device_agent"]) {
      const extension = createSettingsExtension({ ...props, runtimeKind });
      assert.equal(extension.sections.some(section => ["model-preferences", "image-studio"].includes(section.id)), false);
      extension.renderProviders().props.onOpenModelPreferences();
    }
    assert.equal(opened, 2);
  } finally { env.cleanup(); }
});


test("advanced modal keeps the user's settings font scale and closes with Escape", async () => {
  const env = await createWebDomTestEnv();
  const { ProviderSettingsDialog } = env.loadModule("@liveagent/ui/pages/settings/ProvidersSection.tsx");
  const host = document.body.appendChild(document.createElement("div")), root = env.createRoot(host);
  let closed = 0;
  function Harness() {
    const [open, setOpen] = env.React.useState(true);
    return open ? env.React.createElement(ProviderSettingsDialog, {
      settings: { customSettings: { fontScale: { settings: 1.15 } } },
      setSettings() {}, providerType: "codex", content: env.React.createElement("p", null, "配置内容"),
      onClose() { closed++; setOpen(false); },
    }) : null;
  }
  try {
    await env.act(async () => root.render(env.React.createElement(Harness)));
    const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
    assert.equal(dialog.style.getPropertyValue('--zone-font-scale'), '1.15');
    assert.match(dialog.textContent, /配置内容/);
    await env.act(async () => dialog.dispatchEvent(new window.KeyboardEvent('keydown', {key:'Escape',bubbles:true})));
    assert.equal(closed, 1); assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await env.act(async () => root.unmount()); env.cleanup(); }
});
