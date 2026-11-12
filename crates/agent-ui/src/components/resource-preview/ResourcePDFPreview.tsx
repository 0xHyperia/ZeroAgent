import {
  AnnotationMode,
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  version as pdfVersion,
  TextLayer,
} from "pdfjs-dist";
import pdfWorkerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../i18n";
import { ChevronRight, List, SquareMousePointer } from "../IconSet";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { DocumentNavigation } from "./DocumentNavigation";
import type { DocumentRegion } from "./docxReaderDocument";
import { PreviewIdentityContext, PreviewToolbarMount } from "./PreviewChrome";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewScrollArea } from "./PreviewScrollArea";
import {
  PreviewLeadingTools,
  PreviewPageControls,
  PreviewToolbar,
  PreviewZoomControl,
  previewPageKey,
} from "./PreviewToolbar";
import { pdfPreviewAssetsURL } from "./pdfPreviewAssets";
import { capturePDFRevisionEvidence } from "./pdfRevisionEvidence";
import { pdfTextRange } from "./pdfTextRange";
import { boundedPreviewScale, previewScale } from "./previewGeometry";
import {
  type DocumentRevisionComment,
  ResourceDocumentComments,
  type RevisionSelection,
} from "./ResourceDocumentComments";
import {
  COMMENT_CURSOR,
  COMMENT_PIN,
  READER_NAVIGATION_INSET,
  readerScrollBehavior,
} from "./readerInteraction";
import { type PreviewZoom, usePreviewReadingState } from "./readingSession";
import { usePreviewViewport } from "./usePreviewViewport";

GlobalWorkerOptions.workerSrc = pdfWorkerURL;
const DEFAULT_PAGE = { width: 816, height: 1056 };
const PDF_ZOOM_STOPS = [
  30, 40, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500, 600, 700, 800,
];
function pdfPageScale(zoom: PreviewZoom, size: typeof DEFAULT_PAGE, pane: typeof DEFAULT_PAGE) {
  return typeof zoom === "number"
    ? Math.max(30, Math.min(800, zoom)) / 100
    : previewScale(zoom, size, pane);
}
const NO_COMMENTS: readonly DocumentRevisionComment[] = [];

function normalizedPDFRegion(rect: DocumentRegion, paper: DOMRect): DocumentRegion {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const left = clamp((rect.left - paper.left) / paper.width);
  const top = clamp((rect.top - paper.top) / paper.height);
  return {
    left,
    top,
    width: clamp((rect.left + rect.width - paper.left) / paper.width) - left,
    height: clamp((rect.top + rect.height - paper.top) / paper.height) - top,
  };
}

