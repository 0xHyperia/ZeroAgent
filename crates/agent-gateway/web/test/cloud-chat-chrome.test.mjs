import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function mount(t, path, name, props, compact = false) {
  const icons = new Proxy({}, { get: () => () => null });
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": icons,
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url))]: icons,
  } });
  window.matchMedia = () => ({ matches: compact, addEventListener() {}, removeEventListener() {} });
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  t.after(async () => { await env.act(async () => root.unmount()); container.remove(); env.cleanup(); });
  const Component = env.loadModule(path)[name];
  await env.act(async () => { root.render(env.React.createElement(Component, props)); await tick(); });
  return { env, async click(selector) { const target = document.querySelector(selector); assert.ok(target, selector); await env.act(async () => { target.click(); await tick(); }); } };
}

test("header menus expose resources and preserve disabled export without invoking an action", async (t) => {
  const resources = [], exports = [];
  const app = await mount(t, "src/components/cloudchat/CloudChatHeaderActions.tsx", "CloudChatHeaderActions", {
    onOpenResource: (value) => resources.push(value), onOpenModelLimits() {},
    modelLimitsDisabled: false, exportDisabled: true, onExport: (value) => exports.push(value),
  });
  await app.click('[aria-label="对话资料与项目"]');
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  assert.deepEqual(items.map((item) => item.textContent.trim()), ["文件库", "成果库", "来源资料", "项目", "记忆"]);
  await app.env.act(async () => { items[0].click(); await tick(); });
  assert.deepEqual(resources, ["files"]);
  await app.click('[aria-label="对话选项"]');
  const exportItem = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.trim() === "导出 JSON");
  assert.equal(exportItem.getAttribute("aria-disabled"), "true");
  await app.env.act(async () => { exportItem.click(); await tick(); });
  assert.deepEqual(exports, []);
});

for (const compact of [false, true]) {
  test(`resource panel uses ${compact ? "a narrow modal" : "an unobscured wide layout"} and keeps close reachable`, async (t) => {
    let closed = 0;
    const app = await mount(t, "src/components/cloudchat/CloudChatResourcePanel.tsx", "CloudChatResourcePanel", {
      title: "文件库", description: "账户资料", closeLabel: "关闭文件库", onClose: () => { closed++; }, children: "正式文件",
    }, compact);
    assert.ok(document.querySelector('[data-cloud-resource-panel]'));
    assert.equal(Boolean(document.querySelector('[data-slot="sheet-backdrop"]')), compact);
    assert.match(document.querySelector('[role="dialog"]').textContent, /文件库.*账户资料.*正式文件/s);
    if (!compact) {
      const outside = document.body.appendChild(document.createElement("button"));
      outside.textContent = "继续编辑对话";
      await app.env.act(async () => { outside.focus(); outside.click(); await tick(); });
      assert.equal(document.activeElement, outside);
      assert.equal(closed, 0, "wide resource work must survive returning to the conversation");
      outside.remove();
    }
    await app.click('[aria-label="关闭文件库"]');
    assert.equal(closed, 1);
  });
}

test("mobile header consolidates every resource into the options menu without losing its action", async (t) => {
  const resources = [];
  const app = await mount(t, "src/components/cloudchat/CloudChatHeaderActions.tsx", "CloudChatHeaderActions", {
    onOpenResource: (value) => resources.push(value), onOpenModelLimits() {},
    modelLimitsDisabled: false, exportDisabled: true, onExport() {},
  }, true);
  assert.equal(document.querySelector('[aria-label="对话资料与项目"]'), null);
  await app.click('[aria-label="对话选项"]');
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  assert.deepEqual(items.slice(0,5).map(item=>item.textContent.trim()), ["文件库", "成果库", "来源资料", "项目", "记忆"]);
  await app.env.act(async () => { items[0].click(); await tick(); });
  assert.deepEqual(resources,["files"]);
});
