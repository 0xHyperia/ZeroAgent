import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const componentPath = (name) =>
  fileURLToPath(new URL(`../../../agent-ui/src/components/project-tools/${name}`, import.meta.url));

const presentations = [];
let currentWorkspaceReview;
const treeNodes = Object.fromEntries([
  ["", { name: "src", kind: "dir", children: ["nested", "main.ts"] }],
  ["nested", { name: "nested", kind: "dir", children: ["nested/report.md"] }],
  ["nested/report.md", { name: "report.md", kind: "file", children: [] }],
  ["main.ts", { name: "main.ts", kind: "file", children: [] }],
].map(([path, node]) => [path, { ...node, path, loaded: true, loading: false, hidden: false }]));
const env = await createDomTestEnv({
  mocks: {
    [componentPath("file-tree/useFileTreeData.ts")]: {
      useFileTreeData: ({ query }) => ({
        nodes: treeNodes,
        loadChildren: async () => {},
        ensureDirsLoaded: async () => {},
        getDisplayPath: (path) => path,
        isExternalPath: () => false,
        search: {
          results: Object.values(treeNodes).filter((node) => node.path.includes(query) && node.path),
          loading: false,
          error: null,
          truncated: false,
        },
      }),
    },
    "@tanstack/react-virtual": {
      useVirtualizer: ({ count, estimateSize }) => ({
        getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * estimateSize() })),
        getTotalSize: () => count * estimateSize(),
        measure() {},
        measureElement() {},
        scrollToIndex() {},
      }),
    },
    [componentPath("git-review/DiffView.tsx")]: {
      DiffContent: ({ layout, wrapLines, workspaceReview }) => {
        presentations.push({ layout, wrapLines });
        currentWorkspaceReview = workspaceReview;
        return null;
      },
    },
  },
});
const { React, act, createRoot, loadModule } = env;
window.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
test.after(() => env.cleanup());

const { RightWorkspaceFileTree } = loadModule("@liveagent/ui/components/project-tools/RightWorkspaceFileTree.tsx");
const { indexStickyTreeRows } = loadModule("@liveagent/ui/components/project-tools/file-tree/model.ts");
const { WorkspaceFileDiff } = loadModule("@liveagent/ui/components/project-tools/WorkspaceFileDiff.tsx");
const { RightDockToolContext } = loadModule("@liveagent/ui/components/project-tools/RightDockContext.tsx");
const { WORKSPACE_GIT_TURN_REVIEW_EVENT } = loadModule("@liveagent/ui/components/project-tools/workspaceGitPaths.ts");
const { useWorkspaceGitPresentation } = loadModule("@liveagent/ui/components/project-tools/workspaceGitReviewState.ts");
const { buildPatchChunks, getPatchFileNames, shouldPageWorkspaceReview } = loadModule("@liveagent/ui/components/project-tools/git-review/model.ts");
const { buildReviewApplyCommand, filterReviewHunks, readReviewFileContents, sameReviewFileRevision } = loadModule("@liveagent/ui/components/project-tools/git-review/workspaceReviewDiff.ts");

test("review paging uses full summary boundaries and also handles clipped transport", () => {
  const diff = { patch: "" };
  assert.equal(shouldPageWorkspaceReview(diff, 128, 9000), false);
  assert.equal(shouldPageWorkspaceReview(diff, 129, 2), true);
  assert.equal(shouldPageWorkspaceReview(diff, 1, 9001), true);
  assert.equal(shouldPageWorkspaceReview({ ...diff, truncated: true }, 3, 100), true);
  assert.equal(shouldPageWorkspaceReview({ ...diff, patchOmitted: true }, 3, 100), true);
  assert.equal(shouldPageWorkspaceReview({ ...diff, patch: "a".repeat(12 * 1024 * 1024 + 1) }, 1, 1), true);
});

test("sticky file tree ancestry stops at the next branch or section", () => {
  const { parents, ends } = indexStickyTreeRows([
    { level: 1, sticky: true },
    { level: 2, sticky: true },
    { level: 3, sticky: true },
    { level: 4 },
    { level: 3 },
    { level: 2 },
    { level: 1, sticky: true },
    { level: 2 },
  ]);
  assert.deepEqual([...parents], [undefined, 0, 1, 2, 1, 0, undefined, 6]);
  assert.deepEqual([ends[0], ends[1], ends[2], ends[6]], [6, 5, 4, 8]);
});

