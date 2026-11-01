import { sheetColumnName } from "./previewGeometry";
import {
  SHEET_HEADER,
  type SheetCell,
  type SheetCellStyle,
  type SheetModel,
  type SheetRange,
  sheetOffsets,
} from "./sheetModel";

export type SheetGeometry = { x: number[]; y: number[]; cells: Map<string, SheetCell> };
export type SheetView = {
  width: number;
  height: number;
  left: number;
  top: number;
  zoom: number;
  headers: boolean;
  selection?: SheetRange;
  active?: { row: number; column: number };
};

function wrapLines(ctx: CanvasRenderingContext2D, text: string, width: number, wrap: boolean) {
  if (!wrap) return text.split(/\r?\n/);
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    // Keep Latin words together where possible; CJK naturally breaks between characters.
    for (const token of paragraph.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\s]+\s*|\s+/gu,
    ) ?? [""]) {
      if (line && ctx.measureText(line + token).width > width) {
        lines.push(line);
        line = "";
      }
      if (ctx.measureText(token).width > width) {
        for (const char of token) {
          if (line && ctx.measureText(line + char).width > width) {
            lines.push(line);
            line = "";
          }
          line += char;
        }
      } else line += token;
    }
    lines.push(line);
  }
  return lines;
}

/** Retain explicit row sizes, expanding only where wrapped text would otherwise be clipped. */
export function layoutSheetGeometry(
  model: SheetModel,
  ctx: CanvasRenderingContext2D | null,
): SheetGeometry {
  const x = sheetOffsets(model.widths);
  const heights = [...model.heights];
  if (ctx)
    for (const cell of model.cells) {
      const style = model.styles[cell.style];
      if (!cell.text || !style.wrap || !heights[cell.row] || !model.widths[cell.column]) continue;
      const merge = model.merges.find((m) => cell.row === m.r1 && cell.column === m.c1);
      if (merge && merge.r1 !== merge.r2) continue;
      const width =
        x[(merge?.c2 ?? cell.column) + 1] - x[cell.column] - 4 - style.indent * style.size;
      ctx.font = `${style.italic ? "italic " : ""}${style.bold ? "bold " : ""}${style.size}px "${style.font}", Arial, sans-serif`;
      const lines = wrapLines(ctx, cell.text, Math.max(1, width), true).length;
      heights[cell.row] = Math.min(
        2000,
        Math.max(heights[cell.row], Math.ceil(lines * style.size * 1.2)),
      );
    }
  return {
    x,
    y: sheetOffsets(heights),
    cells: new Map(model.cells.map((cell) => [`${cell.row}:${cell.column}`, cell])),
  };
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  cell: SheetCell | undefined,
  style: SheetCellStyle,
  x: number,
  y: number,
  width: number,
  height: number,
  zoom: number,
) {
  if (style.fill) {
    ctx.fillStyle = style.fill;
    ctx.fillRect(x, y, width, height);
  }
  if (cell?.text) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 1, y + 1, width - 2, height - 2);
    ctx.clip();
    const size = style.size * zoom;
    ctx.font = `${style.italic ? "italic " : ""}${style.bold ? "bold " : ""}${size}px "${style.font}", Arial, sans-serif`;
    ctx.fillStyle = style.color;
    ctx.textAlign = style.align;
    ctx.textBaseline = "top";
    const padding = Math.max(2, 2 * zoom),
      indent = style.indent * size;
    const lines = wrapLines(ctx, cell.text, Math.max(1, width - padding * 2 - indent), style.wrap);
    const lineHeight = size * 1.2;
    let top =
      style.vertical === "top"
        ? y + padding
        : style.vertical === "middle"
          ? y + (height - lines.length * lineHeight) / 2
          : y + height - padding - lines.length * lineHeight;
    top = Math.max(y + padding, top);
    const left =
      style.align === "center"
        ? x + width / 2
        : style.align === "right"
          ? x + width - padding - indent
          : x + padding + indent;
    for (const line of lines.slice(0, Math.ceil(height / Math.max(1, lineHeight)))) {
      ctx.fillText(line, left, top);
      if (style.underline || style.strike) {
        const lineWidth = ctx.measureText(line).width;
        const start =
          style.align === "center"
            ? left - lineWidth / 2
            : style.align === "right"
              ? left - lineWidth
              : left;
        ctx.strokeStyle = style.color;
        ctx.lineWidth = Math.max(0.5, zoom);
        ctx.beginPath();
        ctx.moveTo(start, top + size * (style.strike ? 0.5 : 1));
        ctx.lineTo(start + lineWidth, top + size * (style.strike ? 0.5 : 1));
        ctx.stroke();
      }
      top += lineHeight;
    }
    ctx.restore();
  }
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    const border = style.borders?.[edge];
    if (!border) continue;
    ctx.strokeStyle = border.color;
    ctx.lineWidth = border.width * zoom;
    ctx.setLineDash(border.dash?.map((n) => n * zoom) ?? []);
    const [x1, y1, x2, y2] =
      edge === "top"
        ? [x, y, x + width, y]
        : edge === "bottom"
          ? [x, y + height, x + width, y + height]
          : edge === "left"
            ? [x, y, x, y + height]
            : [x + width, y, x + width, y + height];
    ctx.beginPath();
    ctx.moveTo(x1 + 0.5, y1 + 0.5);
    ctx.lineTo(x2 + 0.5, y2 + 0.5);
    ctx.stroke();
    if (border.double) {
      ctx.lineWidth = Math.max(0.5, zoom);
      ctx.beginPath();
      const shift = 2 * zoom;
      ctx.moveTo(
        x1 + (edge === "left" ? shift : edge === "right" ? -shift : 0),
        y1 + (edge === "top" ? shift : edge === "bottom" ? -shift : 0),
      );
      ctx.lineTo(
        x2 + (edge === "left" ? shift : edge === "right" ? -shift : 0),
        y2 + (edge === "top" ? shift : edge === "bottom" ? -shift : 0),
      );
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

/** Same inert pixel renderer for the reader and the cropped composer cover. */
export function paintSheet(
  ctx: CanvasRenderingContext2D,
  model: SheetModel,
  geometry: SheetGeometry,
  view: SheetView,
) {
  const { width, height, left, top, zoom, selection, active } = view;
  const hw = view.headers ? SHEET_HEADER.width : 0,
    hh = view.headers ? SHEET_HEADER.height : 0;
  const { x, y, cells } = geometry;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.rect(hw, hh, width - hw, height - hh);
  ctx.clip();
  const visibleRows = model.heights.flatMap((h, r) =>
    h > 0 && y[r + 1] * zoom > top && y[r] * zoom < top + height - hh ? [r] : [],
  );
  const visibleCols = model.widths.flatMap((w, c) =>
    w > 0 && x[c + 1] * zoom > left && x[c] * zoom < left + width - hw ? [c] : [],
  );
  const merges = new Set<SheetRange>();
  for (const r of visibleRows)
    for (const c of visibleCols) {
      const merge = model.merges.find((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2);
      if (merge) {
        merges.add(merge);
        continue;
      }
      const px = hw + x[c] * zoom - left,
        py = hh + y[r] * zoom - top;
      const w = model.widths[c] * zoom,
        h = (y[r + 1] - y[r]) * zoom;
      ctx.strokeStyle = "#e7e7e7";
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, w, h);
      const cell = cells.get(`${r}:${c}`);
      drawCell(ctx, cell, model.styles[cell?.style ?? 0], px, py, w, h, zoom);
    }
  for (const m of merges) {
    const px = hw + x[m.c1] * zoom - left,
      py = hh + y[m.r1] * zoom - top;
    const w = (x[m.c2 + 1] - x[m.c1]) * zoom,
      h = (y[m.r2 + 1] - y[m.r1]) * zoom;
    ctx.fillStyle = "#fff";
    ctx.fillRect(px, py, w, h);
    ctx.strokeStyle = "#e7e7e7";
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, w, h);
    const cell = cells.get(`${m.r1}:${m.c1}`);
    drawCell(ctx, cell, model.styles[cell?.style ?? 0], px, py, w, h, zoom);
  }
  if (selection) {
    const sx = hw + x[selection.c1] * zoom - left,
      sy = hh + y[selection.r1] * zoom - top;
    const sw = (x[selection.c2 + 1] - x[selection.c1]) * zoom,
      sh = (y[selection.r2 + 1] - y[selection.r1]) * zoom;
    ctx.fillStyle = "rgba(53,116,237,.10)";
    ctx.fillRect(sx, sy, sw, sh);
    if (active) {
      const merge = model.merges.find((m) => m.r1 === active.row && m.c1 === active.column);
      ctx.clearRect(
        hw + x[active.column] * zoom - left + 1,
        hh + y[active.row] * zoom - top + 1,
        (x[(merge?.c2 ?? active.column) + 1] - x[active.column]) * zoom - 2,
        (y[(merge?.r2 ?? active.row) + 1] - y[active.row]) * zoom - 2,
      );
      // A translucent active cell preserves original formatting and text.
      const cell = cells.get(`${active.row}:${active.column}`);
      ctx.fillStyle = "#fff";
      ctx.fillRect(
        hw + x[active.column] * zoom - left + 1,
        hh + y[active.row] * zoom - top + 1,
        (x[(merge?.c2 ?? active.column) + 1] - x[active.column]) * zoom - 2,
        (y[(merge?.r2 ?? active.row) + 1] - y[active.row]) * zoom - 2,
      );
      drawCell(
        ctx,
        cell,
        model.styles[cell?.style ?? 0],
        hw + x[active.column] * zoom - left,
        hh + y[active.row] * zoom - top,
        (x[(merge?.c2 ?? active.column) + 1] - x[active.column]) * zoom,
        (y[(merge?.r2 ?? active.row) + 1] - y[active.row]) * zoom,
        zoom,
      );
    }
    ctx.strokeStyle = "#3574ed";
    ctx.lineWidth = 2;
    ctx.strokeRect(sx + 1, sy + 1, Math.max(0, sw - 2), Math.max(0, sh - 2));
  }
  ctx.restore();
  if (!view.headers) return;
  ctx.font = "12px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f5f5f5";
  ctx.fillRect(0, 0, width, hh);
  ctx.fillRect(0, 0, hw, height);
  ctx.strokeStyle = "#d6d6d6";
  ctx.lineWidth = 1;
  for (const c of visibleCols) {
    const px = hw + x[c] * zoom - left,
      w = model.widths[c] * zoom;
    const selected = !!selection && c >= selection.c1 && c <= selection.c2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.max(hw, px), 0, Math.max(0, Math.min(w, px + w - hw)), hh);
    ctx.clip();
    if (selected) {
      ctx.fillStyle = "#d7e2f3";
      ctx.fillRect(px, 0, w, hh);
    }
    ctx.fillStyle = selected ? "#254e8e" : "#666";
    ctx.fillText(sheetColumnName(c), px + w / 2, hh / 2);
    ctx.strokeStyle = "#ddd";
    ctx.strokeRect(px + 0.5, 0.5, w, hh);
    ctx.restore();
  }
  for (const r of visibleRows) {
    const py = hh + y[r] * zoom - top,
      h = (y[r + 1] - y[r]) * zoom;
    const selected = !!selection && r >= selection.r1 && r <= selection.r2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, Math.max(hh, py), hw, Math.max(0, Math.min(h, py + h - hh)));
    ctx.clip();
    if (selected) {
      ctx.fillStyle = "#d7e2f3";
      ctx.fillRect(0, py, hw, h);
    }
    ctx.fillStyle = selected ? "#254e8e" : "#666";
    ctx.fillText(String(r + 1), hw / 2, py + h / 2);
    ctx.strokeStyle = "#ddd";
    ctx.strokeRect(0.5, py + 0.5, hw, h);
    ctx.restore();
  }
  ctx.fillStyle = "#eee";
  ctx.fillRect(0, 0, hw, hh);
  ctx.strokeStyle = "#d6d6d6";
  ctx.strokeRect(0.5, 0.5, hw, hh);
}
