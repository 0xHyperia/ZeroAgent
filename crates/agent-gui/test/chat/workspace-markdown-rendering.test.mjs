import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("editable Markdown renders tables, code fences and Mermaid without modifying source", async () => {
  const env = await createDomTestEnv({
    mocks: {
      "../markdown/MarkdownMermaidBlock": {
        MarkdownMermaidBlock: ({ chart }) =>
          env.React.createElement("div", { "data-chart": chart }),
      },
    },
  });
  const previousWindow = globalThis.Window;
  globalThis.Window = window.Window;
  // CodeMirror measures selections even in jsdom.
  window.Range.prototype.getClientRects = () => [];
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  const { React, act, createRoot, loadModule } = env;
  const { default: Editor } = loadModule(
    "@liveagent/ui/components/workspace-editor/WorkspaceMarkdownEditor.tsx",
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef();
  const fence = "`".repeat(3);
  const source = [
    "# Heading",
    "",
    fence + "ts options",
    "const value = 1;",
    fence,
    "",
    "| Name | Quantity |",
    "| --- | --- |",
    "| **Item** | 2 |",
    "| | 3 |",
    "",
    "Alpha **first** and **second**.",
    "",
    "[guide](README.md)",
    "",
    "> " + fence + "mermaid",
    "> flowchart TD",
    ">",
    ">   A --> B",
    "> " + fence,
  ].join("\n");
  const opened = [];
  const changed = [];
  const props = {
    handle,
    active: true,
    mode: "preview",
    readOnly: false,
    theme: "light",
    value: source,
    onOpenLink: (href) => (opened.push(href), true),
    onChange: (value) => changed.push(value),
    onHistory() {},
    onSave() {},
  };

  try {
    await act(async () => root.render(React.createElement(Editor, props)));
    const heading = container.querySelector(".za-md-heading");
    assert.equal(heading.textContent, "Heading");
    assert.ok(!heading.querySelector("span:not(:empty)"));
    const [opening, body, closing] = container.querySelectorAll(".za-md-code-line");
    assert.equal(opening.dataset.language, "ts");
    assert.equal(opening.textContent, "");
    assert.equal(body.textContent, "const value = 1;");
    assert.equal(closing.textContent, "");
    assert.ok(closing.matches(".za-md-code-last"));
    assert.equal(
      container.querySelector(".za-md-mermaid-widget [data-chart]").dataset.chart,
      "flowchart TD\n\n  A --> B",
    );

    const tableRows = [...container.querySelectorAll(".za-md-table-row")];
    assert.deepEqual(
      tableRows.map((row) =>
        [...row.querySelectorAll(":scope > .za-md-table-cell")].map((cell) => cell.textContent),
      ),
      [["Name", "Quantity"], ["Item", "2"], ["", "3"]],
    );
    assert.ok(tableRows.every((row) => !row.textContent.includes("|")));
    assert.equal(container.querySelector(".za-md-table-separator").textContent, "");

    const link = container.querySelector("[data-workspace-markdown-href]");
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, shiftKey: true }));
    assert.deepEqual(opened, []);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    assert.deepEqual(opened, ["README.md"]);

    await act(async () => handle.current.revealLine(12, 2));
    await act(async () => handle.current.revealLine(12, 10));
    const editorLine = (text) =>
      [...container.querySelectorAll(".cm-line")].find((line) => line.textContent.includes(text));
    assert.equal(editorLine("Alpha").textContent, "Alpha **first** and second.");
    await act(async () => handle.current.revealLine(9, 1));
    assert.ok(editorLine("Item").textContent.startsWith("| "));
    assert.ok(!editorLine("Item").classList.contains("za-md-table-row"));
    await act(async () => handle.current.revealLine(3, 1));
    assert.equal(editorLine("ts options").textContent, fence + "ts options");

    await act(async () => root.render(React.createElement(Editor, { ...props, mode: "source" })));
    assert.equal(container.querySelector(".za-md-mermaid-widget"), null);
    assert.equal(editorLine("flowchart TD").textContent, "> flowchart TD");
    assert.equal(editorLine("Heading").textContent, "# Heading");
    assert.equal(editorLine("Quantity").textContent, "| Name | Quantity |");
    assert.equal(handle.current.getValue(), source);
    assert.deepEqual(changed, []);
  } finally {
    await act(async () => root.unmount());
    if (previousWindow === undefined) delete globalThis.Window;
    else globalThis.Window = previousWindow;
    env.cleanup();
  }
});

test("Markdown editor commands preserve the selection and reject a paste after leaving the file", async () => {
  const copied = [];
  const errors = [];
  let copySucceeds = true;
  const env = await createDomTestEnv({
    mocks: {
      "../../lib/shared/clipboard": {
        copyTextToClipboard: async (text) => {
          if (copySucceeds) copied.push(text);
          return copySucceeds;
        },
      },
      "../ui/toast-manager": { toast: { error: (message) => errors.push(message) } },
    },
  });
  const previousWindow = globalThis.Window;
  globalThis.Window = window.Window;
  window.Range.prototype.getClientRects = () => [];
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  const { React, act, createRoot, loadModule } = env;
  const { default: Editor } = loadModule(
    "@liveagent/ui/components/workspace-editor/WorkspaceMarkdownEditor.tsx",
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef();
  const props = {
    handle,
    active: true,
    mode: "preview",
    readOnly: false,
    theme: "light",
    value: "# Heading\r\nBody\r\nLast line",
    onChange() {},
    onHistory() {},
    onSave() {},
  };

  try {
    await act(async () => root.render(React.createElement(Editor, props)));
    const editor = handle.current;
    await act(async () => editor.revealLine(2, 1, 2));
    assert.deepEqual(editor.selectedLines(), { startLine: 2, endLine: 2 });
    copySucceeds = false;
    await act(async () => editor.copySelection(true));
    await act(async () => editor.pasteSelection(async () => null));
    assert.equal(errors.length, 2);
    assert.equal(editor.getValue(), props.value);
    copySucceeds = true;
    await act(async () => editor.copySelection(true));
    assert.deepEqual(copied, ["Body"]);
    assert.equal(editor.getValue(), "# Heading\r\n\r\nLast line");
    await act(async () => editor.undo());
    assert.equal(editor.getValue(), props.value);
    await act(async () => editor.redo());
    assert.equal(editor.getValue(), "# Heading\r\n\r\nLast line");
    await act(async () => editor.pasteSelection(async () => "New\r\nbody"));
    assert.equal(editor.getValue(), "# Heading\r\nNew\r\nbody\r\nLast line");

    let finishRead;
    const pendingPaste = editor.pasteSelection(
      () => new Promise((resolve) => { finishRead = resolve; }),
    );
    await act(async () =>
      root.render(React.createElement(Editor, { ...props, active: false, value: editor.getValue() })),
    );
    await act(async () => {
      finishRead("stale");
      await pendingPaste;
    });
    assert.equal(editor.getValue(), "# Heading\r\nNew\r\nbody\r\nLast line");
  } finally {
    await act(async () => root.unmount());
    if (previousWindow === undefined) delete globalThis.Window;
    else globalThis.Window = previousWindow;
    env.cleanup();
  }
});
