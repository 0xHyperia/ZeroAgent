import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test("project appearance exposes localized option names and searches in both languages", async (t) => {
  const icons = new Proxy({}, { get: () => () => null });
  let isOpen;
  let onOpenChange;
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": icons,
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url))]: icons,
    // The JSDOM layout cannot position the floating layer. Exercise the picker's own controls.
    "@liveagent/ui/components/ui/popover": {
      Popover: ({ open, onOpenChange: setOpen, children }) => {
        isOpen = open;
        onOpenChange = setOpen;
        return children;
      },
      PopoverTrigger: ({ render, children }) =>
        env.React.cloneElement(render, { onClick: () => onOpenChange(true) }, children),
      PopoverContent: ({ children }) => isOpen ? env.React.createElement("div", null, children) : null,
    },
  } });
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  t.after(async () => { await env.act(async () => root.unmount()); env.cleanup(); });
  const { CloudProjectIconPicker, projectAppearanceLabel } = env.loadModule("src/components/cloudchat/CloudProjectIcon.tsx");
  const { LocaleContext, t: translate } = env.loadModule("../../agent-ui/src/i18n/index.ts");
  const changes = [];
  const render = (locale) => env.act(async () => root.render(env.React.createElement(LocaleContext.Provider, {
    value: { locale, t: (key) => translate(key, locale) },
  }, env.React.createElement(CloudProjectIconPicker, {
    icon: "folder", color: "blue", onChange: (next) => changes.push(next),
  }))));
  const byLabel = (label) => document.querySelector(`[aria-label="${label}"]`);

  await render("en-US");
  await env.act(async () => byLabel("Choose project icon and color").click());
  assert.equal(byLabel(projectAppearanceLabel("icon", "folder", "en-US")).getAttribute("aria-pressed"), "true");
  assert.equal(byLabel(projectAppearanceLabel("color", "blue", "en-US")).getAttribute("aria-pressed"), "true");
  const search = byLabel("Search icons");
  assert.equal(search.placeholder, "Search icons");
  const setSearch = async (value) => env.act(async () => {
    Object.getOwnPropertyDescriptor(search.constructor.prototype, "value").set.call(search, value);
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await setSearch("unmatched");
  assert.match(document.body.textContent, /No icons found/);
  await setSearch("PROGRAMMING 开发");
  assert.equal(byLabel("Project icon").querySelectorAll("button").length, 1);
  assert.ok(byLabel("Code"));

  await render("zh-CN");
  assert.equal(byLabel("搜索图标").value, "PROGRAMMING 开发");
  assert.equal(byLabel("蓝色").getAttribute("aria-pressed"), "true");
  await env.act(async () => byLabel(projectAppearanceLabel("icon", "code", "zh-CN")).click());
  assert.deepEqual(changes, [{ icon: "code", color: "blue" }]);
  assert.equal(byLabel("搜索图标"), null);
  assert.equal(projectAppearanceLabel("icon", "", "en-US"), "Folder");
  assert.equal(projectAppearanceLabel("color", "", "en-US"), "Default");
  assert.equal(projectAppearanceLabel("icon", "unrecognized", "en-US"), "unrecognized");
});
