import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("Android Back closes a nested popup before its sheet, including with a floating IME", async () => {
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
  } });
  const { React, act, createRoot } = env;
  const { Sheet, SheetContent, SheetTitle } = env.loadModule("@liveagent/ui/components/ui/sheet.tsx");
  const { Popover, PopoverTrigger, PopoverContent } = env.loadModule("@liveagent/ui/components/ui/popover.tsx");
  const { handleMobileBack } = env.loadModule("@/lib/mobileRuntime.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  let taskBacks = 0;
  window.__ZEROAGENT_ANDROID__ = { moveTaskToBack: () => taskBacks++ };
  function App() {
    const [sheet, setSheet] = React.useState(true);
    return React.createElement(Sheet, { open: sheet, onOpenChange: setSheet },
      React.createElement(SheetContent, { showCloseButton: false, "aria-describedby": undefined, "data-slot": "sidebar", "data-mobile": "true" },
        React.createElement(SheetTitle, null, "导航"),
        React.createElement(Popover, null,
          React.createElement(PopoverTrigger, null, "模型"),
          React.createElement(PopoverContent, null, React.createElement("button", null, "当前模型")))));
  }
  try {
    await act(async () => { root.render(React.createElement(App)); await tick(); });
    await act(async () => { document.querySelector('[data-slot="popover-trigger"]').click(); await tick(); });
    assert.ok(document.querySelector('[data-slot="popover-content"][data-open]'));
    document.documentElement.dataset.zeroagentKeyboard = "open";
    await act(async () => { handleMobileBack(); await tick(); });
    assert.equal(document.querySelector('[data-slot="popover-content"][data-open]'), null);
    assert.ok(document.querySelector('[data-slot="sidebar"][data-open]'));
    assert.equal(taskBacks, 0);
    await act(async () => { handleMobileBack(); await tick(); });
    assert.equal(document.querySelector('[data-slot="sidebar"][data-open]'), null);
    assert.equal(taskBacks, 0);
    document.documentElement.dataset.zeroagentKeyboard = "closed";
    handleMobileBack();
    assert.equal(taskBacks, 1);
  } finally {
    await act(async () => root.unmount()); host.remove(); env.cleanup();
  }
});

test("Android Back respects a modal close guard and never falls through to page navigation", async () => {
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
  } });
  const { React, act, createRoot } = env;
  const { Dialog, DialogContent, DialogTitle } = env.loadModule("@liveagent/ui/components/ui/dialog.tsx");
  const { handleMobileBack } = env.loadModule("@/lib/mobileRuntime.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  let taskBacks = 0, pageBacks = 0, closeAttempts = 0;
  window.__ZEROAGENT_ANDROID__ = { moveTaskToBack: () => taskBacks++ };
  const pageBack = () => pageBacks++;
  window.addEventListener("zeroagent:mobile-back", pageBack);
  try {
    await act(async () => {
      root.render(React.createElement(Dialog, { open: true, onOpenChange: (open, details) => {
        if (!open) { closeAttempts++; details.cancel(); }
      } }, React.createElement(DialogContent, { "aria-describedby": undefined }, React.createElement(DialogTitle, null, "正在保存"))));
      await tick();
    });
    await act(async () => { handleMobileBack(); await tick(); });
    assert.equal(closeAttempts, 1);
    assert.ok(document.querySelector('[data-slot="dialog-content"][data-open]'));
    assert.equal(pageBacks, 0); assert.equal(taskBacks, 0);
  } finally {
    window.removeEventListener("zeroagent:mobile-back", pageBack);
    await act(async () => root.unmount()); host.remove(); env.cleanup();
  }
});

