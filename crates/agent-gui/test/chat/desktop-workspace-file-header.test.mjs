import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const nativeCalls = [];
const icon = "data:image/png;base64,iVBORw0KGgo=";
const wordApps = {
  defaultApplication: { id: "word", name: "Word", iconDataUrl: icon },
  alternatives: [{ id: "writer", name: "Writer", iconDataUrl: icon }],
};
const pdfApps = {
  defaultApplication: { id: "edge", name: "Microsoft Edge", iconDataUrl: icon },
  alternatives: [{ id: "reader", name: "PDF Reader", iconDataUrl: icon }],
};
let fileApplications = (path) =>
  path.endsWith(".docx") ? wordApps : path.endsWith(".pdf") ? pdfApps : {
    defaultApplication: { id: "notepad", name: "Notepad" },
    alternatives: [],
  };
const env = await createDomTestEnv({
  mocks: {
    [fileURLToPath(new URL("../../../agent-ui/src/lib/tools/fsBackend.ts", import.meta.url))]: {
      invokeFs: async (command, payload) => {
        nativeCalls.push({ command, payload });
        if (command === "fs_workspace_editor_targets") return ["vscode"];
        if (command === "fs_workspace_file_apps") return fileApplications(payload.path);
        if (command === "fs_list") return { entries: [] };
      },
    },
  },
});
const { React, act, createRoot, loadModule } = env;
const { createPortal } = loadModule("react-dom");
const { WorkspaceFileHeader } = loadModule(
  "../agent-ui/src/components/project-tools/WorkspaceFileHeader.tsx",
);
const { WorkspaceDiffNavigation } = loadModule(
  "../agent-ui/src/components/project-tools/git-review/WorkspaceDiffNavigation.tsx",
);
test.after(() => env.cleanup());

const file = {
  id: 1,
  projectPathKey: "d:/repo",
  workdir: "D:/repo",
  path: "docs/guides/README.md",
  line: 12,
  column: 2,
};
const findButton = (container, label) =>
  [...container.querySelectorAll("button")].find((button) => label.test(button.ariaLabel ?? ""));

function mount(t) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, root };
}

test("file tools remain available in the compact header and keep their reader state", async (t) => {
  const { container, root } = mount(t);
  container.dataset.slot = "sheet-popup";
  let resize;
  const previousObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe(element) {
      if (element.hasAttribute("data-desktop-workspace-file-header")) {
        resize = (width) => this.callback([{ contentRect: { width } }]);
      }
    }
    unobserve() {}
    disconnect() {}
  };
  t.after(() => {
    globalThis.ResizeObserver = previousObserver;
  });

  function Harness() {
    const [target, setTarget] = React.useState(null);
    const [page, setPage] = React.useState(1);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(WorkspaceFileHeader, {
        active: true,
        request: file,
        modeActions: null,
        setFormatTools: setTarget,
        onOpenFile() {},
        onError() {},
        readDraft() {},
        beforeOpen: async () => true,
      }),
      target && createPortal(
        React.createElement("button", { type: "button", onClick: () => setPage(page + 1) }, `Page ${page}`),
        target,
      ),
    );
  }

  await act(async () => root.render(React.createElement(Harness)));
  const pageButton = () => [...document.body.querySelectorAll("button")].find(
    (button) => /^Page \d+$/.test(button.textContent),
  );
  assert.equal(pageButton()?.textContent, "Page 1");
  assert.ok(container.contains(pageButton()));
  await act(async () => pageButton().click());
  await act(async () => pageButton().focus());
  await act(async () => resize(420));
  const overflow = findButton(container, /^(File controls|文件控件)$/);
  assert.ok(overflow);
  assert.equal(document.activeElement, overflow);
  assert.equal(overflow.hidden, false);
  await act(async () => overflow.click());
  assert.equal(overflow.getAttribute("aria-expanded"), "true");
  assert.equal(pageButton()?.textContent, "Page 2");
  const controls = pageButton().closest("[data-popover-content], [data-slot=popover-content]");
  assert.ok(controls);
  assert.ok(container.contains(controls), "compact tools stay in the full-width reader sheet");
  await act(async () => pageButton().click());
  await act(async () => pageButton().focus());
  await act(async () => resize(760));
  assert.ok(container.contains(pageButton()));
  assert.equal(pageButton().textContent, "Page 3");
  assert.ok(container.querySelector(".za-workspace-file-tool-group").contains(document.activeElement));
});

