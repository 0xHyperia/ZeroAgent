import { createHighlighter, type ThemeRegistrationRaw } from "shiki";

export const MARKDOWN_CODE_THEMES = ["github-light", "github-dark"] as const;
export const DEFAULT_MARKDOWN_CODE_LANGUAGE = "markdown";
export const SOURCE_LIGHT_THEME = "zeroagent-source-light";
export const SOURCE_DARK_THEME = "zeroagent-source-dark";

function sourceTheme(
  name: string,
  type: "light" | "dark",
  palette: {
    foreground: string;
    background: string;
    keyword: string;
    string: string;
    comment: string;
    number: string;
    name: string;
    function: string;
  },
): ThemeRegistrationRaw {
  return {
    name,
    type,
    colors: { "editor.foreground": palette.foreground, "editor.background": palette.background },
    settings: [
      { settings: { foreground: palette.foreground, background: palette.background } },
      { scope: "source.python", settings: { foreground: palette.name } },
      { scope: ["keyword", "storage"], settings: { foreground: palette.keyword } },
      { scope: ["punctuation", "keyword.operator"], settings: { foreground: palette.foreground } },
      {
        scope: "keyword.operator.logical",
        settings: { foreground: palette.keyword },
      },
      {
        scope: ["string", "punctuation.definition.string", "constant.character"],
        settings: { foreground: palette.string },
      },
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: palette.comment, fontStyle: "italic" },
      },
      {
        scope: ["constant.numeric", "constant.language", "constant.character.escape"],
        settings: { foreground: palette.number },
      },
      {
        scope: [
          "entity.name.namespace",
          "variable.parameter",
          "constant.other.caps",
          "support.constant",
        ],
        settings: { foreground: palette.name },
      },
      {
        scope: [
          "entity.name.function",
          "entity.name.type",
          "support.function",
          "support.type",
          "entity.name.tag",
        ],
        settings: { foreground: palette.function },
      },
    ],
  };
}

const sourceLight = sourceTheme(SOURCE_LIGHT_THEME, "light", {
  foreground: "#24292E",
  background: "#FFFFFF",
  keyword: "#CA2A39",
  string: "#237C15",
  comment: "#627068",
  number: "#315FD3",
  name: "#B4540A",
  function: "#7439B7",
});

const sourceDark = sourceTheme(SOURCE_DARK_THEME, "dark", {
  foreground: "#DCE0E6",
  background: "#1E1E1E",
  keyword: "#FF8493",
  string: "#A4D88C",
  comment: "#9EAFA4",
  number: "#92B5FF",
  name: "#EDAD76",
  function: "#C9A5FB",
});

/** Shared grammar cache contains public syntax definitions, never documents or rendered tokens. */
let highlighter: ReturnType<typeof createHighlighter> | undefined;
export function getSyntaxHighlighter() {
  highlighter ??= createHighlighter({
    themes: [...MARKDOWN_CODE_THEMES, sourceLight, sourceDark],
    langs: [],
  }).catch((error) => {
    highlighter = undefined;
    throw error;
  });
  return highlighter;
}
