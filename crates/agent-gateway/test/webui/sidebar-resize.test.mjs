import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";

async function setup(t, { saved, width: initialWidth = 1200, open = true, preview = false, settings = false, reader = false } = {}) {
  const env = await createWebDomTestEnv();
  let width = initialWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, get() { return width; } });
  document.documentElement.dataset.liveagentWebui = "gateway";
  const mediaListeners = new Set();
  window.matchMedia = query => ({
    get matches() { return query.includes("max-width") && width <= Number(query.match(/max-width:\s*(\d+)/)?.[1] ?? 0); },
    media: query, addEventListener: (_, listener) => mediaListeners.add(listener), removeEventListener: (_, listener) => mediaListeners.delete(listener),
  });
  Object.defineProperty(env.dom.window.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return width; } });
  if (reader) env.dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 800, width, height: 800, toJSON() {} };
  };
  const frames = new Map(); let frameId = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const storage = env.dom.window.localStorage;
  const model = env.loadModule("@liveagent/ui/lib/sidebar/width.ts");
  if (saved !== undefined) storage.setItem(model.SIDEBAR_WIDTH_STORAGE_KEY, String(saved));
  const { Sidebar, SidebarProvider, useSidebar } = env.loadModule("@liveagent/ui/components/ui/sidebar.tsx");
  const { SettingsWorkspace } = env.loadModule("@liveagent/ui/application/SettingsWorkspace.tsx");
  const { SettingsShell } = env.loadModule("@liveagent/ui/pages/settings/SettingsShell.tsx");
  const Reader = reader ? env.loadModule("@/components/cloudchat/CloudChatResourceWorkbench.tsx").CloudChatResourceWorkbench : null;
  const host = document.body.appendChild(document.createElement("div")), root = env.createRoot(host);
  let sidebar, mounted = true, draftMounts = 0;
  function Draft() {
    env.React.useEffect(() => { draftMounts++; }, []);
    return env.React.createElement("textarea", { defaultValue: "保留草稿和选区", "data-draft": "" });
  }
  function Content({ peek }) {
    sidebar = useSidebar();
    return env.React.createElement(env.React.Fragment, null,
      env.React.createElement(Sidebar, { label: "Navigation", previewOpen: peek }, env.React.createElement("button", null, "Conversation")),
      Reader ? env.React.createElement(Reader, { open: true, primaryVisible: true, onSplitAvailabilityChange() {}, readingScope: "test", primary: env.React.createElement(Draft) },
        env.React.createElement("div", { "data-reading-content": "" }, "Reading content")) : env.React.createElement(Draft));
  }
  const registry = { surface: "web", services: {}, slots: {}, settingsSections: [{ id: "system", labelKey: "settings.system", groupKey: "settings.title", groupOrder: 0, order: 0, icon: null, render: () => "Settings content" }] };
  const render = async (showSettings = settings, peek = preview) => env.act(async () => root.render(env.React.createElement(env.React.StrictMode, null,
    env.React.createElement(SidebarProvider, { defaultOpen: open },
      env.React.createElement(Content, { peek }),
      showSettings ? env.React.createElement(SettingsWorkspace, { navigation: "external" },
        env.React.createElement(SettingsShell, { registry, context: {}, saveState: { status: "idle" }, onBack() {} })) : null))));
  const handle = () => settings ? host.querySelector("[data-design-settings] [role=separator]") : host.querySelector(".sidebar-resize-handle");
  const pointer = async (type, x, id = 1, target = handle()) => env.act(async () => {
    if (type === "pointerdown") {
      const captures = new Set();
      target.setPointerCapture = value => captures.add(value);
      target.hasPointerCapture = value => captures.has(value);
      target.releasePointerCapture = value => captures.delete(value);
    }
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, button: 0 });
    Object.defineProperty(event, "pointerId", { value: id }); target.dispatchEvent(event);
  });
  const key = async (value, shiftKey = false) => env.act(async () => handle().dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })));
  const flush = async () => env.act(async () => { const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(); });
  const unmount = async () => { if (mounted) { await env.act(async () => root.unmount()); mounted = false; } };
  t.after(async () => { await unmount(); host.remove(); env.cleanup(); });
  await render();
  return { env, host, model, storage, handle, pointer, key, flush, render, unmount, get sidebar() { return sidebar; }, get draftMounts() { return draftMounts; }, get saved() { return storage.getItem(model.SIDEBAR_WIDTH_STORAGE_KEY); }, async resize(next) {
    await env.act(async () => { width = next; mediaListeners.forEach(listener => listener()); window.dispatchEvent(new Event("resize")); });
  } };
}

