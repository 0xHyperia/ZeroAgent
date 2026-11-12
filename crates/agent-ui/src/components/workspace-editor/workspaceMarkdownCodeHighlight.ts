import { syntaxTree } from "@codemirror/language";
import { type Range, StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { ThemedToken } from "shiki";
import {
  COLLAPSED_CODE_BLOCK_CHARACTER_THRESHOLD,
  COLLAPSED_CODE_BLOCK_MAX_LINE_CHARACTERS,
} from "../../lib/markdownCodeBlockPolicy";
import { normalizeSourceLanguage } from "../../lib/sourceLanguages";
import {
  DEFAULT_MARKDOWN_CODE_LANGUAGE,
  getSyntaxHighlighter,
  MARKDOWN_CODE_THEMES,
} from "../../lib/syntaxHighlighter";

type CodePart = { from: number; to: number };
type CodeBlock = {
  language: NonNullable<ReturnType<typeof normalizeSourceLanguage>>;
  parts: CodePart[];
  code: string;
};

function visibleCodeBlocks(view: EditorView) {
  const { state } = view;
  const tree = syntaxTree(state);
  const blocks = new Map<number, CodeBlock>();
  for (const visible of view.visibleRanges) {
    tree.iterate({
      ...visible,
      enter({ name, from, to, node }) {
        if (name !== "FencedCode" && name !== "CodeBlock") return;
        if (blocks.has(from) || to - from > COLLAPSED_CODE_BLOCK_CHARACTER_THRESHOLD) return false;
        const info = node.getChild("CodeInfo");
        const fence = info
          ? state.sliceDoc(info.from, info.to).trim().split(/\s+/, 1)[0].toLowerCase()
          : "";
        if (fence === "mermaid" || fence === "mmd") return false;
        const language = normalizeSourceLanguage(fence || DEFAULT_MARKDOWN_CODE_LANGUAGE);
        if (!language || language === "plaintext") return false;

        // CodeText leaves Markdown quote and list prefixes outside the grammar input.
        const parts = node.getChildren("CodeText");
        const code = parts.map((part) => state.sliceDoc(part.from, part.to)).join("");
        if (
          code &&
          !code.split("\n").some((line) => line.length > COLLAPSED_CODE_BLOCK_MAX_LINE_CHARACTERS)
        ) {
          blocks.set(from, { language, parts, code });
        }
        return false;
      },
    });
  }
  return blocks.values();
}

function addTokenMarks(parts: CodePart[], lines: ThemedToken[][], marks: Range<Decoration>[]) {
  let partIndex = 0;
  let partOffset = 0;
  for (const tokens of lines) {
    for (const { offset, content, htmlStyle } of tokens) {
      const light = htmlStyle?.color;
      if (typeof light !== "string" || !content.trim()) continue;
      const dark = htmlStyle?.["--shiki-dark"] ?? light;
      const mark = Decoration.mark({
        class: "za-md-code-token",
        attributes: { style: `--za-md-token-light:${light};--za-md-token-dark:${dark}` },
      });
      const end = offset + content.length;
      while (partIndex < parts.length && partOffset < end) {
        const part = parts[partIndex];
        const length = part.to - part.from;
        const start = Math.max(0, offset - partOffset);
        const stop = Math.min(length, end - partOffset);
        if (start < stop) marks.push(mark.range(part.from + start, part.from + stop));
        if (stop < length) break;
        partOffset += length;
        partIndex += 1;
      }
    }
  }
}

const applyCodeHighlights = StateEffect.define<DecorationSet>();

export const workspaceMarkdownCodeHighlight = ViewPlugin.fromClass(
  class {
    decorations = Decoration.none;
    private timer?: ReturnType<typeof setTimeout>;
    private revision = 0;
    private cache = new Map<string, ThemedToken[][]>();

    constructor(readonly view: EditorView) {
      this.schedule(0);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = this.decorations.map(update.changes);
      for (const transaction of update.transactions) {
        for (const effect of transaction.effects) {
          if (effect.is(applyCodeHighlights)) this.decorations = effect.value;
        }
      }
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.schedule(75);
      }
    }

    destroy() {
      clearTimeout(this.timer);
      this.revision += 1;
    }

    private schedule(delay: number) {
      clearTimeout(this.timer);
      const revision = ++this.revision;
      this.timer = setTimeout(() => void this.highlight(revision), delay);
    }

    private async highlight(revision: number) {
      const marks: Range<Decoration>[] = [];
      const cache = new Map<string, ThemedToken[][]>();
      for (const { language, parts, code } of visibleCodeBlocks(this.view)) {
        const key = `${language}\n${code}`;
        let lines = cache.get(key) ?? this.cache.get(key);
        if (!lines) {
          try {
            const engine = await getSyntaxHighlighter();
            await engine.loadLanguage(language);
            if (revision !== this.revision) return;
            lines = engine.codeToTokens(code, {
              lang: language,
              themes: { light: MARKDOWN_CODE_THEMES[0], dark: MARKDOWN_CODE_THEMES[1] },
            }).tokens;
          } catch {
            if (revision !== this.revision) return;
            continue;
          }
        }
        cache.set(key, lines);
        addTokenMarks(parts, lines, marks);
      }
      this.cache = cache;
      if (marks.length || this.decorations.size) {
        this.view.dispatch({ effects: applyCodeHighlights.of(Decoration.set(marks, true)) });
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
