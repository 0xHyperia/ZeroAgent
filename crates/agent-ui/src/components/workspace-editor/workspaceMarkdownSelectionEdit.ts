import type { ProjectToolTextGenerationClient } from "../../lib/ai/projectToolTextGeneration";
import { workspaceMarkdownEditorText } from "./workspaceMarkdownDocument";

export const MARKDOWN_EDIT_INSTRUCTION_LIMIT = 1200;
export const MARKDOWN_EDIT_TEXT_LIMIT = 32_768;
const EDIT_CONTEXT_SIDE_LIMIT = 4096;
const WORKSPACE_EDIT_BYTE_LIMIT = 3 * 1024 * 1024;

export type WorkspaceMarkdownEditRange = { from: number; to: number; revision: number };

export function markdownEditRequest(
  document: string,
  range: WorkspaceMarkdownEditRange,
  rawInstruction: string,
) {
  const { from, to } = range;
  const instruction = rawInstruction.trim();
  const selected = document.slice(from, to);
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from >= to ||
    to > document.length ||
    !selected.trim() ||
    selected.length > MARKDOWN_EDIT_TEXT_LIMIT ||
    !instruction ||
    instruction.length > MARKDOWN_EDIT_INSTRUCTION_LIMIT
  )
    return null;
  return {
    selected,
    request: {
      output: "json",
      systemPrompt: [
        "Rewrite only the selected Markdown source according to the instruction.",
        "Use the neighboring excerpts as reference data. Preserve surrounding syntax, language and indentation.",
        'Return one JSON object with only a string field named "replacement". An empty replacement deletes the selection.',
        "Do not return explanations, enclosing Markdown fences, the entire document, or any edit outside the selection.",
      ].join(" "),
      userPrompt: JSON.stringify({
        instruction,
        selected,
        preceding: document.slice(Math.max(0, from - EDIT_CONTEXT_SIDE_LIMIT), from),
        following: document.slice(to, to + EDIT_CONTEXT_SIDE_LIMIT),
      }),
    } satisfies Parameters<ProjectToolTextGenerationClient["generate"]>[0],
  };
}

export function parseMarkdownEditReplacement(response: string, original: string) {
  if (response.length > MARKDOWN_EDIT_TEXT_LIMIT * 6 + 64) return null;
  let value: unknown;
  try {
    value = JSON.parse(response);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("replacement" in value) ||
    Object.keys(value).length !== 1 ||
    typeof value.replacement !== "string" ||
    value.replacement.length > MARKDOWN_EDIT_TEXT_LIMIT ||
    value.replacement.includes("\0")
  )
    return null;
  // A BOM belongs to the file boundary. It isn't stripped from a selected span.
  const replacement = value.replacement.replace(/\r\n?/g, "\n");
  return replacement === original ? null : replacement;
}

export function markdownEditWithinFileLimit(source: string) {
  return new TextEncoder().encode(source).length <= WORKSPACE_EDIT_BYTE_LIMIT;
}

export function isInlineMarkdownEdit(before: string, after: string) {
  return (
    before.length + after.length <= 4000 &&
    workspaceMarkdownEditorText(before).split("\n", 41).length <= 40 &&
    workspaceMarkdownEditorText(after).split("\n", 41).length <= 40
  );
}