function mount(t) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, root };
}

function gitStatus(...paths) {
  return {
    status: "ready",
    repoRoot: "C:/repo",
    entries: paths.map((path) => ({ path, indexStatus: ".", worktreeStatus: "M", kind: "modified" })),
  };
}

async function waitForUpdate() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
}

test("large review pages by tree order, uses full totals and requests only the selected file", async (t) => {
  const { root, container } = mount(t);
  const calls = [];
  const changes = ["a-root.ts", "nested/a10.ts", "nested/a2.ts"].map((path) => ({
    path, status: "M", kind: "modified", additions: 3334, deletions: 1,
  }));
  const snapshot = {
    patch: "", stat: "", baseRef: "origin/main", files: changes.map(({ path }) => path),
    changes, totals: { additions: 10002, deletions: 3 }, patchOmitted: true,
  };
  let finishSlowPage;
  const client = {
    status: async () => gitStatus(),
    diff: async (_cwd, _scope, path, options) => {
      calls.push({ path, options });
      if (!path) return snapshot;
      if (path.endsWith("/a10.ts")) await new Promise((resolve) => { finishSlowPage = resolve; });
      return {
        patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
      };
    },
  };
  const jump = React.createRef();
  await act(async () => root.render(React.createElement(WorkspaceFileDiff, {
    active: true, workdir: "C:/repo", client, fileJumpRef: jump,
  })));
  await waitForUpdate();
  assert.deepEqual(calls.map(({ path }) => path), [undefined, "nested/a2.ts"]);
  assert.equal(calls[0].options.paginateLarge, true);
  assert.match(container.textContent, /\+10,002-3/);
  assert.equal(currentWorkspaceReview.rows.length, 1);
  assert.match(currentWorkspaceReview.rows[0].chunk, /\+new/);
  assert.equal(currentWorkspaceReview.rows[0].summary, undefined);
  assert.equal(currentWorkspaceReview.rows[0].lineStats.additions, 3334);
  const previous = container.querySelector('button[aria-label="Previous file"],button[aria-label="上一个文件"]');
  const next = container.querySelector('button[aria-label="Next file"],button[aria-label="下一个文件"]');
  assert.equal(previous.disabled, true);
  await act(async () => next.click());
  assert.equal(currentWorkspaceReview.rows.length, 0);
  await act(async () => jump.current("C:/repo/a-root.ts"));
  assert.equal(currentWorkspaceReview.rows[0].label, "a-root.ts");
  assert.equal(next.disabled, true);
  await act(async () => finishSlowPage());
  assert.equal(currentWorkspaceReview.rows[0].label, "a-root.ts");
});

test("the changed-file tree filters real Git entries to the workspace and opens one file", async (t) => {
  const { container, root } = mount(t);
  const opened = [];
  const git = { status: async () => gitStatus("src/nested/report.md", "src/main.ts", "other/no.ts") };
  const render = async (query) => {
    const context = {
      cwd: "c:\\repo\\src",
      clients: { git },
      capabilities: { projectReady: true },
      fileTree: { state: { query, selectedPath: "" }, onStateChange: () => {} },
    };
    await act(async () => root.render(
      React.createElement(RightDockToolContext.Provider, { value: context },
        React.createElement(RightWorkspaceFileTree, {
          groups: { changes: true, files: true },
          onToggleGroup: () => {},
          active: true,
          onOpenReview: () => opened.push("review"),
          onOpenDiff: (path, temporary) => opened.push([path, temporary]),
        }),
      ),
    ));
  };
  await render("");
  await waitForUpdate();
  assert.match(container.textContent, /report\.md/);
  assert.match(container.textContent, /main\.ts/);
  assert.doesNotMatch(container.textContent, /no\.ts/);
  const allChanges = [...container.querySelectorAll("button")].find((button) =>
    /^(All changes|所有更改)$/.test(button.textContent),
  );
  assert.ok(allChanges);
  await act(async () => allChanges.click());
  await render("report");
  assert.doesNotMatch(container.textContent, /main\.ts/);
  const row = container.querySelector('[role="treeitem"][title="nested/report.md"]');
  await act(async () => row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  await act(async () => row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })));
  assert.deepEqual(opened, ["review", ["C:/repo/src/nested/report.md", true], ["C:/repo/src/nested/report.md", false]]);
});

