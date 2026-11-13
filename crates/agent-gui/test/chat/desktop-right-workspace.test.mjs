import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const breadcrumbListings = {
  "": ["src/", "README.md"],
  src: ["src/components/", "src/index.ts"],
  "src/components": ["src/components/Panel.tsx", "src/components/Toolbar.tsx"],
};
const breadcrumbReads = [];
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/lib/tools/fsBackend": {
      async invokeFs(command, { path = "" }) {
        assert.equal(command, "fs_list");
        breadcrumbReads.push(path);
        return {
          entries: breadcrumbListings[path].map((entry) => ({
            path: entry.replace(/\/$/, ""),
            kind: entry.endsWith("/") ? "dir" : "file",
          })),
        };
      },
    },
    "./rightDockRegistry": {
      getRightDockToolDefinition: () => ({
        titleKey: "projectTools.gitReviewTitle",
        closeKey: "projectTools.closeGitReview",
        icon: () => null,
      }),
    },
  },
});
const { React, act, createRoot, loadModule } = env;
const { useWorkspaceTabs, workspaceFileTabId } = loadModule(
  "../agent-ui/src/components/project-tools/useWorkspaceTabs.ts",
);
const { workbenchBrowserLinkUrl } = loadModule("@liveagent/ui/lib/chat/workbenchBrowserLink.ts");
const { RightDockTabStrip } = loadModule("@liveagent/ui/components/project-tools/RightDockTabStrip.tsx");
const { WorkspaceFileHeader } = loadModule(
  "@liveagent/ui/components/project-tools/WorkspaceFileHeader.tsx",
);
const { TooltipProvider } = loadModule("@liveagent/ui/components/ui/tooltip");
const { desktopWorkspaceTabWidths } = loadModule(
  "@liveagent/ui/components/project-tools/desktopWorkspaceTabLayout.ts",
);

const file = (path) => ({ projectPathKey: "d:/repo", workdir: "D:\\repo", path });

test("breadcrumb root, folder and file open different selections", async (t) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const opened = [];
  const noop = () => {};
  await act(async () => root.render(React.createElement(TooltipProvider, null,
    React.createElement(WorkspaceFileHeader, {
      active: true,
      nativeFileActions: false,
      request: file("src/components/Panel.tsx"),
      setFormatTools: noop,
      onOpenFile: (path) => opened.push(path),
      onError: (error) => assert.fail(error),
      readDraft: noop,
      beforeOpen: async () => true,
    }),
  )));
  const crumbs = container.querySelectorAll("nav ol button");
  const popup = () => document.querySelector("[data-workspace-breadcrumb-picker]");
  const current = () => popup()?.querySelector("[aria-current]");
  const rows = () => [...popup().querySelectorAll(".za-breadcrumb-entry")].map((row) => row.textContent);
  const click = (element) => act(async () => element.click());

  await click(crumbs[0]);
  assert.equal(current(), null);
  assert.deepEqual(rows(), ["src", "README.md"]);
  assert.deepEqual(breadcrumbReads, [""]);

  await click(crumbs[1]);
  assert.equal(current().textContent, "src");
  assert.equal(current().getAttribute("aria-current"), "location");
  assert.equal(current().getAttribute("aria-expanded"), "true");
  assert.deepEqual(rows(), ["src", "components", "index.ts", "README.md"]);
  assert.deepEqual(breadcrumbReads.slice(-2), ["", "src"]);

  await click(current());
  assert.deepEqual(rows(), ["src", "README.md"]);
  await click(crumbs[2]);
  assert.equal(current().textContent, "components");
  assert.deepEqual(rows(), ["components", "Panel.tsx", "Toolbar.tsx", "index.ts"]);
  assert.deepEqual(breadcrumbReads.slice(-2), ["src", "src/components"]);

  await click(crumbs[3]);
  assert.equal(current().textContent, "Panel.tsx");
  assert.equal(current().getAttribute("aria-current"), "page");
  assert.deepEqual(rows(), ["Panel.tsx", "Toolbar.tsx"]);
  assert.equal(breadcrumbReads.at(-1), "src/components");
  await click(popup().querySelectorAll(".za-breadcrumb-entry")[1]);
  assert.deepEqual(opened, ["src/components/Toolbar.tsx"]);
});

