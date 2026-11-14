import {
  AnnotationMode,
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  version as pdfVersion,
  TextLayer,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerURL from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import {
  memo,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../i18n";
import { ChevronRight, List, Search, SquareMousePointer, X } from "../IconSet";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { DocumentNavigation } from "./DocumentNavigation";
import type { DocumentRegion } from "./docxReaderDocument";
import { PDFPageLinks } from "./PDFPageLinks";
import { PDFTextSelectionAction } from "./PDFTextSelectionAction";
import { PreviewIdentityContext, PreviewToolbarMount } from "./PreviewChrome";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewScrollArea } from "./PreviewScrollArea";
import {
  PreviewLeadingTools,
  PreviewToolbar,
  PreviewZoomControl,
  previewPageKey,
} from "./PreviewToolbar";
import { createPDFFind, type PDFFind } from "./pdfFind";
import { pdfPreviewAssetsURL } from "./pdfPreviewAssets";
import { capturePDFRevisionEvidence } from "./pdfRevisionEvidence";
import { normalizedPDFRegion, pdfTextRange, readPDFTextRange } from "./pdfTextRange";
import { boundedPreviewScale } from "./previewGeometry";
import { ReaderCommentTooltip } from "./ReaderCommentTooltip";
import {
  type DocumentRevisionComment,
  ResourceDocumentComments,
  type RevisionSelection,
  type RevisionSelectionBounds,
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
const THUMBNAIL_PANE = { width: 124, height: 180 };
const PDF_ZOOM_STOPS = [
  30, 40, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500, 600, 700, 800,
];
function pdfPageScale(zoom: PreviewZoom, size: typeof DEFAULT_PAGE, pane: typeof DEFAULT_PAGE) {
  if (typeof zoom === "number") return Math.max(30, Math.min(800, zoom)) / 100;
  const width = Math.max(1, pane.width - 48) / size.width;
  return Math.min(1, width, zoom === "fit-page" ? Math.max(1, pane.height - 48) / size.height : 1);
}
const NO_COMMENTS: readonly DocumentRevisionComment[] = [];

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
              exactWidth
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
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [navigation, setNavigation] = usePreviewReadingState("pdfNavigation", false);
  const [annotating, setAnnotating] = useState(false);
  const [selection, setSelection] = useState<RevisionSelection | null>(null);
  const dismissSelection = useRef<(() => boolean) | null>(null);
  const toggleAnnotation = useCallback(() => {
    setAnnotating((active) => !active);
  }, []);
  const [commentDestination, setCommentDestination] = useState<{
    comment: DocumentRevisionComment;
    request: number;
  } | null>(null);
  const [markedComments, setMarkedComments] =
    useState<readonly DocumentRevisionComment[]>(NO_COMMENTS);
  const editComment = useRef<((id: string, source?: "marker") => void) | null>(null);
  const editAtMarker = useCallback((id: string) => editComment.current?.(id, "marker"), []);
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
  const [loaded, setLoaded] = useState<{
    bytes: Uint8Array;
    pdf: PDFDocumentProxy;
    firstSize: typeof DEFAULT_PAGE;
  } | null>(null);
  const document = loaded?.bytes === bytes ? loaded.pdf : null;
  const firstSize = loaded?.bytes === bytes ? loaded.firstSize : DEFAULT_PAGE;
  const [pageSizes, setPageSizes] = useState<{
    pdf: PDFDocumentProxy;
    values: (typeof DEFAULT_PAGE | undefined)[];
  }>();
  const saveLayoutAnchor = useRef<() => void>(() => {});
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
  const [findOpen, setFindOpen] = useState(false);
  const [findStarted, setFindStarted] = useState(false);
  const [find, setFind] = useState<PDFFind>();
  const [findQuery, setFindQuery] = useState("");
  const [findStatus, setFindStatus] = useState({ current: 0, total: 0, pending: false });
  const [findError, setFindError] = useState(false);
  const findInput = useRef<HTMLInputElement>(null);
  const revealPage = useRef<(target: number, behavior?: ScrollBehavior) => void>(() => {});
  const paperViewport = useMemo(
    () => ({
      height: viewport.height,
      width: Math.max(
        1,
        viewport.width -
          (thumbnail
            ? 0
            : sideInset + (navigation && viewport.width >= 600 ? READER_NAVIGATION_INSET : 0)),
      ),
    }),
    [viewport.height, viewport.width, thumbnail, sideInset, navigation],
  );
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
  const pageElements = useRef<HTMLElement[]>([]);
  const resolveCommentBounds = useCallback(
    (selection: RevisionSelection): RevisionSelectionBounds | undefined => {
      const view = container.current;
      const paper = pageElements.current[selection.page - 1];
      if (!view || !paper) return undefined;
      const paperBox = paper.getBoundingClientRect();
      const layer = paper.querySelector<HTMLElement>(".za-pdf-text-layer");
      const region = selection.region;
      const target = region
        ? new DOMRect(
            paperBox.left + region.left * paperBox.width,
            paperBox.top + region.top * paperBox.height,
            region.width * paperBox.width,
            region.height * paperBox.height,
          )
        : layer &&
          pdfTextRange(
            layer,
            selection.start,
            selection.end,
            selection.quote,
          )?.getBoundingClientRect();
      return target
        ? { target, viewport: view.getBoundingClientRect(), observe: paper, align: "end" }
        : undefined;
    },
    [container],
  );
  const selectComment = useCallback(
    (next: RevisionSelection | null) => {
      const view = container.current;
      if (!next && view?.ownerDocument.activeElement?.closest(".za-document-comment-editor"))
        view.focus({ preventScroll: true });
      setSelection(next);
    },
    [container],
  );
  const handleAnnotationEscape = useCallback(() => {
    if (selection) {
      dismissSelection.current?.();
      return true;
    }
    if (annotating && dismissSelection.current?.() !== false) setAnnotating(false);
    return annotating;
  }, [annotating, selection]);
  const registerEscape = chrome?.registerEscapeHandler;
  useLayoutEffect(
    () => (annotating || selection ? registerEscape?.(handleAnnotationEscape) : undefined),
    [annotating, selection, registerEscape, handleAnnotationEscape],
  );
  function trackViewport() {
    if (scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const element = container.current;
      if (!element || !document) return;
      const viewportBox = element.getBoundingClientRect();
      const pages = pageElements.current;
      let low = 0,
        high = pages.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (pages[middle].getBoundingClientRect().bottom <= viewportBox.top) low = middle + 1;
        else high = middle;
      }
      let best = Math.min(low + 1, pages.length);
      let maxVisibility = 0;
      for (let index = low; index < pages.length; index++) {
        const box = pages[index].getBoundingClientRect();
        if (box.top >= viewportBox.bottom) break;
        const height =
          Math.min(box.bottom, viewportBox.bottom) - Math.max(box.top, viewportBox.top);
        const width = Math.min(box.right, viewportBox.right) - Math.max(box.left, viewportBox.left);
        const visibility = (Math.max(0, height) * Math.max(0, width)) / (box.width * box.height);
        if (visibility > maxVisibility) {
          maxVisibility = visibility;
          best = index + 1;
        }
      }
      if (best && best !== currentPage.current) setPage(best);
    });
  }
  useEffect(() => {
    let active = true;
    setPainted(false);
    setError("");
    const task = openPreviewPDF(bytes);
    const timer = setTimeout(() => {
      if (active) {
        setError("PDF 较复杂，读取超时。请下载原件查看。");
        active = false;
        void task.destroy().catch(() => {});
      }
    }, 30_000);
    void task.promise
      .then(async (result) => {
        assertCurrent();
        if (!result.numPages || result.numPages > 1000) throw new Error("PDF 页数超过预览限制。");
        const first = await result.getPage(1);
        clearTimeout(timer);
        if (active) {
          assertCurrent();
          setPage(Math.min(result.numPages, Math.max(1, initialPage.current)));
          const { width, height } = first.getViewport({ scale: 96 / 72 });
          setLoaded({ bytes, pdf: result, firstSize: { width, height } });
        }
      })
      .catch(() => {
        clearTimeout(timer);
        if (active) setError("PDF 无法打开，可能已加密或损坏。请下载原件查看。");
      });
    return () => {
      active = false;
      clearTimeout(timer);
      void task.destroy().catch(() => {});
    };
  }, [bytes, assertCurrent, setPage]);
  useEffect(() => {
    if (!document || thumbnail || document.numPages <= 1) return;
    let active = true;
    const sizes: (typeof DEFAULT_PAGE | undefined)[] = [firstSize];
    void (async () => {
      for (let start = 2; start <= document.numPages && active; start += 8) {
        const count = Math.min(8, document.numPages - start + 1);
        const results = await Promise.allSettled(
          Array.from({ length: count }, (_, offset) => document.getPage(start + offset)),
        );
        if (!active) return;
        for (const [offset, result] of results.entries()) {
          if (result.status === "fulfilled") {
            const { width, height } = result.value.getViewport({ scale: 96 / 72 });
            sizes[start + offset - 1] = { width, height };
          }
        }
        // Replacing estimates must not jump away from the reader's current paper.
        if (container.current?.scrollTop && !zoomAnchor.current) saveLayoutAnchor.current();
        setPageSizes({ pdf: document, values: sizes.slice() });
      }
    })();
    return () => {
      active = false;
    };
  }, [document, thumbnail, firstSize, container]);
  useLayoutEffect(() => {
    pageElements.current = Array.from(
      container.current?.querySelectorAll<HTMLElement>("[data-pdf-page]") ?? [],
    );
    if (!thumbnail && document) revealPage.current(currentPage.current, "instant");
  }, [document, thumbnail, container]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reposition the anchor after a geometry change.
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const view = container.current;
    zoomAnchor.current = null;
    if (anchor && view?.contains(anchor.page)) {
      const rect = anchor.page.getBoundingClientRect();
      view.scrollLeft += rect.left + anchor.x * rect.width - anchor.clientX;
      view.scrollTop += rect.top + anchor.y * rect.height - anchor.clientY;
    }
    trackViewport();
  }, [
    thumbnail,
    container,
    viewport.width,
    viewport.height,
    zoom,
    sideInset,
    navigation,
    pageSizes,
  ]);

  function navigatePage(target: number, behavior = readerScrollBehavior()) {
    if (!document || !Number.isInteger(target) || target < 1 || target > document.numPages) return;
    if (target !== currentPage.current) setPage(target);
    const view = container.current;
    const paper = pageElements.current[target - 1];
    if (!view || !paper) return;
    const padding = view.firstElementChild
      ? Number.parseFloat(getComputedStyle(view.firstElementChild).paddingTop) || 0
      : 0;
    view.scrollTo?.({
      top:
        view.scrollTop +
        paper.getBoundingClientRect().top -
        view.getBoundingClientRect().top -
        padding,
      behavior,
    });
  }
  revealPage.current = navigatePage;
  const navigateLink = useCallback((page: number) => revealPage.current(page), []);

  function anchorZoom(clientX?: number, clientY?: number) {
    const view = container.current;
    const viewportBox = view?.getBoundingClientRect();
    if (!view || !viewportBox || thumbnail) return;
    const x = clientX ?? viewportBox.left + viewportBox.width / 2;
    const y = clientY ?? viewportBox.top + viewportBox.height / 2;
    const hit = view.ownerDocument
      .elementFromPoint?.(x, y)
      ?.closest<HTMLElement>("[data-pdf-page]");
    const paper = hit && view.contains(hit) ? hit : pageElements.current[currentPage.current - 1];
    const box = paper?.getBoundingClientRect();
    if (!paper || !box?.width || !box.height) return;
    zoomAnchor.current = {
      page: paper,
      clientX: x,
      clientY: y,
      x: Math.min(1, Math.max(0, (x - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (y - box.top) / box.height)),
    };
  }
  saveLayoutAnchor.current = anchorZoom;

  useEffect(() => {
    if (!document || !findStarted) return;
    let active = true;
    let dispose: (() => void) | undefined;
    setFindError(false);
    void createPDFFind(document, {
      current: () => currentPage.current,
      go: (page) => revealPage.current(page, "instant"),
    })
      .then((engine) => {
        if (!active) return engine.destroy();
        const unsubscribe = engine.subscribe(({ current, total, pending }) => {
          setFindStatus((old) => ({ current, total, pending: pending ?? old.pending }));
        });
        dispose = () => {
          unsubscribe();
          engine.destroy();
        };
        setFind(engine);
      })
      .catch(() => {
        if (active) setFindError(true);
      });
    return () => {
      active = false;
      dispose?.();
      setFind(undefined);
    };
  }, [document, findStarted]);
  useEffect(() => {
    if (findOpen) findInput.current?.focus();
  }, [findOpen]);
  useEffect(() => {
    if (!find || !findOpen) return;
    if (findQuery.trim()) find.find(findQuery.trim());
    else {
      find.close();
      setFindStatus({ current: 0, total: 0, pending: false });
    }
  }, [find, findOpen, findQuery]);

  function closeFind() {
    find?.close();
    setFindOpen(false);
    container.current?.focus({ preventScroll: true });
  }
  function openFind() {
    setFindStarted(true);
    setFindOpen(true);
    findInput.current?.focus();
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
              aria-label="请求修改"
              aria-pressed={annotating}
              onClick={toggleAnnotation}
            >
              <SquareMousePointer className="size-4" aria-hidden="true" />
              <span>请求修改</span>
            </Button>
          ) : null}
        </PreviewLeadingTools>
        {!thumbnail && (
          <Button
            variant="ghost"
            size="icon-sm"
            tooltip={zh ? "查找 PDF" : "Find in PDF"}
            aria-label={zh ? "查找 PDF" : "Find in PDF"}
            aria-expanded={findOpen}
            disabled={!document}
            onClick={openFind}
          >
            <Search className="size-4" />
          </Button>
        )}
        <PreviewZoomControl
          label="PDF 缩放"
          value={zoom}
          onChange={(value) => {
            if (value === zoom) return;
            if (!zoomAnchor.current) anchorZoom();
            setZoom(value);
          }}
          actualPercent={actualPercent}
          minPercent={30}
          maxPercent={800}
          percentages={[30, 50, 100, 200]}
          zoomCurve="pdf"
          zoomStops={PDF_ZOOM_STOPS}
          fitPage={false}
          gestureRoot={container}
          onZoomAnchor={anchorZoom}
        />
      </PreviewToolbar>
      {/* biome-ignore lint/a11y/useSemanticElements: The workspace groups the PDF canvas and its controls. */}
      <div
        className="za-document-workspace"
        ref={workspace}
        role="group"
        aria-label="PDF 阅读与批注"
        data-pdf-workspace=""
        data-navigation-pinned={navigation}
        data-annotating={annotating}
        onKeyDown={(event) => {
          if (
            event.key !== "Escape" ||
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            (!selection && !annotating)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) handleAnnotationEscape();
        }}
        style={
          {
            "--za-comment-cursor": COMMENT_CURSOR,
            "--za-comment-pin": COMMENT_PIN,
          } as React.CSSProperties
        }
      >
        {!thumbnail && document && document.numPages > 1 ? (
          <DocumentNavigation
            label="PDF 目录"
            pinned={navigation}
            onPinned={setNavigation}
            count={document.numPages}
            current={page}
            title={`${document.numPages} 页`}
          >
            {Array.from({ length: document.numPages }, (_, index) => (
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
                  pane={THUMBNAIL_PANE}
                  root={workspace}
                  assertCurrent={assertCurrent}
                  renderText={false}
                  exactWidth
                />
              </button>
            ))}
          </DocumentNavigation>
        ) : null}
        {findOpen && document && (
          // biome-ignore lint/a11y/useSemanticElements: The search role labels a form and works in older WebViews.
          <form
            className="za-pdf-find"
            role="search"
            aria-label={zh ? "PDF 查找" : "PDF search"}
            onSubmit={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeFind();
              } else if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                event.target === findInput.current
              ) {
                event.preventDefault();
                if (findQuery.trim())
                  find?.find(findQuery.trim(), event.shiftKey ? "previous" : "next");
              }
            }}
          >
            <Search className="size-4 shrink-0" />
            <input
              ref={findInput}
              type="search"
              aria-label={zh ? "查找文字" : "Find text"}
              placeholder={zh ? "查找文字" : "Find text"}
              maxLength={256}
              value={findQuery}
              onChange={(event) => {
                setFindStatus({ current: 0, total: 0, pending: !!event.target.value.trim() });
                setFindQuery(event.target.value);
              }}
            />
            <span role="status">
              {findError
                ? zh
                  ? "查找不可用"
                  : "Search unavailable"
                : findQuery.trim() &&
                  (findStatus.pending || !find ? "…" : `${findStatus.current}/${findStatus.total}`)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              tooltip={zh ? "上一个匹配" : "Previous match"}
              aria-label={zh ? "上一个匹配" : "Previous match"}
              disabled={!findStatus.total}
              onClick={() => find?.find(findQuery.trim(), "previous")}
            >
              <ChevronRight className="size-4 rotate-180" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              tooltip={zh ? "下一个匹配" : "Next match"}
              aria-label={zh ? "下一个匹配" : "Next match"}
              disabled={!findStatus.total}
              onClick={() => find?.find(findQuery.trim(), "next")}
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              tooltip={zh ? "关闭查找" : "Close search"}
              aria-label={zh ? "关闭查找" : "Close search"}
              onClick={closeFind}
            >
              <X className="size-4" />
            </Button>
          </form>
        )}
        <PreviewScrollArea
          ref={container}
          className="za-preview-pdf za-preview-frame-content"
          data-ready={painted || !!error}
          aria-label="PDF 阅读画布"
          aria-busy={!document && !error}
          onScroll={thumbnail ? undefined : trackViewport}
          onPointerDownCapture={(event) => {
            if (
              (!annotating && !selection) ||
              event.button !== 0 ||
              !event.isPrimary ||
              (event.target instanceof Element && event.target.closest("button,a"))
            )
              return;
            if (dismissSelection.current?.() === false) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          tabIndex={0}
          onKeyDown={(event) => {
            if (
              document &&
              (event.ctrlKey || event.metaKey) &&
              !event.shiftKey &&
              !event.altKey &&
              event.key.toLowerCase() === "f"
            ) {
              event.preventDefault();
              event.stopPropagation();
              openFind();
            } else if (event.key === "Escape" && findOpen && !event.defaultPrevented) {
              event.preventDefault();
              event.stopPropagation();
              closeFind();
            } else {
              previewPageKey(event, page, document?.numPages ?? 0, navigatePage);
            }
          }}
        >
          {error ? (
            <PreviewUnavailable message={error} onDownload={onDownload} onRetry={onRetry} />
          ) : document ? (
            Array.from({ length: thumbnail ? 1 : document.numPages }, (_, index) => index + 1).map(
              (number) => (
                <PDFPage
                  key={number}
                  document={document}
                  number={number}
                  selected={thumbnail || Math.abs(page - number) <= 2}
                  zoom={zoom}
                  cover={thumbnail}
                  pane={paperViewport}
                  initialSize={
                    (pageSizes?.pdf === document && pageSizes.values[number - 1]) || firstSize
                  }
                  onScale={page === number ? setActualPercent : undefined}
                  root={container}
                  assertCurrent={assertCurrent}
                  onDownload={onDownload}
                  onRetry={onRetry}
                  annotating={annotating}
                  onSelection={setSelection}
                  workspace={workspace}
                  comments={markedComments}
                  onEditComment={editAtMarker}
                  activeSelection={selection}
                  onPainted={thumbnail || page === number ? markPainted : undefined}
                  hideLoading={!painted}
                  commentDestination={commentDestination}
                  find={findOpen ? find : undefined}
                  onLink={thumbnail ? undefined : navigateLink}
                />
              ),
            )
          ) : null}
        </PreviewScrollArea>
        {onRequestRevision && document && !thumbnail && !annotating && !selection && !findOpen && (
          <PDFTextSelectionAction
            viewport={container}
            workspace={workspace}
            pageCount={document.numPages}
            zoom={zoom}
            assertCurrent={assertCurrent}
            onPick={(next) => {
              if (dismissSelection.current?.() !== false) setSelection(next);
            }}
          />
        )}
        {!painted && !error ? (
          <div className="za-preview-frame-pending" data-cover={!!thumbnail}>
            <PreviewLoading message="正在读取 PDF…" onCancel={thumbnail ? undefined : onCancel} />
          </div>
        ) : null}
        {!thumbnail ? (
          <ResourceDocumentComments
            enabled={annotating || !!selection}
            onEnabled={setAnnotating}
            selection={selection}
            onSelection={selectComment}
            editRef={editComment}
            dismissSelectionRef={dismissSelection}
            resolveSelectionBounds={resolveCommentBounds}
            onNavigate={(id, comment, source) => {
              const target = Number(id.split("-")[2]);
              if (source === "marker") return;
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
const PDFPage = memo(function PDFPage({
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
  onEditComment,
  commentDestination,
  onScale,
  activeSelection,
  onPainted,
  hideLoading,
  cover = false,
  renderText = true,
  exactWidth = false,
  initialSize = DEFAULT_PAGE,
  find,
  onLink,
}: PreviewRecovery & {
  onPainted?: () => void;
  hideLoading?: boolean;
  onScale?: (percent: number) => void;
  activeSelection?: RevisionSelection | null;
  comments?: readonly DocumentRevisionComment[];
  onEditComment?: (id: string) => void;
  commentDestination?: { comment: DocumentRevisionComment; request: number } | null;
  annotating?: boolean;
  onSelection?: (value: RevisionSelection) => void;
  workspace?: RefObject<HTMLDivElement | null>;
  cover?: boolean;
  renderText?: boolean;
  exactWidth?: boolean;
  initialSize?: typeof DEFAULT_PAGE;
  find?: PDFFind;
  onLink?: (page: number) => void;
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
  const textLayer = useRef<TextLayer | null>(null);
  const logicalPage = useRef<{ width: number; height: number } | null>(null);
  const [linkPage, setLinkPage] = useState<PDFPageProxy>();
  const [near, setNear] = useState(false);
  const [measuredSize, setSize] = useState<typeof DEFAULT_PAGE>();
  const size = measuredSize ?? initialSize;
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [textRevision, setTextRevision] = useState(0);
  const navigatedRequest = useRef(0);
  const [marks, setMarks] = useState<
    { comment: DocumentRevisionComment; regions: DocumentRegion[] }[]
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
  const scale =
    cover || exactWidth
      ? (pane.width || 168) / size.width
      : pdfPageScale(zoom, size, { width: pane.width || 640, height: pane.height || 800 });
  useEffect(() => {
    onScale?.(scale * 100);
  }, [scale, onScale]);
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const preload = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: root.current,
      rootMargin: "200px 0px",
      threshold: 0.01,
    });
    preload.observe(element);
    return () => {
      preload.disconnect();
    };
  }, [root]);
  useEffect(() => {
    const element = canvas.current;
    if (!element || !enabled) return;
    const hasPaint = element.width > 0;
    if (!hasPaint) setBusy(true);
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
        if (onLink) setLinkPage(pdfPage);
        setSize((old) =>
          old?.width === base.width && old.height === base.height
            ? old
            : { width: base.width, height: base.height },
        );
        const desiredScale =
          cover || exactWidth
            ? (pane.width || 168) / base.width
            : pdfPageScale(zoom, base, { width: pane.width || 640, height: pane.height || 800 });
        const pixelRatio = element.ownerDocument.defaultView?.devicePixelRatio || 1;
        const viewport = pdfPage.getViewport({
          scale: (96 / 72) * boundedPreviewScale(desiredScale * pixelRatio, base),
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
        if (!hasPaint) setError("此页未能渲染，请下载原件查看。");
        setBusy(false);
      }
    };
    const delay = hasPaint ? setTimeout(() => void paint(), 120) : undefined;
    if (delay === undefined) void paint();
    return () => {
      active = false;
      clearTimeout(delay);
      render?.cancel();
    };
  }, [
    document,
    number,
    enabled,
    zoom,
    pane.width,
    pane.height,
    assertCurrent,
    renderText,
    cover,
    exactWidth,
    onLink,
  ]);
  useEffect(() => {
    const element = text.current;
    if (!renderText || !element || !enabled || typeof TextLayer !== "function") return;
    let active = true;
    let layer: TextLayer | undefined;
    void (async () => {
      const page = await document.getPage(number);
      if (!active) return;
      const content = await page.getTextContent();
      if (!active || content.items.length > 20000) return;
      assertCurrent();
      const viewport = page.getViewport({ scale: 96 / 72 });
      const unrotated = viewport.clone({ rotation: 0 });
      element.style.setProperty("--total-scale-factor", String(viewport.scale * page.userUnit));
      layer = new TextLayer({ textContentSource: content, container: element, viewport });
      // TextLayer sets viewer-specific rounded sizes. This reader lays out at exact paper size
      // before applying the same zoom as the canvas, including when the page is rotated.
      element.style.width = `${unrotated.width}px`;
      element.style.height = `${unrotated.height}px`;
      await layer.render();
      if (active) {
        textLayer.current = layer;
        setTextRevision((old) => old + 1);
      }
    })().catch(() => {});
    return () => {
      active = false;
      textLayer.current = null;
      layer?.cancel();
      element.replaceChildren();
    };
  }, [document, number, enabled, assertCurrent, renderText]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A re-created text layer needs a fresh search subscription.
  useLayoutEffect(() => {
    if (enabled && textLayer.current && find) return find.register(number - 1, textLayer.current);
  }, [enabled, find, number, textRevision]);
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
    const positioned: typeof marks = [];
    for (const comment of comments) {
      if (comment.block !== `pdf-page-${number}`) continue;
      const range =
        !textRevision || (comment.region && comment.pdf?.kind !== "text")
          ? null
          : pdfTextRange(layer, comment.start, comment.end, comment.quote);
      const glyphs = range?.getClientRects?.();
      const regions = Array.from(glyphs ?? [])
        .slice(0, 128)
        .filter((rect) => rect.width && rect.height)
        .map((rect) => normalizedPDFRegion(rect, box));
      if (!regions.length && comment.region) regions.push(comment.region);
      if (regions.length) positioned.push({ comment, regions });
    }
    setMarks(positioned);
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
          (event.target instanceof Element && !!event.target.closest("button")) ||
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
        const selected = readPDFTextRange(text.current, text.current.ownerDocument.getSelection());
        if (!selected) return;
        const { range, start, end, quote } = selected;
        const rect = range.getBoundingClientRect(),
          box = workspace?.current?.getBoundingClientRect(),
          paper = event.currentTarget.getBoundingClientRect();
        if (!box || !paper.width || !paper.height) return;
        event.stopPropagation();
        onSelection({
          id: `pdf-page-${number}`,
          page: number,
          start,
          end,
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
      data-pdf-page-width={size.width * (72 / 96)}
      data-pdf-page-height={size.height * (72 / 96)}
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
        <div ref={text} className="za-pdf-text-layer" style={{ scale: String(scale) }} />
      )}
      {enabled && !annotating && onLink && linkPage && (
        <PDFPageLinks
          page={linkPage}
          document={document}
          onPage={onLink}
          assertCurrent={assertCurrent}
        />
      )}
      <div className="za-pdf-comment-marks">
        {lasso ? (
          <span
            className="za-pdf-region"
            style={{ left: lasso.left, top: lasso.top, width: lasso.width, height: lasso.height }}
          />
        ) : null}
        {activeSelection?.page === number &&
        !activeSelection.editingCommentId &&
        activeSelection.region ? (
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
        {marks.map(({ comment, regions }, index) => {
          const { left, top, width } = regions[0];
          return (
            <div key={comment.id}>
              {regions.map((region, part) =>
                region.width || region.height ? (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: Fragments keep their order within this comment.
                    key={part}
                    aria-hidden="true"
                    className="za-pdf-region"
                    style={{
                      left: `${region.left * 100}%`,
                      top: `${region.top * 100}%`,
                      width: `${region.width * 100}%`,
                      height: `${region.height * 100}%`,
                    }}
                  />
                ) : null,
              )}
              {onEditComment && (
                <ReaderCommentTooltip
                  label={comment.comment}
                  disabled={!!activeSelection?.editingCommentId}
                  render={
                    <button
                      type="button"
                      className="za-pdf-comment-pin"
                      aria-expanded={activeSelection?.editingCommentId === comment.id}
                      aria-label={`编辑第 ${number} 页批注 ${index + 1}`}
                      style={{ left: `${(left + width) * 100}%`, top: `${top * 100}%` }}
                      onClick={() => onEditComment(comment.id)}
                    />
                  }
                />
              )}
            </div>
          );
        })}
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
    </div>
  );
});