test("the review tree shares complete change metadata and preserves its distinct lanes", async (t) => {
  const { container, root } = mount(t);
  const { compareWorkspaceReviewPaths } = loadModule(
    "@liveagent/ui/components/project-tools/file-tree/model.ts",
  );
  const paths = [
    "z.ts",
    "nested/test10.ts",
    "nested/test2.ts",
    "nested/sub/a.ts",
    "nested",
  ];
  assert.deepEqual(paths.toSorted(compareWorkspaceReviewPaths), [
    "nested/sub/a.ts",
    "nested/test2.ts",
    "nested/test10.ts",
    "nested",
    "z.ts",
  ]);
  let requests = 0;
  const context = {
    cwd: "C:/repo/src",
    clients: { git: { status: async () => { requests += 1; return gitStatus(); } } },
    capabilities: { projectReady: true },
    fileTree: { state: { query: "", selectedPath: "nested/test10.ts" }, onStateChange() {} },
  };
  const diff = {
    changes: [
      { path: "src/nested/test10.ts", status: "M", kind: "modified", additions: 1200, deletions: 3 },
      { path: "src/nested/test2.ts", status: "A", kind: "added", additions: 6, deletions: 0 },
      { path: "src/nested", status: "D", kind: "deleted", additions: 0, deletions: 9 },
      { path: "src/z.ts", status: "R", kind: "renamed", additions: 0, deletions: 0 },
    ],
    patch: "",
    truncated: true,
  };
  await act(async () => root.render(
    React.createElement(RightDockToolContext.Provider, { value: context },
      React.createElement(RightWorkspaceFileTree, {
        active: true,
        reviewOnly: true,
        reviewRepository: gitStatus(),
        reviewDiff: diff,
        activeReviewPath: "src/nested/test2.ts",
        groups: { changes: true, files: true },
        onToggleGroup() {},
        onOpenReview() {},
        onOpenDiff() {},
      }),
    ),
  ));
  await waitForUpdate();
  assert.equal(requests, 0);
  const tree = container.querySelector('[data-workspace-review-tree="true"]');
  const rows = [...tree.querySelectorAll('[role="treeitem"][title]')];
  assert.deepEqual(rows.map((row) => row.title), [
    "nested", "nested/test2.ts", "nested/test10.ts", "nested", "z.ts",
  ]);
  assert.equal(rows[0].dataset.workspaceChangeTone, "directory");
  assert.equal(rows[0].querySelectorAll("svg").length, 1);
  assert.ok(rows[0].querySelector(".za-workspace-tree-change-indicator"));
  assert.equal(rows[1].dataset.workspaceChangeTone, "added");
  assert.equal(rows[1].getAttribute("aria-selected"), "true");
  assert.equal(rows[1].querySelector("[data-added]").textContent, "+6");
  assert.equal(rows[1].querySelector("[data-deleted]"), null);
  assert.equal(rows[2].dataset.workspaceChangeTone, "modified");
  assert.equal(rows[2].getAttribute("aria-selected"), "false");
  assert.equal(rows[2].querySelector("[data-added]").textContent, "+1,200");
  assert.equal(rows[2].querySelector("[data-deleted]").textContent, "-3");
  assert.equal(rows[3].dataset.workspaceChangeTone, "deleted");
  assert.equal(rows[3].querySelector("[data-added]"), null);
  assert.equal(rows[3].querySelector("[data-deleted]").textContent, "-9");
  assert.equal(rows[4].querySelector(".za-workspace-tree-change-counts"), null);
});

