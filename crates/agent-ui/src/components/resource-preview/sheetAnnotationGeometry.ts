import type { XlsxCellRange } from "@extend-ai/react-xlsx";

type Freeze = { row: number; col: number };
type AxisCell = { index: number; start: number; end: number };
type Axis = {
  cells: AxisCell[];
  frozenCount: number;
  headerEnd: number;
  freezeEnd: number;
  viewportEnd: number;
};

function measureAxis(
  elements: Iterable<Element>,
  axis: "row" | "col",
  origin: number,
  viewportEnd: number,
  headerEnd: number,
  frozenCount: number,
): Axis {
  let freezeEnd = headerEnd;
  const cells: AxisCell[] = [];
  for (const element of elements) {
    const index = Number(
      element.getAttribute(axis === "row" ? "data-xlsx-row" : "data-xlsx-col-header"),
    );
    // A row header is sticky in a frozen row. The enclosing <tr> itself scrolls.
    const rect = (axis === "row" ? element.firstElementChild : element)?.getBoundingClientRect();
    if (!rect) continue;
    const start = (axis === "row" ? rect.top : rect.left) - origin;
    const end = (axis === "row" ? rect.bottom : rect.right) - origin;
    if (index < frozenCount) freezeEnd = Math.max(freezeEnd, end);
    if (start < viewportEnd && end > headerEnd) cells.push({ index, start, end });
  }
  return { cells, frozenCount, headerEnd, freezeEnd, viewportEnd };
}

/** The DOM grid can grow beyond the engine's nominal row heights to fit content. */
export function measureSheetGrid(viewport: HTMLElement, freeze: Freeze) {
  const header = viewport.querySelector("thead th");
  if (!header) return null;
  const corner = header.getBoundingClientRect();
  const view = viewport.getBoundingClientRect();
  return {
    rows: measureAxis(
      viewport.querySelectorAll("tr[data-xlsx-row]"),
      "row",
      view.top,
      viewport.clientHeight,
      corner.bottom - view.top,
      freeze.row,
    ),
    cols: measureAxis(
      viewport.querySelectorAll("[data-xlsx-col-header]"),
      "col",
      view.left,
      viewport.clientWidth,
      corner.right - view.left,
      freeze.col,
    ),
  };
}

type SheetGrid = NonNullable<ReturnType<typeof measureSheetGrid>>;

function projectAxis(axis: Axis, from: number, to: number) {
  const parts: { start: number; end: number; frozen: boolean }[] = [];
  for (const frozen of [true, false]) {
    const clipStart = frozen ? axis.headerEnd : axis.freezeEnd;
    const clipEnd = frozen ? Math.min(axis.freezeEnd, axis.viewportEnd) : axis.viewportEnd;
    let start = Infinity;
    let end = -Infinity;
    for (const cell of axis.cells) {
      if (cell.index < axis.frozenCount !== frozen || cell.index < from || cell.index > to)
        continue;
      start = Math.min(start, cell.start);
      end = Math.max(end, cell.end);
    }
    start = Math.max(start, clipStart);
    end = Math.min(end, clipEnd);
    if (end > start) parts.push({ start, end, frozen });
  }
  return parts;
}

/** Each frozen quadrant is clipped separately so scrolled cells cannot cover frozen cells. */
export function projectSheetRange(grid: SheetGrid | null, range: XlsxCellRange) {
  if (!grid) return [];
  const rows = projectAxis(grid.rows, range.start.row, range.end.row);
  const cols = projectAxis(grid.cols, range.start.col, range.end.col);
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