test("preview and comparison actions share one file tool group and tree toggle", async (t) => {
  const { container, root } = mount(t);
  function Harness() {
    const [diff, setDiff] = React.useState(false);
    const [tree, setTree] = React.useState(true);
    return React.createElement(WorkspaceFileHeader, {
      active: true,
      request: file,
      modeActions: React.createElement("button", { onClick: () => setDiff(!diff) }, diff ? "Hide changes" : "Show changes"),
      viewAction: React.createElement("button", {}, "View source"),
      comparisonActions: diff && React.createElement("button", {}, "Diff layout"),
      fileTree: { open: tree, toggle: () => setTree(!tree) },
      setFormatTools() {},
      onOpenFile() {},
      onError() {},
      readDraft() {},
      beforeOpen: async () => true,
    });
  }

  await act(async () => root.render(React.createElement(Harness)));
  const group = container.querySelector(".za-workspace-file-tool-group");
  const mode = container.querySelector(".za-workspace-file-mode-actions button");
  const tree = findButton(group, /^(Toggle file tree|切换文件树)$/);
  assert.equal(group.querySelectorAll("button").length, 5);
  assert.ok(findButton(group, /Open with|打开方式/));
  assert.ok(findButton(group, /Notepad/));
  assert.ok(!group.contains(mode));
  assert.equal(tree.getAttribute("aria-pressed"), "true");
  await act(async () => tree.click());
  await act(async () => mode.click());
  assert.equal(mode.textContent, "Hide changes");
  assert.equal(tree.getAttribute("aria-pressed"), "false");
  assert.ok([...group.querySelectorAll("button")].some((button) => button.textContent === "Diff layout"));
});

test("the device file header retains file tools without looking up host applications", async (t) => {
  const { container, root } = mount(t);
  const callsBefore = nativeCalls.length;
  await act(async () =>
    root.render(React.createElement(WorkspaceFileHeader, {
      active: true,
      request: file,
      nativeFileActions: false,
      modeActions: null,
      fileTree: { open: false, toggle() {} },
      setFormatTools() {},
      onOpenFile() {},
      onError() {},
      readDraft() {},
      beforeOpen: async () => true,
    })),
  );
  assert.ok(findButton(container, /Toggle file tree|切换文件树/));
  assert.equal(findButton(container, /Open with|打开方式/), undefined);
  assert.equal(nativeCalls.length, callsBefore);
});

test("change navigation uses the side of split diff rows", async (t) => {
  const { container, root } = mount(t);
  const review = document.createElement("section");
  document.body.append(review);
  t.after(() => review.remove());
  review.innerHTML = `
    <div data-review-scroll-viewport>
      <div data-review-hunk-anchors="old:3,new:14">
        <table><tbody><tr data-side="old"><td><span data-line-num="3">3</span></td></tr></tbody></table>
        <table><tbody><tr data-side="new"><td><span data-line-num="14">14</span></td></tr></tbody></table>
      </div>
    </div>
  `;
  const viewport = review.firstElementChild;
  viewport.getBoundingClientRect = () => ({ top: 20 });
  [...review.querySelectorAll("tr")].forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: 140 + index * 300 - viewport.scrollTop });
  });

  await act(async () =>
    root.render(React.createElement(WorkspaceDiffNavigation, { root: { current: review } })),
  );
  const previous = findButton(container, /Previous change|上一处变更/);
  const next = findButton(container, /Next change|下一处变更/);
  assert.match(container.textContent, /2/);
  assert.equal(previous.disabled, true);
  await act(async () => next.click());
  assert.equal(viewport.scrollTop, 120);
  assert.equal(container.querySelector("[role=status]").textContent, "1/2");
  await act(async () => next.click());
  assert.equal(viewport.scrollTop, 420);
  assert.equal(container.querySelector("[role=status]").textContent, "2/2");
  assert.equal(next.disabled, true);
  await act(async () => previous.click());
  assert.equal(viewport.scrollTop, 120);
});