test("the 250px workspace inspector uses one keyboard and scroll tree for both file sections", async (t) => {
  const { container, root } = mount(t);
  container.style.width = "250px";
  const opened = [];
  const git = { status: async () => gitStatus("src/nested/report.md", "src/main.ts") };
  function Inspector({ compactFilter }) {
    const [groups, setGroups] = React.useState({ changes: true, files: true });
    const [state, setState] = React.useState({
      query: "",
      selectedPath: "",
      expandedPaths: ["nested"],
      revision: 0,
    });
    const context = {
      cwd: "C:/repo/src",
      projectPathKey: "project",
      clients: { git },
      capabilities: { projectReady: true },
      fileTree: {
        state,
        onStateChange: (patch) => setState((value) => ({ ...value, ...patch })),
        onOpenFile: (path, _images, temporary) => opened.push(["file", path, temporary]),
      },
    };
    return React.createElement(
      RightDockToolContext.Provider,
      { value: context },
      React.createElement(RightWorkspaceFileTree, {
        active: true,
        compactFilter,
        groups,
        onToggleGroup: (group) => setGroups((value) => ({ ...value, [group]: !value[group] })),
        onOpenReview() {},
        onOpenDiff: (path, temporary) => opened.push(["change", path, temporary]),
      }),
    );
  }
  await act(async () => root.render(React.createElement(Inspector)));
  await waitForUpdate();
  assert.equal(container.querySelectorAll('[role="tree"]').length, 1);
  assert.equal(container.querySelectorAll(".project-file-tree-panel-scroll").length, 1);
  const tree = container.querySelector("[data-workspace-tree-scroll]");
  const sections = [...tree.querySelectorAll("[data-workspace-tree-section]")];
  assert.deepEqual(sections.map((row) => row.dataset.workspaceTreeSection), ["changes", "files"]);
  assert.ok(!tree.querySelector('[role="treeitem"][title=""]'));
  const reports = () => [...tree.querySelectorAll('[role="treeitem"][title="nested/report.md"]')];
  const click = (row, type, detail) => act(async () => row.dispatchEvent(
    new MouseEvent(type, { bubbles: true, detail }),
  ));
  await click(reports()[0], "click", 1);
  await click(reports()[0], "click", 2);
  await click(reports()[0], "dblclick", 2);
  assert.equal(reports()[0].getAttribute("aria-selected"), "true");
  assert.equal(reports()[1].getAttribute("aria-selected"), "false");
  await click(reports()[1], "click", 1);
  assert.equal(reports()[0].getAttribute("aria-selected"), "false");
  assert.equal(reports()[1].getAttribute("aria-selected"), "true");
  assert.deepEqual(opened, [
    ["change", "C:/repo/src/nested/report.md", true],
    ["change", "C:/repo/src/nested/report.md", false],
    ["file", "nested/report.md", true],
  ]);
  sections[1].focus();
  await act(async () => sections[1].dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowUp", bubbles: true,
  })));
  assert.equal(document.activeElement.title, "main.ts");
  await click(sections[0], "click", 0);
  assert.equal(reports().length, 1);
  assert.equal(sections[0].getAttribute("aria-expanded"), "false");
  await click(sections[0], "click", 0);
  const filter = container.querySelector("input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(filter, "report");
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(container.querySelectorAll(".project-file-tree-panel-scroll").length, 1);
  assert.equal(reports().length, 2);
  const filteredFolders = [...tree.querySelectorAll('[role="treeitem"][title="nested"]')];
  assert.equal(filteredFolders.length, 2);
  assert.deepEqual(reports().map((row) => row.getAttribute("aria-level")), ["3", "3"]);
  await click(filteredFolders[1], "click", 0);
  assert.equal(filteredFolders[1].getAttribute("aria-expanded"), "false");
  assert.equal(filter.value, "report");
  assert.equal(reports().length, 1);
  await click(filteredFolders[1], "click", 0);
  assert.equal(reports().length, 2);
  assert.ok(!tree.querySelector('[title="main.ts"]'));

  await click(sections[1], "click", 0);
  assert.equal(sections[1].getAttribute("aria-expanded"), "false");
  await act(async () => root.render(React.createElement(Inspector, { compactFilter: true })));
  await waitForUpdate();
  assert.equal(container.querySelector("input"), filter);
  assert.equal(filter.value, "report");
  assert.equal(tree.querySelectorAll("[data-workspace-tree-section]").length, 0);
  assert.equal(reports().length, 1);
  await click(reports()[0], "click", 0);
  assert.deepEqual(opened.at(-1), ["file", "nested/report.md", true]);

  await act(async () => root.render(React.createElement(Inspector)));
  assert.equal(filter.value, "report");
  assert.equal(tree.querySelector('[data-workspace-tree-section="files"]').getAttribute("aria-expanded"), "false");
});

