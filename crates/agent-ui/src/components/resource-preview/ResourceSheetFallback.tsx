import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import FunctionIcon from "~icons/gravity-ui/function";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewScrollArea } from "./PreviewScrollArea";
import { PreviewToolbar, PreviewZoomControl } from "./PreviewToolbar";
import { parseSheetCoordinate, sheetColumnName } from "./previewGeometry";
import { createResourcePreviewWorker } from "./previewWorkerClient";
import { usePreviewReadingState } from "./readingSession";
import { layoutSheetGeometry, paintSheet } from "./sheetCanvas";
import {
  normalizeSheetRange,
  SHEET_HEADER,
  type SheetModel,
  sheetCellAt,
  sheetRangeName,
} from "./sheetModel";

type Position = { row: number; column: number };
type SelectionKind = "cell" | "row" | "column" | "all";
function axisIndex(offsets: number[], value: number) {
  let low = 0,
    high = offsets.length - 2;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid + 1] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

export default function ResourceSheetFallback(
  props: PreviewRecovery & {
    bytes: Uint8Array;
    name: string;
    thumbnail?: boolean;
    assertCurrent: () => void;
    onCancel?: () => void;
  },
) {
  const [sheet, setSheet] = usePreviewReadingState("sheetName", "");
  const [zoom, setZoom] = usePreviewReadingState("sheetZoom", 1);
  const [cell, setCell] = usePreviewReadingState("sheetCell", "A1");
  const [savedRange, setSavedRange] = usePreviewReadingState("sheetRange", cell);
  const [coordinate, setCoordinate] = useState(cell);
  const [notice, setNotice] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [model, setModel] = useState<SheetModel | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [view, setView] = useState({ width: 0, height: 0, top: 0, left: 0 });
  const worker = useRef<ReturnType<typeof createResourcePreviewWorker> | null>(null);
  const sequence = useRef(0);
  const initial = useRef(sheet);
  const scroll = useRef<HTMLDivElement>(null);
  const cover = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<SelectionKind | null>(null);
  const touch = useRef<{ id: number; x: number; y: number } | null>(null);
  const moving = useRef<Position | null>(null);
  const pendingZoom = useRef<{ left: number; top: number } | null>(null);
  const zoomPoint = useRef<{ x: number; y: number } | null>(null);
  const id = useId();
  const { bytes, assertCurrent, thumbnail } = props;
  useEffect(() => {
    const controller = new AbortController();
    const client = createResourcePreviewWorker(controller.signal);
    worker.current = client;
    const seq = ++sequence.current;
    void (async () => {
      let result = await client.request({ type: "load", kind: "sheet", bytes });
      assertCurrent();
      if (controller.signal.aborted || sequence.current !== seq) return;
      const sheets = result.sheetNames ?? [];
      const restored =
        !thumbnail && sheets.includes(initial.current) ? initial.current : (sheets[0] ?? "");
      if (restored && restored !== sheets[0])
        result = await client.request({ type: "sheet", name: restored });
      assertCurrent();
      if (controller.signal.aborted || sequence.current !== seq) return;
      if (!result.sheet) throw new Error("工作表未能打开，请重试或下载原件。");
      setNames(sheets);
      if (!thumbnail) setSheet(restored);
      setModel(result.sheet);
      setBusy(false);
    })().catch((cause) => {
      if (!controller.signal.aborted && sequence.current === seq) {
        setError(cause instanceof Error ? cause.message : "工作表无法打开。");
        setBusy(false);
      }
    });
    return () => {
      sequence.current++;
      controller.abort();
      client.dispose();
      worker.current = null;
    };
  }, [bytes, assertCurrent, setSheet, thumbnail]);
  const geometry = useMemo(
    () =>
      model ? layoutSheetGeometry(model, document.createElement("canvas").getContext("2d")) : null,
    [model],
  );
  const active = model
    ? (parseSheetCoordinate(cell, model.heights.length, model.widths.length) ?? {
        row: 0,
        column: 0,
        name: "A1",
      })
    : { row: 0, column: 0, name: "A1" };
  const selection = useMemo(() => {
    if (!model) return { r1: 0, c1: 0, r2: 0, c2: 0 };
    const [start, end = start] = savedRange.split(":");
    const a = parseSheetCoordinate(start, model.heights.length, model.widths.length) ?? {
      row: active.row,
      column: active.column,
    };
    const b = parseSheetCoordinate(end, model.heights.length, model.widths.length) ?? a;
    return normalizeSheetRange(a, b);
  }, [savedRange, model, active.row, active.column]);
  const selectedCell = geometry?.cells.get(`${active.row}:${active.column}`);
  useEffect(() => {
    setCoordinate(sheetRangeName(selection));
  }, [selection]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the loading state swaps the measured canvas
  useEffect(() => {
    const element = thumbnail ? cover.current : scroll.current;
    if (!element) return;
    const measure = () =>
      setView({
        width: element.clientWidth,
        height: element.clientHeight,
        top: element.scrollTop,
        left: element.scrollLeft,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [thumbnail, !!model]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore the scroll anchor after the zoomed spacer commits
  useLayoutEffect(() => {
    const pending = pendingZoom.current;
    if (!pending || !scroll.current || !model) return;
    pendingZoom.current = null;
    scroll.current.scrollLeft = pending.left;
    scroll.current.scrollTop = pending.top;
    setView((current) => ({
      ...current,
      left: scroll.current?.scrollLeft ?? current.left,
      top: scroll.current?.scrollTop ?? current.top,
    }));
  }, [zoom, model]);
  useLayoutEffect(() => {
    if (!model || !geometry || !canvas.current || !view.width || !view.height) return;
    const context = canvas.current.getContext("2d");
    if (!context) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.current.width = Math.round(view.width * ratio);
    canvas.current.height = Math.round(view.height * ratio);
    context.scale(ratio, ratio);
    paintSheet(context, model, geometry, {
      ...view,
      left: thumbnail ? 0 : view.left,
      top: thumbnail ? 0 : view.top,
      zoom: thumbnail ? view.width / 360 : zoom,
      headers: !thumbnail,
      selection: thumbnail ? undefined : selection,
      active: thumbnail ? undefined : { row: active.row, column: active.column },
    });
  }, [model, geometry, view, zoom, selection, active.row, active.column, thumbnail]);

  function select(
    position: Position,
    extend = false,
    reveal = false,
    kind: SelectionKind = "cell",
  ) {
    if (!model || !geometry) return;
    const target = sheetCellAt(model, position.row, position.column);
    const anchor = extend ? { row: active.row, column: active.column } : target;
    let range = normalizeSheetRange(anchor, target);
    if (kind === "row" || kind === "all") {
      range.c1 = 0;
      range.c2 = model.widths.length - 1;
    }
    if (kind === "column" || kind === "all") {
      range.r1 = 0;
      range.r2 = model.heights.length - 1;
    }
    for (let pass = 0; pass < 3; pass++)
      for (const m of model.merges)
        if (range.r1 <= m.r2 && range.r2 >= m.r1 && range.c1 <= m.c2 && range.c2 >= m.c1) {
          range = {
            r1: Math.min(range.r1, m.r1),
            c1: Math.min(range.c1, m.c1),
            r2: Math.max(range.r2, m.r2),
            c2: Math.max(range.c2, m.c2),
          };
        }
    if (!extend) setCell(`${sheetColumnName(target.column)}${target.row + 1}`);
    setSavedRange(sheetRangeName(range));
    setNotice("");
    if (reveal && scroll.current) {
      const viewport = scroll.current,
        left = geometry.x[target.column] * zoom,
        top = geometry.y[target.row] * zoom;
      if (left < viewport.scrollLeft) viewport.scrollLeft = left;
      else if (
        left + model.widths[target.column] * zoom >
        viewport.scrollLeft + viewport.clientWidth - SHEET_HEADER.width
      )
        viewport.scrollLeft =
          left + model.widths[target.column] * zoom - viewport.clientWidth + SHEET_HEADER.width;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (
        geometry.y[target.row + 1] * zoom >
        viewport.scrollTop + viewport.clientHeight - SHEET_HEADER.height
      )
        viewport.scrollTop =
          geometry.y[target.row + 1] * zoom - viewport.clientHeight + SHEET_HEADER.height;
      setView((current) => ({ ...current, left: viewport.scrollLeft, top: viewport.scrollTop }));
    }
  }
  function hit(clientX: number, clientY: number) {
    if (!geometry || !canvas.current) return null;
    const bounds = canvas.current.getBoundingClientRect();
    const x = clientX - bounds.left,
      y = clientY - bounds.top;
    return {
      row: axisIndex(geometry.y, Math.max(0, (y - SHEET_HEADER.height + view.top) / zoom)),
      column: axisIndex(geometry.x, Math.max(0, (x - SHEET_HEADER.width + view.left) / zoom)),
      kind: (x < SHEET_HEADER.width
        ? y < SHEET_HEADER.height
          ? "all"
          : "row"
        : y < SHEET_HEADER.height
          ? "column"
          : "cell") as SelectionKind,
    };
  }
  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === "touch") {
      touch.current = event.isPrimary
        ? { id: event.pointerId, x: event.clientX, y: event.clientY }
        : null;
      return;
    }
    if (event.button !== 0) return;
    const target = hit(event.clientX, event.clientY);
    if (!target) return;
    event.preventDefault();
    scroll.current?.focus({ preventScroll: true });
    moving.current = null;
    drag.current = target.kind;
    select(target, event.shiftKey, false, target.kind);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent<HTMLCanvasElement>) {
    if (!drag.current || !model) return;
    const target = hit(event.clientX, event.clientY);
    if (!target) return;
    select(target, true, false, drag.current);
    const element = scroll.current,
      rect = canvas.current?.getBoundingClientRect();
    if (element && rect) {
      const dx = event.clientX < rect.left + 40 ? -16 : event.clientX > rect.right - 20 ? 16 : 0;
      const dy =
        event.clientY < rect.top + SHEET_HEADER.height
          ? -16
          : event.clientY > rect.bottom - 20
            ? 16
            : 0;
      if (dx || dy) {
        element.scrollLeft += dx;
        element.scrollTop += dy;
      }
    }
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!model || busy || event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      select(active, false, false, "all");
      return;
    }
    const start = event.shiftKey ? (moving.current ?? active) : active;
    const merged = model.merges.find(
      (m) => start.row >= m.r1 && start.row <= m.r2 && start.column >= m.c1 && start.column <= m.c2,
    );
    let row = start.row,
      column = start.column;
    const far = event.ctrlKey || event.metaKey;
    const nextVisible = (value: number, delta: number, sizes: number[]) => {
      let n = value;
      do {
        n = Math.max(0, Math.min(sizes.length - 1, n + delta));
        if (n === 0 || n === sizes.length - 1) break;
      } while (!sizes[n]);
      return n;
    };
    if (event.key === "ArrowDown" || event.key === "Enter")
      row = far ? model.heights.length - 1 : nextVisible(merged?.r2 ?? row, 1, model.heights);
    else if (event.key === "ArrowUp")
      row = far ? 0 : nextVisible(merged?.r1 ?? row, -1, model.heights);
    else if (event.key === "ArrowRight" || event.key === "Tab")
      column = far
        ? model.widths.length - 1
        : nextVisible(
            event.shiftKey && event.key === "Tab" ? (merged?.c1 ?? column) : (merged?.c2 ?? column),
            event.shiftKey && event.key === "Tab" ? -1 : 1,
            model.widths,
          );
    else if (event.key === "ArrowLeft")
      column = far ? 0 : nextVisible(merged?.c1 ?? column, -1, model.widths);
    else if (event.key === "Home") {
      column = 0;
      if (far) row = 0;
    } else if (event.key === "End") {
      column = model.widths.length - 1;
      if (far) row = model.heights.length - 1;
    } else if (event.key === "PageDown" || event.key === "PageUp")
      row = axisIndex(
        geometry?.y ?? [0, 1],
        (geometry?.y[row] ?? 0) + ((event.key === "PageDown" ? 1 : -1) * view.height) / zoom,
      );
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      select(active);
      moving.current = null;
      return;
    } else return;
    event.preventDefault();
    moving.current = { row, column };
    select({ row, column }, event.shiftKey && event.key !== "Tab", true);
  }
  async function navigate(name: string) {
    if (!worker.current || !names.includes(name) || name === sheet) return;
    const seq = ++sequence.current;
    setBusy(true);
    setError("");
    setModel(null);
    drag.current = null;
    try {
      const result = await worker.current.request({ type: "sheet", name });
      assertCurrent();
      if (sequence.current !== seq) return;
      if (!result.sheet) throw new Error("工作表未能打开。");
      setModel(result.sheet);
      setSheet(name);
      setCell("A1");
      setSavedRange("A1");
      moving.current = null;
      if (scroll.current) {
        scroll.current.scrollTop = 0;
        scroll.current.scrollLeft = 0;
      }
      setView((current) => ({ ...current, top: 0, left: 0 }));
    } catch (cause) {
      if (sequence.current === seq)
        setError(cause instanceof Error ? cause.message : "工作表未能打开。");
    } finally {
      if (sequence.current === seq) setBusy(false);
    }
  }
  function locate() {
    if (!model) return;
    const [start, end = start] = coordinate.toUpperCase().trim().split(":");
    const a = parseSheetCoordinate(start, model.heights.length, model.widths.length),
      b = parseSheetCoordinate(end, model.heights.length, model.widths.length);
    if (!a || !b || !model.widths[a.column] || !model.heights[a.row]) {
      setNotice(
        `请输入 A1–${sheetColumnName(model.widths.length - 1)}${model.heights.length} 范围内的单元格。`,
      );
      return;
    }
    moving.current = null;
    select(b, false, true);
    setCell(a.name);
    setSavedRange(sheetRangeName(normalizeSheetRange(a, b)));
    scroll.current?.focus({ preventScroll: true });
  }
  const feedback = error ? (
    <PreviewUnavailable message={error} onDownload={props.onDownload} onRetry={props.onRetry} />
  ) : (
    <PreviewLoading message="正在读取工作表…" onCancel={props.onCancel} />
  );
  if (thumbnail)
    return (
      <div ref={cover} className="za-sheet-cover" aria-hidden="true">
        {model ? (
          <canvas ref={canvas} style={{ width: view.width, height: view.height }} />
        ) : (
          feedback
        )}
      </div>
    );
  const cellId = `${id}-cell`;
  return (
    <>
      <PreviewToolbar label="表格">
        <PreviewZoomControl
          label="表格缩放"
          value={zoom * 100}
          fitPage={false}
          fitWidth={false}
          zoomCurve="camera"
          percentages={[25, 50, 100, 200]}
          onZoomAnchor={(x, y) => {
            const rect = scroll.current?.getBoundingClientRect();
            if (rect)
              zoomPoint.current = {
                x: Math.max(0, x - rect.left - SHEET_HEADER.width),
                y: Math.max(0, y - rect.top - SHEET_HEADER.height),
              };
          }}
          onChange={(value) => {
            const next = typeof value === "number" ? value / 100 : 1;
            const point = zoomPoint.current ?? { x: 0, y: 0 };
            zoomPoint.current = null;
            if (next === zoom) return;
            pendingZoom.current = {
              left: ((view.left + point.x) * next) / zoom - point.x,
              top: ((view.top + point.y) * next) / zoom - point.y,
            };
            setZoom(next);
          }}
        />
      </PreviewToolbar>
      <div className="za-sheet-formula-bar">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            locate();
          }}
        >
          <input
            aria-label="定位单元格"
            value={coordinate}
            spellCheck={false}
            maxLength={14}
            disabled={!model || busy}
            aria-invalid={!!notice}
            onChange={(event) => setCoordinate(event.target.value)}
            onBlur={() => setCoordinate(sheetRangeName(selection))}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setCoordinate(sheetRangeName(selection));
                setNotice("");
              }
            }}
          />
        </form>
        <span className="za-sheet-formula-icon" aria-hidden="true">
          <FunctionIcon />
        </span>
        <input
          aria-label="公式栏"
          readOnly
          value={selectedCell?.formula ?? selectedCell?.text ?? ""}
          tabIndex={0}
        />
      </div>
      {notice ? (
        <p role="status" className="za-sheet-notice">
          {notice}
        </p>
      ) : null}
      <PreviewScrollArea
        ref={scroll}
        className="za-sheet-scroll"
        role="grid"
        aria-readonly="true"
        aria-label={`${props.name} · ${sheet}`}
        aria-rowcount={model?.heights.length ?? 0}
        aria-colcount={model?.widths.length ?? 0}
        aria-activedescendant={model ? cellId : undefined}
        aria-busy={busy}
        tabIndex={0}
        onKeyDown={keyDown}
        onScroll={(event) => {
          const target = event.currentTarget;
          setView((current) => ({ ...current, top: target.scrollTop, left: target.scrollLeft }));
        }}
        onCopy={(event) => {
          if (!model || !geometry) return;
          const text = Array.from({ length: selection.r2 - selection.r1 + 1 }, (_, i) =>
            Array.from(
              { length: selection.c2 - selection.c1 + 1 },
              (_, j) => geometry.cells.get(`${selection.r1 + i}:${selection.c1 + j}`)?.text ?? "",
            ).join("\t"),
          ).join("\n");
          event.preventDefault();
          event.clipboardData.setData("text/plain", text);
        }}
      >
        {model && geometry ? (
          <div
            className="za-sheet-scroll-space"
            style={{
              width: geometry.x[geometry.x.length - 1] * zoom + SHEET_HEADER.width,
              height: Math.max(
                view.height,
                geometry.y[geometry.y.length - 1] * zoom + SHEET_HEADER.height,
              ),
            }}
          >
            <canvas
              ref={canvas}
              className="za-sheet-canvas"
              aria-label="工作表画布"
              style={{ width: view.width, height: view.height }}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={(event) => {
                const start = touch.current;
                touch.current = null;
                if (
                  event.pointerType === "touch" &&
                  start?.id === event.pointerId &&
                  Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8
                ) {
                  const target = hit(event.clientX, event.clientY);
                  if (target) {
                    moving.current = null;
                    select(target);
                  }
                }
                drag.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                touch.current = null;
                drag.current = null;
              }}
            />
            <table className="sr-only" aria-label="当前单元格">
              <tbody>
                <tr aria-rowindex={active.row + 1}>
                  <td
                    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: keyboard focus belongs to the viewport through aria-activedescendant
                    role="gridcell"
                    id={cellId}
                    data-cell={cell}
                    aria-colindex={active.column + 1}
                    aria-selected="true"
                    tabIndex={-1}
                  >
                    {selectedCell?.text ?? ""}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          feedback
        )}
      </PreviewScrollArea>
      <div className="za-sheet-footer">
        <fieldset className="za-preview-sheets" aria-label="工作表">
          {names.map((name) => (
            <Button
              key={name}
              size="sm"
              variant="ghost"
              aria-pressed={sheet === name}
              disabled={busy}
              onClick={() => void navigate(name)}
            >
              {name}
            </Button>
          ))}
        </fieldset>
        {model?.formatLimited ? (
          <span className="za-sheet-limit">大型工作表 · 文本预览</span>
        ) : model?.truncated ? (
          <span className="za-sheet-limit">预览前 500 行、80 列</span>
        ) : selection.r1 !== selection.r2 || selection.c1 !== selection.c2 ? (
          <span className="za-sheet-selection-count">{sheetRangeName(selection)}</span>
        ) : null}
      </div>
    </>
  );
}
