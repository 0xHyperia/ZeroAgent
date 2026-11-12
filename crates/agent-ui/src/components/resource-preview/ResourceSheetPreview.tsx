import {
  parseXlsxRange,
  setWasmSource,
  useXlsxViewerController,
  type XlsxCellAddress,
  type XlsxCellRange,
  type XlsxScrollerRenderProps,
  XlsxViewer,
} from "@extend-ai/react-xlsx";
import wasmURL from "@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url";
import {
  type CSSProperties,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import FunctionIcon from "~icons/gravity-ui/function";
import { SquareMousePointer } from "../IconSet";
import { ScrollArea } from "../ui/scroll-area";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewIdentityContext } from "./PreviewChrome";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewLeadingTools, PreviewToolbar, PreviewZoomControl } from "./PreviewToolbar";
import { sheetColumnName } from "./previewGeometry";
import { createResourcePreviewWorker } from "./previewWorkerClient";
import {
  type DocumentRevisionComment,
  type DocumentRevisionTarget,
  ResourceDocumentComments,
  type RevisionSelection,
} from "./ResourceDocumentComments";
import ResourceSheetFallback from "./ResourceSheetFallback";
import { SHEET_COMMENT_CURSOR } from "./readerInteraction";
import { usePreviewReadingState } from "./readingSession";
import { SheetAnnotationOverlay, type SheetRevisionCandidate } from "./SheetAnnotationOverlay";
import { expandSheetRange, sheetGridCellAt, spansSheetCells } from "./sheetAnnotationGeometry";

// Vite emits the version-pinned WASM next to the application, including remote-device builds.
setWasmSource(wasmURL);

function addressAt(row: number, col: number) {
  return `${sheetColumnName(col)}${row + 1}`;
}

function rangeAddress({ start, end }: XlsxCellRange) {
  const first = addressAt(start.row, start.col);
  const last = addressAt(end.row, end.col);
  return first === last ? first : `${first}:${last}`;
}

type SheetProps = PreviewRecovery & {
  bytes: Uint8Array;
  name: string;
  thumbnail?: boolean;
  assertCurrent: () => void;
  onCancel?: () => void;
};

export default function ResourceSheetPreview(props: SheetProps) {
  const [source, setSource] = useState<ArrayBuffer | null>(null);
  const [fallback, setFallback] = useState(false);
  const [error, setError] = useState("");
  const { bytes, assertCurrent } = props;
  useEffect(() => {
    const abort = new AbortController();
    const worker = createResourcePreviewWorker(abort.signal);
    setSource(null);
    setFallback(false);
    setError("");
    void worker
      .request({ type: "load", kind: "sheet-source", bytes })
      .then((result) => {
        assertCurrent();
        if (abort.signal.aborted) return;
        if (result.sheetFallback) setFallback(true);
        else if (result.workbookBytes) setSource(result.workbookBytes.slice().buffer);
        else throw new Error("工作表未能打开，请下载原件查看。");
      })
      .catch((cause) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : "工作表无法打开。");
      })
      .finally(() => worker.dispose());
    return () => {
      abort.abort();
      worker.dispose();
    };
  }, [bytes, assertCurrent]);
  if (error)
    return (
      <PreviewUnavailable message={error} onDownload={props.onDownload} onRetry={props.onRetry} />
    );
  if (fallback) return <ResourceSheetFallback {...props} />;
  if (!source) return <PreviewLoading message="正在读取工作表…" onCancel={props.onCancel} />;
  return <StyledSheet key={props.name} {...props} source={source} onFatal={setError} />;
}