test("file diff uses repository-relative paths and never loads a sibling of the workspace", async (t) => {
  const { root } = mount(t);
  const calls = [];
  const client = {
    status: async () => gitStatus(),
    diff: async (...args) => { calls.push(args); return {}; },
  };
  const render = (path) => act(async () => root.render(
    React.createElement(WorkspaceFileDiff, { active: true, workdir: "C:/repo/src", path, client }),
  ));
  await render("c:\\repo\\src\\nested\\report.md");
  await waitForUpdate();
  await render("C:/repo/src-other/no.ts");
  await waitForUpdate();
  assert.deepEqual(calls, [["C:/repo/src", "working_tree", "src/nested/report.md"]]);
});

test("changed files and file diff follow the same selected scope without widening a subdirectory", async (t) => {
  const { container, root } = mount(t);
  const calls = [];
  const client = {
    status: async () => gitStatus("src/unrelated.ts"),
    diff: async (...args) => {
      calls.push(args);
      return { changes: [{ path: "src/staged.ts", status: "A", kind: "added" }] };
    },
    commitDiff: async (...args) => {
      calls.push(args);
      return { changes: [{ path: "src/removed.ts", status: "D", kind: "deleted" }] };
    },
  };
  const context = {
    cwd: "C:/repo/src",
    clients: { git: client },
    capabilities: { projectReady: true },
    fileTree: { state: { query: "", selectedPath: "" }, onStateChange: () => {} },
  };
  const render = (comparison, path) => act(async () => root.render(
    React.createElement(RightDockToolContext.Provider, { value: context },
      React.createElement(RightWorkspaceFileTree, {
        comparison, active: true, groups: { changes: true, files: false },
        onToggleGroup() {}, onOpenReview() {}, onOpenDiff() {},
      }),
      React.createElement(WorkspaceFileDiff, {
        comparison, path, active: true, client, workdir: context.cwd, hideComparisonMenu: true,
      }),
    ),
  ));

  await render("staged", "C:/repo/src/staged.ts");
  await waitForUpdate();
  assert.ok(container.querySelector('[role="treeitem"][title="staged.ts"]'));
  assert.doesNotMatch(container.textContent, /unrelated\.ts/);
  assert.deepEqual(calls.slice(0, 2).map((args) => args.join("|")).sort(), [
    "C:/repo/src|staged|src", "C:/repo/src|staged|src/staged.ts",
  ]);

  await render("commit:0123abcdef", "C:/repo/src/removed.ts");
  assert.doesNotMatch(container.textContent, /staged\.ts/);
  await waitForUpdate();
  assert.ok(container.querySelector('[role="treeitem"][title="removed.ts"] [data-workspace-file-decoration="D"]'));
  assert.deepEqual(calls.slice(2).map((args) => args.join("|")).sort(), [
    "C:/repo/src|0123abcdef|src", "C:/repo/src|0123abcdef|src/removed.ts",
  ]);

  await render("branch:refs/remotes/origin/stable", "C:/repo/src/staged.ts");
  await waitForUpdate();
  assert.deepEqual(calls.slice(4).map((args) => args.join("|")).sort(), [
    "C:/repo/src|branch:refs/remotes/origin/stable|src",
    "C:/repo/src|branch:refs/remotes/origin/stable|src/staged.ts",
  ]);
});

