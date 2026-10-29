import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function setup(t) {
  const icons = new Proxy({}, { get: () => () => null });
  const env = await createWebDomTestEnv({ mocks: { "@liveagent/ui/components/IconSet": icons } });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); });
  return { env, host, async render(node) { await env.act(async () => { root.render(node); await tick(); }); } };
}

test("tooltip button keeps one real control, its ref and click handler, with no native title", async (t) => {
  const app = await setup(t);
  const { TooltipButton } = app.env.loadModule("../../agent-ui/src/components/ui/tooltip-button.tsx");
  let clicked = 0;
  const ref = { current: null };
  await app.render(app.env.React.createElement(TooltipButton, { ref, title: "对话历史", "aria-label": "对话历史", onClick: () => clicked++ }, "历史"));
  const button = app.host.querySelector("button");
  assert.equal(app.host.querySelectorAll("button").length, 1);
  assert.equal(button.parentElement, app.host, "tooltip composition must not add a layout wrapper");
  assert.equal(button.getAttribute("title"), null);
  assert.equal(ref.current, button);
  await app.env.act(async () => { button.click(); await tick(); });
  assert.equal(clicked, 1);
});

test("pointer hover observes the opening delay and leaving dismisses the hint", async (t) => {
  const app = await setup(t);
  const { TooltipButton } = app.env.loadModule("../../agent-ui/src/components/ui/tooltip-button.tsx");
  await app.render(app.env.React.createElement(TooltipButton, { title: "设备", "aria-label": "设备" }, "设备"));
  const button = app.host.querySelector("button");
  await app.env.act(async () => {
    button.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: false, relatedTarget: document.body }));
    button.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 20, clientY: 20 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  assert.equal(document.querySelector('[role="tooltip"]'), null);
  await app.env.act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  assert.match(document.querySelector('[role="tooltip"]').textContent, /设备/);
  await app.env.act(async () => {
    button.dispatchEvent(new window.MouseEvent("mouseleave", { bubbles: false, relatedTarget: document.body, clientX: 500, clientY: 500 }));
    document.body.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 500, clientY: 500 }));
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
  assert.equal(button.getAttribute("aria-describedby"), null);
});

test("copy feedback opens on the first click without requiring a preceding hover", async (t) => {
  const app = await setup(t);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
  const { CopyButton } = app.env.loadModule("../../agent-ui/src/components/ui/copy-button.tsx");
  await app.render(app.env.React.createElement(CopyButton, { value: "synthetic review text", label: "复制", copiedLabel: "已复制" }));
  await app.env.act(async () => { app.host.querySelector("button").click(); await tick(); });
  assert.match(document.querySelector('[role="tooltip"]').textContent, /已复制/);
  assert.equal(app.host.querySelector("button").getAttribute("title"), null);
});

test("keyboard focus reveals label, description and shortcut through aria-describedby; Escape dismisses", async (t) => {
  const app = await setup(t);
  const { TooltipButton } = app.env.loadModule("../../agent-ui/src/components/ui/tooltip-button.tsx");
  await app.render(app.env.React.createElement(TooltipButton, { title: "搜索会话", "aria-label": "搜索会话", "aria-describedby": "existing-help", tooltipDescription: "查找已保存的对话", tooltipShortcut: "Ctrl K" }, "搜索"));
  const button = app.host.querySelector("button");
  await app.env.act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    button.focus(); await tick();
  });
  const tooltip = document.querySelector('[role="tooltip"]');
  assert.ok(tooltip, document.body.innerHTML);
  assert.match(tooltip.textContent, /搜索会话.*Ctrl K.*查找已保存的对话/);
  assert.deepEqual(button.getAttribute("aria-describedby").split(/\s+/), ["existing-help", tooltip.id]);
  assert.ok(tooltip.classList.contains("app-tooltip-surface"));
  await app.env.act(async () => {
    button.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await tick();
  });
  assert.equal(button.getAttribute("aria-describedby"), "existing-help");
  assert.equal(document.activeElement, button);
});

test("a composed menu retains its own trigger behavior and suppresses the hint while expanded", async (t) => {
  const app = await setup(t);
  const { TooltipButton } = app.env.loadModule("../../agent-ui/src/components/ui/tooltip-button.tsx");
  const { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } = app.env.loadModule("../../agent-ui/src/components/ui/dropdown-menu.tsx");
  let selected = 0;
  const h = app.env.React.createElement;
  await app.render(h(DropdownMenu, null,
    h(DropdownMenuTrigger, { render: h(TooltipButton, { title: "添加资料", "aria-label": "添加资料" }) }, "添加"),
    h(DropdownMenuContent, null, h(DropdownMenuItem, { onClick: () => selected++ }, "从资料库添加"))));
  await app.env.act(async () => { app.host.querySelector("button").click(); await tick(); });
  assert.equal(app.host.querySelector("button").getAttribute("aria-expanded"), "true");
  assert.equal(document.querySelector('[role="tooltip"]:not([data-ending-style])'), null);
  const item = document.querySelector('[role="menuitem"]');
  assert.ok(item);
  await app.env.act(async () => { item.click(); await tick(); });
  assert.equal(selected, 1);
});

test("controlled legacy label tooltips preserve touch-style click ownership and remove duplicate titles", async (t) => {
  const app = await setup(t);
  const { LabelTooltip } = app.env.loadModule("../../agent-ui/src/components/ui/label-tooltip.tsx");
  let clicks = 0, closed = 0;
  const h = app.env.React.createElement;
  await app.render(h(LabelTooltip, { label: "上下文用量", open: true, closeOnClick: false, onOpenChange: () => closed++, render: h("button", { title: "旧原生提示", onClick: () => clicks++ }, "用量") }));
  assert.equal(app.host.querySelector("button").getAttribute("title"), null);
  await app.env.act(async () => { app.host.querySelector("button").click(); await tick(); });
  assert.equal(clicks, 1);
  assert.equal(closed, 0);
  assert.match(document.querySelector('[role="tooltip"]').textContent, /上下文用量/);
});
