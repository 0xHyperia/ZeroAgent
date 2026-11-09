/** CodeMirror stores lines with LF and leaves the BOM outside the editable document. */
export function workspaceMarkdownEditorText(source: string) {
  return source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export type MarkdownSourceEdit = { from: number; to: number; insert: string };

/** Apply editor UTF-16 ranges to the original file without rewriting untouched bytes. */
export function applyWorkspaceMarkdownEdits(source: string, edits: readonly MarkdownSourceEdit[]) {
  if (!edits.length) return source;
  const leadingBom = source.startsWith("\uFEFF") ? 1 : 0;
  const fallbackLineEnding = source.match(/\r\n?|\n/)?.[0] ?? "\n";
  let rawOffset = leadingBom;
  let editorOffset = 0;
  let outputEnd = 0;
  let lineEnding = fallbackLineEnding;
  const parts: string[] = [];
  const locate = (offset: number) => {
    while (editorOffset < offset) {
      const character = source[rawOffset++];
      if (character === "\r" || character === "\n") {
        lineEnding = character === "\r" && source[rawOffset] === "\n" ? "\r\n" : character;
        if (lineEnding === "\r\n") rawOffset++;
      }
      editorOffset++;
    }
    return rawOffset;
  };
  for (const edit of edits) {
    const from = locate(edit.from);
    const firstEnding = lineEnding;
    const to = locate(edit.to);
    // Reuse endings from replaced lines where possible, falling back to the
    // surrounding line's style for any newly inserted lines.
    const removedEndings = source.slice(from, to).match(/\r\n?|\n/g) ?? [];
    let nextEnding = 0;
    parts.push(
      source.slice(outputEnd, from),
      edit.insert.replace(/\n/g, () => removedEndings[nextEnding++] ?? firstEnding),
    );
    outputEnd = to;
  }
  parts.push(source.slice(outputEnd));
  return parts.join("");
}
