import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
const env = await createDomTestEnv({ mocks: {
  "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
  "../IconSet": new Proxy({}, { get: () => () => null }),
  "../components/IconSet": new Proxy({}, { get: () => () => null }),
} });
const { React, act, createRoot } = env;
window.ResizeObserver = globalThis.ResizeObserver;
let mobile = false;
const mediaListeners = new Set();
window.matchMedia = () => ({ get matches() { return mobile; }, media: "", addEventListener: (_, listener) => mediaListeners.add(listener), removeEventListener: (_, listener) => mediaListeners.delete(listener) });
const { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } = env.loadModule("@liveagent/ui/components/ui/sidebar.tsx");
const { WorkbenchFeatureSidebar } = env.loadModule("@liveagent/ui/application/WorkbenchFeatureSidebar.tsx");

test("mobile feature navigation follows its page and closes its sheet without showing conversation history", async () => {
  mobile = true;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let setOpen;
  let selected = "skills-hub";
  function Content() {
    const sidebar = useSidebar();
    setOpen = sidebar.setOpenMobile;
    return React.createElement(WorkbenchFeatureSidebar, {
      activeView: selected, fontScale: 1.25,
      shortcuts: { skills: true, mcp: true, cron: false, planning: false, "image-studio": false, memory: false },
      onOpenResourceHub: value => { selected = `${value}-hub`; },
      onNewConversation() {},
    });
  }
  try {
    await act(async () => root.render(React.createElement(SidebarProvider, null, React.createElement(Content))));
    await act(async () => setOpen(true));
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.querySelector('[aria-current="page"]').textContent, /Skills/);
    assert.equal(dialog.querySelector(".chat-history-row"), null);
    const buttons = Array.from(dialog.querySelectorAll("button"));
    assert.equal(buttons.some(button => /定时任务|Scheduled Tasks/.test(button.textContent)), false, "shortcut visibility remains respected");
    await act(async () => buttons.find(button => button.textContent.trim() === "MCP").click());
    assert.equal(selected, "mcp-hub");
    assert.equal(document.querySelector('[role="dialog"]'), null, "selection dismisses the mobile navigation sheet");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    mobile = false;
  }
});

test("a background local sidebar yields shortcuts to the visible remote sidebar without losing its state", async () => {
  mobile = false;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const states = {};
  const identities = new Set();
  function Content({ name }) {
    const sidebar = useSidebar();
    states[name] = sidebar.open;
    if (name === "local") identities.add(sidebar.setOpen);
    return React.createElement("span", { "data-test-sidebar": name }, String(sidebar.open));
  }
  const render = async (localActive) => act(async () => root.render(
    React.createElement(React.Fragment, null,
      React.createElement(SidebarProvider, { keyboardShortcutEnabled: localActive }, React.createElement(Content, { name: "local" })),
      React.createElement(SidebarProvider, { keyboardShortcutEnabled: !localActive }, React.createElement(Content, { name: "remote" }))),
  ));
  const toggle = async () => act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, cancelable: true })));
  try {
    await render(true);
    await toggle();
    assert.deepEqual(states, { local: false, remote: true });
    const local = container.querySelector('[data-test-sidebar="local"]');
    await render(false);
    await toggle();
    assert.deepEqual(states, { local: false, remote: false });
    await render(true);
    assert.equal(container.querySelector('[data-test-sidebar="local"]'), local);
    assert.equal(identities.size, 1);
    await toggle();
    assert.deepEqual(states, { local: true, remote: false });
  } finally { await act(async () => root.unmount()); container.remove(); }
});

