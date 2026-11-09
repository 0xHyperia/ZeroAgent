import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
test.after(() => env.cleanup());
const { isInlineMarkdownEdit, markdownEditRequest, markdownEditWithinFileLimit, parseMarkdownEditReplacement } =
  env.loadModule("@liveagent/ui/components/workspace-editor/workspaceMarkdownSelectionEdit.ts");
const { applyWorkspaceMarkdownEdits, workspaceMarkdownEditorText } =
  env.loadModule("@liveagent/ui/components/workspace-editor/workspaceMarkdownDocument.ts");

test("Markdown edit requests contain one exact selection and bounded neighboring text", () => {
  const left = "private prefix" + "x".repeat(6000);
  const chosen = "**selected 🙂**";
  const right = "y".repeat(6000) + "private suffix";
  const text = left + chosen + right;
  const range = { from: left.length, to: left.length + chosen.length, revision: 1 };
  const result = markdownEditRequest(text, range, "  Keep the emphasis  ");
  assert.equal(result.selected, chosen);
  assert.equal(result.request.output, "json");
  assert.deepEqual(JSON.parse(result.request.userPrompt), {
    selected: chosen,
    instruction: "Keep the emphasis",
    preceding: "x".repeat(4096),
    following: "y".repeat(4096),
  });
  for (const invalid of [
    { from: -1, to: 2 }, { from: 0, to: 0 }, { from: 0.5, to: 2 }, { from: 0, to: text.length + 1 },
  ]) {
    assert.equal(markdownEditRequest(text, { ...range, ...invalid }, "Edit"), null);
  }
  assert.equal(markdownEditRequest(text, range, "  "), null);
  assert.equal(markdownEditRequest(text, range, "x".repeat(1201)), null);
  assert.equal(markdownEditRequest("x".repeat(32769), { from: 0, to: 32769, revision: 1 }, "Edit"), null);
});

test("Markdown model responses permit exact replacement or deletion only", () => {
  assert.equal(parseMarkdownEditReplacement('{"replacement":"  new\\r\\n"}', "old"), "  new\n");
  assert.equal(parseMarkdownEditReplacement('{"replacement":""}', "old"), "");
  for (const response of [
    "old", "null", "[]", '{"replacement":false}', '{"replacement":"old"}',
    '{"replacement":"new","path":"other.md"}', '{"replacement":"\\u0000"}',
  ]) {
    assert.equal(parseMarkdownEditReplacement(response, "old"), null);
  }
  assert.equal(isInlineMarkdownEdit("x".repeat(3999), "y"), true);
  assert.equal(isInlineMarkdownEdit("x".repeat(4000), "y"), false);
  assert.equal(isInlineMarkdownEdit("x\n".repeat(40), "y"), false);
  assert.equal(markdownEditWithinFileLimit("x".repeat(3 * 1024 * 1024)), true);
  assert.equal(markdownEditWithinFileLimit("🙂".repeat(3 * 1024 * 1024 / 4 + 1)), false);
});

test("accepting a Markdown edit preserves bytes outside the selected range", () => {
  const source = "\uFEFF# Heading\r\n\rold 🙂\n untouched";
  const editorText = workspaceMarkdownEditorText(source);
  const from = editorText.indexOf("old");
  const to = from + "old 🙂".length;
  assert.equal(
    applyWorkspaceMarkdownEdits(source, [{ from, to, insert: "new" }]),
    "\uFEFF# Heading\r\n\rnew\n untouched",
  );
});