function StyledSheet({
  source,
  onFatal,
  ...props
}: SheetProps & { source: ArrayBuffer; onFatal: (message: string) => void }) {
  const controller = useXlsxViewerController({
    file: source,
    fileName: props.name,
    readOnly: true,
    useWorker: true,
    maxFileSizeBytes: 32 * 1024 * 1024,
    showHiddenSheets: false,
  });
  const [savedSheet, setSavedSheet] = usePreviewReadingState("sheetName", "");
  const [savedZoom, setSavedZoom] = usePreviewReadingState("sheetZoom", 1);
  const [savedRange, setSavedRange] = usePreviewReadingState("sheetRange", "A1");
  const [, setSavedCell] = usePreviewReadingState("sheetCell", "A1");
  const initial = useRef({ savedSheet, savedZoom, savedRange });
  const ready = useRef(false);
  const engine = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [coordinate, setCoordinate] = useState("A1");
  const [notice, setNotice] = useState("");
  const { onRequestRevision } = useContext(PreviewIdentityContext);
  const [annotating, setAnnotating] = useState(false);
  const [selection, setSelection] = useState<RevisionSelection | null>(null);
  const draft = annotating ? selection : null;
  const hasDraft = Boolean(draft);
  const [candidate, setCandidate] = useState<SheetRevisionCandidate | null>(null);
  const [marks, setMarks] = useState<readonly DocumentRevisionComment[]>([]);
  const [commentsToolbar, setCommentsToolbar] = useState<HTMLSpanElement | null>(null);
  const editRef = useRef<((id: string, source?: "marker") => void) | null>(null);
  const dismissSelectionRef = useRef<(() => boolean) | null>(null);
  const pointer = useRef<{
    id: number;
    anchor: XlsxCellAddress;
    sheet: string;
  } | null>(null);
  const selectionFrame = useRef(0);
  const blockedPointer = useRef(false);
  const pending = useRef<Extract<DocumentRevisionTarget, { kind: "sheet" }> | null>(null);

  const [coverWidth, setCoverWidth] = useState(160);
  const latest = useRef(controller);
  latest.current = controller;
  const thumbnail = !!props.thumbnail;
  const busy = controller.isLoading || !controller.activeSheet;
  const rangeName = controller.selectedRangeAddress || controller.activeCellAddress || "A1";
  const sheetName = controller.activeSheet?.name ?? "";
  const activeCellId = useId();
  const activeCell = controller.activeCell;
  const selectedValue = controller.selectedValue;
  const zoom = controller.zoomScale;
  const zoomPoint = useRef<{ x: number; y: number } | null>(null);
  const zoomScroll = useRef<{ left: number; top: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Apply the scroll anchor after the new zoom is laid out.
  useLayoutEffect(() => {
    const target = zoomScroll.current;
    const view = viewport.current;
    if (!view || !target) return;
    zoomScroll.current = null;
    view.scrollLeft = target.left;
    view.scrollTop = target.top;
  }, [zoom]);
  const addSelection = useCallback(
    (
      edit: boolean,
      gesture?: {
        start: XlsxCellAddress;
        end: XlsxCellAddress;
      },
    ) => {
      const active = latest.current;
      const sheet = active.activeSheet?.name;
      const end = gesture?.end;
      const base = gesture
        ? {
            start: {
              row: Math.min(gesture.start.row, gesture.end.row),
              col: Math.min(gesture.start.col, gesture.end.col),
            },
            end: {
              row: Math.max(gesture.start.row, gesture.end.row),
              col: Math.max(gesture.start.col, gesture.end.col),
            },
          }
        : (active.selection ??
          (active.activeCell ? { start: active.activeCell, end: active.activeCell } : null));
      if (!sheet || !base) return;
      const merges = active.activeSheet?.mergedRanges ?? [];
      const bounds = expandSheetRange(base, merges);
      if (!edit && (!end || !spansSheetCells(bounds, merges))) return;
      props.assertCurrent();
      const range = rangeAddress(bounds);
      const quote =
        !range.includes(":") && range === active.activeCellAddress
          ? active.selectedValue.slice(0, 500)
          : "";
      const next: RevisionSelection = {
        id: JSON.stringify(["sheet", sheet, range]),
        page: active.activeSheetIndex + 1,
        start: 0,
        end: quote.length,
        x: 0,
        y: 0,
        quote,
        target: {
          kind: "sheet",
          sheet,
          range,
          anchor: gesture
            ? addressAt(gesture.start.row, gesture.start.col)
            : (active.activeCellAddress ?? undefined),
        },
      };
      if (edit) {
        setSelection(next);
      } else if (end) {
        setCandidate({
          selection: next,
          endpoint: end,
          below: end.row === base.end.row,
          leading: end.col < base.end.col,
        });
      }
    },
    [props.assertCurrent],
  );

  const changeAnnotationMode = useCallback((enabled: boolean) => {
    cancelAnimationFrame(selectionFrame.current);
    selectionFrame.current = 0;
    pointer.current = null;
    setCandidate(null);
    setAnnotating(enabled);
  }, []);
  const requestCandidate = useCallback(() => {
    if (!candidate || dismissSelectionRef.current?.() === false) return;
    props.assertCurrent();
    changeAnnotationMode(true);
    setSelection(candidate.selection);
  }, [candidate, changeAnnotationMode, props.assertCurrent]);
  useEffect(() => () => cancelAnimationFrame(selectionFrame.current), []);

  // Reset only on a new immutable byte source; host account/lease changes unmount the reader.
  useEffect(() => {
    ready.current = false;

    const timer = setTimeout(() => {
      if (latest.current.isLoading) onFatal("文件较复杂，预览超时。请下载原件查看。");
    }, 20_000);
    return () => clearTimeout(timer);
  }, [onFatal]);
  useEffect(() => {
    if (controller.isLoading || controller.error || !controller.sheets.length || ready.current)
      return;
    props.assertCurrent();
    const saved = initial.current;
    const index = thumbnail
      ? 0
      : Math.max(
          0,
          controller.sheets.findIndex((sheet) => sheet.name === saved.savedSheet),
        );
    if (controller.activeSheetIndex !== index) {
      controller.setActiveSheetIndex(index);
      return;
    }
    controller.setZoomScale(thumbnail ? 100 : Math.max(25, Math.min(400, saved.savedZoom * 100)));
    const parsed = parseXlsxRange(saved.savedRange);
    if (!thumbnail && parsed && parsed.kind === "cells") controller.selectRange(parsed.range);
    else controller.clearSelection();
    ready.current = true;
  }, [controller, thumbnail, props.assertCurrent]);
  useEffect(() => {
    if (!ready.current || thumbnail || busy) return;
    props.assertCurrent();
    setSavedSheet(sheetName);
    setSavedZoom(zoom / 100);
    setSavedRange(rangeName);
    setSavedCell(controller.activeCellAddress || "A1");
  }, [
    sheetName,
    zoom,
    rangeName,
    busy,
    thumbnail,
    controller.activeCellAddress,
    setSavedCell,
    setSavedRange,
    setSavedSheet,
    setSavedZoom,
    props.assertCurrent,
  ]);
  useEffect(() => setCoordinate(rangeName), [rangeName]);
  useLayoutEffect(() => {
    if (!thumbnail || !frame.current) return;
    const element = frame.current;
    const measure = () => setCoverWidth(element.clientWidth || 160);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [thumbnail]);

  const renderScroller = useCallback(
    ({ children, viewportProps, gridGeometry }: XlsxScrollerRenderProps) => {
      const { ref, ...rest } = viewportProps;
      return (
        <>
          <ScrollArea
            className="za-sheet-engine-scroll"
            horizontal
            viewportRef={(element) => {
              viewport.current = element;
              if (typeof ref === "function") ref(element);
              else if (ref) ref.current = element;
            }}
            contentClassName="za-sheet-engine-content"
            viewportProps={{
              ...rest,
              "aria-label": `${props.name} · 工作表`,
              "aria-activedescendant": !thumbnail && activeCell ? activeCellId : undefined,
              style: rest.style,
              onPointerDownCapture: (event) => {
                blockedPointer.current = false;
                if (onRequestRevision && event.isPrimary && event.button === 0 && gridGeometry) {
                  cancelAnimationFrame(selectionFrame.current);
                  selectionFrame.current = 0;
                  pointer.current = null;
                  if (hasDraft && dismissSelectionRef.current?.() === false) {
                    blockedPointer.current = true;
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                  }
                  const cell = sheetGridCellAt(
                    gridGeometry,
                    event.currentTarget,
                    event.clientX,
                    event.clientY,
                  );
                  setCandidate(null);
                  if (cell)
                    pointer.current = {
                      id: event.pointerId,
                      anchor: (event.shiftKey && latest.current.activeCell) || cell,
                      sheet: latest.current.activeSheet?.name ?? "",
                    };
                }
                rest.onPointerDownCapture?.(event);
              },
              onClickCapture: (event) => {
                if (blockedPointer.current && event.detail > 0) {
                  blockedPointer.current = false;
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                rest.onClickCapture?.(event);
              },
              onPointerUpCapture: (event) => {
                rest.onPointerUpCapture?.(event);
                const gesture = pointer.current;
                if (gesture?.id !== event.pointerId) return;
                pointer.current = null;
                const end =
                  gridGeometry &&
                  sheetGridCellAt(gridGeometry, event.currentTarget, event.clientX, event.clientY);
                if (!end) return;
                // Let the engine publish the active cell text. The range itself comes from the canvas.
                selectionFrame.current = requestAnimationFrame(() => {
                  selectionFrame.current = 0;
                  if (!viewport.current || latest.current.activeSheet?.name !== gesture.sheet)
                    return;
                  addSelection(annotating, { start: gesture.anchor, end });
                });
              },
              onPointerCancel: (event) => {
                rest.onPointerCancel?.(event);
                pointer.current = null;
              },
              onKeyDownCapture: (event) => {
                if (
                  hasDraft &&
                  /^(Arrow|Home|End|Page|Enter)/.test(event.key) &&
                  dismissSelectionRef.current?.() === false
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                rest.onKeyDownCapture?.(event);
                if (annotating && event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.stopPropagation();
                  addSelection(true);
                } else if (
                  candidate &&
                  (event.ctrlKey || event.metaKey) &&
                  event.shiftKey &&
                  event.key.toLowerCase() === "x"
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  requestCandidate();
                } else if (
                  event.key === "Escape" &&
                  (candidate || annotating || selectionFrame.current)
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelAnimationFrame(selectionFrame.current);
                  selectionFrame.current = 0;
                  if (hasDraft) dismissSelectionRef.current?.();
                  else if (annotating) changeAnnotationMode(false);
                  setCandidate(null);
                } else if (event.key.startsWith("Arrow")) {
                  setCandidate(null);
                }
              },
            }}
          >
            {children}
            {!thumbnail && activeCell && (
              // biome-ignore lint/a11y/useSemanticElements: The canvas grid owns this virtual row.
              <div role="row" tabIndex={-1} aria-rowindex={activeCell.row + 1} className="sr-only">
                {/* biome-ignore lint/a11y/useSemanticElements: The grid uses aria-activedescendant for this virtual cell. */}
                <div
                  id={activeCellId}
                  role="gridcell"
                  tabIndex={-1}
                  aria-colindex={activeCell.col + 1}
                  aria-selected="true"
                >
                  {addressAt(activeCell.row, activeCell.col)} {selectedValue}
                </div>
              </div>
            )}
          </ScrollArea>
          {onRequestRevision && !busy && gridGeometry && (
            <SheetAnnotationOverlay
              viewport={viewport}
              sheetName={sheetName}
              geometry={gridGeometry}
              candidate={candidate}
              draft={draft}
              marks={marks}
              onRequest={requestCandidate}
              onDismiss={() => {
                setCandidate(null);
                viewport.current?.focus({ preventScroll: true });
              }}
              onEdit={(id) => editRef.current?.(id, "marker")}
            />
          )}
        </>
      );
    },
    [
      activeCell,
      activeCellId,
      addSelection,
      annotating,
      busy,
      candidate,
      changeAnnotationMode,
      draft,
      hasDraft,
      marks,
      onRequestRevision,
      props.name,
      requestCandidate,
      selectedValue,
      sheetName,
      thumbnail,
    ],
  );

  const selectCommentRange = useCallback(
    (target: Extract<DocumentRevisionTarget, { kind: "sheet" }>, scroll = true) => {
      const parsed = parseXlsxRange(target.range);
      if (parsed?.kind !== "cells") return;
      const active = latest.current;
      active.selectRange(parsed.range);
      if (scroll) active.highlightRanges(target.range, { autoScroll: true });
    },
    [],
  );

  useEffect(() => {
    if (pending.current?.sheet !== sheetName || !pending.current) return;
    const target = pending.current;
    pending.current = null;
    selectCommentRange(target);
  }, [selectCommentRange, sheetName]);

  const navigate = (index: number) => {
    if (selection && dismissSelectionRef.current?.() === false) return;
    props.assertCurrent();
    pending.current = null;
    controller.setActiveTabIndex(index);
    controller.clearSelection();
    setSelection(null);
    setCandidate(null);
    setNotice("");
    if (viewport.current) {
      viewport.current.scrollTop = 0;
      viewport.current.scrollLeft = 0;
    }
  };
  const locate = () => {
    if (hasDraft && dismissSelectionRef.current?.() === false) {
      setCoordinate(rangeName);
      return;
    }
    const parsed = parseXlsxRange(coordinate.toUpperCase().trim());
    if (!parsed || parsed.sheetName || parsed.kind !== "cells") {
      setNotice("请输入有效的单元格或范围，如 A1 或 A1:C8。");
      return;
    }
    props.assertCurrent();
    controller.selectRange(parsed.range);
    setNotice("");
    // Navigation uses the engine's merged/hidden/frozen geometry and retains the actual selection.
    controller.highlightRanges(coordinate, { autoScroll: true });
    viewport.current?.focus({ preventScroll: true });
  };
  const feedback = <PreviewLoading message="正在读取工作表…" onCancel={props.onCancel} />;
  useEffect(() => {
    if (controller.error) onFatal("此工作簿暂时无法预览，请重试或下载原件。");
  }, [controller.error, onFatal]);
  const failure = controller.error;
  if (failure)
    return (
      <PreviewUnavailable
        message={"此工作簿暂时无法预览，请重试或下载原件。"}
        onDownload={props.onDownload}
        onRetry={props.onRetry}
      />
    );

  // A real, inert viewport crop includes the same chart/image/conditional-format layers.
  // The library's separate thumbnail hook omits charts, so it is deliberately not used here.
  const viewer = (
    <XlsxViewer
      controller={controller}
      readOnly
      rounded={false}
      height="100%"
      experimentalCanvas
      showDefaultToolbar={false}
      isDark={false}
      showImages
      enableContextMenu={false}
      highlightClassName="za-sheet-navigation-highlight"
      renderTableHeaderMenu={() => null}
      enableCanvasSelectionAnimation={false}
      enableGestureZoom={false}
      headerBackgroundColor="#f5f5f5"
      headerTextColor="#333333"
      selectionColor="#3578ed"
      selectionFillColor="rgba(53,120,237,.10)"
      selectionHeaderColor="#d5e0f1"
      loadingState={feedback}
      errorState={<PreviewUnavailable message="工作表未能打开。" onDownload={props.onDownload} />}
      renderChartLoading={() => <PreviewLoading message="正在绘制图表…" />}
      renderScroller={renderScroller}
    />
  );
  if (thumbnail) {
    const scale = coverWidth / 360;
    return (
      <div ref={frame} className="za-sheet-cover" aria-hidden="true" inert>
        {busy ? (
          <div className="za-preview-frame-pending" data-cover="true">
            {feedback}
          </div>
        ) : null}
        <div
          className="za-sheet-cover-engine"
          style={{
            width: 400,
            height: 300,
            transform: `scale(${scale})`,
            left: -40 * scale,
            top: -21 * scale,
          }}
        >
          {viewer}
        </div>
      </div>
    );
  }
  return (
    <>
      <PreviewToolbar label="表格">
        <PreviewLeadingTools>
          {onRequestRevision && (
            <Button
              variant="ghost"
              size="sm"
              className="za-request-revision"
              data-active={annotating}
              aria-pressed={annotating}
              disabled={busy || controller.activeTab?.kind !== "sheet"}
              onClick={() => changeAnnotationMode(!annotating)}
            >
              <SquareMousePointer className="size-4" />
              请求修改
            </Button>
          )}
          {onRequestRevision && (
            <span ref={setCommentsToolbar} className="za-sheet-comments-slot" />
          )}
        </PreviewLeadingTools>
        <PreviewZoomControl
          label="表格缩放"
          value={zoom}
          fitPage={false}
          fitWidth={false}
          maxPercent={400}
          zoomCurve="camera"
          gestureRoot={engine}
          percentages={[25, 50, 100, 200]}
          onZoomAnchor={(x, y) => {
            const rect = viewport.current?.getBoundingClientRect();
            if (rect) zoomPoint.current = { x: x - rect.left, y: y - rect.top };
          }}
          onChange={(value) => {
            props.assertCurrent();
            const next = typeof value === "number" ? value : 100;
            const view = viewport.current;
            const point = zoomPoint.current;
            zoomPoint.current = null;
            if (next !== zoom && view && point) {
              zoomScroll.current = {
                left: ((view.scrollLeft + point.x) * next) / zoom - point.x,
                top: ((view.scrollTop + point.y) * next) / zoom - point.y,
              };
            }
            controller.setZoomScale(next);
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
            maxLength={24}
            disabled={busy}
            aria-invalid={!!notice}
            onChange={(event) => setCoordinate(event.target.value)}
            onBlur={() => setCoordinate(rangeName)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setCoordinate(rangeName);
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
          value={controller.selectedFormula || controller.selectedValue || ""}
        />
      </div>
      {notice ? (
        <p role="status" className="za-sheet-notice">
          {notice}
        </p>
      ) : null}
      <div
        ref={engine}
        className="za-sheet-engine relative"
        aria-busy={busy}
        data-sheet-annotation-mode={(annotating && !draft) || undefined}
        data-sheet-single-selection={!rangeName.includes(":") || undefined}
        data-sheet-own-selection={
          !!draft ||
          marks.some(
            (item) =>
              item.target?.kind === "sheet" &&
              item.target.sheet === sheetName &&
              item.target.range === rangeName,
          ) ||
          undefined
        }
        style={
          annotating
            ? ({ "--za-sheet-comment-cursor": SHEET_COMMENT_CURSOR } as CSSProperties)
            : undefined
        }
      >
        {viewer}
        {onRequestRevision && (
          <ResourceDocumentComments
            enabled={annotating}
            onEnabled={changeAnnotationMode}
            selection={selection}
            onSelection={setSelection}
            editRef={editRef}
            dismissSelectionRef={dismissSelectionRef}
            toolbarTarget={commentsToolbar}
            onMarks={setMarks}
            sheetSelection
            onNavigate={(_block, comment, source) => {
              const target = comment?.target;
              if (target?.kind !== "sheet") return;
              props.assertCurrent();
              if (target.sheet === sheetName && controller.activeTab?.kind === "sheet") {
                selectCommentRange(target, source !== "marker");
              } else {
                const index = controller.tabs.findIndex(
                  (tab) => tab.kind === "sheet" && tab.name === target.sheet,
                );
                if (index < 0) return;
                pending.current = target;
                controller.setActiveTabIndex(index);
              }
            }}
          />
        )}
      </div>
      <div className="za-sheet-footer">
        <fieldset className="za-preview-sheets" aria-label="工作表">
          {controller.tabs.map((tab, index) => (
            <Button
              key={`${tab.kind}:${tab.name}`}
              variant="ghost"
              size="sm"
              aria-pressed={controller.activeTabIndex === index}
              disabled={busy}
              onClick={() => navigate(index)}
            >
              {tab.name}
            </Button>
          ))}
        </fieldset>
        {rangeName.includes(":") ? (
          <span className="za-sheet-selection-count">{rangeName}</span>
        ) : null}
      </div>
    </>
  );
}
