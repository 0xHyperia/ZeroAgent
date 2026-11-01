import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  version as pdfVersion,
  TextLayer,
} from "pdfjs-dist";
import pdfWorkerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { type RefObject, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { List, MessageSquare } from "../IconSet";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewIdentityContext, PreviewToolbarMount } from "./PreviewChrome";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import {
  PreviewPageControls,
  PreviewToolbar,
  PreviewZoomControl,
  previewPageKey,
} from "./PreviewToolbar";
import { pdfPreviewAssetsURL } from "./pdfPreviewAssets";
import { pdfTextRange } from "./pdfTextRange";
import { boundedPreviewScale, previewScale } from "./previewGeometry";
import {
  type DocumentRevisionComment,
  ResourceDocumentComments,
  type RevisionSelection,
} from "./ResourceDocumentComments";
import { type PreviewZoom, usePreviewReadingState } from "./readingSession";
import { usePreviewViewport } from "./usePreviewViewport";

GlobalWorkerOptions.workerSrc = pdfWorkerURL;
const DEFAULT_PAGE = { width: 816, height: 1056 };
const NO_COMMENTS: readonly DocumentRevisionComment[] = [];

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
  const [navigation, setNavigation] = usePreviewReadingState("pdfNavigation", false);
  const [annotating, setAnnotating] = useState(false);
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
          <DropdownMenuItem onClick={() => setAnnotating((old) => !old)}>
            <MessageSquare className="size-4" />
            请求修改
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
      </>,
    );
    return () => setFileMenu(null);
  }, [setFileMenu, thumbnail, onRequestRevision, setNavigation]);

  const workspace = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = usePreviewReadingState("pdfPage", 1);
  const [zoom, setZoom] = usePreviewReadingState("pdfZoom", "fit-width");
  const [error, setError] = useState("");
  const { container, viewport } = usePreviewViewport<HTMLElement>();
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
      // Stable page placeholders permit logarithmic lookup even in long documents.
      let low = 0,
        high = element.children.length - 1,
        index = 0;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        const candidate = element.children[middle];
        if (candidate instanceof HTMLElement && candidate.offsetTop <= line) {
          index = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      const number = Number(element.children[index]?.getAttribute("data-pdf-page"));
      if (number >= 1 && number <= document.numPages) setPage(number);
    });
  }
  useEffect(() => {
    let active = true;
    const assets = pdfPreviewAssetsURL(pdfVersion);
    const task = getDocument({
      data: bytes.slice(),
      enableXfa: false,
      cMapUrl: `${assets}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assets}standard_fonts/`,
      wasmUrl: `${assets}wasm/`,
      iccUrl: `${assets}iccs/`,
      useSystemFonts: true,
    });
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
    if (!document) return;
    // A narrower pane changes every paper's height. Retain the page, rather than
    // retaining a pixel offset which could now point into a different page.
    const frame = requestAnimationFrame(() => {
      container.current
        ?.querySelector(`[data-pdf-page="${currentPage.current}"]`)
        ?.scrollIntoView?.({ block: "start", behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [document, container, viewport.width, viewport.height, zoom]);
  function navigatePage(target: number) {
    if (!document || !Number.isInteger(target) || target < 1 || target > document.numPages) return;
    setPage(target);
    container.current
      ?.querySelector(`[data-pdf-page="${target}"]`)
      ?.scrollIntoView?.({ block: "start", behavior: "instant" });
  }
  return (
    <>
      <PreviewToolbar label="PDF" detail="只读">
        {!thumbnail ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="PDF 页面目录"
            onClick={() => setNavigation(!navigation)}
          >
            <List className="size-4" />
          </Button>
        ) : null}
        {onRequestRevision && !thumbnail ? (
          <Button
            variant="ghost"
            size="sm"
            className="za-request-revision"
            data-active={annotating}
            onClick={() => setAnnotating(!annotating)}
          >
            <MessageSquare className="size-4" />
            请求修改
          </Button>
        ) : null}
        <PreviewPageControls page={page} count={document?.numPages ?? 0} onPage={navigatePage} />
        <PreviewZoomControl label="PDF 缩放" value={zoom} onChange={setZoom} />
      </PreviewToolbar>
      <div className="za-document-workspace" ref={workspace}>
        {!thumbnail && document ? (
          navigation ? (
            <aside className="za-document-navigation" aria-label="PDF 页面目录">
              <header>
                <strong>{document.numPages} 页</strong>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="收起 PDF 目录"
                  onClick={() => setNavigation(false)}
                >
                  <List className="size-4" />
                </Button>
              </header>
              <nav>
                {Array.from({ length: Math.min(document.numPages, 80) }, (_, index) => (
                  <button
                    type="button"
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
              </nav>
            </aside>
          ) : (
            <button
              type="button"
              className="za-document-navigation-rail"
              aria-label="展开 PDF 目录"
              onClick={() => setNavigation(true)}
            >
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
            </button>
          )
        ) : null}
        <section
          ref={container}
          className="za-preview-pdf"
          aria-label="PDF 阅读画布"
          aria-busy={!document && !error}
          onScroll={trackPage}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: focus scopes page shortcuts to this reading canvas
          tabIndex={0}
          onKeyDown={(event) => previewPageKey(event, page, document?.numPages ?? 0, navigatePage)}
        >
          {error ? (
            <PreviewUnavailable message={error} onDownload={onDownload} onRetry={onRetry} />
          ) : document ? (
            Array.from({ length: thumbnail ? 1 : document.numPages }, (_, index) => (
              <PDFPage
                // biome-ignore lint/suspicious/noArrayIndexKey: immutable PDF page numbers are the resource's stable identities.
                key={index + 1}
                document={document}
                number={index + 1}
                selected={page === index + 1}
                zoom={zoom}
                pane={viewport}
                root={container}
                assertCurrent={assertCurrent}
                onDownload={onDownload}
                onRetry={onRetry}
                annotating={annotating}
                onSelection={setSelection}
                workspace={workspace}
                comments={markedComments}
                commentDestination={commentDestination}
              />
            ))
          ) : (
            <PreviewLoading message="正在读取 PDF…" onCancel={onCancel} />
          )}
        </section>
        {!thumbnail ? (
          <ResourceDocumentComments
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
}: PreviewRecovery & {
  comments?: readonly DocumentRevisionComment[];
  commentDestination?: { comment: DocumentRevisionComment; request: number } | null;
  annotating?: boolean;
  onSelection?: (value: RevisionSelection) => void;
  workspace?: RefObject<HTMLDivElement | null>;
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
  const [near, setNear] = useState(false);
  const [size, setSize] = useState(DEFAULT_PAGE);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [textRevision, setTextRevision] = useState(0);
  const navigatedRequest = useRef(0);
  const [marks, setMarks] = useState<
    { key: string; left: number; top: number; width: number; height: number }[]
  >([]);
  const enabled = near || selected;
  const scale = boundedPreviewScale(
    previewScale(zoom, size, { width: pane.width || 640, height: pane.height || 800 }),
    size,
  );
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
    let active = true;
    let layer: TextLayer | null = null;
    const textElement = text.current;
    textElement?.replaceChildren();
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | null =
      null;
    setBusy(true);
    setError("");
    void document
      .getPage(number)
      .then(async (pdfPage) => {
        assertCurrent();
        if (!active) return;
        const units = 96 / 72,
          base = pdfPage.getViewport({ scale: units });
        setSize((old) =>
          old.width === base.width && old.height === base.height
            ? old
            : { width: base.width, height: base.height },
        );
        const safeScale = boundedPreviewScale(
          previewScale(zoom, base, { width: pane.width || 640, height: pane.height || 800 }),
          base,
        );
        const viewport = pdfPage.getViewport({ scale: units * safeScale });
        element.width = Math.max(1, Math.floor(viewport.width));
        element.height = Math.max(1, Math.floor(viewport.height));
        render = pdfPage.render({ canvas: element, viewport });
        await render.promise;
        assertCurrent();
        if (active) setBusy(false);
        if (active && textElement && typeof TextLayer === "function") {
          const content = await pdfPage.getTextContent();
          if (!active) return;
          assertCurrent();
          if (content.items.length > 20000) return;
          textElement.style.setProperty("--total-scale-factor", String(units * safeScale));
          layer = new TextLayer({ textContentSource: content, container: textElement, viewport });
          await layer.render();
          if (active) setTextRevision((old) => old + 1);
        }
      })
      .catch(() => {
        if (active) {
          setError("此页未能渲染，请下载原件查看。");
          setBusy(false);
        }
      });
    return () => {
      active = false;
      render?.cancel();
      layer?.cancel();
      textElement?.replaceChildren();
    };
  }, [document, number, enabled, zoom, pane.width, pane.height, assertCurrent]);
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
      const range = pdfTextRange(layer, comment.start, comment.end, comment.quote);
      if (!range || typeof range.getClientRects !== "function") continue;
      for (const rect of Array.from(range.getClientRects()).slice(0, 128)) {
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
    const range = pdfTextRange(text.current, comment.start, comment.end, comment.quote);
    const element = range?.startContainer.parentElement;
    if (element) {
      navigatedRequest.current = commentDestination.request;
      element.scrollIntoView?.({ block: "center", behavior: "instant" });
    }
  }, [commentDestination, number, enabled, busy, textRevision]);
  return (
    <div
      ref={holder}
      className="za-preview-pdf-page"
      data-annotating={annotating}
      onMouseUp={(event) => {
        if (!annotating || !onSelection || !text.current) return;
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
          box = workspace?.current?.getBoundingClientRect();
        if (!quote.trim() || !box) return;
        event.stopPropagation();
        onSelection({
          id: `pdf-page-${number}`,
          page: number,
          start,
          end: start + quote.length,
          quote,
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
      <div ref={text} className="za-pdf-text-layer" />
      <div className="za-pdf-comment-marks" aria-hidden="true">
        {marks.map((mark) => (
          <span
            key={mark.key}
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
      ) : busy && (near || selected) ? (
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
