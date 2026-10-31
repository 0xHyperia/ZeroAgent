import type { PreviewZoom } from "./readingSession";

/** Percentages refer to original content dimensions, independently of the pane size. */
export function previewScale(
  zoom: PreviewZoom,
  content: { width: number; height: number },
  pane: { width: number; height: number },
) {
  const width = Math.max(1, pane.width - 32);
  const height = Math.max(1, pane.height - 32);
  if (zoom === "fit-width") return width / content.width;
  if (zoom === "fit-page") return Math.min(width / content.width, height / content.height);
  return Math.max(0.1, Math.min(4, zoom / 100));
}

export function boundedPreviewScale(scale: number, content: { width: number; height: number }) {
  return Math.min(
    scale,
    4096 / Math.max(content.width, content.height),
    Math.sqrt(12_000_000 / (content.width * content.height)),
  );
}

export function parseSheetCoordinate(value: string, rows: number, columns: number) {
  const match = /^([A-Z]{1,2})([1-9]\d{0,2})$/.exec(value.trim().toUpperCase());
  if (!match) return null;
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (row > rows || column > columns) return null;
  return { row: row - 1, column: column - 1, name: `${match[1]}${row}` };
}

export function sheetColumnName(index: number) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}
