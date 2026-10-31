import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("reading expansion and actual-canvas resizing preserve the draft, resource and focus return", async (t) => {
  const icons = new Proxy({}, { get: () => () => null });
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": icons,
  } });
  let width = 1400;
  const observers = new Set();
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains("cloud-resource-workbench")
      ? { width, height: 800, top: 0, left: 0, right: width, bottom: 800 }
      : originalRect.call(this);
  };
  const OriginalObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe(element) { if (element.classList.contains("cloud-resource-workbench")) observers.add(this.callback); }
    disconnect() { observers.delete(this.callback); }
  };
  const { CloudChatResourceWorkbench } = env.loadModule("src/components/cloudchat/CloudChatResourceWorkbench.tsx");
  const { CloudChatResourcePanel, CloudChatResourcePresentation } = env.loadModule("src/components/cloudchat/CloudChatResourcePanel.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  t.after(async () => {
    await env.act(async () => root.unmount());
    window.HTMLElement.prototype.getBoundingClientRect = originalRect;
    globalThis.ResizeObserver = OriginalObserver;
    host.remove(); env.cleanup();
  });
  const h = env.React.createElement;
  function App() {
    const [open, setOpen] = env.React.useState(false);
    return h(CloudChatResourceWorkbench, {
      open, primaryVisible: true,
      primary: h("div", null,
        h("input", { "aria-label": "草稿", defaultValue: "已有草稿" }),
        h("button", { onClick: () => setOpen(true) }, "打开资料")),
    }, open && h(CloudChatResourcePresentation.Provider, { value: "inline" },
      h(CloudChatResourcePanel, { title: "方案.docx", description: "文档", onClose: () => setOpen(false),
        headerActions: h("button", { onClick: () => {
          setOpen(false);
          requestAnimationFrame(() => host.querySelector('[aria-label="草稿"]').focus());
        } }, "继续处理"),
      },
        h("input", { "aria-label": "阅读位置", defaultValue: "第二页" }))));
  }
  await env.act(async () => { root.render(h(App)); await tick(); });
  const draft = host.querySelector('[aria-label="草稿"]');
  draft.value = "不要丢失的草稿";
  const trigger = [...host.querySelectorAll("button")].find((button) => button.textContent === "打开资料");
  trigger.focus();
  await env.act(async () => { trigger.click(); await tick(); });
  const reader = host.querySelector('[aria-label="阅读位置"]');
  const primary = host.querySelector(".cloud-workspace-primary");
  assert.equal(primary.hidden, false);
  assert.equal(host.querySelector('[role="dialog"]'), null, "wide reading must not trap the conversation");
  assert.equal(document.activeElement.getAttribute("aria-label"), "关闭资料面板");
  await env.act(async () => { host.querySelector('[aria-label="展开阅读"]').click(); await tick(); });
  assert.equal(primary.hidden, true);
  assert.equal(primary.hasAttribute("inert"), true);
  assert.equal(host.querySelector('[aria-label="阅读位置"]'), reader);
  await env.act(async () => { host.querySelector('[aria-label="恢复并排阅读"]').click(); await tick(); });
  assert.equal(primary.hidden, false);
  await env.act(async () => { width = 720; for (const notify of observers) notify(); await tick(); });
  assert.equal(primary.hidden, true, "uses the remaining workbench width, not window width");
  assert.equal(host.querySelector('[aria-label="阅读位置"]'), reader);
  await env.act(async () => { width = 1400; for (const notify of observers) notify(); await tick(); });
  assert.equal(primary.hidden, false);
  await env.act(async () => { host.querySelector('[aria-label="关闭资料面板"]').click(); await tick(); });
  assert.equal(host.querySelector('[aria-label="草稿"]'), draft);
  assert.equal(draft.value, "不要丢失的草稿");
  await env.act(async () => { await new Promise(requestAnimationFrame); });
  assert.equal(document.activeElement, trigger, "ordinary close returns to the original file row");
  await env.act(async () => { trigger.click(); await tick(); });
  await env.act(async () => {
    [...host.querySelectorAll("button")].find((button) => button.textContent === "继续处理").click();
    await tick();
  });
  await env.act(async () => { await new Promise(requestAnimationFrame); });
  assert.equal(document.activeElement, draft, "explicit continuation focus wins over reader cleanup");
  assert.equal(observers.size, 1);
});