test("desktop tabs share a fixed pane while reserving additional tab actions", () => {
  const sameTabs = [0, 0, 30, 0];
  assert.deepEqual(desktopWorkspaceTabWidths(300, sameTabs), [90, 90, 120, 90]);
  assert.deepEqual(desktopWorkspaceTabWidths(420, sameTabs), [100, 100, 120, 100]);
  assert.deepEqual(desktopWorkspaceTabWidths(760, sameTabs), [190, 190, 190, 190]);
  assert.deepEqual(desktopWorkspaceTabWidths(1180, sameTabs), [240, 240, 240, 240]);
  assert.deepEqual(desktopWorkspaceTabWidths(420, [0, 30, 0], 100), [100, 120, 100]);
  assert.deepEqual(desktopWorkspaceTabWidths(420, [0, 30, 0]), [140, 140, 140]);
});

test("the desktop Changes tab exposes its close action and restores focus to the remaining file", async (t) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const noop = () => {};
  function Harness() {
    const [changesOpen, setChangesOpen] = React.useState(true);
    return React.createElement("div", { className: "project-tools-panel-tabs", role: "tablist" },
      React.createElement(RightDockTabStrip, {
        tabs: changesOpen ? [{ id: "gitReview", kind: "gitReview" }] : [],
        currentActiveTab: changesOpen ? "gitReview" : "fileTree",
        workspaceTabs: [{ id: "readme", label: "README.md", onActivate: noop, onClose: noop }],
        activeWorkspaceTabId: changesOpen ? null : "readme",
        backgroundTasksRunning: 0,
        pendingCloseSessionId: "",
        closingSessionIds: new Set(),
        draggingTabId: "",
        renderTabDragHandle: noop,
        getTabDragProps: noop,
        getTabDragStyle: noop,
        consumeSuppressedTabClick: () => false,
        onCloseToolTab: () => setChangesOpen(false),
      }),
    );
  }
  await act(async () => root.render(React.createElement(Harness)));
  const changes = container.querySelector('[role="tab"][aria-selected="true"]');
  assert.match(changes.getAttribute("aria-label"), /^(Changes|变更)$/);
  const close = changes.parentElement.querySelector('[data-project-tools-tab-action="close"]');
  assert.ok(close.classList.contains("opacity-100"));
  await act(async () => changes.focus());
  await act(async () => changes.dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Delete",
    bubbles: true,
  })));
  assert.equal(container.querySelectorAll('[role="tab"]').length, 1);
  assert.equal(document.activeElement.getAttribute("aria-label"), "README.md");
});

test("the compact tab menu keeps the active preview and leaves the other tab alone", async (t) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const { ContextMenuItem } = loadModule("@liveagent/ui/components/ui/context-menu");
  const calls = [];
  const tabs = [
    { id: "old", label: "README.md", onClose: () => calls.push("close-old") },
    {
      id: "preview",
      label: "notes.md",
      temporary: true,
      onClose: () => calls.push("close-preview"),
      menuItems: React.createElement(ContextMenuItem, { onSelect: () => calls.push("keep") }, "Keep"),
    },
  ].map((tab) => ({ ...tab, onActivate: () => calls.push(tab.id) }));
  const noop = () => {};
  await act(async () => root.render(React.createElement("div", {
    "data-slot": "sheet-popup",
    className: "project-tools-panel-tabs",
  }, React.createElement(RightDockTabStrip, {
    compact: true,
    tabs: [],
    workspaceTabs: tabs,
    activeWorkspaceTabId: "preview",
    backgroundTasksRunning: 0,
    pendingCloseSessionId: "",
    closingSessionIds: new Set(),
    draggingTabId: "",
    renderTabDragHandle: noop,
    getTabDragProps: noop,
    getTabDragStyle: noop,
  }))));
  const triggers = container.querySelectorAll(".za-workspace-tab-more");
  assert.equal(triggers.length, 1);
  assert.match(triggers[0].getAttribute("aria-label"), /notes\.md/);
  await act(async () => triggers[0].click());
  const menu = container.querySelector('[role="menu"]');
  assert.ok(menu);
  await act(async () => [...menu.querySelectorAll('[role="menuitem"]')]
    .find((item) => item.textContent === "Keep").click());
  assert.deepEqual(calls, ["keep"]);
});

