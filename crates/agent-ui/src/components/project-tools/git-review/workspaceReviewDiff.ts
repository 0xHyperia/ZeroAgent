import { parser as javascriptParser } from "@lezer/javascript";

const HUNK_START = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BLOB_PAIR = /^index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?$/m;
const IMPORT_CONTEXT_MAX_CHARS = 1_000_000;
const TRAILING_IMPORT_COMMENTS = new Set(["LineComment", "BlockComment", "Comment"]);
const IMPORT_LANGUAGES = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
} as const;
type ImportLanguage = (typeof IMPORT_LANGUAGES)[keyof typeof IMPORT_LANGUAGES];
export type ReviewImportParser = typeof javascriptParser;
const scriptImportParsers = {
  javascript: javascriptParser.configure({ dialect: "jsx" }),
  typescript: javascriptParser.configure({ dialect: "ts" }),
  tsx: javascriptParser.configure({ dialect: "ts jsx" }),
};

export type ReviewFileContents = { before: string; after: string };
type ReviewLineAnchor = { side: "old" | "new"; lineNumber: number };

function importLanguage(path: string): ImportLanguage | undefined {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return Object.hasOwn(IMPORT_LANGUAGES, extension)
    ? IMPORT_LANGUAGES[extension as keyof typeof IMPORT_LANGUAGES]
    : undefined;
}

export async function loadReviewImportParser(
  path: string,
): Promise<ReviewImportParser | undefined> {
  const language = importLanguage(path);
  switch (language) {
    case "javascript":
    case "typescript":
    case "tsx":
      return scriptImportParsers[language];
    case "python":
      return (await import("@lezer/python")).parser;
    case "rust":
      return (await import("@lezer/rust")).parser;
    case "go":
      return (await import("@lezer/go")).parser;
    case "java":
      return (await import("@lezer/java")).parser;
    default:
      return undefined;
  }
}

export function sameReviewFileRevision(original: string, full: string) {
  if (original.split("\ndiff --git ").length !== 1 || full.split("\ndiff --git ").length !== 1)
    return false;
  if (original.trimEnd() === full.trimEnd()) return true;
  const originalPair = BLOB_PAIR.exec(original)?.[0];
  return Boolean(originalPair && originalPair === BLOB_PAIR.exec(full)?.[0]);
}

