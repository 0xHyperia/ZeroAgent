import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("layout and execution controls vary independently, and cloud capability restrictions cannot be widened by visibility", async () => {
  const env = await createDomTestEnv();
  try {
    const { resolveComposerPresentation, resolveComposerControls, CLOUD_COMPOSER_CAPABILITIES, DEVICE_COMPOSER_CAPABILITIES } = env.loadModule("@liveagent/ui/contracts/composerPresentation.ts");
    for (const presentation of ["pane", "column"]) {
      for (const surface of ["desktop", "web"]) {
        assert.equal(resolveComposerPresentation({ presentation, surface }), presentation);
        const cloud = resolveComposerControls(CLOUD_COMPOSER_CAPABILITIES, { executionControls: true, gitControls: true });
        assert.equal(cloud.executionControls, false);
        assert.equal(cloud.gitControls, false);
        assert.equal(CLOUD_COMPOSER_CAPABILITIES.workspaceFolders, false);
        const device = resolveComposerControls(DEVICE_COMPOSER_CAPABILITIES, { gitControls: false });
        assert.equal(device.executionControls, true);
        assert.equal(device.gitControls, false);
        assert.equal(DEVICE_COMPOSER_CAPABILITIES.workspaceFolders, true);
      }
    }
    assert.equal(resolveComposerPresentation({ surface: "desktop" }), "pane");
    assert.equal(resolveComposerPresentation({ surface: "web" }), "column");
  } finally { env.cleanup(); }
});

for (const profile of [
  { name: "desktop local", layout: "panels", navigation: "portal" },
  { name: "desktop remote", layout: "panels", navigation: "portal" },
  { name: "Web remote", layout: "panels", navigation: "portal" },
  { name: "Web CloudChat", layout: "page", navigation: "external" },
  { name: "mobile CloudChat", layout: "page", navigation: "external" },
]) {
  test(`${profile.name}: settings reuse one rail and preserve the mounted draft, selection and scroll container`, async () => {
    const env = await createDomTestEnv();
    const { React, act } = env;
    const { WorkbenchShell, WorkbenchBody, WorkbenchCanvas } = env.loadModule("@liveagent/ui/application/WorkbenchShell.tsx");
    const { SettingsWorkspace } = env.loadModule("@liveagent/ui/application/SettingsWorkspace.tsx");
    const { WorkbenchNavigationMount } = env.loadModule("@liveagent/ui/application/WorkbenchNavigationMount.tsx");
    const container = document.body.appendChild(document.createElement("div"));
    const root = env.createRoot(container);
    let toggle;
    let draftMounts = 0;
    function Draft() {
      React.useEffect(() => { draftMounts++; }, []);
      return React.createElement("textarea", { defaultValue: "保留输入与选区", "data-draft": "" });
    }
    function Harness() {
      const [open, setOpen] = React.useState(false);
      const [target, setTarget] = React.useState(null);
      toggle = setOpen;
      const rail = React.createElement("nav", { "data-owned-rail": "" }, React.createElement("button", { onClick: () => setOpen(!open) }, "设置"));
      const workspace = React.createElement(WorkbenchShell, { layout: profile.layout, "data-background": "", inert: open || undefined, hidden: profile.navigation === "external" && open },
        React.createElement(WorkbenchNavigationMount, { target: profile.navigation === "portal" ? target : null }, profile.navigation === "portal" ? rail : null),
        React.createElement(profile.layout === "page" ? WorkbenchCanvas : WorkbenchBody, null,
          React.createElement("div", { "data-scroller": "" }, React.createElement(Draft))));
      return React.createElement(React.Fragment, null,
        profile.navigation === "external" ? rail : null,
        workspace,
        open ? React.createElement(SettingsWorkspace, { navigation: profile.navigation, navigationRef: setTarget }, React.createElement("p", null, "设置内容")) : null);
    }
    try {
      await act(async () => root.render(React.createElement(Harness)));
      const editor = container.querySelector("[data-draft]");
      const scroller = container.querySelector("[data-scroller]");
      editor.value = "原草稿继续编辑";
      editor.setSelectionRange(1, 4);
      scroller.scrollTop = 123;
      for (let round = 0; round < 3; round++) {
        await act(async () => toggle(true));
        assert.equal(container.querySelectorAll("[data-owned-rail]").length, 1);
        assert.equal(container.querySelector("[data-owned-rail]").closest("[inert]"), null);
        assert.ok(container.querySelector("[data-background]").hasAttribute("inert"));
        assert.equal(container.querySelector("[data-draft]"), editor);
        assert.equal(editor.value, "原草稿继续编辑");
        assert.equal(editor.selectionStart, 1);
        assert.equal(editor.selectionEnd, 4);
        assert.equal(container.querySelectorAll("[data-navigation-rail-placeholder]").length, profile.navigation === "portal" ? 1 : 0);
        await act(async () => toggle(false));
        assert.equal(container.querySelector("[data-draft]"), editor);
        assert.equal(container.querySelector("[data-scroller]"), scroller);
        assert.equal(scroller.scrollTop, 123);
        assert.equal(container.querySelectorAll("[data-owned-rail]").length, 1);
        assert.equal(container.querySelector("[data-background]").hasAttribute("inert"), false);
      }
      assert.equal(draftMounts, 1);
      assert.equal(container.querySelector("[data-settings-workspace]"), null);
    } finally { await act(async () => root.unmount()); container.remove(); env.cleanup(); }
  });
}