test("file identity is shared by transcript, Git and file-tree links on Windows", () => {
  assert.equal(workspaceFileTabId(file("docs/README.md")), workspaceFileTabId(file("d:\\repo\\DOCS\\readme.md")));
  assert.notEqual(workspaceFileTabId(file("docs/README.md")), workspaceFileTabId(file("d:\\other\\docs\\README.md")));
  const unix = (path) => ({ projectPathKey: "/repo", workdir: "/repo", path });
  assert.notEqual(workspaceFileTabId(unix("Readme.md")), workspaceFileTabId(unix("README.md")));
});

test("desktop workspace restores scoped tabs, modes, tree and dirty state", async (t) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  let workspace;
  const opened = [];
  function Harness({ owner, conversation }) {
    workspace = useWorkspaceTabs(owner, conversation, () => opened.push(conversation));
    return null;
  }
  const render = (conversation, owner = "account-a") => act(async () => {
    root.render(React.createElement(Harness, { owner, conversation }));
  });

  await render("A");
  await act(async () => workspace.openFile(file("notes.md"), "preview"));
  const reader = workspace.view.tabs[0];
  await act(async () => workspace.openFile(file("D:/repo/notes.md"), "source"));
  assert.equal(workspace.view.tabs.length, 1);
  assert.deepEqual(workspace.view.tabs[0].openedModes, ["preview", "source"]);
  assert.equal(workspace.view.tabs[0].request.id, reader.request.id);
  await act(async () => {
    workspace.setFileDirty(reader.id, true, "A");
    workspace.openTree();
    workspace.toggleTreeGroup("changes");
    workspace.toggleExpanded();
    workspace.openBrowser("https://example.test/");
  });
  const browser = workspace.view.tabs[1];
  await act(async () => workspace.openBrowser("https://other.example.test/", browser.id, false));
  const background = workspace.view.tabs[2];
  assert.equal(workspace.view.activeId, browser.id);
  const staleOpen = workspace.openFile;
  const updateBrowser = workspace.updateBrowser;

  await render("B");
  assert.equal(workspace.view.tabs.length, 0);
  assert.equal(workspace.view.treeOpen, false);
  await act(async () => {
    staleOpen(file("late.md"), "preview");
    updateBrowser(browser.id, { title: "A browser" }, "A");
    workspace.openFile(file("other.md"), "diff");
  });
  assert.equal(workspace.view.tabs.length, 1);
  assert.deepEqual(opened, ["A", "A", "A", "B"]);

  await render("A");
  assert.equal(workspace.view.expanded, true);
  assert.equal(workspace.view.treeOpen, true);
  assert.equal(workspace.view.treeGroups.changes, false);
  assert.equal(workspace.view.tabs[1].title, "A browser");
  await act(async () => workspace.requestCloseFile(reader.id));
  assert.equal(workspace.view.activeId, reader.id);
  assert.equal(workspace.view.tabs[0].dirty, true);
  assert.ok(workspace.view.tabs[0].closeRequestId > 0);
  await act(async () => workspace.close(reader.id, "A"));
  assert.equal(workspace.view.activeId, browser.id);
  await act(async () => workspace.move(background.id, browser.id));
  assert.deepEqual(workspace.view.tabs.map((tab) => tab.id), [background.id, browser.id]);
  await act(async () => workspace.reopen());
  assert.equal(workspace.view.activeId, reader.id);
  assert.equal(workspace.view.tabs.at(-1).dirty, false);

  const history = { entries: ["https://example.test/earlier", browser.url], index: 1 };
  await act(async () => workspace.openBrowser(browser.url, browser.id, true, "A", history));
  const duplicate = workspace.view.tabs.find((tab) => tab.id === workspace.view.activeId);
  assert.notEqual(duplicate.id, browser.id);
  assert.deepEqual(duplicate.history, history);

  await render("A", "account-b");
  await act(async () => updateBrowser(browser.id, { title: "Late update" }, "A"));
  assert.equal(workspace.views.size, 0);
  await render("A");
  await act(async () => staleOpen(file("late-after-account-return.md"), "preview"));
  assert.equal(workspace.views.size, 0);
});

test("only explicit HTTP(S) links without embedded credentials use the guest browser", () => {
  assert.equal(workbenchBrowserLinkUrl("https://example.test/a"), "https://example.test/a");
  assert.equal(workbenchBrowserLinkUrl("http://127.0.0.1:5000"), "http://127.0.0.1:5000/");
  for (const url of ["file:///C:/secret", "javascript:void(0)", "https://user:secret@example.test", "/local", "mailto:a@example.test"]) {
    assert.equal(workbenchBrowserLinkUrl(url), null);
  }
});

