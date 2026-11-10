import { type RefCallback, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ChevronRight, LayoutGrid, PanelLeft, Play, SquareMousePointer, X } from "../IconSet";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { TooltipButton as Button } from "../ui/tooltip-button";
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
import { boundedPreviewScale, previewScale } from "./previewGeometry";
import { createResourcePreviewWorker } from "./previewWorkerClient";
import type { SlideRevisionMetadata } from "./previewWorkerProtocol";
import {
  type DocumentRevisionComment,
  ResourceDocumentComments,
  type RevisionSelection,
} from "./ResourceDocumentComments";
import ResourceImagePreview from "./ResourceImagePreview";
import { COMMENT_CURSOR, COMMENT_PIN } from "./readerInteraction";
import { usePreviewReadingState } from "./readingSession";
import { usePreviewViewport } from "./usePreviewViewport";

type SlidePoint = { x: number; y: number };
type SlideAnnotation = {
  enabled: boolean;
  marks: readonly DocumentRevisionComment[];
  selection: RevisionSelection | null;
  onEdit: (id: string) => void;
  onPick: (point: SlidePoint, area?: DocumentRegion) => void;
};

function slideSelection(
  page: number,
  slide: SlideRevisionMetadata | undefined,
  point: SlidePoint,
  area?: DocumentRegion,
): RevisionSelection {
  let element: SlideRevisionMetadata["elements"][number] | undefined;
  if (slide && !area) {
    for (let index = slide.elements.length - 1; index >= 0; index--) {
      const candidate = slide.elements[index];
      const { x, y } = slideElementOffset(slide, point, candidate.region, candidate.rotation);
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
        element = candidate;
        break;
      }
    }
  }
  const region = area ?? { left: point.x, top: point.y, width: 0, height: 0 };
  const quote = element?.quote ?? "";
  return {
    id: JSON.stringify(["slide", slide?.slideId ?? page, element?.id ?? region]),
    page,
    region,
    start: 0,
    end: quote.length,
    x: 0,
    y: 0,
    quote,
    target: {
      kind: "slide",
      slide: page,
      slideId: slide?.slideId,
      slideTitle: slide?.slideTitle,
      ...(element && slide
        ? {
            element: {
              id: element.id,
              name: element.name,
              kind: element.kind,
              rotation: element.rotation,
              bounds: element.region,
            },
            elementOffset: slideElementOffset(slide, point, element.region, element.rotation),
          }
        : {}),
      point,
    },
  };
}

function slideElementOffset(
  slide: SlideRevisionMetadata,
  point: SlidePoint,
  region: DocumentRegion,
  rotation: number,
) {
  const x = (point.x - region.left - region.width / 2) * slide.width;
  const y = (point.y - region.top - region.height / 2) * slide.height;
  const radians = (rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: 0.5 + (x * cosine + y * sine) / (region.width * slide.width),
    y: 0.5 + (y * cosine - x * sine) / (region.height * slide.height),
  };
}

