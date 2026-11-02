import {
  parseXlsxRange,
  setWasmSource,
  useXlsxViewerController,
  type XlsxScrollerRenderProps,
  XlsxViewer,
} from "@extend-ai/react-xlsx";
import wasmURL from "@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import FunctionIcon from "~icons/gravity-ui/function";
import { ScrollArea } from "../ui/scroll-area";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewToolbar, PreviewZoomControl } from "./PreviewToolbar";
import { createResourcePreviewWorker } from "./previewWorkerClient";
import ResourceSheetFallback from "./ResourceSheetFallback";
import { usePreviewReadingState } from "./readingSession";

// Vite emits the version-pinned WASM next to the application, including remote-device builds.
setWasmSource(wasmURL);

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
  const viewport = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [coordinate, setCoordinate] = useState("A1");
  const [notice, setNotice] = useState("");

  const [coverWidth, setCoverWidth] = useState(160);
  const latest = useRef(controller);
  latest.current = controller;
  const thumbnail = !!props.thumbnail;
  const busy = controller.isLoading || !controller.activeSheet;
  const rangeName = controller.selectedRangeAddress || controller.activeCellAddress || "A1";
  const sheetName = controller.activeSheet?.name ?? "";
  const zoom = controller.zoomScale;

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
    ({ children, viewportProps }: XlsxScrollerRenderProps) => {
      const { ref, ...rest } = viewportProps;
      return (
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
            style: rest.style,
          }}
        >
          {children}
        </ScrollArea>
      );
    },
    [props.name],
  );

  const navigate = (index: number) => {
    props.assertCurrent();
    controller.setActiveTabIndex(index);
    controller.clearSelection();
    setNotice("");
    if (viewport.current) {
      viewport.current.scrollTop = 0;
      viewport.current.scrollLeft = 0;
    }
  };
  const locate = () => {
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
    requestAnimationFrame(() => {
      latest.current.clearHighlightedRanges();
      viewport.current?.focus({ preventScroll: true });
    });
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
      experimentalCanvas={false}
      showDefaultToolbar={false}
      isDark={false}
      showImages
      enableContextMenu={false}
      renderTableHeaderMenu={() => null}
      enableCanvasSelectionAnimation={!thumbnail}
      enableGestureZoom={false}
      headerBackgroundColor="#f5f5f5"
      headerTextColor="#737373"
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
        <PreviewZoomControl
          label="表格缩放"
          value={zoom}
          fitPage={false}
          fitWidth={false}
          maxPercent={400}
          percentages={[25, 50, 75, 100, 125, 150, 200]}
          onChange={(value) => {
            props.assertCurrent();
            controller.setZoomScale(typeof value === "number" ? value : 100);
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
      <div className="za-sheet-engine" aria-busy={busy}>
        {viewer}
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
