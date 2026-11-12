import type { XlsxCellRange, XlsxScrollerRenderProps } from "@extend-ai/react-xlsx";

export type SheetGrid = NonNullable<XlsxScrollerRenderProps["gridGeometry"]>;
type Axis = SheetGrid["rows"];
type Viewport = { width: number; height: number; left: number; top: number };

function freezeEdge(axis: Axis) {
  return axis.header + (axis.offsets[axis.frozenCount] ?? axis.offsets.at(-1) ?? 0);
}

function axisIndex(axis: Axis, point: number, scroll: number) {
  if (point < axis.header) return null;
  const coordinate = point - axis.header + (point < freezeEdge(axis) ? 0 : scroll);
  let low = 0;
  let high = axis.offsets.length - 1;
  if (high <= 0 || coordinate >= (axis.offsets[high] ?? 0)) return null;
  // Use the last edge at this position so hidden rows and columns have no hit area.
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if ((axis.offsets[mid] ?? Infinity) <= coordinate) low = mid;
    else high = mid;
  }
  return low;
}

export function sheetGridCellAt(grid: SheetGrid, viewport: HTMLElement, x: number, y: number) {
  const rect = viewport.getBoundingClientRect();
  const localX = x - rect.left;
  const localY = y - rect.top;
  if (localX >= viewport.clientWidth || localY >= viewport.clientHeight) return null;
  const col = axisIndex(grid.cols, localX, viewport.scrollLeft);
  const row = axisIndex(grid.rows, localY, viewport.scrollTop);
  return col === null || row === null ? null : { row, col };
}

function projectAxis(axis: Axis, from: number, to: number, scroll: number, viewportEnd: number) {
  const parts: { start: number; end: number; frozen: boolean }[] = [];
  const frozenEnd = freezeEdge(axis);
  const lastCell = axis.offsets.length - 2;
  for (const frozen of [true, false]) {
    const first = Math.max(from, frozen ? 0 : axis.frozenCount);
    const last = Math.min(to, frozen ? axis.frozenCount - 1 : lastCell, lastCell);
    if (first > last) continue;
    const origin = axis.header - (frozen ? 0 : scroll);
    const startOffset = axis.offsets[first];
    const endOffset = axis.offsets[last + 1];
    if (startOffset === undefined || endOffset === undefined) continue;
    const start = Math.max(origin + startOffset, frozen ? axis.header : frozenEnd);
    const end = Math.min(origin + endOffset, frozen ? frozenEnd : viewportEnd, viewportEnd);
    if (end > start) parts.push({ start, end, frozen });
  }
  return parts;
}

/** Each frozen quadrant is clipped separately so scrolled cells cannot cover frozen cells. */
export function projectSheetRange(grid: SheetGrid, range: XlsxCellRange, viewport: Viewport) {
  const rows = projectAxis(
    grid.rows,
    range.start.row,
    range.end.row,
    viewport.top,
    viewport.height,
  );
  const cols = projectAxis(
    grid.cols,
    range.start.col,
    range.end.col,
    viewport.left,
    viewport.width,
  );
  return rows.flatMap((row) =>
    cols.map((col) => ({
      key: `${row.frozen}:${col.frozen}`,
      left: col.start,
      top: row.start,
      width: col.end - col.start,
      height: row.end - row.start,
    })),
  );
}

export function expandSheetRange(range: XlsxCellRange, merges: readonly XlsxCellRange[]) {
  let current = range;
  for (;;) {
    let next = current;
    for (const merge of merges) {
      if (
        merge.start.row > next.end.row ||
        merge.end.row < next.start.row ||
        merge.start.col > next.end.col ||
        merge.end.col < next.start.col ||
        (merge.start.row >= next.start.row &&
          merge.end.row <= next.end.row &&
          merge.start.col >= next.start.col &&
          merge.end.col <= next.end.col)
      )
        continue;
      next = {
        start: {
          row: Math.min(next.start.row, merge.start.row),
          col: Math.min(next.start.col, merge.start.col),
        },
        end: {
          row: Math.max(next.end.row, merge.end.row),
          col: Math.max(next.end.col, merge.end.col),
        },
      };
    }
    if (next === current) return next;
    current = next;
  }
}

export function spansSheetCells(range: XlsxCellRange, merges: readonly XlsxCellRange[]) {
  return (
    (range.start.row !== range.end.row || range.start.col !== range.end.col) &&
    !merges.some(
      ({ start, end }) =>
        start.row <= range.start.row &&
        start.col <= range.start.col &&
        end.row >= range.end.row &&
        end.col >= range.end.col,
    )
  );
}

export function sheetRangeTopRight(parts: ReturnType<typeof projectSheetRange>) {
  return parts.reduce<(typeof parts)[number] | undefined>((corner, part) => {
    const right = part.left + part.width;
    const previousRight = corner ? corner.left + corner.width : -Infinity;
    return !corner || right > previousRight || (right === previousRight && part.top < corner.top)
      ? part
      : corner;
  }, undefined);
}