test("single preview is replaced in place and double-click or editing keeps a tab", async (t) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  let workspace;
  function Harness() {
    workspace = useWorkspaceTabs("account", "conversation", () => {});
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => {
    workspace.openFile(file("one.md"), "preview", true);
    workspace.openFile(file("kept.md"), "preview");
    workspace.openFile(file("two.md"), "diff", true);
  });
  assert.deepEqual(workspace.view.tabs.map((tab) => [tab.request.path, tab.temporary]), [
    ["two.md", true], ["kept.md", false],
  ]);
  await act(async () => {
    workspace.keepFileOpen(workspace.view.activeId);
    workspace.openFile(file("edit.md"), "source", true);
    workspace.setFileDirty(workspaceFileTabId(file("edit.md")), true, "conversation");
    workspace.openFile(file("three.md"), "preview", true);
  });
  assert.deepEqual(workspace.view.tabs.map((tab) => [tab.request.path, tab.temporary]), [
    ["two.md", false], ["kept.md", false], ["edit.md", false], ["three.md", true],
  ]);
});

test("desktop restart restores only permitted routes under their account and conversation", async (t) => {
  const container = document.body.appendChild(document.createElement("div"));
  let root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  let workspace;
  let visible;
  function Harness({ owner, scope }) {
    const [open, setOpen] = React.useState(false);
    workspace = useWorkspaceTabs(owner, scope, () => setOpen(true), {
      projectPathKey: "d:/repo", workdir: "D:\\repo", open, setOpen,
    });
    visible = open;
    return null;
  }
  const render = (owner, scope = "first") => act(async () => {
    root.render(React.createElement(Harness, { key: `${owner}:${scope}`, owner, scope }));
  });
  await render("checkpoint-a");
  await act(async () => {
    workspace.openFile(file("D:/repo/notes.md"), "source");
    workspace.openFile(file("D:/other/outside.md"), "source");
    workspace.openFile(file("scratch.md"), "preview", true);
    workspace.openBrowser("https://example.test/dashboard");
    workspace.openBrowser("https://example.test/oauth?code=secret");
    workspace.activate(workspaceFileTabId(file("D:/other/outside.md")));
    workspace.setFileDirty(workspaceFileTabId(file("notes.md")), true, "first");
    workspace.setComparison("branch:refs/remotes/origin/main");
    workspace.setTreeWidth(326);
    workspace.openTree();
    workspace.toggleExpanded();
  });
  const resumable = workspace.view.tabs.find((tab) => tab.kind === "browser" && tab.url.endsWith("/dashboard"));
  assert.ok(resumable);
  await act(async () => workspace.updateBrowser(resumable.id, {
    history: { entries: ["https://example.test/", "https://example.test/dashboard"], index: 1 },
  }, "first"));
  const checkpoint = window.localStorage.getItem("zeroagent.desktopWorkspace.routes:checkpoint-a");
  assert.ok(checkpoint);
  assert.doesNotMatch(checkpoint, /outside\.md|scratch\.md|code=secret/);
  await act(async () => workspace.activate(workspaceFileTabId(file("notes.md"))));
  await act(async () => root.unmount());
  root = createRoot(container);
  await render("checkpoint-b");
  assert.equal(workspace.view.tabs.length, 0);
  await render("checkpoint-a", "other");
  assert.equal(workspace.view.tabs.length, 0);
  await render("checkpoint-a");
  assert.equal(visible, true);
  assert.equal(workspace.view.treeWidth, 326);
  assert.equal(workspace.view.treeOpen, true);
  assert.equal(workspace.view.expanded, true);
  assert.equal(workspace.view.comparison, "branch:refs/remotes/origin/main");
  assert.equal(workspace.view.activeId, workspaceFileTabId(file("notes.md")));
  assert.deepEqual(workspace.view.tabs.map((tab) => tab.kind === "browser" ? tab.url : [tab.request.path, tab.mode, tab.dirty]), [
    ["notes.md", "source", false], "https://example.test/dashboard",
  ]);
  assert.deepEqual(workspace.view.tabs.at(-1).history, { entries: ["https://example.test/", "https://example.test/dashboard"], index: 1 });
});

test.after(() => env.cleanup());