function SlideAnnotationLayer({ enabled, marks, selection, onEdit, onPick }: SlideAnnotation) {
  const start = useRef<{ id: number; point: SlidePoint } | null>(null);
  const [area, setArea] = useState<DocumentRegion>();
  function getPoint(node: HTMLElement, x: number, y: number) {
    const rect = node.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (x - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (y - rect.top) / rect.height)),
    };
  }
  function getArea(first: SlidePoint, last: SlidePoint) {
    return {
      left: Math.min(first.x, last.x),
      top: Math.min(first.y, last.y),
      width: Math.abs(first.x - last.x),
      height: Math.abs(first.y - last.y),
    };
  }
  function reset() {
    start.current = null;
    setArea(undefined);
  }
  function renderRegion(region: DocumentRegion, rotation?: number) {
    if (!region.width || !region.height) return null;
    return (
      <span
        aria-hidden="true"
        className="pointer-events-none absolute rounded-sm border-2 border-dashed border-[#3478df] bg-[#3478df1a]"
        style={{
          left: `${region.left * 100}%`,
          top: `${region.top * 100}%`,
          width: `${region.width * 100}%`,
          height: `${region.height * 100}%`,
          transform: rotation ? `rotate(${rotation}deg)` : undefined,
        }}
      />
    );
  }
  return (
    <>
      {enabled && (
        <button
          type="button"
          aria-label="选择幻灯片上的内容并添加批注"
          className="absolute inset-0 touch-none bg-transparent"
          style={{ cursor: COMMENT_CURSOR }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            start.current = {
              id: event.pointerId,
              point: getPoint(event.currentTarget, event.clientX, event.clientY),
            };
          }}
          onPointerMove={(event) => {
            const initial = start.current;
            if (initial?.id === event.pointerId) {
              setArea(
                getArea(initial.point, getPoint(event.currentTarget, event.clientX, event.clientY)),
              );
            }
          }}
          onPointerUp={(event) => {
            const initial = start.current;
            if (initial?.id !== event.pointerId) return;
            const point = getPoint(event.currentTarget, event.clientX, event.clientY);
            const box = getArea(initial.point, point);
            const rect = event.currentTarget.getBoundingClientRect();
            const dragged = box.width * rect.width >= 5 && box.height * rect.height >= 5;
            onPick(point, dragged ? box : undefined);
            reset();
          }}
          onPointerCancel={reset}
          onLostPointerCapture={reset}
          onClick={(event) => {
            if (event.detail === 0) onPick({ x: 0.5, y: 0.5 });
          }}
        />
      )}
      {area
        ? renderRegion(area)
        : selection?.region &&
          renderRegion(
            (selection.target?.kind === "slide" && selection.target.element?.bounds) ||
              selection.region,
            selection.target?.kind === "slide" ? selection.target.element?.rotation : undefined,
          )}
      {marks.map((mark) => {
        const point = mark.target?.kind === "slide" ? mark.target.point : undefined;
        if (!point) return null;
        return (
          <Button
            key={mark.id}
            variant="ghost"
            size="icon-sm"
            className="absolute -translate-y-1/2 -translate-x-1/2 rounded-full hover:bg-transparent"
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
            aria-label="编辑幻灯片批注"
            tooltip={mark.comment}
            onClick={() => onEdit(mark.id)}
          >
            <span
              aria-hidden="true"
              className="size-6 bg-contain bg-center bg-no-repeat"
              style={{ backgroundImage: COMMENT_PIN }}
            />
          </Button>
        );
      })}
    </>
  );
}

