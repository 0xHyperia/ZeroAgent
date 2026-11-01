import type { Cell, Color, Style, Workbook, Worksheet } from "exceljs";
import { sheetColumnName } from "./previewGeometry";

export type SheetBorder = { color: string; width: number; dash?: number[]; double?: boolean };
export type SheetCellStyle = {
  font: string;
  size: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color: string;
  fill?: string;
  align: "left" | "center" | "right";
  vertical: "top" | "middle" | "bottom";
  wrap: boolean;
  indent: number;
  borders?: Partial<Record<"top" | "right" | "bottom" | "left", SheetBorder>>;
};
export type SheetCell = {
  row: number;
  column: number;
  text: string;
  formula?: string;
  style: number;
};
export type SheetRange = { r1: number; c1: number; r2: number; c2: number };
export type SheetModel = {
  formatLimited?: boolean;
  name: string;
  widths: number[];
  heights: number[];
  cells: SheetCell[];
  styles: SheetCellStyle[];
  merges: SheetRange[];
  truncated: boolean;
};
export const SHEET_ROWS = 500;
export const SHEET_COLUMNS = 80;
export const SHEET_HEADER = { width: 40, height: 20 };
const themeDefaults = [
  "FFFFFF",
  "000000",
  "EEECE1",
  "1F497D",
  "4F81BD",
  "C0504D",
  "9BBB59",
  "8064A2",
  "4BACC6",
  "F79646",
  "0000FF",
  "800080",
];
const indexed = [
  "000000",
  "FFFFFF",
  "FF0000",
  "00FF00",
  "0000FF",
  "FFFF00",
  "FF00FF",
  "00FFFF",
  "000000",
  "FFFFFF",
  "FF0000",
  "00FF00",
  "0000FF",
  "FFFF00",
  "FF00FF",
  "00FFFF",
  "800000",
  "008000",
  "000080",
  "808000",
  "800080",
  "008080",
  "C0C0C0",
  "808080",
];