export function countReviewChanges(patch: string) {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    if (HUNK_START.test(line)) inHunk = true;
    if (!inHunk) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/** Full context is requested for one authorized file. A partial or binary patch cannot
 * serve as a rendered document. Preserve original line endings and missing final LF. */
export function readReviewFileContents(
  patch: string,
  fullContext: boolean,
): ReviewFileContents | null {
  const lines = patch.split("\n");
  const offset = lines.findIndex((line) => HUNK_START.test(line));
  if (offset < 0) return null;
  const header = HUNK_START.exec(lines[offset] ?? "");
  if (!header || (!fullContext && header[1] !== "0")) return null;
  if (Number(header[1]) > 1 || Number(header[3]) > 1) return null;
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let oldHasNewline = true;
  let newHasNewline = true;
  let side = "";
  for (const line of lines.slice(offset + 1)) {
    if (line === "") continue;
    const prefix = line[0] ?? "";
    if (prefix === "\\" && line.startsWith("\\ No newline at end of file")) {
      if (side !== "+") oldHasNewline = false;
      if (side !== "-") newHasNewline = false;
      continue;
    }
    if (prefix !== " " && prefix !== "+" && prefix !== "-") return null;
    if (prefix !== "+") oldLines.push(line.slice(1));
    if (prefix !== "-") newLines.push(line.slice(1));
    side = prefix;
  }
  if (oldLines.length !== Number(header[2] ?? 1) || newLines.length !== Number(header[4] ?? 1))
    return null;
  return {
    before: oldLines.join("\n") + (oldHasNewline && oldLines.length > 0 ? "\n" : ""),
    after: newLines.join("\n") + (newHasNewline && newLines.length > 0 ? "\n" : ""),
  };
}

type ReviewSyntaxNode = ReturnType<ReviewImportParser["parse"]>["topNode"];

function isImportNode(node: ReviewSyntaxNode, language: ImportLanguage) {
  switch (language) {
    case "python":
      return node.name === "ImportStatement";
    case "rust":
      return (
        !node.getChild("Vis") &&
        (node.name === "UseDeclaration" || node.name === "ExternCrateDeclaration")
      );
    case "go":
      return node.name === "ImportDecl";
    default:
      return node.name === "ImportDeclaration";
  }
}

function importLines(source: string, language: ImportLanguage, parser: ReviewImportParser) {
  const imports = new Set<number>();
  if (source.length > IMPORT_CONTEXT_MAX_CHARS) return imports;
  let line = 1;
  let newline = source.indexOf("\n");
  const lineAt = (offset: number) => {
    while (newline !== -1 && newline < offset) {
      line += 1;
      newline = source.indexOf("\n", newline + 1);
    }
    return line;
  };
  const syntax = parser.parse(source);
  for (let node = syntax.topNode.firstChild; node; node = node.nextSibling) {
    if (!isImportNode(node, language)) continue;
    const start = source.lastIndexOf("\n", node.from - 1) + 1;
    const nextLine = source.indexOf("\n", node.to - 1);
    const end = nextLine === -1 ? source.length : nextLine + 1;
    let trailingEnd = node.to;
    for (
      let sibling = node.nextSibling;
      sibling &&
      sibling.from < end &&
      sibling.to <= end &&
      TRAILING_IMPORT_COMMENTS.has(sibling.name) &&
      !source.slice(trailingEnd, sibling.from).trim();
      sibling = sibling.nextSibling
    ) {
      trailingEnd = sibling.to;
    }
    if (source.slice(start, node.from).trim() || source.slice(trailingEnd, end).trim()) continue;
    let hasError = false;
    node.toTree().iterate({
      enter({ type }) {
        if (type.isError) hasError = true;
      },
    });
    if (hasError) continue;
    const first = lineAt(node.from);
    const last = lineAt(node.to - 1);
    for (let current = first; current <= last; current += 1) imports.add(current);
  }
  return imports;
}

function isImportOnlyHunk(
  hunk: string[],
  before: Set<number>,
  after: Set<number>,
  annotatedLines: readonly ReviewLineAnchor[],
) {
  const header = HUNK_START.exec(hunk[0] ?? "");
  if (!header) return false;
  let oldLine = Number(header[1]);
  let newLine = Number(header[3]);
  const oldEnd = oldLine + Number(header[2] ?? 1);
  const newEnd = newLine + Number(header[4] ?? 1);
  if (
    annotatedLines.some(({ side, lineNumber }) =>
      side === "old"
        ? lineNumber >= oldLine && lineNumber < oldEnd
        : lineNumber >= newLine && lineNumber < newEnd,
    )
  )
    return false;
  let changedImport = false;
  for (const line of hunk.slice(1)) {
    if (line.startsWith("+")) {
      if (after.has(newLine)) changedImport = true;
      else if (line.slice(1).trim()) return false;
      newLine += 1;
    } else if (line.startsWith("-")) {
      if (before.has(oldLine)) changedImport = true;
      else if (line.slice(1).trim()) return false;
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return changedImport;
}

/** Hide complete import-only hunks without rewriting the original patch or line anchors. */
export function filterReviewHunks(
  patch: string,
  path: string,
  options: {
    hideImports: boolean;
    contents?: ReviewFileContents | null;
    importParser?: ReviewImportParser;
    annotatedLines?: readonly ReviewLineAnchor[];
  },
) {
  if (
    !options.hideImports ||
    !options.contents ||
    /^(?:new file mode|deleted file mode|--- \/dev\/null|\+\+\+ \/dev\/null)/m.test(patch)
  )
    return patch;
  const language = importLanguage(path);
  if (!language) return patch;
  const parser =
    options.importParser ??
    (language in scriptImportParsers
      ? scriptImportParsers[language as keyof typeof scriptImportParsers]
      : undefined);
  if (!parser) return patch;
  const [header = "", ...hunks] = patch.split(/\n(?=@@ )/);
  const before = importLines(options.contents.before, language, parser);
  const after = importLines(options.contents.after, language, parser);
  const visible = hunks.filter(
    (hunk) => !isImportOnlyHunk(hunk.split("\n"), before, after, options.annotatedLines ?? []),
  );
  if (hunks.length > 0 && visible.length === 0) return null;
  return [header, ...visible].join("\n");
}

export function buildReviewApplyCommand(patch: string) {
  if (!patch.startsWith("diff --git ") || /^Binary files /m.test(patch)) return null;
  const lines = new Set(patch.split(/\r?\n/));
  let marker = "ZEROAGENT_PATCH";
  while (lines.has(marker)) marker += "_";
  const body = patch.endsWith("\n") ? patch : `${patch}\n`;
  return `(cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'${marker}'\n${body}${marker}\n)`;
}