test("the installed editor opens the original path only after the current editor is saved", async (t) => {
  const { container, root } = mount(t);
  let canOpen = false;
  const checks = [];
  await act(async () => root.render(React.createElement(WorkspaceFileHeader, {
    active: true,
    request: file,
    modeActions: null,
    setFormatTools() {},
    onOpenFile() {},
    onError() {},
    readDraft() {},
    beforeOpen: async () => {
      checks.push(canOpen);
      return canOpen;
    },
  })));

  const openEditor = async () => {
    await act(async () => findButton(container, /Open with|打开方式/).click());
    const editor = [...document.querySelectorAll('[role="menuitem"]')]
      .find((item) => item.textContent === "VS Code");
    assert.ok(editor);
    await act(async () => editor.click());
  };
  await openEditor();
  assert.deepEqual(nativeCalls.filter(({ command }) => command === "fs_open_workspace_editor"), []);
  canOpen = true;
  await openEditor();
  assert.deepEqual(checks, [false, true]);
  assert.deepEqual(nativeCalls.filter(({ command }) => command === "fs_open_workspace_editor"), [
    {
      command: "fs_open_workspace_editor",
      payload: {
        workdir: "D:/repo",
        path: "docs/guides/README.md",
        editor: "vscode",
        line: 12,
        column: 2,
      },
    },
  ]);
});

test("reader applications and icons follow the current file and preserve the system default", async (t) => {
  const { container, root } = mount(t);
  const start = nativeCalls.length;
  const show = async (path) => act(async () => root.render(React.createElement(WorkspaceFileHeader, {
    active: true,
    request: { ...file, path },
    modeActions: null,
    setFormatTools() {},
    onOpenFile() {},
    onError() {},
    readDraft() {},
    beforeOpen: async () => true,
  })));
  const menu = async () => {
    const trigger = findButton(container, /Open with|打开方式/);
    if (trigger.getAttribute("aria-expanded") !== "true") await act(async () => trigger.click());
    return [...document.querySelectorAll('[role="menuitem"]')];
  };
  await show("draft.docx");
  assert.equal(findButton(container, /Word/).querySelector("img").getAttribute("src"), icon);
  const docChoices = await menu();
  assert.match(docChoices[0].textContent, /Word.*(?:默认应用|Default)/);
  const writer = docChoices.find((item) => item.textContent === "Writer");
  assert.equal(writer.querySelector("img").getAttribute("src"), icon);
  assert.ok(!docChoices.some((item) => item.textContent === "VS Code"));
  await act(async () => writer.click());
  assert.ok(findButton(container, /Word/));
  await act(async () => findButton(container, /Word/).click());
  await show("manual.pdf");
  assert.equal(findButton(container, /Word/), undefined);
  assert.ok(findButton(container, /Microsoft Edge/));
  const pdfChoices = await menu();
  assert.ok(pdfChoices.some((item) => item.textContent === "PDF Reader"));
  assert.ok(!pdfChoices.some((item) => item.textContent === "Writer"));
  assert.deepEqual(nativeCalls.slice(start).filter(({ command }) => command.startsWith("fs_open")), [
    { command: "fs_open_workspace_file_app", payload: { workdir: "D:/repo", path: "draft.docx", application: "writer" } },
    { command: "fs_open_workspace_path", payload: { workdir: "D:/repo", path: "draft.docx", mode: "open" } },
  ]);
  assert.ok(!nativeCalls.slice(start).some(({ command }) => command === "fs_workspace_editor_targets"));
});

test("a stale association lookup cannot replace the current file applications", async (t) => {
  const { container, root } = mount(t);
  const lookup = fileApplications;
  let finish;
  fileApplications = (path) =>
    path.endsWith(".docx") ? new Promise((resolve) => { finish = resolve; }) : lookup(path);
  t.after(() => { fileApplications = lookup; });
  const show = async (path) => act(async () => root.render(React.createElement(WorkspaceFileHeader, {
    active: true, request: { ...file, path }, modeActions: null,
    setFormatTools() {}, onOpenFile() {}, onError() {}, readDraft() {},
    beforeOpen: async () => true,
  })));
  await show("draft.docx");
  await show("manual.pdf");
  assert.ok(findButton(container, /Microsoft Edge/));
  await act(async () => finish(wordApps));
  assert.ok(findButton(container, /Microsoft Edge/));
  assert.equal(findButton(container, /Word/), undefined);
});