export function sheetColor(
  value: (Partial<Color> & { indexed?: number; tint?: number }) | undefined,
  theme = themeDefaults,
  fallback = "#000000",
) {
  if (!value) return fallback;
  const raw =
    value.argb?.slice(-6) ??
    (value.theme !== undefined
      ? theme[value.theme]
      : value.indexed !== undefined
        ? indexed[value.indexed]
        : undefined);
  if (!raw || !/^[0-9a-f]{6}$/i.test(raw)) return fallback;
  const tint = Number.isFinite(value.tint) ? Math.max(-1, Math.min(1, value.tint ?? 0)) : 0;
  return `#${[0, 2, 4]
    .map((offset) => {
      const channel = parseInt(raw.slice(offset, offset + 2), 16);
      return Math.round(tint < 0 ? channel * (1 + tint) : channel + (255 - channel) * tint)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

function workbookTheme(workbook: Workbook) {
  const model = workbook.model as unknown as { themes?: { theme1?: string } };
  const xml = model.themes?.theme1 ?? "";
  const scheme =
    xml.match(/<(?:\w+:)?clrScheme\b[^>]*>([\s\S]*?)<\/(?:\w+:)?clrScheme>/)?.[1] ?? "";
  // Theme files are inert strings. Only six-digit colors are ever passed to the canvas.
  return [
    "lt1",
    "dk1",
    "lt2",
    "dk2",
    "accent1",
    "accent2",
    "accent3",
    "accent4",
    "accent5",
    "accent6",
    "hlink",
    "folHlink",
  ].map((key, i) => {
    const fragment =
      scheme.match(
        new RegExp(`<(?:\\w+:)?${key}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${key}>`),
      )?.[1] ?? "";
    return fragment.match(/(?:lastClr|val)="([\da-f]{6})"/i)?.[1] ?? themeDefaults[i];
  });
}

function border(value: Partial<Style>["border"], theme: string[]) {
  const result: SheetCellStyle["borders"] = {};
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    const source = value?.[edge];
    if (!source?.style) continue;
    result[edge] = {
      color: sheetColor(source.color, theme),
      width: /thick/.test(source.style)
        ? 3
        : /medium|double/.test(source.style)
          ? 2
          : source.style === "hair"
            ? 0.5
            : 1,
      ...(/dash/i.test(source.style)
        ? { dash: [4, 3] }
        : /dot/i.test(source.style)
          ? { dash: [1, 2] }
          : {}),
      ...(source.style === "double" ? { double: true } : {}),
    };
  }
  return result;
}

export function sheetStyle(
  style: Partial<Style> = {},
  theme = themeDefaults,
  numeric = false,
): SheetCellStyle {
  const font = style.font;
  const alignment = style.alignment;
  const fill = style.fill;
  return {
    font: [...(font?.name ?? "Arial")]
      .filter((char) => char.charCodeAt(0) >= 32 && char !== '"' && char !== "\\")
      .join("")
      .slice(0, 100),
    size: Math.max(6, Math.min(128, ((font?.size ?? 11) * 4) / 3)),
    bold: font?.bold,
    italic: font?.italic,
    underline: !!font?.underline,
    strike: font?.strike,
    color: sheetColor(font?.color, theme),
    fill:
      fill?.type === "pattern" && fill.pattern === "solid"
        ? sheetColor(fill.fgColor, theme, "#ffffff")
        : undefined,
    align:
      alignment?.horizontal === "center" || alignment?.horizontal === "centerContinuous"
        ? "center"
        : alignment?.horizontal === "right" || (!alignment?.horizontal && numeric)
          ? "right"
          : "left",
    vertical:
      alignment?.vertical === "top"
        ? "top"
        : alignment?.vertical === "middle"
          ? "middle"
          : "bottom",
    wrap: !!alignment?.wrapText,
    indent: Math.max(0, Math.min(20, alignment?.indent ?? 0)),
    borders: border(style.border, theme),
  };
}

function cellText(
  cell: Cell,
  format: (format: string, value: number, options?: { date1904?: boolean }) => string,
  date1904: boolean,
) {
  const value = cell.value;
  let raw: unknown = value;
  let formula: string | undefined;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    if ("formula" in value || "sharedFormula" in value) {
      formula = `=${cell.formula ?? ""}`;
      raw = "result" in value ? value.result : "";
    } else if ("richText" in value) raw = value.richText.map((run) => run.text).join("");
    else if ("text" in value) raw = value.text;
    else if ("error" in value) raw = value.error;
  }
  let text =
    raw == null
      ? ""
      : raw instanceof Date
        ? raw.toLocaleDateString("zh-CN", { timeZone: "UTC" })
        : String(raw);
  if (
    (typeof raw === "number" || raw instanceof Date) &&
    cell.numFmt &&
    cell.numFmt !== "General"
  ) {
    try {
      const numeric =
        raw instanceof Date ? raw.getTime() / 86400000 + 25569 - (date1904 ? 1462 : 0) : raw;
      text = format(cell.numFmt, numeric, { date1904 });
    } catch {
      /* Keep the saved value for unsupported number formats. */
    }
  }
  return {
    text: text.slice(0, 8192),
    formula: formula?.slice(0, 8192),
    numeric: typeof raw === "number",
  };
}

export function excelSheetModel(
  workbook: Workbook,
  sheet: Worksheet,
  format: Parameters<typeof cellText>[1],
  displayText?: (address: string) => string | undefined,
): SheetModel {
  const rows = Math.max(1, Math.min(SHEET_ROWS, sheet.rowCount));
  const columns = Math.max(1, Math.min(SHEET_COLUMNS, sheet.columnCount));
  const theme = workbookTheme(workbook);
  const styles: SheetCellStyle[] = [sheetStyle()];
  const styleIds = new Map<string, number>([[JSON.stringify(styles[0]), 0]]);
  const cells: SheetCell[] = [];
  let textBudget = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 1; col <= columns; col++) {
      const cell = sheet.getRow(row + 1).getCell(col);
      if (cell.isMerged && cell.master.address !== cell.address) continue;
      const value = cellText(cell, format, !!workbook.properties.date1904);
      value.text = (displayText?.(cell.address) ?? value.text).slice(0, 8192);
      textBudget += value.text.length + (value.formula?.length ?? 0);
      if (textBudget > 4 * 1024 * 1024) throw new Error("工作表文字较多，请下载原件查看。");
      if (!value.text && !value.formula && !Object.keys(cell.style).length) continue;
      const style = sheetStyle(cell.style, theme, value.numeric);
      const key = JSON.stringify(style);
      let id = styleIds.get(key);
      if (id === undefined) {
        id = styles.length;
        styles.push(style);
        styleIds.set(key, id);
      }
      cells.push({ row, column: col - 1, text: value.text, formula: value.formula, style: id });
    }
  }
  const merges: SheetRange[] = [];
  for (const address of (sheet.model.merges ?? []).slice(0, 2000)) {
    const match = address.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!match) continue;
    const col = (name: string) => [...name].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    const range = {
      r1: Number(match[2]) - 1,
      c1: col(match[1]),
      r2: Number(match[4]) - 1,
      c2: col(match[3]),
    };
    if (range.r1 >= rows || range.c1 >= columns) continue;
    merges.push({
      ...range,
      r2: Math.min(rows - 1, range.r2),
      c2: Math.min(columns - 1, range.c2),
    });
  }
  return {
    name: sheet.name,
    widths: Array.from({ length: columns }, (_, i) => {
      const column = sheet.getColumn(i + 1);
      return column.hidden
        ? 0
        : Math.max(
            8,
            Math.min(2000, (column.width ?? sheet.properties.defaultColWidth ?? 8.43) * 8),
          );
    }),
    heights: Array.from({ length: rows }, (_, i) => {
      const row = sheet.getRow(i + 1);
      return row.hidden
        ? 0
        : Math.max(
            4,
            Math.min(2000, ((row.height ?? sheet.properties.defaultRowHeight ?? 15) * 4) / 3),
          );
    }),
    cells,
    styles,
    merges,
    truncated: sheet.rowCount > SHEET_ROWS || sheet.columnCount > SHEET_COLUMNS,
  };
}

export function sheetOffsets(sizes: number[]) {
  const offsets = [0];
  for (const size of sizes) offsets.push(offsets[offsets.length - 1] + size);
  return offsets;
}
export function sheetRangeName(range: SheetRange) {
  const start = `${sheetColumnName(range.c1)}${range.r1 + 1}`;
  const end = `${sheetColumnName(range.c2)}${range.r2 + 1}`;
  return start === end ? start : `${start}:${end}`;
}
export function normalizeSheetRange(a: { row: number; column: number }, b = a): SheetRange {
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.column, b.column),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.column, b.column),
  };
}
export function sheetCellAt(model: SheetModel, row: number, column: number) {
  const merge = model.merges.find(
    (m) => row >= m.r1 && row <= m.r2 && column >= m.c1 && column <= m.c2,
  );
  return { row: merge?.r1 ?? row, column: merge?.c1 ?? column };
}