function mount({rail=false}={}) {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  let setOpen;
  function Content() {
    const sidebar = useSidebar();
    setOpen = sidebar.isMobile ? sidebar.setOpenMobile : sidebar.setOpen;
    return React.createElement(React.Fragment, null,
      React.createElement(SidebarTrigger, { id: "open-navigation" }),
      React.createElement(Sidebar, { label: "Navigation", mobileRail:rail?React.createElement('nav',{'aria-label':'Application'},React.createElement(SidebarTrigger,{id:'close-mobile-rail'})):undefined }, React.createElement("button", { id: "inside-navigation" }, "Conversation")));
  }
  function Harness() { return React.createElement(SidebarProvider, { defaultOpen: false }, React.createElement(Content)); }
  return { container, root, Harness, setOpen: value => setOpen(value), destroy: async () => { await act(async () => root.unmount()); container.remove(); } };
}
test("desktop sidebar keeps content identity and makes collapsed controls inert", async () => {
  mobile = false;
  const h = mount();
  try {
    await act(async () => h.root.render(React.createElement(h.Harness)));
    const content = document.getElementById("inside-navigation");
    assert.equal(h.container.querySelector("[data-slot=sidebar-container]").getAttribute("aria-hidden"), "true");
    assert.ok(h.container.querySelector("[data-slot=sidebar-container]").hasAttribute("inert"));
    await act(async () => h.setOpen(true));
    assert.equal(h.container.querySelector("[data-slot=sidebar]").dataset.state, "expanded");
    assert.equal(document.getElementById("inside-navigation"), content);
    assert.equal(h.container.querySelector("[data-slot=sidebar-container]").hasAttribute("inert"), false);
    await act(async () => h.setOpen(false));
    assert.equal(document.getElementById("inside-navigation"), content);
    assert.ok(h.container.querySelector("[data-slot=sidebar-container]").hasAttribute("inert"));
  } finally { await h.destroy(); }
});
test("mobile sidebar uses a real Sheet dialog with a label and Escape dismissal", async () => {
  mobile = true;
  const h = mount();
  try {
    await act(async () => h.root.render(React.createElement(h.Harness)));
    const opener = document.getElementById("open-navigation");
    opener.focus();
    await act(async () => opener.click());
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(document.getElementById(dialog.getAttribute("aria-labelledby")).textContent, "Navigation");
    assert.ok(dialog.contains(document.getElementById("inside-navigation")));
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, opener);
  } finally { await h.destroy(); mobile = false; }
});

test("an opted-in mobile rail shares one modal with the panel and its close action restores focus", async () => {
  mobile=true;
  const h=mount({rail:true});
  try {
    await act(async()=>h.root.render(React.createElement(h.Harness)));
    const opener=document.getElementById('open-navigation'); opener.focus();
    await act(async()=>opener.click());
    const dialog=document.querySelector('[role=dialog]');
    assert.equal(document.querySelectorAll('[role=dialog]').length,1);
    assert.ok(dialog.querySelector('nav[aria-label=Application]'));
    assert.ok(dialog.querySelector('.sidebar-mobile-panel #inside-navigation'));
    assert.ok(document.querySelector('.sheet-navigation-backdrop'));
    await act(async()=>document.getElementById('close-mobile-rail').click());
    assert.equal(document.querySelector('[role=dialog]'),null);
    assert.equal(document.activeElement,opener);
  } finally {await h.destroy(); mobile=false;}
});

// react-resizable-panels measures panels; jsdom returns 0 for everything, so
// fake a 1000px group with a 1px separator.
function installPanelLayoutMocks() {
  const oldRect = HTMLElement.prototype.getBoundingClientRect;
  const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const leftDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft");
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() {
    if (this.hasAttribute("data-panel")) {
      const grow = Number.parseFloat(this.style.flexGrow);
      const panels = [...this.parentElement.querySelectorAll(":scope > [data-panel]")];
      const total = panels.reduce((sum, panel) => sum + (Number.parseFloat(panel.style.flexGrow) || 0), 0);
      return Number.isFinite(grow) && total > 1 ? grow / total * 999 : (this.id === "workspace-tools" ? 400 : 599);
    }
    return this.hasAttribute("data-separator") ? 1 : 1000;
  } });
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", { configurable: true, get() { return this.id === "workspace-tools" ? 601 : this.hasAttribute("data-separator") ? 600 : 0; } });
  HTMLElement.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, toJSON() {} }; };
  return () => { HTMLElement.prototype.getBoundingClientRect = oldRect; Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDescriptor); Object.defineProperty(HTMLElement.prototype, "offsetLeft", leftDescriptor); };
}