test("sidebar drag previews once per frame, commits on release and preserves the editor and selection", async t => {
  const app = await setup(t);
  const draft = app.host.querySelector("textarea"); draft.setSelectionRange(2, 5);
  const mounts = app.draftMounts, cookie = document.cookie;
  await app.pointer("pointerdown", 272);
  await app.pointer("pointermove", 320); await app.pointer("pointermove", 390);
  assert.equal(app.model.sidebarWidthStore.getSnapshot(), 272);
  await app.flush();
  assert.equal(app.host.querySelector("[data-slot=sidebar-wrapper]").style.getPropertyValue("--sidebar-width"), "390px");
  assert.equal(app.saved, null);
  assert.ok(document.querySelector(".sidebar-resize-shield"));
  await app.pointer("pointermove", 900); await app.pointer("pointerup", 900);
  assert.equal(app.saved, "440"); assert.equal(document.querySelector(".sidebar-resize-shield"), null);
  assert.equal(app.host.querySelector("textarea"), draft); assert.equal(draft.selectionStart, 2); assert.equal(draft.selectionEnd, 5);
  assert.equal(app.draftMounts, mounts); assert.equal(document.cookie, cookie);
  assert.equal(app.model.createSidebarWidthStore(() => app.storage).getSnapshot(), 440);
});

test("left and reader resets are independent and keep the live editor, reading content and scroll position", async t => {
  const app = await setup(t, { saved: 380, reader: true });
  const right = () => app.host.querySelector('[data-workbench-divider="cloud-reader"]');
  const pressRight = (key, shiftKey = false) => app.env.act(async () => right().dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })));
  const draft = app.host.querySelector("textarea"), content = app.host.querySelector("[data-reading-content]");
  draft.setSelectionRange(1, 4); content.scrollTop = 128;
  const mounts = app.draftMounts;
  assert.equal(right().getAttribute("aria-valuenow"), "44");
  assert.equal(right().getAttribute("aria-valuemin"), "27");
  assert.equal(right().getAttribute("aria-valuemax"), "65");
  await app.env.act(async () => app.handle().focus());
  assert.equal(app.saved, "380", "discovering the edge never resets it");
  await pressRight("ArrowRight"); await pressRight("ArrowRight");
  assert.equal(right().getAttribute("aria-valuenow"), "48");
  await app.env.act(async () => right().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  assert.equal(right().getAttribute("aria-valuenow"), "44", "reset restores the initial reader split, not an arbitrary equal split");
  assert.equal(app.saved, "380", "right reset does not touch the sidebar preference");
  await pressRight("ArrowRight"); await app.key("Enter");
  assert.equal(app.saved, "272"); assert.equal(right().getAttribute("aria-valuenow"), "46");
  await pressRight("Enter"); assert.equal(right().getAttribute("aria-valuenow"), "44");
  await pressRight("Home"); assert.equal(right().getAttribute("aria-valuenow"), "27");
  await pressRight("End"); assert.equal(right().getAttribute("aria-valuenow"), "65");
  await pressRight("Enter");
  await pressRight("ArrowLeft", true); assert.equal(right().getAttribute("aria-valuenow"), "36");
  for (const cancel of ["Escape", "pointercancel", "lostpointercapture", "blur"]) {
    await app.pointer("pointerdown", 430, 2, right());
    await app.pointer("pointermove", 660, 2, right());
    await app.flush();
    assert.equal(right().getAttribute("aria-valuenow"), "55");
    if (cancel === "Escape") await app.env.act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    else if (cancel === "blur") await app.env.act(async () => window.dispatchEvent(new Event("blur")));
    else await app.pointer(cancel, 660, 2, right());
    assert.equal(right().getAttribute("aria-valuenow"), "36", cancel);
    assert.equal(right().hasAttribute("data-resizing"), false);
  }
  await app.pointer("pointerdown", 430, 3, right());
  await app.pointer("pointermove", 660, 3, right());
  await app.pointer("pointerup", 660, 3, right());
  assert.equal(right().getAttribute("aria-valuenow"), "55", "release commits the most recent movement");
  assert.equal(app.host.querySelector("textarea"), draft); assert.equal(app.draftMounts, mounts);
  assert.equal(draft.value, "保留草稿和选区"); assert.equal(draft.selectionStart, 1); assert.equal(draft.selectionEnd, 4);
  assert.equal(app.host.querySelector("[data-reading-content]"), content); assert.equal(content.scrollTop, 128);
  assert.equal(app.sidebar.open, true);
});

