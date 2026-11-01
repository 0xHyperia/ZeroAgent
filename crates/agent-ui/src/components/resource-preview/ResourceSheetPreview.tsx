import { useEffect, useRef, useState } from "react";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewToolbar, PreviewZoomControl } from "./PreviewToolbar";
import { parseSheetCoordinate, sheetColumnName } from "./previewGeometry";
import { createResourcePreviewWorker } from "./previewWorkerClient";
import { usePreviewReadingState } from "./readingSession";

export default function ResourceSheetPreview(
  props: PreviewRecovery & {
    bytes: Uint8Array;
    name: string;
    assertCurrent: () => void;
    onCancel?: () => void;
  },
) {
  const [sheet, setSheet] = usePreviewReadingState("sheetName", "");
  const [zoom, setZoom] = usePreviewReadingState("sheetZoom", 1);
  const [cell, setCell] = usePreviewReadingState("sheetCell", "A1");
  const [wrap, setWrap] = usePreviewReadingState("sheetWrap", true);
  const [coordinate, setCoordinate] = useState(cell);
  const [coordinateError, setCoordinateError] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const client = useRef<ReturnType<typeof createResourcePreviewWorker> | null>(null);
  const lifetime = useRef<AbortSignal | null>(null);
  const generation = useRef(0);
  const selectionSequence = useRef(0);
  const pendingFocus = useRef<number | null>(null);
  const initialSheet = useRef(sheet);
  const canvas = useRef<HTMLDivElement>(null);
  const { bytes, assertCurrent } = props;
  const columns = Math.max(1, ...(rows?.map((row) => row.length) ?? []));
  useEffect(() => {
    const controller = new AbortController();
    const worker = createResourcePreviewWorker(controller.signal);
    client.current = worker;
    lifetime.current = controller.signal;
    const seq = ++generation.current;
    void (async () => {
      let result = await worker.request({ type: "load", kind: "sheet", bytes });
      assertCurrent();
      if (controller.signal.aborted || generation.current !== seq) return;
      const sheets = result.sheetNames ?? [];
      const restored = sheets.includes(initialSheet.current)
        ? initialSheet.current
        : (sheets[0] ?? "");
      if (restored && restored !== sheets[0])
        result = await worker.request({ type: "sheet", name: restored });
      assertCurrent();
      if (controller.signal.aborted || generation.current !== seq) return;
      setNames(sheets);
      setSheet(restored);
      setRows(result.rows ?? []);
      setBusy(false);
    })().catch((cause) => {
      if (!controller.signal.aborted && generation.current === seq) {
        setError(cause instanceof Error ? cause.message : "工作表无法打开。");
        setBusy(false);
      }
    });
    return () => {
      generation.current++;
      selectionSequence.current++;
      if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current);
      controller.abort();
      worker.dispose();
      client.current = null;
    };
  }, [bytes, assertCurrent, setSheet]);

  useEffect(() => {
    if (rows && !parseSheetCoordinate(cell, rows.length, columns)) {
      setCell("A1");
      setCoordinate("A1");
    }
  }, [rows, columns, cell, setCell]);

  async function navigate(name: string) {
    if (!client.current || !names.includes(name)) return;
    const seq = ++generation.current;
    selectionSequence.current++;
    if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current);
    setSheet(name);
    setRows(null);
    setBusy(true);
    setError("");
    setCoordinateError("");
    try {
      const result = await client.current.request({ type: "sheet", name });
      assertCurrent();
      if (!lifetime.current?.aborted && generation.current === seq) setRows(result.rows ?? []);
    } catch (cause) {
      if (!lifetime.current?.aborted && generation.current === seq)
        setError(cause instanceof Error ? cause.message : "工作表未能打开。");
    } finally {
      if (!lifetime.current?.aborted && generation.current === seq) setBusy(false);
    }
  }

  function selectCell(name: string, focus = false) {
    const target = parseSheetCoordinate(name, rows?.length ?? 0, columns);
    if (!target) {
      setCoordinateError(
        `请输入当前预览范围内的单元格：A1–${sheetColumnName(columns - 1)}${rows?.length || 1}。`,
      );
      return;
    }
    setCell(target.name);
    setCoordinate(target.name);
    setCoordinateError("");
    const selection = ++selectionSequence.current;
    const navigation = generation.current;
    if (pendingFocus.current !== null) cancelAnimationFrame(pendingFocus.current);
    pendingFocus.current = requestAnimationFrame(() => {
      pendingFocus.current = null;
      if (
        selectionSequence.current !== selection ||
        generation.current !== navigation ||
        lifetime.current?.aborted
      )
        return;
      try {
        assertCurrent();
      } catch {
        return;
      }
      const viewport = canvas.current;
      const element = viewport?.querySelector<HTMLElement>(`[data-cell="${target.name}"]`);
      if (!viewport || !element) return;
      const bounds = viewport.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      // Scroll the sheet only, leaving the conversation and outer reader in place.
      if (rect.top < bounds.top + 32) viewport.scrollTop += rect.top - bounds.top - 32;
      else if (rect.bottom > bounds.bottom) viewport.scrollTop += rect.bottom - bounds.bottom;
      if (rect.left < bounds.left + 44) viewport.scrollLeft += rect.left - bounds.left - 44;
      else if (rect.right > bounds.right) viewport.scrollLeft += rect.right - bounds.right;
      if (focus) element.focus({ preventScroll: true });
    });
  }

  return (
    <>
      <PreviewToolbar label="表格" detail="只读数据">
        <form
          className="za-preview-coordinate"
          onSubmit={(event) => {
            event.preventDefault();
            selectCell(coordinate, true);
          }}
        >
          <input
            aria-label="定位单元格"
            value={coordinate}
            maxLength={6}
            disabled={!rows?.length || busy}
            onChange={(event) => setCoordinate(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setCoordinate(cell);
                setCoordinateError("");
              }
            }}
          />
          <Button variant="ghost" size="sm" type="submit" disabled={!rows?.length || busy}>
            定位
          </Button>
        </form>
        <PreviewZoomControl
          label="表格缩放"
          value={zoom * 100}
          fitPage={false}
          fitWidth={false}
          percentages={[75, 100, 125, 150]}
          onChange={(value) => {
            if (typeof value === "number") setZoom(value / 100);
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={wrap}
          tooltip="单元格内容换行"
          onClick={() => setWrap(!wrap)}
        >
          换行
        </Button>
      </PreviewToolbar>
      {coordinateError ? (
        <p className="za-preview-coordinate-error" role="status">
          {coordinateError}
        </p>
      ) : null}
      <div ref={canvas} className="za-preview-table-scroll" aria-busy={busy}>
        {error ? (
          <PreviewUnavailable
            message={error}
            onDownload={props.onDownload}
            onRetry={props.onRetry}
          />
        ) : !rows ? (
          <PreviewLoading
            message={sheet ? `正在读取“${sheet}”…` : "正在读取工作表…"}
            onCancel={props.onCancel}
          />
        ) : rows.some((row) => row.some((value) => value !== "")) ? (
          <table
            className="za-preview-table"
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a readonly ARIA grid uses native table structure and roving coordinate focus
            role="grid"
            aria-readonly="true"
            aria-label={`${props.name} · ${sheet}`}
            data-wrap={wrap}
            style={{ zoom }}
          >
            <thead>
              <tr>
                <th aria-label="行号" />
                {Array.from({ length: columns }, (_, column) => (
                  <th key={sheetColumnName(column)} scope="col">
                    {sheetColumnName(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: read-only rows have stable coordinates
                <tr key={rowIndex}>
                  <th scope="row">{rowIndex + 1}</th>
                  {Array.from({ length: columns }, (_, column) => {
                    const name = `${sheetColumnName(column)}${rowIndex + 1}`;
                    return (
                      <td
                        key={name}
                        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: grid cells support explicit selection and arrow-key coordinate navigation, never editing
                        role="gridcell"
                        data-cell={name}
                        aria-selected={cell === name}
                        tabIndex={cell === name ? 0 : -1}
                        onClick={() => selectCell(name)}
                        onFocus={() => {
                          selectionSequence.current++;
                          setCell(name);
                          setCoordinate(name);
                          setCoordinateError("");
                        }}
                        onKeyDown={(event) => {
                          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
                            return;
                          const rowDelta =
                            event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                          const colDelta =
                            event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                          if (rowDelta || colDelta) {
                            event.preventDefault();
                            const nextRow = Math.max(
                              0,
                              Math.min(rows.length - 1, rowIndex + rowDelta),
                            );
                            const nextColumn = Math.max(
                              0,
                              Math.min(columns - 1, column + colDelta),
                            );
                            selectCell(`${sheetColumnName(nextColumn)}${nextRow + 1}`, true);
                          }
                        }}
                      >
                        {row[column] ?? ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <PreviewUnavailable message="此工作表暂无可显示的内容。" />
        )}
      </div>
      <fieldset className="za-preview-sheets" aria-label="工作表">
        {names.map((name) => (
          <Button
            key={name}
            size="sm"
            variant="ghost"
            aria-pressed={sheet === name}
            onClick={() => void navigate(name)}
          >
            {name}
          </Button>
        ))}
      </fieldset>
    </>
  );
}