test("standard resizable panels restore width, preserve main content, and save keyboard resizing", async () => {
  mobile = false;
  const restoreLayout = installPanelLayoutMocks();
  const { WorkspacePanelGroup, WorkspaceMainPanel, WorkspaceToolsPanel } = env.loadModule("@liveagent/ui/components/project-tools/WorkspacePanels.tsx");
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const widths = [];
  const { ProjectToolsPanelToggle } = env.loadModule("@liveagent/ui/components/project-tools/ProjectToolsPanelToggle.tsx");
  let setOpen;
  function Harness() {
    const [open, updateOpen] = React.useState(false); setOpen = updateOpen;
    const [width, setWidth] = React.useState(420);
    const chrome = React.createElement("header", { "data-app-workbench-chrome": "" },
      React.createElement(ProjectToolsPanelToggle, {isOpen: open, sessionCount: 0, onToggle: () => updateOpen(value => !value)}));
    return React.createElement(WorkspacePanelGroup, { open, width, onClose: () => updateOpen(false), onWidthChange: next => { widths.push(next); setWidth(next); } },
      React.createElement(WorkspaceMainPanel, { chrome }, React.createElement("input", { id: "main-draft", defaultValue: "draft" })),
      React.createElement(WorkspaceToolsPanel, null, React.createElement("div", { id: "tools-content" }, "Tools")));
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const draft = document.getElementById("main-draft");
    const header = container.querySelector("[data-app-workbench-chrome]");
    const toggle = header.querySelector("button");
    const tools = container.querySelector('#workspace-tools');
    assert.ok(tools);
    assert.ok(container.querySelector("#workspace-main").contains(toggle));
    assert.equal(toggle.hasAttribute("title"), false);
    assert.equal(tools.getAttribute("aria-hidden"), "true");
    await act(async () => toggle.click());
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.ok(tools.parentElement.hasAttribute("data-workspace-tools-docked"));
    assert.equal(tools.getAttribute("aria-hidden"), "false");
    assert.equal(Math.round(tools.offsetWidth), 540, "first open uses 54% of the available group");
    assert.deepEqual(widths, [], "opening leaves the default responsive");
    await act(async () => setOpen(false));
    assert.equal(tools.getAttribute("aria-hidden"), "true");
    assert.ok(tools.hasAttribute("inert"));
    await act(async () => setOpen(true));
    assert.equal(Math.round(tools.offsetWidth), 540, "reopening restores the default split");
    assert.equal(document.getElementById("main-draft"), draft);
    assert.equal(draft.value, "draft");
    const separator = container.querySelector('[role="separator"]');
    assert.ok(separator);
    await act(async () => separator.focus());
    await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    assert.ok(widths.length > 0, "keyboard resizing saves the new width");
    const savedWidth = widths.at(-1);
    assert.ok(savedWidth > 540);
    await act(async () => setOpen(false));
    await act(async () => setOpen(true));
    assert.equal(Math.round(tools.offsetWidth), savedWidth, "reopening restores the custom width");
    await act(async () => separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    assert.equal(widths.at(-1), 420, "double click saves the responsive default rather than the measured width");
    assert.equal(Math.round(tools.offsetWidth), 540);
    assert.equal(tools.getAttribute("aria-hidden"), "false", "reset leaves the tools open");
    await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.equal(widths.at(-1), 420);
    assert.equal(Math.round(tools.offsetWidth), 540);
    assert.equal(document.getElementById("main-draft"), draft);
    assert.equal(draft.value, "draft");
    await act(async () => { mobile = true; mediaListeners.forEach(listener => listener()); });
    assert.equal(tools.parentElement.hasAttribute("data-workspace-tools-docked"), false);
    assert.equal(document.querySelectorAll("#tools-content").length, 1);
    assert.ok(document.querySelector('[role="dialog"]')?.contains(document.getElementById("tools-content")));
    assert.equal(document.getElementById("main-draft"), draft);
    await act(async () => { mobile = false; mediaListeners.forEach(listener => listener()); });
    assert.equal(document.querySelectorAll("#tools-content").length, 1);
    assert.equal(document.getElementById("main-draft"), draft);
  } finally { await act(async () => root.unmount()); container.remove(); restoreLayout(); }
});

test("tools panel content follows the panel width once the open animation settles", async () => {
  mobile = false;
  const restoreLayout = installPanelLayoutMocks();
  const { WorkspacePanelGroup, WorkspaceMainPanel, WorkspaceToolsPanel } = env.loadModule("@liveagent/ui/components/project-tools/WorkspacePanels.tsx");
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const content = () => document.getElementById("tools-content").parentElement;
  try {
    await act(async () => root.render(React.createElement(WorkspacePanelGroup, { open: true, width: 400, onClose: () => {}, onWidthChange: () => {} },
      React.createElement(WorkspaceMainPanel, null, "Main"),
      React.createElement(WorkspaceToolsPanel, null, React.createElement("div", { id: "tools-content" }, "Tools")))));
    // While the flex-grow transition runs the content keeps its saved pixel width (slide-in).
    assert.equal(content().style.width, "400px");
    // Afterwards it must track the real panel width, otherwise a narrower group
    // (left sidebar expanded) leaves it overflowing and clipped on the left.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    assert.equal(content().style.width, "100%");
    // Immediate mode never waits.
    await act(async () => root.render(React.createElement(WorkspacePanelGroup, { open: true, width: 400, immediate: true, onClose: () => {}, onWidthChange: () => {} },
      React.createElement(WorkspaceMainPanel, null, "Main"),
      React.createElement(WorkspaceToolsPanel, null, React.createElement("div", { id: "tools-content" }, "Tools")))));
    assert.equal(content().style.width, "100%");
  } finally { await act(async () => root.unmount()); container.remove(); restoreLayout(); }
});

test("desktop preference survives mobile dismissal and shortcut ignores text editing", async () => {
  mobile = false;
  const h = mount();
  try {
    await act(async () => h.root.render(React.createElement(h.Harness)));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true })));
    assert.equal(h.container.querySelector('[data-slot="sidebar"]').dataset.state, "expanded");
    assert.ok(document.cookie.includes("sidebar_state=true"));
    const input = document.createElement("textarea"); h.container.appendChild(input);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true })));
    assert.equal(h.container.querySelector('[data-slot="sidebar"]').dataset.state, "expanded");
    input.remove();
    await act(async () => { mobile = true; mediaListeners.forEach(listener => listener()); });
    assert.equal(document.querySelector('[role="dialog"]'), null, "mobile starts closed despite desktop being expanded");
    await act(async () => document.getElementById("open-navigation").click());
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => { mobile = false; mediaListeners.forEach(listener => listener()); });
    assert.equal(h.container.querySelector('[data-slot="sidebar"]').dataset.state, "expanded");
  } finally { mobile = false; await h.destroy(); }
});