test("last-turn tree and file diff request only their conversation and refresh when it settles", async (t) => {
  const { container, root } = mount(t);
  const calls = [];
  let relative = "src/before.ts";
  const client = {
    status: async () => gitStatus("src/unrelated.ts"),
    lastTurnDiff: async (...args) => {
      calls.push(args);
      return { changes: [{ path: relative, status: "M", kind: "modified" }] };
    },
  };
  const workdir = "C:/repo/src";
  const context = {
    cwd: workdir,
    clients: { git: client },
    capabilities: { projectReady: true },
    fileTree: { state: { query: "", selectedPath: "" }, onStateChange: () => {} },
  };
  await act(async () => root.render(
    React.createElement(RightDockToolContext.Provider, { value: context },
      React.createElement(RightWorkspaceFileTree, {
        comparison: "last-turn", conversationId: "thread-1", active: true,
        groups: { changes: true, files: false },
        onToggleGroup() {}, onOpenReview() {}, onOpenDiff() {},
      }),
      React.createElement(WorkspaceFileDiff, {
        comparison: "last-turn", conversationId: "thread-1", path: `${workdir}/before.ts`,
        active: true, client, workdir, hideComparisonMenu: true,
      }),
    ),
  ));
  await waitForUpdate();
  assert.ok(container.querySelector('[role="treeitem"][title="before.ts"]'));
  assert.doesNotMatch(container.textContent, /unrelated\.ts/);
  assert.deepEqual(calls.map((args) => args.join("|")).sort(), [
    "C:/repo/src|thread-1|", "C:/repo/src|thread-1|src/before.ts",
  ]);
  const settle = (id) => window.dispatchEvent(new window.CustomEvent(WORKSPACE_GIT_TURN_REVIEW_EVENT, { detail: id }));
  await act(async () => settle("thread-2"));
  assert.equal(calls.length, 2);
  relative = "src/after.ts";
  await act(async () => settle("thread-1"));
  await waitForUpdate();
  assert.ok(container.querySelector('[role="treeitem"][title="after.ts"]'));
  assert.equal(calls.length, 4);
});

test("diff layout and wrapping are shared and survive remounting the file reader", async (t) => {
  const { root, container } = mount(t);
  const client = { status: async () => gitStatus(), diff: async () => ({}) };
  function Preferences() {
    const [, setPresentation] = useWorkspaceGitPresentation();
    return React.createElement("button", {
      onClick: () => setPresentation({ layout: "split", wrapLines: false }),
    }, "Change presentation");
  }
  const render = (key) => act(async () => root.render(
    React.createElement(React.Fragment, null,
      React.createElement(Preferences),
      React.createElement(WorkspaceFileDiff, {
        key, active: true, client, workdir: "C:/repo/src", hideComparisonMenu: true,
      }),
    ),
  ));
  await render("review");
  await act(async () => container.querySelector("button").click());
  assert.deepEqual(presentations.at(-1), { layout: "split", wrapLines: false });
  await render("file");
  assert.deepEqual(presentations.at(-1), { layout: "split", wrapLines: false });
});

const reviewPatch = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 0123abc..f123abc 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,3 @@",
  " import {",
  "-  oldName,",
  "+  newName,",
  ' } from "./module";',
  "",
].join("\n");

test("the review only expands files with complete matching revision content", () => {
  assert.equal(readReviewFileContents(reviewPatch, false), null);
  const contents = readReviewFileContents(reviewPatch, true);
  assert.equal(contents.before, 'import {\n  oldName,\n} from "./module";\n');
  assert.equal(contents.after, 'import {\n  newName,\n} from "./module";\n');
  const partial = reviewPatch.replace("@@ -1,3 +1,3 @@", "@@ -4,3 +4,3 @@");
  assert.equal(readReviewFileContents(partial, true), null);
  assert.ok(sameReviewFileRevision(partial, reviewPatch));
  assert.ok(!sameReviewFileRevision(partial, reviewPatch.replace("f123abc", "f456def")));
  assert.ok(!sameReviewFileRevision(partial, reviewPatch + reviewPatch));
});

test("review filters preserve non-import hunks and the original patch", () => {
  const contents = readReviewFileContents(reviewPatch, true);
  assert.equal(filterReviewHunks(reviewPatch, "src/example.ts", { hideImports: true, contents }), null);
  assert.equal(filterReviewHunks(reviewPatch, "src/example.ts", { hideImports: true }), reviewPatch);
  const stringContents = {
    before: 'const sample = `\n  oldName,\n`;',
    after: 'const sample = `\n  newName,\n`;',
  };
  assert.equal(filterReviewHunks(reviewPatch, "src/example.ts", { hideImports: true, contents: stringContents }), reviewPatch);
  assert.match(reviewPatch, /\+  newName,/);
  assert.equal(buildReviewApplyCommand("diff --git a/a b/a\nBinary files a/a and b/a differ\n"), null);
  const command = buildReviewApplyCommand(reviewPatch);
  assert.ok(command.includes(reviewPatch));
  assert.match(command, /git apply --3way <<'ZEROAGENT_PATCH'/);
});

