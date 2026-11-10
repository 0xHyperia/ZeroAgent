import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const ui = "@liveagent/ui/components/project-tools/";
const diffViewPath = fileURLToPath(
  new URL("../../../agent-ui/src/components/project-tools/git-review/DiffView.tsx", import.meta.url),
);
let review;
let displayedDiff;
const env = await createDomTestEnv({
  mocks: {
    [diffViewPath]: {
      DiffContent(props) {
        review = props.workspaceReview;
        displayedDiff = props.diff;
        return null;
      },
    },
  },
});
const { React, act, createRoot, loadModule } = env;
const { WorkspaceFileDiff } = loadModule(`${ui}WorkspaceFileDiff.tsx`);
const { useWorkspaceGitPresentation } = loadModule(`${ui}workspaceGitReviewState.ts`);
const { GitBinaryReviewPreview, gitReviewPreviewKind } = loadModule(
  `${ui}git-review/GitBinaryReviewPreview.tsx`,
);
test.after(() => env.cleanup());

const png = (byte) => ({ mime: "image/png", base64: Buffer.from([byte]).toString("base64") });
const patch = [
  "diff --git a/src/a.png b/src/a.png",
  `index ${"a".repeat(40)}..${"b".repeat(40)} 100644`,
  "Binary files a/src/a.png and b/src/a.png differ",
].join("\n");

function mount(t) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, render: (element) => act(async () => root.render(element)) };
}

test("binary format dispatch follows the packaged review toggle", () => {
  assert.equal(gitReviewPreviewKind("photo.PNG", false), "image");
  assert.equal(gitReviewPreviewKind("doc.pdf", false), "pdf");
  assert.equal(gitReviewPreviewKind("icon.svg", false), null);
  assert.equal(gitReviewPreviewKind("icon.svg", true), "image");
  assert.equal(gitReviewPreviewKind("archive.zip", true), null);
});

test("the selected Git comparison and row identity control the preview request", async (t) => {
  const { render } = mount(t);
  const calls = [];
  const response = {
    patch,
    binaryFiles: ["src/a.png"],
    files: ["src/a.png"],
  };
  const client = {
    status: async () => ({ status: "ready", repoRoot: "C:/repo" }),
    commitDiff: async () => response,
    lastTurnDiff: async () => ({ ...response, snapshotId: "turn-review-a" }),
    readDiffPreview: async (request) => {
      calls.push(request);
      return { before: png(1), after: png(2) };
    },
  };
  const open = async (comparison) => {
    await render(React.createElement(WorkspaceFileDiff, {
      active: true,
      client,
      workdir: "C:/repo/src",
      comparison,
      conversationId: "conversation-a",
    }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 135)));
  };
  await open("commit:abcdef0");
  assert.equal(review.rows.length, 1);
  assert.deepEqual(await review.loadBinaryPreview(review.rows[0]), { before: png(1), after: png(2) });
  await open("last-turn");
  await review.loadBinaryPreview(review.rows[0]);
  assert.deepEqual(
    calls.map(({ comparison, path, expectedPatch, snapshotId }) => ({
      comparison, path, expectedPatch, snapshotId,
    })),
    [
      { comparison: "commit:abcdef0", path: "src/a.png", expectedPatch: patch, snapshotId: undefined },
      { comparison: "last-turn", path: "src/a.png", expectedPatch: patch, snapshotId: "turn-review-a" },
    ],
  );
  assert.equal(await review.loadBinaryPreview({ label: "elsewhere/secret.png", chunk: patch }), null);
  assert.equal(calls.length, 2);
});

test("inline image comparison ignores retired results and releases original bytes", async (t) => {
  const { host, render } = mount(t);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const created = [];
  const revoked = [];
  URL.createObjectURL = (blob) => {
    created.push(blob);
    return `blob:fixture/${created.length}`;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
  t.after(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });
  let resolveOld;
  const old = () => new Promise((resolve) => { resolveOld = resolve; });
  const next = async () => ({ before: null, after: png(12) });
  const deleted = async () => ({ before: png(13), after: null });
  const item = { key: "a", label: "src/a.png", chunk: patch };
  const open = (load) => render(React.createElement(GitBinaryReviewPreview, {
    item, kind: "image", load,
  }));
  await open(old);
  assert.match(host.querySelector('[role="status"]').textContent, /Loading preview|正在加载预览/);
  await open(next);
  assert.equal(host.querySelector("[data-after-only]").dataset.afterOnly, "true");
  assert.equal(host.querySelectorAll("section").length, 1);
  assert.deepEqual([...new Uint8Array(await created[0].arrayBuffer())], [12]);
  await act(async () => resolveOld({ before: png(10), after: png(11) }));
  assert.equal(created.length, 1);
  await open(deleted);
  assert.equal(host.querySelectorAll("section").length, 2);
  assert.match(host.textContent, /No image|无图像预览/);
  await render(null);
  assert.deepEqual(revoked, ["blob:fixture/1", "blob:fixture/2"]);
});

test("whitespace uses the selected snapshot and retains the original binary identity", async (t) => {
  const { host, render } = mount(t);
  const requests = [];
  let setOptions;
  let wrongSnapshot = false;
  const raw = {
    snapshotId: "turn-a",
    patch: patch + "\ndiff --git a/src/spacing.ts b/src/spacing.ts\n@@ -1 +1 @@\n-const a=0;\n+const a = 0;\n",
    binaryFiles: ["src/a.png"],
    files: ["src/a.png", "src/spacing.ts"],
  };
  const filtered = { ...raw, files: ["src/a.png"], patch };
  const client = {
    supportsWhitespaceDiff: true,
    status: async () => ({ status: "ready", repoRoot: "C:/repo" }),
    lastTurnDiff: async (_root, _conversation, _path, options) => {
      requests.push(options);
      return options?.hideWhitespace ? {
        ...filtered,
        snapshotId: wrongSnapshot ? "turn-b" : filtered.snapshotId,
      } : raw;
    },
    readDiffPreview: async (request) => {
      requests.push(request);
      return { before: png(1), after: png(2) };
    },
  };
  function Harness() {
    [, setOptions] = useWorkspaceGitPresentation();
    return React.createElement(WorkspaceFileDiff, {
      active: true,
      client,
      workdir: "C:/repo/src",
      comparison: "last-turn",
      conversationId: "conversation-a",
    });
  }
  await render(React.createElement(Harness));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 135)));
  assert.equal(displayedDiff, raw);
  await act(async () => setOptions({ hideWhitespace: true }));
  assert.equal(displayedDiff.patch, filtered.patch);
  await review.loadBinaryPreview(review.rows[0]);
  assert.equal(requests.at(-1).expectedPatch, patch);
  assert.equal(requests.at(-1).snapshotId, "turn-a");
  await act(async () => setOptions({ hideWhitespace: false }));
  wrongSnapshot = true;
  await act(async () => setOptions({ hideWhitespace: true }));
  assert.equal(displayedDiff, raw);
  assert.match(host.textContent, /Showing the original diff|已显示原始差异/);
  await act(async () => setOptions({ hideWhitespace: false }));
});