test("controlled provider and standard trigger share one state owner", async () => {
  mobile = false;
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const changes = [];
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return React.createElement(SidebarProvider, { open, onOpenChange: next => { changes.push(next); setOpen(next); } },
      React.createElement(SidebarTrigger, { id: "controlled-trigger" }),
      React.createElement(Sidebar, { label: "Controlled", collapsible: "icon", variant: "inset" }, "Contents"));
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(container.querySelector('[data-slot="sidebar"]').dataset.collapsible, "icon");
    await act(async () => document.getElementById("controlled-trigger").click());
    assert.deepEqual(changes, [true]);
    assert.equal(container.querySelector('[data-slot="sidebar"]').dataset.state, "expanded");
    await act(async () => document.getElementById("controlled-trigger").click());
    assert.deepEqual(changes, [true, false]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("five sidebar toggles do not update 200 memoized plain menu rows or replace action callbacks", async () => {
  mobile = false;
  const { SidebarMenuButton } = env.loadModule("@liveagent/ui/components/ui/sidebar.tsx");
  let toggle;
  const setters = new Set(), toggles = new Set();
  let rowUpdates = 0;
  function Controller() {
    const sidebar = useSidebar(); toggle = sidebar.toggleSidebar;
    setters.add(sidebar.setOpen); toggles.add(sidebar.toggleSidebar);
    return null;
  }
  const Row = React.memo(function Row() {
    return React.createElement(React.Profiler, { id: "row", onRender: (_id, phase) => { if (phase !== "mount") rowUpdates++; } },
      React.createElement(SidebarMenuButton, null, "Conversation"));
  });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(SidebarProvider, null,
      React.createElement(Controller), ...Array.from({ length: 200 }, (_, i) => React.createElement(Row, { key: i })))));
    for (let i = 0; i < 5; i++) await act(async () => toggle());
    assert.equal(rowUpdates, 0);
    assert.equal(setters.size, 1);
    assert.equal(toggles.size, 1);
    // Functional updates compose correctly even before React commits.
    await act(async () => { toggle(); toggle(); });
    assert.equal(document.cookie.includes("sidebar_state=false"), true);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("desktop hover preview exposes the same sidebar without pinning it or changing persistence", async () => {
 mobile=false;
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container);
 let pinned;const render=preview=>act(async()=>root.render(React.createElement(SidebarProvider,{defaultOpen:false},React.createElement(Content,{preview}))));
 function Content({preview}){pinned=useSidebar().open;return React.createElement(Sidebar,{previewOpen:preview},React.createElement('button',{id:'peek-entry'},'History'));}
 try{
  await render(false);
  const entry=container.querySelector('#peek-entry'),cookie=document.cookie;
  await render(true);
  const pane=container.querySelector('[data-slot=sidebar-container]');
  assert.equal(pinned,false);
  assert.equal(pane.getAttribute('aria-hidden'),'false');
  assert.equal(pane.hasAttribute('inert'),false);
  assert.equal(container.querySelector('[data-slot=sidebar]').dataset.collapsible,'offcanvas');
  assert.equal(document.cookie,cookie);
  assert.equal(container.querySelector('#peek-entry'),entry);
  await render(false);
  assert.ok(pane.hasAttribute('inert'));
  assert.equal(container.querySelector('#peek-entry'),entry);
 }finally{await act(async()=>root.unmount());container.remove();}
});
