import { strFromU8, unzipSync } from "fflate";

/** Call only after inspectPreviewArchive's expanded-byte/path validation.
 * Spreadsheet engines expand merges into cells, so small XML can otherwise allocate an enormous grid.
 * Oversized workbooks keep the existing bounded SheetJS text preview instead. */
export function canReadStyledWorkbook(bytes: Uint8Array) {
  const files = unzipSync(bytes, {
    filter: (file) => /^xl\/worksheets\/[^/]+\.xml$/.test(file.name),
  });
  const column = (name: string) =>
    [...name].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
  let cells = 0,
    mergedCells = 0;
  for (const bytes of Object.values(files)) {
    const xml = strFromU8(bytes);
    // An encoded coordinate is unusual but valid XML; use the bounded fallback for it.
    if (/\b(?:r|ref)\s*=\s*["'][^"']*&/.test(xml)) return false;
    for (const match of xml.matchAll(
      /<(?:\w+:)?(?:c|row)\b[^>]*\br\s*=\s*["']([A-Z]*)(\d+)["']/g,
    )) {
      if (++cells > 250_000 || Number(match[2]) > 100_000 || column(match[1]) > 16_384)
        return false;
    }
    for (const match of xml.matchAll(
      /<(?:\w+:)?dimension\b[^>]*\bref\s*=\s*["'](?:[A-Z]+\d+:)?([A-Z]+)(\d+)["']/g,
    )) {
      if (Number(match[2]) > 100_000 || column(match[1]) > 16_384) return false;
    }
    for (const match of xml.matchAll(
      /<(?:\w+:)?mergeCell\b[^>]*\bref\s*=\s*["']([A-Z]+)(\d+):([A-Z]+)(\d+)["']/g,
    )) {
      if (Number(match[4]) > 100_000 || column(match[3]) > 16_384) return false;
      const area =
        (Number(match[4]) - Number(match[2]) + 1) * (column(match[3]) - column(match[1]) + 1);
      mergedCells += area;
      if (!Number.isSafeInteger(area) || area < 1 || area > 40_000 || mergedCells > 100_000)
        return false;
    }
  }
  return true;
}