test("Escape, pointer cancel, lost capture, blur and unmount roll back an unfinished drag without saving", async t => {
  const app = await setup(t, { saved: 320 });
  for (const cancel of ["Escape", "pointercancel", "lostpointercapture", "blur"]) {
    await app.pointer("pointerdown", 320); await app.pointer("pointermove", 410); await app.flush();
    assert.equal(app.model.sidebarWidthStore.getSnapshot(), 410);
    if (cancel === "Escape") await app.env.act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    else if (cancel === "blur") await app.env.act(async () => window.dispatchEvent(new Event("blur")));
    else await app.pointer(cancel, 410);
    assert.equal(app.model.sidebarWidthStore.getSnapshot(), 320, cancel); assert.equal(app.saved, "320");
    assert.equal(document.querySelector(".sidebar-resize-shield"), null);
  }
  await app.pointer("pointerdown", 320); await app.pointer("pointermove", 410); await app.flush();
  await app.unmount(); assert.equal(app.model.sidebarWidthStore.getSnapshot(), 320); assert.equal(app.saved, "320");
});

test("keyboard and double-click sizing obey adaptive bounds; narrowing does not replace the preferred width", async t => {
  const app = await setup(t, { saved: 400 });
  await app.key("ArrowLeft"); assert.equal(app.saved, "390");
  await app.key("ArrowRight", true); assert.equal(app.saved, "430");
  await app.key("Home"); assert.equal(app.saved, "240");
  await app.key("End"); assert.equal(app.saved, "440");
  await app.resize(900);
  assert.equal(app.handle().getAttribute("aria-valuenow"), "360"); assert.equal(app.saved, "440");
  await app.resize(1200); assert.equal(app.handle().getAttribute("aria-valuenow"), "440");
  await app.key("Enter"); assert.equal(app.saved, "272");
  await app.key("End"); await app.env.act(async () => app.handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  assert.equal(app.saved, "272");
});

test("collapsed hover preview has no resize handle; mobile sheet retains its own width and pinned state", async t => {
  const app = await setup(t, { saved: 400, open: false, preview: true });
  assert.equal(app.handle(), null); assert.equal(app.sidebar.open, false);
  assert.equal(app.host.querySelector("[data-slot=sidebar-wrapper]").style.getPropertyValue("--sidebar-width"), "400px");
  await app.env.act(async () => app.sidebar.setOpen(true)); assert.ok(app.handle());
  await app.resize(390); assert.equal(app.handle(), null);
  await app.env.act(async () => app.sidebar.setOpenMobile(true));
  const sheet = document.querySelector('[data-mobile="true"]'); assert.ok(sheet);
  assert.equal(sheet.style.getPropertyValue("--sidebar-width"), "min(86vw, 272px)");
  await app.env.act(async () => app.sidebar.setOpenMobile(false));
  await app.resize(1200); assert.ok(app.handle()); assert.equal(app.saved, "400"); assert.equal(app.sidebar.open, true);
});

test("real settings navigation shares the chat width without remounting the hidden draft", async t => {
  const app = await setup(t, { saved: 330, settings: true });
  const draft = app.host.querySelector("textarea"), mounts = app.draftMounts;
  assert.equal(app.host.querySelector("[data-settings-workspace]").style.getPropertyValue("--sidebar-width"), "330px");
  await app.key("ArrowRight"); assert.equal(app.saved, "340");
  assert.equal(app.host.querySelector("[data-slot=sidebar-wrapper]").style.getPropertyValue("--sidebar-width"), "340px");
  await app.render(false); assert.equal(app.host.querySelector("textarea"), draft); assert.equal(app.draftMounts, mounts);
  await app.render(true); await app.resize(800);
  assert.equal(app.host.querySelector("[data-design-settings] .sidebar-resize-handle"), null);
  assert.equal(app.saved, "340");
});

test("width storage is bounded, accepts cross-tab changes and remains usable when storage is blocked", async t => {
  const app = await setup(t, { saved: "broken" });
  assert.equal(app.model.sidebarWidthStore.getSnapshot(), 272);
  await app.env.act(async () => window.dispatchEvent(new app.env.dom.window.StorageEvent("storage", { key: app.model.SIDEBAR_WIDTH_STORAGE_KEY, newValue: "380" })));
  assert.equal(app.handle().getAttribute("aria-valuenow"), "380");
  const memory = app.model.createSidebarWidthStore(() => { throw new Error("Storage denied"); });
  assert.equal(memory.getSnapshot(), 272); memory.set(350, true); assert.equal(memory.getSnapshot(), 350);
  memory.set(Number.NaN, true); assert.equal(memory.getSnapshot(), 272);
  memory.set(9999); assert.equal(memory.getSnapshot(), 440);
  assert.deepEqual(app.model.sidebarWidthBounds(900), { min: 240, max: 360 });
});
