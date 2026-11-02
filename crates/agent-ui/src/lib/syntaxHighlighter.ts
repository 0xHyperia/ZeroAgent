import { createHighlighter } from "shiki";

/** Shared grammar cache contains public syntax definitions, never documents or rendered tokens. */
let highlighter: ReturnType<typeof createHighlighter> | undefined;
export function getSyntaxHighlighter() {
  highlighter ??= createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: [],
  }).catch((error) => {
    highlighter = undefined;
    throw error;
  });
  return highlighter;
}
