import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("navigation skips closed file tabs and resets on a new or revoked device scope", async () => {
  const env = await createDomTestEnv();
  const { React, act, createRoot } = env;
  const { useNavigationHistory, workbenchNavigationLocation, parseNavigationLocation } =
    env.loadModule("@liveagent/ui/lib/navigation/navigationHistory.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const visits = [];
  const authorized = new Set();
  let controls;
  function Workbench({ scopeKey, location }) {
    controls = useNavigationHistory({
      scopeKey,
      location,
      isValid: (target) => authorized.has(target),
      navigate: (target) => visits.push(target),
    });
    return null;
  }
  const conversation = (id) => workbenchNavigationLocation({ activeView: "chat", conversationId: id, isDraft: false });
  const file = workbenchNavigationLocation({ activeView: "chat", conversationId: "a", isDraft: false, file: { projectPathKey: "repo:a", tabId: "docs:readme" } });
  const show = (scopeKey, location) => act(async () => root.render(React.createElement(Workbench, { scopeKey, location })));
  try {
    assert.deepEqual(parseNavigationLocation(file), { kind: "file", projectPathKey: "repo:a", tabId: "docs:readme" });
    for (const target of [conversation("a"), file, conversation("b")]) authorized.add(target);
    await show("device-a", conversation("a"));
    await show("device-a", file);
    await show("device-a", conversation("b"));
    assert.equal(controls.canGoBack, true);
    authorized.delete(file);
    await act(async () => assert.equal(controls.goBack(), true));
    assert.deepEqual(visits, [conversation("a")]);
    await show("device-a", conversation("a"));
    assert.equal(controls.canGoForward, true);
    await show(undefined, null);
    await show("device-a", conversation("a"));
    assert.equal(controls.canGoForward, false);
    await show("device-a", conversation("b"));
    await show("device-b", conversation("a"));
    assert.equal(controls.goBack(), false);
    assert.deepEqual(visits, [conversation("a")]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});

test("settings row search matches aliases and only indexes sections rendered by the host", () => {
  const { searchSettingsIndex } = createTsModuleLoader().loadModule(
    "@liveagent/ui/lib/settings/settingsSearchIndex.ts",
  );
  const t = (key) => ({ "settings.navSystem": "System", "settings.appearance": "Appearance" })[key] ?? key;
  const sections = [{ id: "system", labelKey: "settings.navSystem" }];
  assert.equal(searchSettingsIndex("dark SYSTEM", sections, t)[0]?.entry.anchor, "appearance");
  assert.deepEqual(searchSettingsIndex("speech microphone", sections, t), []);
  assert.deepEqual(searchSettingsIndex("   ", sections, t), []);
});

test("a device palette only offers its authorized settings and forwards the selected anchor", () => {
  const loader = createTsModuleLoader();
  const { getWorkbenchSettingsSections, shortcutCommandSettingsAnchor } = loader.loadModule(
    "@liveagent/ui/lib/settings/settingsSearchIndex.ts",
  );
  const { buildCommandPaletteActions } = loader.loadModule(
    "@liveagent/ui/lib/chat/commandPaletteActions.ts",
  );
  const calls = [];
  const actions = buildCommandPaletteActions({
    t: (key) => key,
    isMac: false,
    onOpenSettings: (section, anchor) => calls.push([section, anchor]),
    settingsSections: getWorkbenchSettingsSections({
      surface: "web",
      usage: true,
      devicePlugins: false,
      webSearch: true,
      permissions: false,
    }),
    settingsExcludedAnchors: [shortcutCommandSettingsAnchor("zoomIn")],
  });
  actions.find(({ id }) => id === "settings:system:appearance")?.run();
  actions.find(({ id }) => id === "settings:shortcuts")?.run();
  assert.deepEqual(calls, [["system", "appearance"], ["shortcuts", undefined]]);
  assert.equal(actions.some(({ id }) => /^settings:(remote|stt|permissions|about|devicePlugins)(:|$)/.test(id)), false);
  assert.equal(actions.some(({ id }) => id === "settings:shortcuts:shortcut-zoomIn"), false);
});

test("terminal shortcut can select the chooser without closing another tool", () => {
  const loader = createTsModuleLoader();
  const {
    activateRightDockTab,
    resolveTerminalToggle,
    RIGHT_DOCK_TERMINAL_LAUNCHER,
  } = loader.loadModule("@liveagent/ui/lib/chat/workbenchCommands.ts");
  const { resolveEffectiveActiveTabId } = loader.loadModule(
    "@liveagent/ui/components/project-tools/rightDockModel.ts",
  );
  const dock = { activeTabId: "tool:git-review", tabOrder: ["tool:git-review"] };
  const context = { tabOrder: dock.tabOrder, open: true, sessions: [] };
  assert.equal(resolveTerminalToggle({ ...context, activeTabId: dock.activeTabId }).kind, "open");
  const selected = activateRightDockTab(dock, RIGHT_DOCK_TERMINAL_LAUNCHER);
  assert.equal(selected.tabOrder, dock.tabOrder);
  assert.equal(resolveEffectiveActiveTabId(selected.activeTabId, dock.tabOrder, true), null);
  assert.equal(resolveTerminalToggle({ ...context, activeTabId: selected.activeTabId }).kind, "close");
});

test("a direct settings link reveals a late row on a narrow screen and focuses its control", async () => {
  const env = await createDomTestEnv();
  const { React, act, createRoot } = env;
  const { SidebarProvider } = env.loadModule("@liveagent/ui/components/ui/sidebar.tsx");
  const { SettingsShell } = env.loadModule("@liveagent/ui/pages/settings/SettingsShell.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const scrolled = [];
  const h = React.createElement;
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  env.dom.window.HTMLElement.prototype.getClientRects = () => [{}];
  env.dom.window.HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this.dataset.settingsAnchor);
  };
  const registry = {
    surface: "web",
    services: {},
    slots: {},
    settingsSections: [{
      id: "system",
      labelKey: "settings.navSystem",
      groupKey: "settings.groupGeneral",
      groupOrder: 10,
      order: 10,
      icon: null,
      render: (ready) => ready
        ? h("div", { "data-settings-anchor": "appearance" }, h("button", { id: "theme" }, "Theme"))
        : null,
    }],
  };
  const render = (ready) => act(async () => root.render(h(SidebarProvider, {}, h(SettingsShell, {
    registry,
    context: ready,
    saveState: { status: "idle" },
    initialSection: "system",
    initialAnchor: "appearance",
    onBack() {},
  }))));
  try {
    await render(false);
    assert.equal(host.querySelector("[data-design-settings]")?.dataset.mobileDetail, "true");
    assert.deepEqual(scrolled, []);
    await render(true);
    await act(async () => new Promise((resolve) => window.requestAnimationFrame(resolve)));
    assert.deepEqual(scrolled, ["appearance"]);
    assert.equal(document.activeElement?.id, "theme");
    assert.equal(host.querySelector("[data-settings-search-target]")?.dataset.settingsAnchor, "appearance");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
});