function openPreviewPDF(bytes: Uint8Array) {
  const assets = pdfPreviewAssetsURL(pdfVersion);
  return getDocument({
    data: bytes.slice(),
    enableXfa: false,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`,
    useSystemFonts: true,
  });
}

const assertInlinePdfCurrent = () => {};

export function GitReviewPDFPreview({ bytes }: { bytes: Uint8Array }) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const { container, viewport } = usePreviewViewport();
  const [loaded, setLoaded] = useState<{ bytes: Uint8Array; pdf: PDFDocumentProxy | null }>();
  const [page, setPage] = useState(1);
  useEffect(() => {
    let active = true;
    const task = openPreviewPDF(bytes);
    const publish = (pdf: PDFDocumentProxy | null) => {
      if (active) setLoaded({ bytes, pdf });
    };
    const stop = () => {
      if (!active) return;
      active = false;
      void task.destroy().catch(() => {});
    };
    const timer = setTimeout(() => {
      publish(null);
      stop();
    }, 30_000);
    setPage(1);
    void task.promise.then(
      (pdf) => {
        clearTimeout(timer);
        publish(pdf.numPages > 0 && pdf.numPages <= 1000 ? pdf : null);
      },
      () => {
        clearTimeout(timer);
        publish(null);
      },
    );
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [bytes]);
  const current = loaded?.bytes === bytes ? loaded : undefined;
  const pdf = current?.pdf;
  return (
    <div className="za-review-pdf" ref={container}>
      {!current ? (
        <div className="za-review-preview-status" role="status">
          {zh ? "正在加载预览…" : "Loading preview…"}
        </div>
      ) : pdf ? (
        <>
          {viewport.width > 0 && (
            <PDFPage
              key={page}
              document={pdf}
              number={page}
              selected
              zoom="fit-width"
              pane={{ width: viewport.width, height: 0 }}
              root={container}
              assertCurrent={assertInlinePdfCurrent}
              renderText={false}
            />
          )}
          {pdf.numPages > 1 && (
            <nav className="za-review-pdf-pages" aria-label={zh ? "PDF 页面导航" : "PDF pages"}>
              <Button
                variant="ghost"
                size="sm"
                tooltip={zh ? "上一页" : "Previous page"}
                aria-label={zh ? "上一页" : "Previous page"}
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                <ChevronRight className="size-3.5 rotate-180" />
              </Button>
              <span aria-live="polite">
                {page}/{pdf.numPages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                tooltip={zh ? "下一页" : "Next page"}
                aria-label={zh ? "下一页" : "Next page"}
                disabled={page >= pdf.numPages}
                onClick={() => setPage((current) => Math.min(pdf.numPages, current + 1))}
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </nav>
          )}
        </>
      ) : (
        <div className="za-review-preview-status">
          {zh ? "无法渲染 PDF 预览" : "Unable to render PDF preview"}
        </div>
      )}
    </div>
  );
}

export default function ResourcePDFPreview({
  bytes,
  assertCurrent,
  onDownload,
  onRetry,
  onCancel,
  thumbnail,
}: PreviewRecovery & {
  bytes: Uint8Array;
  assertCurrent: () => void;
  onCancel?: () => void;
  thumbnail?: boolean;
}) {
  const { onRequestRevision } = useContext(PreviewIdentityContext);
  const chrome = useContext(PreviewToolbarMount);
  const singlePage = Boolean(chrome?.workspaceTab && !thumbnail);
  const [navigation, setNavigation] = usePreviewReadingState("pdfNavigation", false);
  const [annotating, setAnnotating] = useState(false);
  const annotationExit = useRef<(() => void) | null>(null);
  const annotationState = useRef(false);
  annotationState.current = annotating;
  const toggleAnnotation = useCallback(() => {
    if (annotationState.current) annotationExit.current?.();
    else setAnnotating(true);
  }, []);
  const [selection, setSelection] = useState<RevisionSelection | null>(null);
  const [commentDestination, setCommentDestination] = useState<{
    comment: DocumentRevisionComment;
    request: number;
  } | null>(null);
  const [markedComments, setMarkedComments] =
    useState<readonly DocumentRevisionComment[]>(NO_COMMENTS);
  const setFileMenu = chrome?.setFileMenu;
  useEffect(() => {
    if (!setFileMenu || thumbnail) return;
    setFileMenu(
      <>
        <DropdownMenuItem onClick={() => setNavigation((old) => !old)}>
          <List className="size-4" />
          页面目录
        </DropdownMenuItem>
        {onRequestRevision ? (
          <DropdownMenuItem onClick={toggleAnnotation}>
            <SquareMousePointer className="size-4" />
            请求修改
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
      </>,
    );
    return () => setFileMenu(null);
  }, [setFileMenu, thumbnail, onRequestRevision, setNavigation, toggleAnnotation]);

  const workspace = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const prepareEvidence = (comments: readonly DocumentRevisionComment[]) =>
    document ? capturePDFRevisionEvidence(document, comments, assertCurrent) : Promise.resolve([]);
  const [painted, setPainted] = useState(false);
  const markPainted = useCallback(() => setPainted(true), []);
  const [page, setPage] = usePreviewReadingState("pdfPage", 1);
  const [zoom, setZoom] = usePreviewReadingState("pdfZoom", "fit-width");
  const zoomAnchor = useRef<{
    page: HTMLElement;
    x: number;
    y: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const [error, setError] = useState("");
  const { container, viewport, sideInset } = usePreviewViewport();
  const paperViewport = {
    ...viewport,
    width: thumbnail
      ? Math.max(1, viewport.width)
      : Math.max(
          1,
          viewport.width -
            sideInset -
            (navigation && viewport.width >= 600 ? READER_NAVIGATION_INSET : 0),
        ),
  };
  const [actualPercent, setActualPercent] = useState(100);
  const initialPage = useRef(page);
  const currentPage = useRef(page);
  currentPage.current = page;
  const scrollFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );
  function trackPage() {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const element = container.current;
      if (!element || !document) return;
      const line = element.scrollTop + element.clientHeight * 0.45;
      const pages = element.querySelectorAll<HTMLElement>("[data-pdf-page]");
      // Stable page placeholders permit logarithmic lookup even in long documents.
      let low = 0,
        high = pages.length - 1,
        index = 0;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        const candidate = pages[middle];
        if (candidate instanceof HTMLElement && candidate.offsetTop <= line) {
          index = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      const number = Number(pages[index]?.getAttribute("data-pdf-page"));
      if (number >= 1 && number <= document.numPages) setPage(number);
    });
  }
  useEffect(() => {
    let active = true;
    setPainted(false);
    const task = openPreviewPDF(bytes);
    const timer = setTimeout(() => {
      if (active) {
        setError("PDF 较复杂，读取超时。请下载原件查看。");
        void task.destroy();
      }
    }, 30_000);
    void task.promise
      .then((result) => {
        clearTimeout(timer);
        assertCurrent();
        if (!result.numPages || result.numPages > 1000) throw new Error("PDF 页数超过预览限制。");
        if (active) {
          setPage(Math.min(result.numPages, Math.max(1, initialPage.current)));
          setDocument(result);
        }
      })
      .catch(() => {
        clearTimeout(timer);
        if (active) setError("PDF 无法打开，可能已加密或损坏。请下载原件查看。");
      });
    return () => {
      active = false;
      clearTimeout(timer);
      void task.destroy();
    };
  }, [bytes, assertCurrent, setPage]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: paper geometry changes require restoring the visible page after reflow.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const view = container.current;
    zoomAnchor.current = null;
    if (anchor && view?.contains(anchor.page)) {
      const rect = anchor.page.getBoundingClientRect();
      view.scrollLeft += rect.left + anchor.x * rect.width - anchor.clientX;
      view.scrollTop += rect.top + anchor.y * rect.height - anchor.clientY;
      return;
    }
    // A cover must never scroll its containing composer or file browser.
    if (!document || thumbnail || singlePage) return;
    // A narrower pane changes every paper's height. Retain the page, rather than
    // retaining a pixel offset which could now point into a different page.
    const frame = requestAnimationFrame(() => {
      container.current
        ?.querySelector(`[data-pdf-page="${currentPage.current}"]`)
        ?.scrollIntoView?.({ block: "start", behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    document,
    thumbnail,
    singlePage,
    container,
    viewport.width,
    viewport.height,
    zoom,
    sideInset,
    navigation,
  ]);
  function navigatePage(target: number) {
    if (!document || !Number.isInteger(target) || target < 1 || target > document.numPages) return;
    setPage(target);
    if (singlePage && target !== page) {
      setSelection(null);
      if (container.current) container.current.scrollTop = 0;
      return;
    }
    container.current
      ?.querySelector(`[data-pdf-page="${target}"]`)
      ?.scrollIntoView?.({ block: "start", behavior: readerScrollBehavior() });
  }
  const visiblePages = document
    ? singlePage
      ? [Math.max(1, Math.min(page, document.numPages))]
      : Array.from({ length: thumbnail ? 1 : document.numPages }, (_, index) => index + 1)
    : [];
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  function trackSelection() {
    const current = selectionRef.current,
      host = workspace.current?.getBoundingClientRect();
    const paper = container.current?.querySelector<HTMLElement>(
      `[data-pdf-page="${current?.page}"]`,
    );
    const layer = paper?.querySelector<HTMLElement>(".za-pdf-text-layer");
    if (!current || !host || !paper || !layer) return;
    const bounds = paper.getBoundingClientRect();
    const region = current.region;
    const rect = region
      ? {
          left: bounds.left + region.left * bounds.width,
          top: bounds.top + region.top * bounds.height,
          bottom: bounds.top + (region.top + region.height) * bounds.height,
        }
      : pdfTextRange(layer, current.start, current.end, current.quote)?.getBoundingClientRect();
    if (!rect) return;
    setSelection((old) =>
      old
        ? {
            ...old,
            x: Math.max(12, Math.min(rect.left - host.left, host.width - 352)),
            y: Math.min(rect.bottom - host.top, host.height - 110),
            visible: rect.bottom - host.top > 72 && rect.top - host.top < host.height - 20,
          }
        : null,
    );
  }
  return (
    <>
      <PreviewToolbar label="PDF" detail="只读">
        <PreviewLeadingTools>
          {onRequestRevision && !thumbnail ? (
            <Button
              variant="ghost"
              size="sm"
              className="za-request-revision"
              data-active={annotating}
              onClick={toggleAnnotation}
            >
              <SquareMousePointer className="size-4" />
              请求修改
            </Button>
          ) : null}
        </PreviewLeadingTools>
        {!singlePage ? (
          <PreviewPageControls page={page} count={document?.numPages ?? 0} onPage={navigatePage} />
        ) : null}
        <PreviewZoomControl
          label="PDF 缩放"
          value={zoom}
          onChange={setZoom}
          actualPercent={actualPercent}
          minPercent={30}
          maxPercent={800}
          percentages={[30, 50, 100, 150, 200]}
          zoomCurve="pdf"
          zoomStops={PDF_ZOOM_STOPS}
          onZoomAnchor={(clientX, clientY) => {
            const target = container.current?.ownerDocument
              .elementFromPoint?.(clientX, clientY)
              ?.closest<HTMLElement>("[data-pdf-page]");
            if (!target || !container.current?.contains(target)) return;
            const box = target.getBoundingClientRect();
            zoomAnchor.current = {
              page: target,
              clientX,
              clientY,
              x: (clientX - box.left) / box.width,
              y: (clientY - box.top) / box.height,
            };
          }}
        />
      </PreviewToolbar>
      <div
        className="za-document-workspace"
        ref={workspace}
        data-workspace-pdf={singlePage || undefined}
        data-navigation-pinned={navigation}
        data-annotating={annotating}
        style={
          {
            "--za-comment-cursor": COMMENT_CURSOR,
            "--za-comment-pin": COMMENT_PIN,
          } as React.CSSProperties
        }
      >
        {!thumbnail && document ? (
          <DocumentNavigation
            label="PDF 目录"
            pinned={navigation}
            onPinned={setNavigation}
            count={document.numPages}
            current={page}
            title={`${document.numPages} 页`}
          >
            {Array.from({ length: Math.min(document.numPages, 80) }, (_, index) => (
              <button
                type="button"
                // biome-ignore lint/suspicious/noArrayIndexKey: Immutable PDF page numbers are stable identities.
                key={index + 1}
                className="za-document-page-link"
                aria-label={`跳到第 ${index + 1} 页`}
                aria-current={page === index + 1 ? "page" : undefined}
                onClick={() => navigatePage(index + 1)}
              >
                <span>{index + 1}</span>
                <PDFPage
                  document={document}
                  number={index + 1}
                  selected={false}
                  zoom="fit-width"
                  pane={{ width: 124, height: 180 }}
                  root={workspace}
                  assertCurrent={assertCurrent}
                />
              </button>
            ))}
          </DocumentNavigation>
        ) : null}
        <PreviewScrollArea
          ref={container}
          className="za-preview-pdf za-preview-frame-content"
          data-ready={painted || !!error}
          aria-label="PDF 阅读画布"
          aria-busy={!document && !error}
          onScroll={() => {
            if (!singlePage) trackPage();
            trackSelection();
          }}
          tabIndex={0}
          onKeyDown={(event) => previewPageKey(event, page, document?.numPages ?? 0, navigatePage)}
        >
          {error ? (
            <PreviewUnavailable message={error} onDownload={onDownload} onRetry={onRetry} />
          ) : document ? (
            visiblePages.map((number) => (
              <PDFPage
                key={number}
                document={document}
                number={number}
                selected={page === number}
                zoom={zoom}
                cover={thumbnail}
                pane={paperViewport}
                onScale={singlePage || number === 1 ? setActualPercent : undefined}
                root={container}
                assertCurrent={assertCurrent}
                onDownload={onDownload}
                onRetry={onRetry}
                annotating={annotating}
                onSelection={setSelection}
                workspace={workspace}
                comments={markedComments}
                activeSelection={selection}
                onPainted={thumbnail || page === number ? markPainted : undefined}
                hideLoading={!painted}
                commentDestination={commentDestination}
              />
            ))
          ) : null}
        </PreviewScrollArea>
        {singlePage && document && !error && document.numPages > 1 ? (
          <div className="za-pdf-floating-pages">
            <PreviewPageControls
              page={page}
              count={document.numPages}
              onPage={navigatePage}
              inline
              compact
            />
          </div>
        ) : null}
        {!painted && !error ? (
          <div className="za-preview-frame-pending" data-cover={!!thumbnail}>
            <PreviewLoading message="正在读取 PDF…" onCancel={thumbnail ? undefined : onCancel} />
          </div>
        ) : null}
        {!thumbnail ? (
          <ResourceDocumentComments
            exitRef={annotationExit}
            enabled={annotating}
            onEnabled={setAnnotating}
            selection={selection}
            onSelection={setSelection}
            onNavigate={(id, comment) => {
              const target = Number(id.split("-")[2]);
              navigatePage(target);
              if (comment)
                setCommentDestination((old) => ({ comment, request: (old?.request ?? 0) + 1 }));
            }}
            onMarks={setMarkedComments}
            prepareEvidence={prepareEvidence}
          />
        ) : null}
      </div>
    </>
  );
}

/** Continuous paper geometry with rasterization limited to pages near the viewport. */
function PDFPage({
  document,
  number,
  selected,
  zoom,
  pane,
  root,
  assertCurrent,
  onDownload,
  onRetry,
  annotating,
  onSelection,
  workspace,
  comments = NO_COMMENTS,
  commentDestination,
  onScale,
  activeSelection,
  onPainted,
  hideLoading,
  cover = false,
  renderText = true,
}: PreviewRecovery & {
  onPainted?: () => void;
  hideLoading?: boolean;
  onScale?: (percent: number) => void;
  activeSelection?: RevisionSelection | null;
  comments?: readonly DocumentRevisionComment[];
  commentDestination?: { comment: DocumentRevisionComment; request: number } | null;
  annotating?: boolean;
  onSelection?: (value: RevisionSelection) => void;
  workspace?: RefObject<HTMLDivElement | null>;
  cover?: boolean;
  renderText?: boolean;
  document: PDFDocumentProxy;
  number: number;
  selected: boolean;
  zoom: PreviewZoom;
  pane: { width: number; height: number };
  root: RefObject<HTMLElement | null>;
  assertCurrent: () => void;
}) {
  const text = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const logicalPage = useRef<{ width: number; height: number } | null>(null);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState(DEFAULT_PAGE);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [textRevision, setTextRevision] = useState(0);
  const navigatedRequest = useRef(0);
  const [marks, setMarks] = useState<
    { key: string; left: number; top: number; width: number; height: number }[]
  >([]);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [lasso, setLasso] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const enabled = near || selected;
  useEffect(() => {
    if (!busy && enabled) onPainted?.();
  }, [busy, enabled, onPainted]);
  const scale = cover
    ? (pane.width || 168) / size.width
    : pdfPageScale(zoom, size, { width: pane.width || 640, height: pane.height || 800 });
  useEffect(() => {
    onScale?.(scale * 100);
  }, [scale, onScale]);
  useEffect(() => {
    const element = holder.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const preload = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: root.current,
      rootMargin: "600px 0px",
    });
    preload.observe(element);
    return () => {
      preload.disconnect();
    };
  }, [root]);
  useEffect(() => {
    const element = canvas.current;
    if (!element || !enabled) return;
    if (!element.width) setBusy(true);
    let active = true;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | null =
      null;
    const paint = async () => {
      try {
        const pdfPage = await document.getPage(number);
        if (!active) return;
        assertCurrent();
        const base = pdfPage.getViewport({ scale: 96 / 72 });
        logicalPage.current = pdfPage.getViewport({ scale: 1 });
        setSize((old) =>
          old.width === base.width && old.height === base.height
            ? old
            : { width: base.width, height: base.height },
        );
        const desiredScale = cover
          ? (pane.width || 168) / base.width
          : pdfPageScale(zoom, base, { width: pane.width || 640, height: pane.height || 800 });
        const viewport = pdfPage.getViewport({
          scale: (96 / 72) * boundedPreviewScale(desiredScale, base),
        });
        const buffer = element.width ? element.ownerDocument.createElement("canvas") : element;
        buffer.width = Math.max(1, Math.floor(viewport.width));
        buffer.height = Math.max(1, Math.floor(viewport.height));
        render = pdfPage.render({
          canvas: buffer,
          viewport,
          ...(renderText ? {} : { annotationMode: AnnotationMode.DISABLE }),
        });
        await render.promise;
        if (!active) return;
        assertCurrent();
        if (buffer !== element) {
          element.width = buffer.width;
          element.height = buffer.height;
          element.getContext("2d")?.drawImage(buffer, 0, 0);
          buffer.width = 0;
          buffer.height = 0;
        }
        setError("");
        setBusy(false);
      } catch {
        if (!active) return;
        if (busy) setError("此页未能渲染，请下载原件查看。");
        setBusy(false);
      }
    };
    const delay = element.width && !busy ? setTimeout(() => void paint(), 120) : undefined;
    if (delay === undefined) void paint();
    return () => {
      active = false;
      clearTimeout(delay);
      render?.cancel();
    };
  }, [document, number, enabled, zoom, pane.width, pane.height, assertCurrent, renderText, cover]);
  useEffect(() => {
    const element = text.current;
    if (!element || !enabled || typeof TextLayer !== "function") return;
    let active = true;
    let layer: TextLayer | undefined;
    void (async () => {
      const page = await document.getPage(number);
      if (!active) return;
      const content = await page.getTextContent();
      if (!active || content.items.length > 20000) return;
      assertCurrent();
      const viewport = page.getViewport({ scale: 96 / 72 });
      element.style.setProperty("--total-scale-factor", String(96 / 72));
      layer = new TextLayer({ textContentSource: content, container: element, viewport });
      await layer.render();
      if (active) setTextRevision((old) => old + 1);
    })().catch(() => {});
    return () => {
      active = false;
      layer?.cancel();
      element.replaceChildren();
    };
  }, [document, number, enabled, assertCurrent, renderText]);
  useEffect(() => {
    if (!enabled && canvas.current) {
      canvas.current.width = 0;
      canvas.current.height = 0;
    }
  }, [enabled]);
  // Geometry is measured from the newly rendered glyph layer, never from stale PDF coordinates.
  useLayoutEffect(() => {
    const paper = holder.current,
      layer = text.current;
    const box = paper?.getBoundingClientRect();
    if (!layer || !box?.width || !box.height || !enabled || busy) {
      setMarks([]);
      return;
    }
    const rectangles: typeof marks = [];
    for (const comment of comments) {
      if (comment.block !== `pdf-page-${number}`) continue;
      const range =
        !textRevision || (comment.region && comment.pdf?.kind !== "text")
          ? null
          : pdfTextRange(layer, comment.start, comment.end, comment.quote);
      const glyphs = range?.getClientRects?.();
      if (!glyphs?.length && comment.region) {
        rectangles.push({
          key: comment.id,
          left: comment.region.left * 100,
          top: comment.region.top * 100,
          width: comment.region.width * 100,
          height: comment.region.height * 100,
        });
        continue;
      }
      if (!glyphs) continue;
      for (const rect of Array.from(glyphs).slice(0, 128)) {
        if (!rect.width || !rect.height || rectangles.length >= 512) continue;
        rectangles.push({
          key: `${comment.id}-${rectangles.length}`,
          left: ((rect.left - box.left) / box.width) * 100,
          top: ((rect.top - box.top) / box.height) * 100,
          width: (rect.width / box.width) * 100,
          height: (rect.height / box.height) * 100,
        });
      }
    }
    setMarks(rectangles);
  }, [comments, number, enabled, busy, textRevision]);
  useLayoutEffect(() => {
    if (
      !commentDestination ||
      commentDestination.request === navigatedRequest.current ||
      commentDestination.comment.page !== number ||
      !text.current ||
      !enabled ||
      busy
    )
      return;
    const comment = commentDestination.comment;
    if (comment.region && comment.pdf?.kind !== "text" && holder.current) {
      const scroll = root.current;
      const target = holder.current.getBoundingClientRect();
      const viewport = scroll?.getBoundingClientRect();
      if (scroll && viewport) {
        navigatedRequest.current = commentDestination.request;
        const center = (comment.region.top + comment.region.height / 2) * target.height;
        scroll.scrollBy({
          top: target.top + center - viewport.top - viewport.height / 2,
          behavior: readerScrollBehavior(),
        });
      }
      return;
    }
    if (!textRevision) return;
    const range = pdfTextRange(text.current, comment.start, comment.end, comment.quote);
    const element = range?.startContainer.parentElement;
    if (element) {
      navigatedRequest.current = commentDestination.request;
      element.scrollIntoView?.({ block: "center", behavior: readerScrollBehavior() });
    }
  }, [commentDestination, number, enabled, busy, textRevision, root]);
  return (
    // biome-ignore lint/a11y/useSemanticElements: A rendered PDF page groups text and canvas, rather than form fields.
    <div
      ref={holder}
      role="group"
      aria-label={`第 ${number} 页`}
      className="za-preview-pdf-page"
      data-annotating={annotating}
      onPointerDown={(event) => {
        if (
          !annotating ||
          busy ||
          error ||
          !event.isPrimary ||
          event.button !== 0 ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        window.getSelection()?.removeAllRanges();
        const box = event.currentTarget.getBoundingClientRect();
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX - box.left,
          y: event.clientY - box.top,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        const box = event.currentTarget.getBoundingClientRect();
        const x = Math.max(0, Math.min(box.width, event.clientX - box.left)),
          y = Math.max(0, Math.min(box.height, event.clientY - box.top));
        setLasso({
          left: Math.min(start.x, x),
          top: Math.min(start.y, y),
          width: Math.abs(start.x - x),
          height: Math.abs(start.y - y),
        });
      }}
      onPointerCancel={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        setLasso(null);
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        drag.current = null;
        setLasso(null);
        const pageSize = logicalPage.current;
        if (!onSelection || !pageSize) return;
        const paper = event.currentTarget.getBoundingClientRect(),
          host = workspace?.current?.getBoundingClientRect();
        if (!host || !paper.width || !paper.height) return;
        const x = Math.max(0, Math.min(paper.width, event.clientX - paper.left));
        const y = Math.max(0, Math.min(paper.height, event.clientY - paper.top));
        const area = {
          left: Math.min(start.x, x),
          top: Math.min(start.y, y),
          width: Math.abs(start.x - x),
          height: Math.abs(start.y - y),
        };
        const isArea = area.width >= 3 || area.height >= 3;
        const nodes =
          text.current?.querySelectorAll<HTMLElement>('span[role="presentation"]') ?? [];
        let clickedText: DOMRect | undefined;
        let offset = 0,
          from = -1,
          to = -1;
        for (const node of nodes) {
          const bounds = node.getBoundingClientRect(),
            length = node.textContent?.length ?? 0;
          const hit = isArea
            ? bounds.left < paper.left + area.left + area.width &&
              bounds.right > paper.left + area.left &&
              bounds.top < paper.top + area.top + area.height &&
              bounds.bottom > paper.top + area.top
            : event.clientX >= bounds.left &&
              event.clientX <= bounds.right &&
              event.clientY >= bounds.top &&
              event.clientY <= bounds.bottom;
          if (hit) {
            if (from < 0) from = offset;
            to = offset + length;
            if (!isArea && length && bounds.width && bounds.height) {
              clickedText = bounds;
              break;
            }
          }
          offset += length;
        }
        const quote =
          from < 0 ? "" : (text.current?.textContent ?? "").slice(from, Math.min(to, from + 2000));
        const region = normalizedPDFRegion(
          isArea
            ? { ...area, left: paper.left + area.left, top: paper.top + area.top }
            : (clickedText ?? { left: paper.left + x, top: paper.top + y, width: 0, height: 0 }),
          paper,
        );
        onSelection({
          id: `pdf-page-${number}`,
          page: number,
          start: Math.max(0, from),
          end: Math.max(0, from) + quote.length,
          quote,
          x: Math.max(12, Math.min(event.clientX - host.left, host.width - 352)),
          y: Math.min(event.clientY - host.top, host.height - 150),
          region,
          pdf: {
            pageCount: document.numPages,
            pageWidth: pageSize.width,
            pageHeight: pageSize.height,
            kind: isArea ? "region" : clickedText ? "text" : "point",
          },
        });
      }}
      onMouseUp={(event) => {
        const pageSize = logicalPage.current;
        if (!annotating || busy || error || !onSelection || !text.current || !pageSize) return;
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (
          !range ||
          range.collapsed ||
          !text.current.contains(range.startContainer) ||
          !text.current.contains(range.endContainer)
        )
          return;
        const prefix = window.document.createRange();
        prefix.selectNodeContents(text.current);
        prefix.setEnd(range.startContainer, range.startOffset);
        const start = prefix.toString().length,
          quote = range.toString().slice(0, 2000);
        const rect = range.getBoundingClientRect(),
          box = workspace?.current?.getBoundingClientRect(),
          paper = event.currentTarget.getBoundingClientRect();
        if (!quote.trim() || !box || !paper.width || !paper.height) return;
        event.stopPropagation();
        onSelection({
          id: `pdf-page-${number}`,
          page: number,
          start,
          end: start + quote.length,
          quote,
          region: normalizedPDFRegion(rect, paper),
          pdf: {
            pageCount: document.numPages,
            pageWidth: pageSize.width,
            pageHeight: pageSize.height,
            kind: "text",
          },
          x: Math.max(12, Math.min(rect.left - box.left, box.width - 352)),
          y: Math.min(rect.bottom - box.top, box.height - 150),
        });
      }}
      data-pdf-page={number}
      aria-busy={(near || selected) && busy}
      style={{ width: size.width * scale, minHeight: size.height * scale }}
    >
      <canvas
        ref={canvas}
        width={0}
        height={0}
        aria-label={`PDF 第 ${number} 页`}
        style={{
          width: size.width * scale,
          height: size.height * scale,
          visibility: !busy && (near || selected) && !error ? "visible" : "hidden",
        }}
      />
      {renderText && (
        <div
          ref={text}
          className="za-pdf-text-layer"
          style={{ width: size.width, height: size.height, transform: `scale(${scale})` }}
        />
      )}
      <div className="za-pdf-comment-marks" aria-hidden="true">
        {lasso ? (
          <span
            className="za-pdf-region"
            style={{ left: lasso.left, top: lasso.top, width: lasso.width, height: lasso.height }}
          />
        ) : null}
        {activeSelection?.page === number && activeSelection.region ? (
          <span
            className="za-pdf-region"
            style={{
              left: `${activeSelection.region.left * 100}%`,
              top: `${activeSelection.region.top * 100}%`,
              width: `${activeSelection.region.width * 100}%`,
              height: `${activeSelection.region.height * 100}%`,
            }}
          />
        ) : null}
        {marks.map((mark) => (
          <span
            key={mark.key}
            data-note={
              comments.find(
                (comment) => mark.key === comment.id || mark.key.startsWith(`${comment.id}-`),
              )?.comment
            }
            style={{
              left: `${mark.left}%`,
              top: `${mark.top}%`,
              width: `${mark.width}%`,
              height: `${mark.height}%`,
            }}
          />
        ))}
      </div>
      {error ? (
        <div className="za-preview-rendering">
          <PreviewUnavailable message={error} onDownload={onDownload} onRetry={onRetry} />
        </div>
      ) : !hideLoading && busy && (near || selected) ? (
        <div className="za-preview-rendering">
          <PreviewLoading message={`正在渲染第 ${number} 页…`} />
        </div>
      ) : null}
      <span className="za-preview-paper-number" aria-hidden="true">
        {number}
      </span>
    </div>
  );
}
