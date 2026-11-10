import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("desktop Markdown lays out tables and fences without modifying source or revealing the whole line", async () => {
  const env = await createDomTestEnv();
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
