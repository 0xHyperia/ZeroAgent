import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const componentPath = (name) =>
  fileURLToPath(new URL(`../../../agent-ui/src/components/project-tools/${name}`, import.meta.url));

const presentations = [];
let currentWorkspaceReview;
const env = await createDomTestEnv({
  mocks: {
    [componentPath("file-tree/index.tsx")]: { FileTreePanel: () => null },
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
test.after(() => env.cleanup());

const { RightWorkspaceFileTree } = loadModule("@liveagent/ui/components/project-tools/RightWorkspaceFileTree.tsx");
const { WorkspaceFileDiff } = loadModule("@liveagent/ui/components/project-tools/WorkspaceFileDiff.tsx");
const { RightDockToolContext } = loadModule("@liveagent/ui/components/project-tools/RightDockContext.tsx");
const { WORKSPACE_GIT_TURN_REVIEW_EVENT } = loadModule("@liveagent/ui/components/project-tools/workspaceGitPaths.ts");
const { useWorkspaceGitPresentation } = loadModule("@liveagent/ui/components/project-tools/workspaceGitReviewState.ts");
const { buildPatchChunks, getPatchFileNames } = loadModule("@liveagent/ui/components/project-tools/git-review/model.ts");
const { buildReviewApplyCommand, filterReviewHunks, readReviewFileContents, sameReviewFileRevision } = loadModule("@liveagent/ui/components/project-tools/git-review/workspaceReviewDiff.ts");

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
  const row = container.querySelector('button[title="nested/report.md"]');
  await act(async () => row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
  await act(async () => row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 })));
  assert.deepEqual(opened, ["review", ["C:/repo/src/nested/report.md", true], ["C:/repo/src/nested/report.md", false]]);
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
  assert.ok(container.querySelector('button[title="staged.ts"]'));
  assert.doesNotMatch(container.textContent, /unrelated\.ts/);
  assert.deepEqual(calls.slice(0, 2).map((args) => args.join("|")).sort(), [
    "C:/repo/src|staged|src", "C:/repo/src|staged|src/staged.ts",
  ]);

  await render("commit:0123abcdef", "C:/repo/src/removed.ts");
  assert.doesNotMatch(container.textContent, /staged\.ts/);
  await waitForUpdate();
  assert.ok(container.querySelector('button[title="removed.ts"] [data-workspace-file-decoration="D"]'));
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
  assert.ok(container.querySelector('button[title="before.ts"]'));
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
  assert.ok(container.querySelector('button[title="after.ts"]'));
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
    ["C:/repo/src", "working_tree", "src"],
    ["C:/repo/src", "working_tree", "src/example.ts", { fullContext: true }],
  ]);
});