test("diff rows retain quoted Unicode paths and use the original path for deleted files", () => {
  const deleted = [
    'diff --git "a/src/\\345\\217\\230\\346\\233\\264.md" "b/src/\\345\\217\\230\\346\\233\\264.md"',
    "deleted file mode 100644",
    '--- "a/src/\\345\\217\\230\\346\\233\\264.md"',
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-# old",
  ].join("\n");
  assert.deepEqual(getPatchFileNames(deleted, "fallback"), {
    oldFileName: "src/变更.md",
    newFileName: "/dev/null",
  });
  assert.equal(buildPatchChunks(deleted, "Changes")[0].label, "src/变更.md");
});

test("changes toolbar selects display options and copies only the exact underlying patch", async (t) => {
  const { container, root } = mount(t);
  const copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text) => copied.push(text) } });
  t.after(() => delete navigator.clipboard);
  const calls = [];
  const client = {
    supportsFullDiffContext: true,
    status: async () => gitStatus(),
    diff: async (...args) => {
      calls.push(args);
      return { patch: reviewPatch };
    },
  };
  await act(async () => root.render(React.createElement(WorkspaceFileDiff, {
    active: true, client, workdir: "C:/repo/src",
  })));
  await waitForUpdate();
  assert.match(container.textContent, /\+1/);
  const options = [...container.querySelectorAll("button")].find((button) => /^(Changes options|变更选项)$/.test(button.getAttribute("aria-label")));
  await act(async () => options.click());
  const hideImports = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find((item) => /Hide imports|隐藏导入内容/.test(item.textContent));
  await act(async () => hideImports.click());
  assert.equal(currentWorkspaceReview.presentation.hideImports, true);
  await act(async () => options.click());
  const copy = [...document.querySelectorAll('[role="menuitem"]')].find((item) => /(?:Copy|复制) git apply/.test(item.textContent));
  await act(async () => copy.click());
  assert.equal(copied.length, 1);
  assert.ok(copied[0].includes(reviewPatch));
  const contents = await currentWorkspaceReview.loadFileContents(buildPatchChunks(reviewPatch, "Changes")[0]);
  assert.match(contents.after, /newName/);
  assert.deepEqual(calls, [
    ["C:/repo/src", "working_tree", "src", { paginateLarge: true }],
    ["C:/repo/src", "working_tree", "src/example.ts", { fullContext: true }],
  ]);
});

test("the comparison menu applies radio selections and exposes the base branch as a separate control", async (t) => {
  const { container, root } = mount(t);
  const calls = [];
  const state = { ...gitStatus(), head: "feature" };
  const client = {
    status: async () => state,
    branches: async () => ({
      state,
      branches: [{ name: "main", fullName: "refs/heads/main", current: false }],
    }),
    diff: async (_workdir, mode) => {
      calls.push(mode);
      return { patch: reviewPatch, baseRef: "main" };
    },
  };
  await act(async () => root.render(React.createElement(WorkspaceFileDiff, {
    active: true, client, workdir: "C:/repo/src",
  })));
  const findButton = (label) => [...container.querySelectorAll("button")]
    .find((button) => label.test(button.getAttribute("aria-label")));
  const selectRadio = async (itemLabel) => {
    const item = [...document.querySelectorAll('[role="menuitemradio"]')]
      .find((entry) => itemLabel.test(entry.textContent.trim()));
    assert.ok(item);
    await act(async () => item.click());
  };

  const scope = findButton(/^(Comparison source|比较范围)$/);
  await act(async () => scope.click());
  await selectRadio(/^(Staged|已暂存)$/);
  await waitForUpdate();
  assert.equal(calls.at(-1), "staged");
  assert.match(scope.textContent, /^(Staged|已暂存)/);
  assert.equal(findButton(/^(Base branch|基线分支)$/), undefined);

  await act(async () => scope.click());
  await selectRadio(/^(This branch|分支)$/);
  await waitForUpdate();
  assert.equal(calls.at(-1), "branch");
  const base = findButton(/^(Base branch|基线分支)$/);
  assert.ok(base);
  await act(async () => base.click());
  await selectRadio(/^main$/);
  await waitForUpdate();
  assert.equal(calls.at(-1), "branch:refs/heads/main");
  assert.equal(base.textContent, "main");
});