test("Android Back dismisses a menu in a navigation sheet even when focus stays on its trigger", async () => {
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
  } });
  const { React, act, createRoot } = env;
  const { Sheet, SheetContent, SheetTitle } = env.loadModule("@liveagent/ui/components/ui/sheet.tsx");
  const { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } = env.loadModule("@liveagent/ui/components/ui/dropdown-menu.tsx");
  const { handleMobileBack } = env.loadModule("@/lib/mobileRuntime.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  let taskBacks = 0;
  window.__ZEROAGENT_ANDROID__ = { moveTaskToBack: () => taskBacks++ };
  function App() {
    const [sheet, setSheet] = React.useState(true);
    return React.createElement(Sheet, { open: sheet, onOpenChange: setSheet },
      React.createElement(SheetContent, { showCloseButton: false, "aria-describedby": undefined, "data-slot": "sidebar", "data-mobile": "true" },
        React.createElement(SheetTitle, null, "导航"),
        React.createElement(DropdownMenu, { modal: false },
          React.createElement(DropdownMenuTrigger, { "aria-label": "更多" }, "更多"),
          React.createElement(DropdownMenuContent, null,
            React.createElement(DropdownMenuItem, null, "修改标题")))));
  }
  try {
    await act(async () => { root.render(React.createElement(App)); await tick(); });
    const trigger = document.querySelector('[aria-label="更多"]');
    await act(async () => { trigger.click(); await tick(); trigger.focus(); });
    assert.ok(document.querySelector('[role="menu"][data-open]'));
    await act(async () => { handleMobileBack(); await tick(); });
    assert.equal(document.querySelector('[role="menu"][data-open]'), null);
    assert.ok(document.querySelector('[data-slot="sidebar"][data-open]'));
    assert.equal(taskBacks, 0);
    await act(async () => { trigger.click(); await tick(); document.activeElement?.blur(); });
    assert.ok(document.querySelector('[role="menu"][data-open]'));
    await act(async () => { handleMobileBack(); await tick(); });
    assert.equal(document.querySelector('[role="menu"][data-open]'), null);
    assert.ok(document.querySelector('[data-slot="sidebar"][data-open]'));
    assert.equal(taskBacks, 0);
  } finally { await act(async () => root.unmount()); host.remove(); env.cleanup(); }
});

test("Android Back blurs the keyboard without losing a draft, then delegates to its page", async () => {
  const env = await createWebDomTestEnv();
  const { handleMobileBack, MOBILE_BACK_EVENT } = env.loadModule("@/lib/mobileRuntime.ts");
  let taskBacks = 0, pageBacks = 0;
  window.__ZEROAGENT_ANDROID__ = { moveTaskToBack: () => taskBacks++ };
  const field = document.body.appendChild(document.createElement("textarea"));
  const pageBack = (event) => { pageBacks++; event.preventDefault(); };
  try {
    field.value = "未发送的中文草稿"; field.focus();
    document.documentElement.dataset.zeroagentKeyboard = "open";
    window.addEventListener(MOBILE_BACK_EVENT, pageBack);
    handleMobileBack();
    assert.notEqual(document.activeElement, field);
    assert.equal(field.value, "未发送的中文草稿"); assert.equal(pageBacks, 0);
    document.documentElement.dataset.zeroagentKeyboard = "closed";
    handleMobileBack();
    assert.equal(pageBacks, 1); assert.equal(taskBacks, 0);
    window.removeEventListener(MOBILE_BACK_EVENT, pageBack);
    handleMobileBack(); assert.equal(taskBacks, 1);
  } finally {
    window.removeEventListener(MOBILE_BACK_EVENT, pageBack); field.remove(); env.cleanup();
  }
});

test("the upstream Tauri back listener delegates to the active page even when WebView history exists", async () => {
  const env = await createWebDomTestEnv();
  let upstreamBack, registrations = 0, removals = 0, pages = 0, taskBacks = 0;
  window.__TAURI__ = { app: { onBackButtonPress: async (handler) => {
    registrations++; upstreamBack = handler; return { unregister: async () => { removals++; } };
  } } };
  window.__ZEROAGENT_ANDROID__ = { moveTaskToBack: () => taskBacks++ };
  const { installMobileBackBridge, MOBILE_BACK_EVENT } = env.loadModule("@/lib/mobileRuntime.ts");
  const pageBack = (event) => { pages++; event.preventDefault(); };
  try {
    await installMobileBackBridge();
    assert.equal(registrations, 1);
    window.addEventListener(MOBILE_BACK_EVENT, pageBack);
    upstreamBack({ canGoBack: true });
    assert.equal(pages, 1); assert.equal(taskBacks, 0);
    window.removeEventListener(MOBILE_BACK_EVENT, pageBack);
    upstreamBack({ canGoBack: false }); assert.equal(taskBacks, 1);
    window.dispatchEvent(new Event("pagehide"));
    assert.equal(removals, 1);
  } finally {
    window.removeEventListener(MOBILE_BACK_EVENT, pageBack); env.cleanup();
  }
});