function safeSlide(svg: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) throw new Error("幻灯片包含不支持的嵌入内容。");
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (document.querySelector("parsererror") || document.documentElement.localName !== "svg")
    throw new Error("幻灯片渲染失败。");
  const elements = document.querySelectorAll("*");
  if (elements.length > 50_000) throw new Error("此幻灯片过于复杂，请下载原件查看。");
  for (const element of elements) {
    if (
      element.namespaceURI !== "http://www.w3.org/2000/svg" ||
      ["script", "foreignObject", "a", "animate", "set"].includes(element.localName)
    )
      throw new Error("幻灯片包含不支持的活动内容。");
    for (const attr of [...element.attributes]) {
      if (/^on/i.test(attr.name)) element.removeAttributeNode(attr);
      if (
        /href$/i.test(attr.name) &&
        !/^(#|data:image\/(png|jpeg|gif|webp);base64,)/i.test(attr.value)
      )
        element.removeAttributeNode(attr);
      if (/url\(/i.test(attr.value) && !/^url\(#[\w-]+\)$/.test(attr.value))
        element.removeAttributeNode(attr);
    }
    if (element.localName === "style") element.remove();
  }
  const root = document.documentElement;
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
  const width = Number.parseFloat(root.getAttribute("width") ?? "") || viewBox?.[2] || 1600;
  const height = Number.parseFloat(root.getAttribute("height") ?? "") || viewBox?.[3] || 900;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error("幻灯片尺寸无效，请下载原件查看。");
  return { svg: new XMLSerializer().serializeToString(document), width, height };
}

export default function ResourceSlidesPreview(
  props: PreviewRecovery & {
    bytes: Uint8Array;
    name: string;
    assertCurrent: () => void;
    onCancel?: () => void;
    thumbnail?: boolean;
  },
) {
  const [page, setPage] = usePreviewReadingState("slidePage", 1);
  const [zoom, setZoom] = usePreviewReadingState("slideZoom", "fit-page");
  const [count, setCount] = useState(0);
  const [svg, setSVG] = useState("");
  const [slideRevision, setSlideRevision] = useState<SlideRevisionMetadata>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [outline, setOutline] = useState(false);
  const [grid, setGrid] = usePreviewReadingState("slideGrid", false);
  const [presenting, setPresenting] = useState(false);
  const { onRequestRevision } = useContext(PreviewIdentityContext);
  const includeAnnotations = !!onRequestRevision && !props.thumbnail;
  const [annotating, setAnnotating] = useState(false);
  const [selection, setSelection] = useState<RevisionSelection | null>(null);
  const [marks, setMarks] = useState<readonly DocumentRevisionComment[]>([]);
  const exitRef = useRef<(() => void) | null>(null);
  const editRef = useRef<((id: string) => void) | null>(null);
  const [slideFrame, setSlideFrame] = useState<HTMLDivElement | null>(null);
  const chrome = useContext(PreviewToolbarMount);
  const setFileMenu = chrome?.setFileMenu;
  const gridRoot = useRef<HTMLElement>(null);
  const rail = useRef<HTMLElement>(null);
  const [maxPercent, setMaxPercent] = useState<number>();
  const [actualPercent, setActualPercent] = useState(100);
  const client = useRef<ReturnType<typeof createResourcePreviewWorker> | null>(null);
  const generation = useRef(0);
  const lifetime = useRef<AbortSignal | null>(null);
  const initialPage = useRef(page);
  const { bytes, assertCurrent } = props;
  useEffect(() => {
    const controller = new AbortController();
    const worker = createResourcePreviewWorker(controller.signal);
    client.current = worker;
    lifetime.current = controller.signal;
    const seq = ++generation.current;
    void (async () => {
      let result = await worker.request({ type: "load", kind: "pptx", bytes, includeAnnotations });
      assertCurrent();
      if (controller.signal.aborted || generation.current !== seq) return;
      const pages = result.slideCount ?? 0;
      if (!pages || pages > 150) throw new Error("幻灯片页数超出预览范围。");
      const restored = props.thumbnail ? 1 : Math.max(1, Math.min(initialPage.current, pages));
      if (restored !== 1)
        result = await worker.request({ type: "slide", index: restored - 1, includeAnnotations });
      assertCurrent();
      if (controller.signal.aborted || generation.current !== seq) return;
      setPage(restored);
      setCount(pages);
      setSVG(result.svg ?? "");
      setSlideRevision(result.slideRevision);
      setBusy(false);
    })().catch((cause) => {
      if (!controller.signal.aborted && generation.current === seq) {
        setError(cause instanceof Error ? cause.message : "幻灯片无法打开。");
        setBusy(false);
      }
    });
    return () => {
      generation.current++;
      controller.abort();
      worker.dispose();
      client.current = null;
    };
  }, [bytes, assertCurrent, setPage, props.thumbnail, includeAnnotations]);

  async function navigate(target: number) {
    if (
      !client.current ||
      target === page ||
      !Number.isInteger(target) ||
      target < 1 ||
      target > count
    )
      return;
    const seq = ++generation.current;
    setPage(target);
    setSVG("");
    setSlideRevision(undefined);
    setSelection(null);
    setBusy(true);
    setError("");
    try {
      const result = await client.current.request({
        type: "slide",
        index: target - 1,
        includeAnnotations,
      });
      assertCurrent();
      if (lifetime.current?.aborted || generation.current !== seq) return;
      setSVG(result.svg ?? "");
      setSlideRevision(result.slideRevision);
    } catch (cause) {
      if (!lifetime.current?.aborted && generation.current === seq)
        setError(cause instanceof Error ? cause.message : "此页未能打开。");
    } finally {
      if (!lifetime.current?.aborted && generation.current === seq) setBusy(false);
    }
  }

  const resolveSelectionBounds = useCallback(
    (item: RevisionSelection) => {
      const frame = slideFrame;
      const view = frame?.closest("[data-scroll-viewport]");
      if (!frame || !view || grid || busy || page !== item.page || !item.region) return;
      const area = frame.getBoundingClientRect();
      const { left, top, width, height } = item.region;
      const anchor = item.target?.kind === "slide" ? item.target.point : undefined;
      const target = anchor
        ? new DOMRect(area.left + anchor.x * area.width, area.top + anchor.y * area.height, 0, 0)
        : new DOMRect(
            area.left + left * area.width,
            area.top + top * area.height,
            width * area.width,
            height * area.height,
          );
      return { target, viewport: view.getBoundingClientRect(), observe: frame };
    },
    [busy, grid, page, slideFrame],
  );

  useEffect(() => {
    if (!setFileMenu || props.thumbnail) return;
    setFileMenu(
      <>
        <DropdownMenuItem
          role="menuitemcheckbox"
          aria-checked={grid}
          disabled={!count}
          onClick={() => setGrid((value) => !value)}
        >
          <LayoutGrid className="size-4 mr-2" />
          网格视图
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </>,
    );
    return () => setFileMenu(null);
  }, [setFileMenu, setGrid, grid, count, props.thumbnail]);
  if (props.thumbnail)
    return (
      <SlideCover
        svg={svg}
        name={props.name}
        error={error}
        assertCurrent={assertCurrent}
        onError={setError}
      />
    );
  return (
    <>
      <PreviewToolbar label="幻灯片" detail="只读">
        <PreviewLeadingTools>
          {includeAnnotations && (
            <Button
              variant="ghost"
              size="sm"
              className="za-request-revision"
              data-active={annotating}
              aria-pressed={annotating}
              disabled={busy || !!error}
              onClick={() => {
                if (annotating) exitRef.current?.();
                else {
                  setGrid(false);
                  setAnnotating(true);
                }
              }}
            >
              <SquareMousePointer className="size-4" />
              请求修改
            </Button>
          )}
        </PreviewLeadingTools>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="幻灯片目录"
          tooltip="幻灯片目录"
          aria-pressed={outline}
          disabled={!count}
          onClick={() => setOutline((value) => !value)}
        >
          <PanelLeft className="size-4" />
        </Button>
        <PreviewPageControls
          page={page}
          count={count}
          busy={busy}
          onPage={(target) => void navigate(target)}
        />
        <PreviewZoomControl
          label="幻灯片缩放"
          value={zoom}
          onChange={setZoom}
          maxPercent={maxPercent}
          actualPercent={actualPercent}
        />
        {!setFileMenu ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="网格视图"
            tooltip="网格视图"
            aria-pressed={grid}
            disabled={!count}
            onClick={() => setGrid((value) => !value)}
          >
            <LayoutGrid className="size-4" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="演示"
          tooltip="演示"
          disabled={!count}
          onClick={() => setPresenting(true)}
        >
          <Play className="size-4" />
        </Button>
      </PreviewToolbar>
      <div className="za-preview-slides-layout relative">
        {outline && !grid ? (
          <nav ref={rail} className="za-preview-slide-rail" aria-label="选择幻灯片">
            <span className="za-preview-rail-count">{count} 页</span>
            {Array.from({ length: count }, (_, index) => index + 1).map((number) => (
              <button
                type="button"
                key={number}
                aria-label={`转到第 ${number} 页`}
                aria-current={number === page ? "page" : undefined}
                onClick={() => void navigate(number)}
              >
                <span>{number}</span>
                <SlideThumbnail
                  index={number - 1}
                  worker={client.current}
                  root={rail}
                  assertCurrent={assertCurrent}
                />
              </button>
            ))}
          </nav>
        ) : null}
        {grid ? (
          <section ref={gridRoot} className="za-preview-slide-grid" aria-label="幻灯片网格">
            {Array.from({ length: count }, (_, index) => index + 1).map((number) => (
              <button
                type="button"
                key={number}
                aria-label={`打开第 ${number} 页`}
                aria-current={number === page ? "page" : undefined}
                onClick={() => {
                  setGrid(false);
                  void navigate(number);
                }}
              >
                <span className="za-preview-grid-number">{number}</span>
                <SlideThumbnail
                  index={number - 1}
                  worker={client.current}
                  root={gridRoot}
                  assertCurrent={assertCurrent}
                />
              </button>
            ))}
          </section>
        ) : (
          <SlideImage
            svg={svg}
            name={`${props.name} · 第 ${page} 页`}
            zoom={zoom}
            page={page}
            count={count}
            busy={busy}
            error={error}
            onCancel={props.onCancel}
            onDownload={props.onDownload}
            onRetry={props.onRetry}
            onPage={(target) => void navigate(target)}
            assertCurrent={assertCurrent}
            onError={setError}
            onMaxPercent={setMaxPercent}
            onScale={setActualPercent}
            frameRef={setSlideFrame}
            annotation={
              includeAnnotations
                ? {
                    enabled: annotating,
                    marks: marks.filter((mark) => mark.page === page),
                    selection,
                    onEdit: (id) => editRef.current?.(id),
                    onPick: (point, area) => {
                      assertCurrent();
                      setSelection(slideSelection(page, slideRevision, point, area));
                    },
                  }
                : undefined
            }
          />
        )}
        {includeAnnotations && (
          <ResourceDocumentComments
            enabled={annotating}
            onEnabled={setAnnotating}
            selection={selection}
            onSelection={setSelection}
            exitRef={exitRef}
            editRef={editRef}
            onMarks={setMarks}
            resolveSelectionBounds={resolveSelectionBounds}
            onNavigate={(_block, comment) => {
              if (comment?.target?.kind !== "slide") return;
              setGrid(false);
              void navigate(comment.target.slide);
            }}
          />
        )}
      </div>
      <Dialog open={presenting} onOpenChange={setPresenting}>
        <DialogContent
          layout="lightbox"
          className="za-slide-presentation"
          onKeyDown={(event) => {
            if (event.target instanceof HTMLElement && event.target.closest("button")) return;
            if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
              event.preventDefault();
              void navigate(Math.min(count, page + 1));
            } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
              event.preventDefault();
              void navigate(Math.max(1, page - 1));
            } else if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              void navigate(event.key === "Home" ? 1 : count);
            }
          }}
        >
          <DialogTitle className="sr-only">幻灯片演示</DialogTitle>
          <SlideImage
            svg={svg}
            name={`${props.name} · 第 ${page} 页`}
            zoom="fit-page"
            page={page}
            count={count}
            busy={busy}
            error={error}
            onCancel={props.onCancel}
            onDownload={props.onDownload}
            onRetry={props.onRetry}
            onPage={(target) => void navigate(target)}
            assertCurrent={assertCurrent}
            onError={setError}
            onMaxPercent={setMaxPercent}
            onScale={setActualPercent}
          />
          <button
            type="button"
            className="za-slide-advance"
            aria-label="切换到下一张幻灯片"
            disabled={page >= count || busy}
            onClick={() => void navigate(page + 1)}
          />
          <fieldset className="za-slide-playback" aria-label="幻灯片播放控件">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="上一张幻灯片"
              tooltip="上一张幻灯片"
              disabled={page <= 1}
              onClick={() => void navigate(page - 1)}
            >
              <ChevronRight className="size-4 rotate-180" />
            </Button>
            <span aria-live="polite">
              第 {page} 张，共 {count} 张
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="下一张幻灯片"
              tooltip="下一张幻灯片"
              disabled={page >= count}
              onClick={() => void navigate(page + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="退出演示模式"
              tooltip="退出演示模式"
              onClick={() => setPresenting(false)}
            >
              <X className="size-4" />
            </Button>
          </fieldset>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SlideCover({
  svg,
  name,
  error,
  assertCurrent,
  onError,
}: {
  svg: string;
  name: string;
  error: string;
  assertCurrent: () => void;
  onError: (message: string) => void;
}) {
  const [image, setImage] = useState<{ url: string; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!svg) return;
    let url = "";
    try {
      assertCurrent();
      const safe = safeSlide(svg);
      url = URL.createObjectURL(new Blob([safe.svg], { type: "image/svg+xml" }));
      setImage({ url, width: safe.width, height: safe.height });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "封面无法显示");
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [svg, assertCurrent, onError]);
  if (error) return <PreviewUnavailable message={error} />;
  return image ? (
    <ResourceImagePreview
      thumbnail
      url={image.url}
      name={name}
      dimensions={image}
      assertCurrent={assertCurrent}
      onError={onError}
    />
  ) : (
    <PreviewLoading />
  );
}

/** Real, isolated slide covers; only visible rail entries ask the existing worker to render. */
function SlideThumbnail({
  index,
  worker,
  root,
  assertCurrent,
}: {
  index: number;
  worker: ReturnType<typeof createResourcePreviewWorker> | null;
  root: import("react").RefObject<HTMLElement | null>;
  assertCurrent: () => void;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setURL] = useState("");
  useEffect(() => {
    if (!host.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: root.current,
      rootMargin: "160px",
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    if (!visible || !worker) {
      setURL("");
      return;
    }
    let active = true,
      owned = "";
    void worker
      .request({ type: "slide", index })
      .then((result) => {
        assertCurrent();
        if (!active) return;
        const safe = safeSlide(result.svg ?? "");
        owned = URL.createObjectURL(new Blob([safe.svg], { type: "image/svg+xml" }));
        setURL(owned);
      })
      .catch(() => {
        /* A failed cover never disables navigation to the actual page. */
      });
    return () => {
      active = false;
      if (owned) URL.revokeObjectURL(owned);
    };
  }, [index, worker, visible, assertCurrent]);
  return (
    <span ref={host} className="za-preview-slide-cover" aria-hidden="true">
      {url ? <img src={url} alt="" /> : <span className="za-preview-cover-placeholder" />}
    </span>
  );
}

function SlideImage({
  svg,
  name,
  zoom,
  page,
  count,
  busy,
  error,
  onCancel,
  onDownload,
  onRetry,
  onPage,
  assertCurrent,
  onError,
  onMaxPercent,
  onScale,
  frameRef,
  annotation,
}: PreviewRecovery & {
  svg: string;
  name: string;
  zoom: import("./readingSession").PreviewZoom;
  page: number;
  count: number;
  busy: boolean;
  error: string;
  onCancel?: () => void;
  onPage: (page: number) => void;
  assertCurrent: () => void;
  onError: (message: string) => void;
  onMaxPercent: (percent: number) => void;
  onScale?: (percent: number) => void;
  frameRef?: RefCallback<HTMLDivElement>;
  annotation?: SlideAnnotation;
}) {
  const [image, setImage] = useState<{ url: string; width: number; height: number } | null>(null);
  const [paintedURL, setPaintedURL] = useState("");
  const { container, viewport } = usePreviewViewport();
  useEffect(() => {
    let url = "";
    if (!svg) {
      setImage(null);
      return;
    }
    try {
      const safe = safeSlide(svg);
      assertCurrent();
      url = URL.createObjectURL(new Blob([safe.svg], { type: "image/svg+xml" }));
      setImage({ url, width: safe.width, height: safe.height });
      onMaxPercent(boundedPreviewScale(4, safe) * 100);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "此页未能显示。");
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [svg, assertCurrent, onError, onMaxPercent]);
  const scale = image
    ? boundedPreviewScale(
        previewScale(zoom, image, {
          width: viewport.width || 640,
          height: viewport.height || 480,
        }),
        image,
      )
    : 1;
  useEffect(() => {
    onScale?.(scale * 100);
  }, [scale, onScale]);
  return (
    <PreviewScrollArea
      ref={container}
      className="za-preview-slide-scroll"
      aria-label="幻灯片阅读画布"
      aria-busy={busy}
      tabIndex={0}
      onKeyDown={(event) => previewPageKey(event, page, count, onPage)}
    >
      {error ? (
        <PreviewUnavailable message={error} onDownload={onDownload} onRetry={onRetry} />
      ) : busy || !image ? (
        <PreviewLoading
          message={count ? `正在渲染第 ${page} 页…` : "正在排版幻灯片…"}
          onCancel={onCancel}
        />
      ) : (
        <div className="za-preview-visual-inner">
          <div className="relative" ref={frameRef}>
            <img
              src={image.url}
              alt={name}
              className="za-preview-slide za-preview-frame-content"
              data-ready={paintedURL === image.url}
              style={{
                width: `${image.width * scale}px`,
                aspectRatio: `${image.width} / ${image.height}`,
              }}
              onLoad={() => {
                try {
                  assertCurrent();
                  setPaintedURL(image.url);
                } catch {
                  onError("此预览已失效，请重新打开文件。");
                }
              }}
              onError={() => onError("此页未能显示，请下载原件查看。")}
            />
            {annotation && paintedURL === image.url && <SlideAnnotationLayer {...annotation} />}
          </div>
          {paintedURL !== image.url ? (
            <div className="za-preview-frame-pending">
              <PreviewLoading onCancel={onCancel} />
            </div>
          ) : null}
        </div>
      )}
    </PreviewScrollArea>
  );
}
