import {
  type RefCallback,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { ChevronRight, LayoutGrid, PanelLeft, Play, SquareMousePointer, X } from "../IconSet";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { LabelTooltip } from "../ui/label-tooltip";
import { Popover, PopoverContent, PopoverTitle } from "../ui/popover";
import { TooltipButton as Button } from "../ui/tooltip-button";
import type { DocumentRegion } from "./docxReaderDocument";
import { PreviewIdentityContext, PreviewToolbarMount } from "./PreviewChrome";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewScrollArea } from "./PreviewScrollArea";
import {
  PreviewLeadingTools,
  PreviewToolbar,
  PreviewZoomControl,
  previewPageKey,
} from "./PreviewToolbar";
import {
  animatePresentationCamera,
  bindPresentationPageWheel,
  centerPresentationCamera,
  type PresentationCamera,
  type PresentationZoomAnchor,
  presentationGridGeometry,
  presentationGridSlideCenter,
  usePresentationPan,
  usePresentationPlane,
} from "./presentationViewport";
import { createResourcePreviewWorker } from "./previewWorkerClient";
import type { PreviewWorkerResult, SlideRevisionMetadata } from "./previewWorkerProtocol";
import {
  type DocumentRevisionComment,
  ResourceDocumentComments,
  type RevisionSelection,
} from "./ResourceDocumentComments";
import ResourceImagePreview from "./ResourceImagePreview";
import { COMMENT_CURSOR, COMMENT_PIN } from "./readerInteraction";
import { type PreviewZoom, usePreviewReadingState } from "./readingSession";
import { usePreviewViewport } from "./usePreviewViewport";

type SlidePoint = { x: number; y: number };
type SlideElement = SlideRevisionMetadata["elements"][number];
const SLIDE_COACHMARK = "zeroagent.reader.slides.annotation-intro";
const SLIDE_DRAG_DISTANCE = 6;
const SLIDE_FIT_MARGIN = 24;
const SLIDE_PIXEL_GRID_SCALE = 6;
type SlideAnnotation = {
  page: number;
  slide?: SlideRevisionMetadata;
  aspectRatio: number;
  enabled: boolean;
  interactive?: boolean;
  marks: readonly DocumentRevisionComment[];
  selection: RevisionSelection | null;
  candidate: RevisionSelection | null;
  onCandidate: (candidate: RevisionSelection | null) => void;
  onDismissSelection: () => boolean;
  onEdit: (id: string) => void;
  onPick: (selection: RevisionSelection) => void;
};

function slideElementAt(slide: SlideRevisionMetadata | undefined, point: SlidePoint) {
  if (!slide) return;
  for (let index = slide.elements.length - 1; index >= 0; index--) {
    const element = slide.elements[index];
    const { x, y } = slideElementOffset(slide, point, element.region, element.rotation);
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) return element;
  }
}

function slideElementsIn(slide: SlideRevisionMetadata | undefined, area: DocumentRegion) {
  return (
    slide?.elements.filter(({ region, rotation }) => {
      const angle = (rotation * Math.PI) / 180;
      const cosine = Math.abs(Math.cos(angle));
      const sine = Math.abs(Math.sin(angle));
      const width = cosine * region.width + (sine * region.height * slide.height) / slide.width;
      const height = cosine * region.height + (sine * region.width * slide.width) / slide.height;
      const x = region.left + region.width / 2;
      const y = region.top + region.height / 2;
      return (
        x - width / 2 >= area.left &&
        x + width / 2 <= area.left + area.width &&
        y - height / 2 >= area.top &&
        y + height / 2 <= area.top + area.height
      );
    }) ?? []
  );
}

function slideSelection(
  page: number,
  slide: SlideRevisionMetadata | undefined,
  point: SlidePoint,
  area?: DocumentRegion,
): RevisionSelection {
  const element = area ? undefined : slideElementAt(slide, point);
  const region = area ?? { left: point.x, top: point.y, width: 0, height: 0 };
  const elementIds = area
    ? slideElementsIn(slide, area)
        .slice(-20)
        .map(({ id }) => id)
    : [];
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
      ...(elementIds.length ? { elementIds } : {}),
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

function SlideAnnotationLayer({
  page,
  slide,
  aspectRatio,
  enabled,
  interactive = true,
  marks,
  selection,
  candidate,
  onCandidate,
  onDismissSelection,
  onEdit,
  onPick,
}: SlideAnnotation) {
  const start = useRef<{
    id: number;
    point: SlidePoint;
    x: number;
    y: number;
    dismissed: boolean;
  } | null>(null);
  const [area, setArea] = useState<DocumentRegion>();
  const [hovered, setHovered] = useState<SlideElement>();
  const action = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLButtonElement>(null);
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
  function renderRegion(
    region: DocumentRegion,
    state: "hover" | "area" | "candidate" | "selected" | "contained" | "marked",
    rotation?: number,
    key?: string,
  ) {
    if (!region.width || !region.height) return null;
    return (
      <span
        key={key}
        aria-hidden="true"
        className="za-slide-region"
        data-state={state}
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
  const chosen = interactive ? (selection ?? candidate) : null;
  const target = chosen?.target?.kind === "slide" ? chosen.target : undefined;
  const bounds = target?.element?.bounds ?? chosen?.region;
  const anchor = target?.point;
  const contained = area
    ? slideElementsIn(slide, area)
    : (slide?.elements.filter((element) => target?.elementIds?.includes(element.id)) ?? []);
  return (
    <>
      {interactive && (
        <button
          ref={surface}
          type="button"
          aria-label="选择幻灯片上的内容并添加批注"
          className={
            enabled
              ? "absolute inset-0 touch-none bg-transparent"
              : "absolute inset-0 bg-transparent"
          }
          style={{ cursor: enabled ? COMMENT_CURSOR : hovered ? "pointer" : undefined }}
          data-slide-key-target=""
          data-slide-annotation-surface={enabled ? "annotate" : "browse"}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return;
            if (selection && !onDismissSelection()) return;
            if (enabled) event.currentTarget.setPointerCapture(event.pointerId);
            onCandidate(null);
            setHovered(undefined);
            start.current = {
              id: event.pointerId,
              point: getPoint(event.currentTarget, event.clientX, event.clientY),
              x: event.clientX,
              y: event.clientY,
              dismissed: !!selection,
            };
          }}
          onPointerMove={(event) => {
            const initial = start.current;
            const point = getPoint(event.currentTarget, event.clientX, event.clientY);
            if (enabled && initial?.id === event.pointerId) {
              const distance = Math.hypot(event.clientX - initial.x, event.clientY - initial.y);
              setArea(distance >= SLIDE_DRAG_DISTANCE ? getArea(initial.point, point) : undefined);
            } else if (!selection && !candidate && event.pointerType !== "touch")
              setHovered(slideElementAt(slide, point));
          }}
          onPointerLeave={() => {
            setHovered(undefined);
            if (!enabled) reset();
          }}
          onPointerUp={(event) => {
            const initial = start.current;
            if (initial?.id !== event.pointerId) return;
            const point = getPoint(event.currentTarget, event.clientX, event.clientY);
            const box = getArea(initial.point, point);
            const moved =
              Math.hypot(event.clientX - initial.x, event.clientY - initial.y) >=
              SLIDE_DRAG_DISTANCE;
            const element = !moved && slideElementAt(slide, point);
            if (enabled) {
              if (!initial.dismissed || moved) {
                onPick(slideSelection(page, slide, point, moved ? box : undefined));
              }
            } else if (element) {
              onCandidate(slideSelection(page, slide, point));
            }
            reset();
          }}
          onPointerCancel={reset}
          onLostPointerCapture={reset}
          onClick={(event) => {
            const element = hovered ?? slide?.elements.find((item) => !!item.quote);
            if (event.detail === 0 && !selection && (enabled || element)) {
              const point = element
                ? {
                    x: element.region.left + element.region.width / 2,
                    y: element.region.top + element.region.height / 2,
                  }
                : { x: 0.5, y: 0.5 };
              const item = slideSelection(page, slide, point);
              if (enabled) onPick(item);
              else {
                onCandidate(item);
                requestAnimationFrame(() => action.current?.focus());
              }
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && candidate) {
              event.stopPropagation();
              onCandidate(null);
            }
          }}
        />
      )}
      {enabled && area ? renderRegion(area, "area") : null}
      {bounds
        ? renderRegion(bounds, selection ? "selected" : "candidate", target?.element?.rotation)
        : null}
      {enabled &&
        contained.map(({ id, region, rotation }) =>
          renderRegion(region, "contained", rotation, id),
        )}
      {!area && !bounds && hovered ? renderRegion(hovered.region, "hover", hovered.rotation) : null}
      {!enabled && candidate && !selection && bounds && anchor ? (
        <Button
          ref={action}
          variant="outline"
          size="sm"
          className="za-slide-region-action"
          data-slide-annotation-control=""
          data-below={bounds.top < 0.12}
          tooltip="提出修改请求"
          style={{
            left: `clamp(min(50%, 78px), ${(bounds.width ? bounds.left + bounds.width / 2 : anchor.x) * 100}%, max(50%, calc(100% - 78px)))`,
            top: `${Math.min(1, Math.max(0, bounds.top < 0.12 ? bounds.top + Math.min(0.1, bounds.height) : bounds.top)) * 100}%`,
          }}
          onClick={() => {
            onCandidate(null);
            onPick(candidate);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onCandidate(null);
              surface.current?.focus({ preventScroll: true });
            }
          }}
        >
          <SquareMousePointer className="size-4" />
          提出修改请求
        </Button>
      ) : null}
      {marks.map((mark) => {
        const target = mark.target?.kind === "slide" ? mark.target : undefined;
        const region = target?.element?.bounds ?? mark.region;
        const rotation = target?.element?.rotation ?? 0;
        const angle = (rotation * Math.PI) / 180;
        const point =
          region?.width && region.height
            ? {
                x:
                  region.left +
                  (region.width * (1 + Math.cos(angle))) / 2 +
                  (region.height * Math.sin(angle)) / (2 * aspectRatio),
                y:
                  region.top +
                  (region.height * (1 - Math.cos(angle))) / 2 +
                  (region.width * Math.sin(angle) * aspectRatio) / 2,
              }
            : target?.point;
        if (!point || selection?.editingCommentId === mark.id) return null;
        return (
          <span key={mark.id}>
            {region && renderRegion(region, "marked", rotation)}
            <LabelTooltip
              label={mark.comment}
              side="top"
              contentClassName="za-slide-comment-preview"
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="za-slide-comment-pin"
                  data-slide-annotation-control=""
                  style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                  aria-label="编辑幻灯片批注"
                  onClick={() => onEdit(mark.id)}
                >
                  <span
                    aria-hidden="true"
                    className="size-6 bg-contain bg-center bg-no-repeat"
                    style={{ backgroundImage: COMMENT_PIN }}
                  />
                </Button>
              }
            />
          </span>
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

async function rasterSlideThumbnail(source: string, current: () => boolean, pixelLimit: number) {
  const safe = safeSlide(source);
  const sourceURL = URL.createObjectURL(new Blob([safe.svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = sourceURL;
    await image.decode();
    if (!current()) return;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, pixelLimit / Math.max(safe.width, safe.height));
    canvas.width = Math.max(1, Math.round(safe.width * scale));
    canvas.height = Math.max(1, Math.round(safe.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  } finally {
    URL.revokeObjectURL(sourceURL);
  }
}

type RenderedSlide = {
  page: number;
  url: string;
  width: number;
  height: number;
  revision?: SlideRevisionMetadata;
};

function createSlideCache(
  worker: ReturnType<typeof createResourcePreviewWorker>,
  signal: AbortSignal,
  includeAnnotations: boolean,
  assertCurrent: () => void,
) {
  const ready = new Map<number, RenderedSlide>();
  const pending = new Map<number, Promise<RenderedSlide>>();
  let visiblePage = 0;
  signal.addEventListener(
    "abort",
    () => {
      for (const item of ready.values()) URL.revokeObjectURL(item.url);
      ready.clear();
    },
    { once: true },
  );
  function peek(page: number) {
    const item = ready.get(page);
    if (item) {
      ready.delete(page);
      ready.set(page, item);
    }
    return item;
  }
  function read(page: number, first?: PreviewWorkerResult): Promise<RenderedSlide> {
    const existing = peek(page);
    if (existing) return Promise.resolve(existing);
    const inFlight = pending.get(page);
    if (inFlight) return inFlight;
    const task = (async () => {
      const result =
        first ?? (await worker.request({ type: "slide", index: page - 1, includeAnnotations }));
      signal.throwIfAborted();
      assertCurrent();
      const { svg, width, height } = safeSlide(result.svg ?? "");
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      try {
        const image = document.createElement("img");
        image.src = url;
        await image.decode?.();
        signal.throwIfAborted();
        assertCurrent();
        const item = { page, url, width, height, revision: result.slideRevision };
        ready.set(page, item);
        if (ready.size > 12) {
          for (const [number, cached] of ready) {
            if (number === visiblePage || number === page) continue;
            ready.delete(number);
            URL.revokeObjectURL(cached.url);
            break;
          }
        }
        return item;
      } catch (cause) {
        URL.revokeObjectURL(url);
        throw cause;
      }
    })().finally(() => pending.delete(page));
    pending.set(page, task);
    return task;
  }
  return {
    peek,
    read,
    show(page: number) {
      visiblePage = page;
    },
  };
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
  const [hiddenSlides, setHiddenSlides] = useState<number[]>([]);
  const [svg, setSVG] = useState("");
  const [rendered, setRendered] = useState<RenderedSlide>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [outline, setOutline] = useState<boolean>();
  const [railHovered, setRailHovered] = useState(false);
  const railLeave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { container: layout, viewport: pane } = usePreviewViewport();
  const paneWidth = pane.width;
  const [topInset, setTopInset] = useState(0);
  const railToggle = useRef<HTMLButtonElement>(null);
  const railPinned = outline ?? paneWidth >= 820;
  const railOpen = railPinned || railHovered;
  const railOverlay = !railPinned || paneWidth < 680;
  const [grid, setGrid] = usePreviewReadingState("slideGrid", false);
  const [gridZoom, setGridZoom] = useState<PreviewZoom>("fit-page");
  const [gridSelection, setGridSelection] = useState<number | null>(null);
  const [gridAnnotationSlide, setGridAnnotationSlide] = useState<RenderedSlide>();
  const zoomAnchor = useRef<PresentationZoomAnchor | null>(null);
  const [presenting, setPresenting] = useState(false);
  const [playbackVisible, setPlaybackVisible] = useState(false);
  const playbackTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const presentationSurface = useRef<HTMLDivElement>(null);
  const fullscreenOwner = useRef<HTMLElement | null>(null);
  const playTrigger = useRef<HTMLButtonElement>(null);
  const { onRequestRevision } = useContext(PreviewIdentityContext);
  const includeAnnotations = !!onRequestRevision && !props.thumbnail;
  const [annotating, setAnnotating] = useState(false);
  const [selection, setSelection] = useState<RevisionSelection | null>(null);
  const [candidate, setCandidate] = useState<RevisionSelection | null>(null);
  const [marks, setMarks] = useState<readonly DocumentRevisionComment[]>([]);
  const [pendingMark, setPendingMark] = useState<DocumentRevisionComment | null>(null);
  const [commentsToolbar, setCommentsToolbar] = useState<HTMLSpanElement | null>(null);
  const [requestTrigger, setRequestTrigger] = useState<HTMLElement | null>(null);
  const [showIntro, setShowIntro] = useState(() => {
    try {
      return !localStorage.getItem(SLIDE_COACHMARK);
    } catch {
      return true;
    }
  });
  const editRef = useRef<((id: string, source?: "marker") => void) | null>(null);
  const dismissSelectionRef = useRef<(() => boolean) | null>(null);
  const [slideFrame, setSlideFrame] = useState<HTMLDivElement | null>(null);
  const gridRoot = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLElement>(null);
  const gridEntry = useRef<{ page: number; frame?: DOMRect } | null>(null);
  const gridExit = useRef<((page: number, done: () => void) => void) | null>(null);
  const revealGridComment = useRef<((page: number, point: SlidePoint) => void) | null>(null);
  const gridLeaving = useRef(false);
  const [actualPercent, setActualPercent] = useState(100);
  const client = useRef<ReturnType<typeof createResourcePreviewWorker> | null>(null);
  const slideCache = useRef<ReturnType<typeof createSlideCache> | null>(null);
  const generation = useRef(0);
  const initialPage = useRef(page);
  const { bytes, assertCurrent } = props;
  const registerEscapeHandler = useContext(PreviewToolbarMount)?.registerEscapeHandler;
  useLayoutEffect(() => {
    if (layout.current) {
      setTopInset(
        Number.parseFloat(
          getComputedStyle(layout.current).getPropertyValue("--za-reader-top-inset"),
        ) || 0,
      );
    }
  }, [layout, pane.width]);

  const gridSize = presentationGridGeometry(count, rendered ?? { width: 1600, height: 900 });
  const gridFitScale = Math.max(
    0.02,
    Math.min(
      1,
      Math.max(1, pane.width - 192) / Math.max(1, gridSize.width),
      Math.max(1, pane.height - topInset - 192) / Math.max(1, gridSize.height),
    ),
  );
  const gridScale = typeof gridZoom === "number" ? gridZoom / 100 : gridFitScale;
  useEffect(() => {
    const controller = new AbortController();
    const worker = createResourcePreviewWorker(controller.signal);
    client.current = worker;
    const cache = createSlideCache(worker, controller.signal, includeAnnotations, assertCurrent);
    slideCache.current = cache;
    const seq = ++generation.current;
    void (async () => {
      const result = await worker.request({
        type: "load",
        kind: "pptx",
        bytes,
        includeAnnotations,
      });
      assertCurrent();
      if (controller.signal.aborted || generation.current !== seq) return;
      const pages = result.slideCount ?? 0;
      const hidden = result.hiddenSlides ?? [];
      if (!pages || pages > 150) throw new Error("幻灯片页数超出预览范围。");
      const restored = props.thumbnail ? 1 : Math.max(1, Math.min(initialPage.current, pages));
      const image = props.thumbnail
        ? undefined
        : await cache.read(restored, restored === 1 ? result : undefined);
      assertCurrent();
      if (controller.signal.aborted || generation.current !== seq) return;
      setPage(restored);
      setCount(pages);
      setHiddenSlides(hidden);
      cache.show(restored);
      setRendered(image);
      if (props.thumbnail) setSVG(result.svg ?? "");
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
      slideCache.current = null;
    };
  }, [bytes, assertCurrent, setPage, props.thumbnail, includeAnnotations]);

  async function navigate(target: number) {
    if (
      !slideCache.current ||
      target === page ||
      !Number.isInteger(target) ||
      target < 1 ||
      target > count
    )
      return;
    const seq = ++generation.current;
    const cache = slideCache.current;
    const cached = cache.peek(target);
    setPage(target);
    setCandidate(null);
    setBusy(!cached);
    setError("");
    try {
      const result = cached ?? (await cache.read(target));
      assertCurrent();
      if (generation.current !== seq) return;
      cache.show(target);
      setRendered(result);
    } catch (cause) {
      if (generation.current === seq)
        setError(cause instanceof Error ? cause.message : "此页未能打开。");
    } finally {
      if (generation.current === seq) setBusy(false);
    }
  }

  const leftInset = count ? (railPinned && !railOverlay ? 174 : 30) : 0;

  useEffect(() => {
    if (!grid || !includeAnnotations || gridSelection === null || gridSelection === rendered?.page)
      return;
    let active = true;
    void slideCache.current
      ?.read(gridSelection)
      .then((result) => {
        if (active) setGridAnnotationSlide(result);
      })
      .catch(() => {
        if (active) setGridAnnotationSlide(undefined);
      });
    return () => {
      active = false;
    };
  }, [grid, gridSelection, includeAnnotations, rendered]);

  function selectGridPage(target: number | null) {
    if (target === null && selection && !dismissSelectionRef.current?.()) return;
    setGridSelection(target);
    setCandidate(null);
  }

  function annotationForPage(number: number, interactive = true): SlideAnnotation | undefined {
    if (!includeAnnotations) return;
    const source =
      rendered?.page === number
        ? rendered
        : gridAnnotationSlide?.page === number
          ? gridAnnotationSlide
          : undefined;
    const pageMarks = marks.filter((mark) => mark.page === number);
    interactive = interactive && !!source;
    if (!interactive && !pageMarks.length) return;
    return {
      page: number,
      slide: source?.revision,
      aspectRatio: rendered ? rendered.width / rendered.height : 1,
      enabled: annotating,
      interactive,
      marks: pageMarks,
      selection: selection?.page === number ? selection : null,
      candidate: candidate?.page === number ? candidate : null,
      onCandidate: setCandidate,
      onDismissSelection: () => dismissSelectionRef.current?.() ?? false,
      onEdit: (id) => editRef.current?.(id, "marker"),
      onPick: (item) => {
        assertCurrent();
        setAnnotating(true);
        setSelection(item);
      },
    };
  }

  function focusSlideCanvas() {
    requestAnimationFrame(() => {
      layout.current
        ?.querySelector<HTMLElement>(".za-preview-slide-grid,.za-preview-slide-scroll")
        ?.focus({ preventScroll: true });
    });
  }

  function toggleGrid() {
    if (!rendered || gridLeaving.current) return;
    setCandidate(null);
    setRailHovered(false);
    zoomAnchor.current = null;
    if (!grid) {
      const frame = slideFrame?.getBoundingClientRect();
      gridEntry.current = { page, frame };
      const entryScale = Math.min(64, Math.max(0.02, (pane.width - 96) / rendered.width / 2));
      setGridZoom(pane.width ? entryScale * 100 : "fit-page");
      setGridSelection(page);
      setGrid(true);
      focusSlideCanvas();
      return;
    }
    const view = gridRoot.current;
    let target = gridSelection ?? page;
    if (view?.clientWidth) {
      const viewport = view.getBoundingClientRect();
      const x = viewport.left + viewport.width / 2;
      const y = viewport.top + (viewport.height + topInset) / 2;
      let nearest = Infinity;
      for (const tile of view.querySelectorAll<HTMLElement>("[data-grid-slide]")) {
        const rect = tile.querySelector(".za-preview-slide-cover")?.getBoundingClientRect();
        if (!rect) continue;
        const distance = Math.hypot(x - rect.left - rect.width / 2, y - rect.top - rect.height / 2);
        if (distance >= nearest) continue;
        nearest = distance;
        target = Number(tile.dataset.gridSlide);
      }
    }
    const destinationZoom = pane.width
      ? Math.max(
          10,
          Math.min(1600, ((pane.width - leftInset - 2 * SLIDE_FIT_MARGIN) / rendered.width) * 100),
        )
      : zoom;
    gridLeaving.current = true;
    const loading = navigate(target);
    const finish = () => {
      void loading.then(() => {
        setZoom(destinationZoom);
        gridLeaving.current = false;
        setGrid(false);
        focusSlideCanvas();
      });
    };
    if (gridExit.current && typeof destinationZoom === "number") {
      gridExit.current(target, finish);
    } else finish();
  }

  const handleEscape = useCallback(() => {
    if (selection) {
      dismissSelectionRef.current?.();
    } else if (candidate) {
      setCandidate(null);
    } else if (annotating) {
      setAnnotating(false);
    } else if (railHovered) {
      setRailHovered(false);
    } else if (grid && gridSelection !== null) {
      setGridSelection(null);
    } else return false;
    return true;
  }, [annotating, candidate, grid, gridSelection, railHovered, selection]);
  useLayoutEffect(
    () => registerEscapeHandler?.(handleEscape),
    [handleEscape, registerEscapeHandler],
  );

  useEffect(() => {
    const cache = slideCache.current;
    if (!cache || !rendered || rendered.page !== page) return;
    const timer = setTimeout(() => {
      for (const neighbor of [page + 1, page - 1]) {
        if (neighbor >= 1 && neighbor <= count && !hiddenSlides.includes(neighbor)) {
          void cache.read(neighbor).catch(() => {});
        }
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [count, hiddenSlides, page, rendered]);

  function dismissIntro() {
    setShowIntro(false);
    try {
      localStorage.setItem(SLIDE_COACHMARK, "1");
    } catch {
      // The current reader still remembers dismissal when storage is unavailable.
    }
  }

  function keepRailOpen() {
    clearTimeout(railLeave.current);
    railLeave.current = undefined;
  }

  function closeHoveredRail() {
    if (!railHovered || railLeave.current !== undefined) return;
    railLeave.current = setTimeout(() => {
      railLeave.current = undefined;
      setRailHovered(false);
    }, 120);
  }

  function toggleRail() {
    keepRailOpen();
    setRailHovered(false);
    setOutline(!railOpen);
    requestAnimationFrame(() => {
      if (railOpen) railToggle.current?.focus();
      else rail.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    });
  }

  useEffect(() => () => clearTimeout(railLeave.current), []);

  useEffect(() => {
    if (!railOpen || grid) return;
    rail.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [railOpen, grid, page]);

  const playableSlides = Array.from({ length: count }, (_, index) => index + 1).filter(
    (number) => !hiddenSlides.includes(number),
  );
  const nextSlide = playableSlides.find((number) => number > page);
  const previousSlide = playableSlides.filter((number) => number < page).at(-1);
  const playbackWheel = useRef<(direction: number) => void>(() => {});
  playbackWheel.current = (direction) => {
    const target = direction > 0 ? nextSlide : previousSlide;
    if (target !== undefined) void navigate(target);
  };
  const unbindPlaybackWheel = useRef<(() => void) | null>(null);
  const attachPlaybackSurface = useCallback((element: HTMLDivElement | null) => {
    unbindPlaybackWheel.current?.();
    presentationSurface.current = element;
    unbindPlaybackWheel.current = element
      ? bindPresentationPageWheel(
          element,
          () => true,
          (direction) => playbackWheel.current(direction),
        )
      : null;
  }, []);
  const revealPlayback = useCallback(() => {
    clearTimeout(playbackTimeout.current);
    setPlaybackVisible(true);
    playbackTimeout.current = setTimeout(() => setPlaybackVisible(false), 2000);
  }, []);
  const closePresentation = useCallback(() => {
    setPresenting(false);
    clearTimeout(playbackTimeout.current);
    if (fullscreenOwner.current && document.fullscreenElement === fullscreenOwner.current)
      void document.exitFullscreen().catch(() => {});
    fullscreenOwner.current = null;
  }, []);
  useEffect(() => {
    function onFullscreenChange() {
      if (fullscreenOwner.current && document.fullscreenElement !== fullscreenOwner.current)
        closePresentation();
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      clearTimeout(playbackTimeout.current);
      if (fullscreenOwner.current && document.fullscreenElement === fullscreenOwner.current)
        void document.exitFullscreen().catch(() => {});
    };
  }, [closePresentation]);

  function startPresentation() {
    const first = playableSlides.includes(page) ? page : (nextSlide ?? previousSlide);
    if (!first) return;
    void navigate(first);
    flushSync(() => setPresenting(true));
    const surface = presentationSurface.current;
    if (surface?.requestFullscreen) {
      fullscreenOwner.current = surface;
      void surface.requestFullscreen().catch(() => {
        if (fullscreenOwner.current === surface) fullscreenOwner.current = null;
      });
    }
    revealPlayback();
  }

  const resolveSelectionBounds = useCallback(
    (item: RevisionSelection) => {
      const frame = grid
        ? gridSelection === item.page
          ? gridRoot.current?.querySelector<HTMLElement>(
              `[data-grid-annotation-frame="${item.page}"]`,
            )
          : null
        : slideFrame;
      const view = frame?.closest("[data-scroll-viewport]");
      if (!frame || !view || (!grid && (busy || page !== item.page)) || !item.region) return;
      const area = frame.getBoundingClientRect();
      const viewport = view.getBoundingClientRect();
      const { left, top, width, height } = item.region;
      const anchor = item.target?.kind === "slide" ? item.target.point : undefined;
      const x = area.left + (width ? left : (anchor?.x ?? left)) * area.width;
      const y = area.top + (height ? top : (anchor?.y ?? top)) * area.height;
      const target = new DOMRect(x, y, width * area.width, height * area.height);
      return { target, viewport, observe: frame };
    },
    [busy, grid, gridSelection, page, slideFrame],
  );
  useEffect(() => {
    if (busy || grid || !slideFrame || pendingMark?.page !== page) return;
    const viewport = slideFrame.closest<HTMLElement>("[data-scroll-viewport]");
    const point = pendingMark.target?.kind === "slide" ? pendingMark.target.point : undefined;
    if (!viewport || !point) return;
    const frame = requestAnimationFrame(() => {
      const area = slideFrame.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      const x = area.left + point.x * area.width;
      const y = area.top + point.y * area.height;
      if (x < view.left + 24 || x > view.right - 24 || y < view.top + 24 || y > view.bottom - 76) {
        viewport.scrollBy({
          left: x - view.left - view.width / 2,
          top: y - view.top - view.height / 2,
          behavior: "instant",
        });
      }
      setPendingMark(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [busy, grid, page, pendingMark, slideFrame]);

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
      <PreviewToolbar label="幻灯片">
        <PreviewLeadingTools>
          {includeAnnotations && (
            <Button
              ref={setRequestTrigger}
              variant="ghost"
              size="sm"
              className="za-request-revision za-slide-revision-trigger"
              data-active={annotating}
              data-compact={paneWidth < 680}
              aria-pressed={annotating}
              aria-label="请求修改"
              tooltip={showIntro ? undefined : "请求修改"}
              disabled={busy || !!error}
              onClick={() => {
                if (showIntro) dismissIntro();
                setCandidate(null);
                if (annotating) setAnnotating(false);
                else {
                  if (grid && gridSelection === null) selectGridPage(page);
                  setAnnotating(true);
                }
              }}
            >
              <SquareMousePointer className="size-4" />
              <span>请求修改</span>
            </Button>
          )}
        </PreviewLeadingTools>
        {includeAnnotations && <span ref={setCommentsToolbar} className="za-slide-comments-tool" />}
        <div className="za-slide-view-controls">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="网格视图"
            tooltip={grid ? "返回单页" : "网格视图"}
            aria-pressed={grid}
            className="za-slide-grid-toggle"
            disabled={!count}
            onClick={toggleGrid}
          >
            <LayoutGrid className="size-4" />
          </Button>
          <PreviewZoomControl
            label="幻灯片缩放"
            value={grid ? gridZoom : zoom}
            onChange={grid ? setGridZoom : setZoom}
            minPercent={grid ? 2 : 10}
            maxPercent={grid ? 6400 : 1600}
            actualPercent={grid ? gridScale * 100 : actualPercent}
            percentages={[25, 50, 100, 200]}
            zoomCurve="camera"
            gestureRoot={layout}
            onZoomAnchor={(x, y) => {
              zoomAnchor.current = { x, y };
            }}
            windowFitLabel={grid ? "适应网格" : paneWidth >= 420 ? "适应窗口" : undefined}
            fitWidth={false}
          />
          <Button
            ref={playTrigger}
            variant="ghost"
            size="icon-sm"
            aria-label="播放幻灯片"
            tooltip="播放幻灯片"
            disabled={busy || !!error || !playableSlides.length}
            onClick={startPresentation}
          >
            <Play className="size-4" />
          </Button>
        </div>
      </PreviewToolbar>
      {requestTrigger && (
        <Popover
          open={showIntro && !!count && !busy && !error && !presenting && !grid}
          onOpenChange={(open) => {
            if (!open) dismissIntro();
          }}
        >
          <PopoverContent
            anchor={requestTrigger}
            sideOffset={10}
            align="end"
            initialFocus={false}
            finalFocus={false}
            className="za-slide-annotation-intro"
          >
            <PopoverTitle>添加批注</PopoverTitle>
            <p>选中幻灯片上的内容，即可请求修改或提出问题。</p>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="关闭批注提示"
              tooltip="关闭批注提示"
              onClick={dismissIntro}
            >
              <X className="size-4" />
            </Button>
          </PopoverContent>
        </Popover>
      )}
      <div
        ref={layout}
        className="za-preview-slides-layout relative"
        onPointerMove={(event) => {
          if (
            event.pointerType === "mouse" &&
            event.target instanceof Element &&
            !event.target.closest(".za-preview-slide-navigation")
          )
            closeHoveredRail();
        }}
        onKeyDown={(event) => {
          if (
            event.key !== "Escape" ||
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            (event.repeat ? !selection : !handleEscape())
          )
            return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {!!count && !grid && (
          <aside
            className="za-preview-slide-navigation"
            data-open={railOpen}
            data-overlay={railOverlay}
            onPointerEnter={keepRailOpen}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") closeHoveredRail();
            }}
          >
            {!railOpen && (
              <Button
                ref={railToggle}
                variant="ghost"
                size="icon-sm"
                className="za-preview-slide-rail-index"
                aria-expanded={false}
                aria-label="展开幻灯片目录"
                tooltip="展开幻灯片目录"
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") setRailHovered(true);
                }}
                onClick={toggleRail}
                onKeyDown={(event) =>
                  previewPageKey(event, page, count, (next) => void navigate(next), {
                    vertical: true,
                  })
                }
              >
                {Array.from({ length: Math.min(count, 12) }, (_, index) => (
                  <span
                    key={index}
                    aria-hidden="true"
                    data-current={
                      index ===
                      Math.round(((page - 1) * (Math.min(count, 12) - 1)) / Math.max(count - 1, 1))
                    }
                  />
                ))}
              </Button>
            )}
            <div className="za-preview-slide-rail" inert={!railOpen} aria-hidden={!railOpen}>
              <header className="za-preview-rail-count">
                <span>{count} 张幻灯片</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-expanded={true}
                  aria-label="收起幻灯片目录"
                  tooltip="收起幻灯片目录"
                  onClick={toggleRail}
                >
                  <PanelLeft className="size-4" />
                </Button>
              </header>
              <nav
                ref={rail}
                aria-label="选择幻灯片"
                onKeyDown={(event) => {
                  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
                    ".za-slide-thumbnail-button",
                  );
                  if (!button) return;
                  previewPageKey(
                    event,
                    Number(button.dataset.page),
                    count,
                    (next) => {
                      rail.current
                        ?.querySelector<HTMLButtonElement>(`[data-page="${next}"]`)
                        ?.focus();
                      void navigate(next);
                    },
                    { vertical: true, descendants: true },
                  );
                }}
              >
                {Array.from({ length: count }, (_, index) => index + 1).map((number) => (
                  <button
                    type="button"
                    className="za-slide-thumbnail-button"
                    key={number}
                    aria-label={`转到第 ${number} 页`}
                    aria-current={number === page ? "page" : undefined}
                    data-hidden-slide={hiddenSlides.includes(number)}
                    data-page={number}
                    onClick={() => {
                      void navigate(number);
                      if (railOverlay) toggleRail();
                    }}
                  >
                    <span>{number}</span>
                    <SlideThumbnail
                      index={number - 1}
                      worker={client.current}
                      root={rail}
                      observe={railOpen}
                      assertCurrent={assertCurrent}
                    />
                  </button>
                ))}
              </nav>
            </div>
          </aside>
        )}
        {grid && rendered ? (
          <SlideOverview
            root={gridRoot}
            viewport={pane}
            count={count}
            slide={rendered}
            scale={gridScale}
            topInset={topInset}
            leftInset={leftInset}
            fit={gridZoom === "fit-page"}
            entry={gridEntry}
            exit={gridExit}
            reveal={revealGridComment}
            selected={gridSelection}
            onSelect={selectGridPage}
            annotationForPage={annotationForPage}
            anchor={zoomAnchor}
            worker={client.current}
            assertCurrent={assertCurrent}
          />
        ) : (
          <SlideImage
            image={rendered}
            name={props.name}
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
            onScale={setActualPercent}
            frameRef={setSlideFrame}
            fitLeftInset={leftInset}
            fitTopInset={topInset}
            fitMargin={SLIDE_FIT_MARGIN}
            anchor={zoomAnchor}
            onBlankClick={() => {
              setCandidate(null);
              if (selection) dismissSelectionRef.current?.();
            }}
            annotation={annotationForPage(page)}
          />
        )}
        {includeAnnotations && (
          <ResourceDocumentComments
            enabled={annotating}
            onEnabled={setAnnotating}
            selection={selection}
            onSelection={(next) => {
              if (!next && document.activeElement?.closest(".za-document-comment-editor")) {
                focusSlideCanvas();
              }
              setSelection(next);
            }}
            editRef={editRef}
            dismissSelectionRef={dismissSelectionRef}
            toolbarTarget={commentsToolbar}
            onMarks={setMarks}
            resolveSelectionBounds={resolveSelectionBounds}
            onNavigate={(_block, comment, source) => {
              if (comment?.target?.kind !== "slide") return;
              if (grid) {
                const { slide, point } = comment.target;
                if (source === "marker" && gridSelection === slide) return;
                selectGridPage(slide);
                if (point) revealGridComment.current?.(slide, point);
                return;
              }
              if (source === "marker" && comment.target.slide === page) return;
              setPendingMark(comment);
              void navigate(comment.target.slide);
            }}
          />
        )}
      </div>
      <Dialog
        open={presenting}
        onOpenChange={(open) => {
          if (!open) closePresentation();
        }}
      >
        <DialogContent
          ref={attachPlaybackSurface}
          initialFocus={presentationSurface}
          finalFocus={playTrigger}
          layout="lightbox"
          className="za-slide-presentation"
          data-controls-visible={playbackVisible}
          onPointerMove={revealPlayback}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closePresentation();
              return;
            }
            if (
              event.key === " " &&
              event.target instanceof HTMLElement &&
              event.target.closest("button")
            )
              return;
            let target: number | undefined;
            if (["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key)) {
              target = nextSlide;
            } else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) {
              target = previousSlide;
            } else if (event.key === "Home" || event.key === "End") {
              target = event.key === "Home" ? playableSlides[0] : playableSlides.at(-1);
            } else return;
            event.preventDefault();
            if (target !== undefined) void navigate(target);
          }}
        >
          <DialogTitle className="sr-only">幻灯片演示</DialogTitle>
          <SlideImage
            image={rendered}
            name={props.name}
            zoom="fit-page"
            page={page}
            count={count}
            busy={busy}
            error={error}
            onCancel={props.onCancel}
            onDownload={props.onDownload}
            onRetry={props.onRetry}
            presentation
            assertCurrent={assertCurrent}
            onError={setError}
          />
          <button
            type="button"
            className="za-slide-advance"
            aria-label="切换到下一张幻灯片"
            disabled={nextSlide === undefined}
            onClick={() => {
              if (nextSlide !== undefined) void navigate(nextSlide);
            }}
          />
          <fieldset className="za-slide-playback" aria-label="幻灯片播放控件">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="上一张幻灯片"
              tooltip="上一张幻灯片"
              disabled={previousSlide === undefined}
              onClick={() => {
                if (previousSlide !== undefined) void navigate(previousSlide);
              }}
            >
              <ChevronRight className="size-4 rotate-180" />
            </Button>
            <span aria-live="polite">
              第 {playableSlides.indexOf(page) + 1} 张，共 {playableSlides.length} 张
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="下一张幻灯片"
              tooltip="下一张幻灯片"
              disabled={nextSlide === undefined}
              onClick={() => {
                if (nextSlide !== undefined) void navigate(nextSlide);
              }}
            >
              <ChevronRight className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="退出演示模式"
              tooltip="退出演示模式"
              onClick={closePresentation}
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
  observe = true,
  vector = false,
  currentURL,
  assertCurrent,
}: {
  index: number;
  worker: ReturnType<typeof createResourcePreviewWorker> | null;
  root: import("react").RefObject<HTMLElement | null>;
  observe?: boolean;
  vector?: boolean;
  currentURL?: string;
  assertCurrent: () => void;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setURL] = useState("");
  useEffect(() => {
    if (!host.current || currentURL || (visible && !vector) || !observe) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          if (!vector) observer.disconnect();
        } else if (vector) setVisible(false);
      },
      { root: root.current, rootMargin: "160px" },
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [root, visible, observe, vector, currentURL]);
  useEffect(() => {
    if (!visible || !worker || currentURL) {
      setURL("");
      return;
    }
    let active = true,
      owned = "";
    void worker
      .request({ type: "slide", index })
      .then(async (result) => {
        assertCurrent();
        if (!active || !result.svg) return;
        const thumbnail = vector
          ? new Blob([safeSlide(result.svg).svg], { type: "image/svg+xml" })
          : await rasterSlideThumbnail(result.svg, () => active, 320);
        assertCurrent();
        if (!active || !thumbnail) return;
        owned = URL.createObjectURL(thumbnail);
        setURL(owned);
      })
      .catch(() => {
        /* A failed cover never disables navigation to the actual page. */
      });
    return () => {
      active = false;
      if (owned) URL.revokeObjectURL(owned);
    };
  }, [index, worker, visible, assertCurrent, vector, currentURL]);
  return (
    <span ref={host} className="za-preview-slide-cover" aria-hidden="true">
      {currentURL || url ? (
        <img src={currentURL || url} alt="" />
      ) : (
        <span className="za-preview-cover-placeholder" />
      )}
    </span>
  );
}

function SlideOverview({
  root,
  viewport,
  count,
  slide,
  scale,
  topInset,
  leftInset,
  fit,
  entry,
  exit,
  reveal,
  selected,
  onSelect,
  annotationForPage,
  anchor,
  worker,
  assertCurrent,
}: {
  root: RefObject<HTMLDivElement | null>;
  viewport: { width: number; height: number };
  count: number;
  slide: RenderedSlide;
  scale: number;
  topInset: number;
  leftInset: number;
  fit: boolean;
  entry: RefObject<{ page: number; frame?: DOMRect } | null>;
  exit: RefObject<((page: number, done: () => void) => void) | null>;
  reveal: RefObject<((page: number, point: SlidePoint) => void) | null>;
  selected: number | null;
  onSelect: (page: number | null) => void;
  annotationForPage: (page: number, interactive: boolean) => SlideAnnotation | undefined;
  anchor: RefObject<PresentationZoomAnchor | null>;
  worker: ReturnType<typeof createResourcePreviewWorker> | null;
  assertCurrent: () => void;
}) {
  const grid = presentationGridGeometry(count, slide);
  const world = useRef<HTMLDivElement>(null);
  const camera = useRef<PresentationCamera | null>(null);
  const cancelAnimation = useRef<(() => void) | null>(null);
  const previous = useRef({ viewport, scale, fit });
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    origin: PresentationCamera;
    moved: boolean;
  } | null>(null);
  const dragged = useRef(false);

  const draw = useCallback(
    (next: PresentationCamera, opacity = 1) => {
      camera.current = next;
      if (!world.current) return;
      world.current.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
      world.current.style.setProperty("--za-grid-scale", String(next.scale));
      world.current.style.setProperty("--za-grid-progress", String(opacity));
      root.current?.dispatchEvent(new Event("scroll"));
    },
    [root],
  );

  useLayoutEffect(() => {
    const view = root.current;
    if (!view || !world.current || world.current.hasAttribute("data-leaving")) return;
    const starting = entry.current;
    const before = previous.current;
    const current = camera.current;
    const center = { x: grid.width / 2, y: grid.height / 2 };
    const rect = view.getBoundingClientRect();
    const pointer = anchor.current;
    anchor.current = null;
    previous.current = { viewport, scale, fit };
    if (starting) {
      entry.current = null;
      const point = presentationGridSlideCenter(starting.page, slide, grid);
      const to = centerPresentationCamera(viewport, fit ? center : point, scale, topInset);
      const from = starting.frame;
      if (!from?.width || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        draw(to);
      } else {
        const k = from.width / slide.width;
        const source = {
          x: from.left - rect.left - (point.x - slide.width / 2) * k,
          y: from.top - rect.top - (point.y - slide.height / 2) * k,
          scale: k,
        };
        world.current.dataset.transitionPage = String(starting.page);
        draw(source, 0);
        cancelAnimation.current = animatePresentationCamera(source, to, point, draw, () => {
          if (world.current) delete world.current.dataset.transitionPage;
          cancelAnimation.current = null;
        });
      }
      return;
    }
    cancelAnimation.current?.();
    cancelAnimation.current = null;
    delete world.current.dataset.transitionPage;
    if (!current || fit) {
      draw(centerPresentationCamera(viewport, center, scale, topInset));
      return;
    }
    const x = pointer ? pointer.x - rect.left : viewport.width / 2;
    const y = pointer ? pointer.y - rect.top : (viewport.height + topInset) / 2;
    const oldX = pointer ? x : before.viewport.width / 2;
    const oldY = pointer ? y : (before.viewport.height + topInset) / 2;
    draw({
      x: x - ((oldX - current.x) / current.scale) * scale,
      y: y - ((oldY - current.y) / current.scale) * scale,
      scale,
    });
  }, [
    anchor,
    draw,
    entry,
    fit,
    grid.width,
    grid.height,
    root,
    scale,
    slide.width,
    slide.height,
    topInset,
    viewport,
  ]);

  useLayoutEffect(() => {
    exit.current = (page, done) => {
      const current = camera.current;
      const layer = world.current;
      cancelAnimation.current?.();
      cancelAnimation.current = null;
      if (
        !current ||
        !layer ||
        !viewport.width ||
        !viewport.height ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ) {
        done();
        return;
      }
      const point = presentationGridSlideCenter(page, slide, grid);
      const widthScale = Math.max(
        0.1,
        Math.min(16, (viewport.width - leftInset - 2 * SLIDE_FIT_MARGIN) / slide.width),
      );
      const destination = centerPresentationCamera(
        viewport,
        point,
        widthScale,
        topInset,
        leftInset,
      );
      layer.dataset.transitionPage = String(page);
      layer.dataset.leaving = "";
      layer.querySelector("[data-transition-focus]")?.removeAttribute("data-transition-focus");
      layer.querySelector(`[data-grid-slide="${page}"]`)?.setAttribute("data-transition-focus", "");
      cancelAnimation.current = animatePresentationCamera(
        current,
        destination,
        point,
        (next, progress) => draw(next, 1 - progress),
        done,
      );
    };
    return () => {
      exit.current = null;
    };
  });
  useLayoutEffect(() => {
    reveal.current = (page, point) => {
      const current = camera.current;
      if (!current) return;
      const center = presentationGridSlideCenter(page, slide, grid);
      const x = center.x + (point.x - 0.5) * slide.width;
      const y = center.y + (point.y - 0.5) * slide.height;
      const px = current.x + x * current.scale;
      const py = current.y + y * current.scale;
      if (
        px >= 24 &&
        px <= viewport.width - 24 &&
        py >= topInset + 24 &&
        py <= viewport.height - 100
      )
        return;
      cancelAnimation.current?.();
      if (world.current) delete world.current.dataset.transitionPage;
      draw(centerPresentationCamera(viewport, { x, y }, current.scale, topInset));
    };
    return () => {
      reveal.current = null;
    };
  });
  useLayoutEffect(() => () => cancelAnimation.current?.(), []);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const pan = (event: WheelEvent) => {
      const current = camera.current;
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.defaultPrevented ||
        !current ||
        world.current?.hasAttribute("data-leaving")
      )
        return;
      event.preventDefault();
      cancelAnimation.current?.();
      if (world.current) delete world.current.dataset.transitionPage;
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      draw({
        ...current,
        x: current.x - (event.shiftKey ? event.deltaY : event.deltaX) * factor,
        y: current.y - (event.shiftKey ? 0 : event.deltaY) * factor,
      });
    };
    element.addEventListener("wheel", pan, { passive: false });
    return () => element.removeEventListener("wheel", pan);
  }, [draw, root]);

  return (
    <div
      ref={root}
      className="za-preview-slide-grid"
      role="region"
      aria-label="幻灯片网格"
      data-scroll-viewport=""
      tabIndex={-1}
      onPointerDown={(event) => {
        dragged.current = false;
        if (!event.isPrimary) {
          drag.current = null;
          delete event.currentTarget.dataset.panning;
          return;
        }
        if (
          (event.button !== 0 && event.button !== 1) ||
          !camera.current ||
          world.current?.hasAttribute("data-leaving")
        )
          return;
        if (
          event.button === 0 &&
          event.target instanceof Element &&
          event.target.closest(
            '[data-slide-annotation-surface="annotate"],[data-slide-annotation-control]',
          )
        )
          return;
        if (event.button === 1) event.preventDefault();
        drag.current = {
          pointer: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          origin: camera.current,
          moved: false,
        };
      }}
      onPointerMove={(event) => {
        const gesture = drag.current;
        if (gesture?.pointer !== event.pointerId) return;
        const dx = event.clientX - gesture.x,
          dy = event.clientY - gesture.y;
        if (!gesture.moved && Math.hypot(dx, dy) < 5) return;
        if (!gesture.moved) {
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.dataset.panning = "";
          cancelAnimation.current?.();
          if (world.current) delete world.current.dataset.transitionPage;
          gesture.moved = true;
          dragged.current = true;
        }
        draw({ ...gesture.origin, x: gesture.origin.x + dx, y: gesture.origin.y + dy });
      }}
      onPointerUp={(event) => {
        drag.current = null;
        delete event.currentTarget.dataset.panning;
      }}
      onPointerCancel={(event) => {
        drag.current = null;
        delete event.currentTarget.dataset.panning;
      }}
      onClickCapture={(event) => {
        if (dragged.current && event.detail > 0) {
          event.stopPropagation();
          dragged.current = false;
        }
      }}
      onClick={(event) => {
        if (event.target instanceof Element && !event.target.closest("[data-grid-slide]"))
          onSelect(null);
      }}
    >
      <div
        ref={world}
        className="za-preview-slide-grid-pages"
        style={{
          width: grid.width,
          height: grid.height,
          gap: grid.gap,
          gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
          gridAutoRows: slide.height + grid.labelHeight,
        }}
      >
        {Array.from({ length: count }, (_, index) => index + 1).map((number) => {
          const active = number === selected;
          const annotation = annotationForPage(number, active);
          return (
            <div
              key={number}
              data-grid-slide={number}
              data-transition-focus={entry.current?.page === number || active ? "" : undefined}
            >
              <span className="za-preview-grid-number" style={{ height: grid.labelHeight }}>
                <span>{number}</span>
              </span>
              <div className="za-preview-grid-frame" data-grid-annotation-frame={number}>
                <SlideThumbnail
                  index={number - 1}
                  worker={worker}
                  root={root}
                  vector
                  currentURL={number === slide.page ? slide.url : undefined}
                  assertCurrent={assertCurrent}
                />
                <button
                  type="button"
                  className="za-preview-grid-select"
                  aria-label={`选中第 ${number} 页`}
                  aria-pressed={active}
                  tabIndex={annotation?.interactive ? -1 : 0}
                  onClick={(event) => {
                    onSelect(number);
                    if (event.detail === 0 && annotationForPage(number, true)) {
                      const tile = event.currentTarget.parentElement;
                      requestAnimationFrame(() => {
                        tile
                          ?.querySelector<HTMLElement>("[data-slide-annotation-surface]")
                          ?.focus({ preventScroll: true });
                      });
                    }
                  }}
                />
                {annotation && (
                  <SlideAnnotationLayer
                    key={String(annotation.enabled && annotation.interactive)}
                    {...annotation}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SlideImage({
  image,
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
  onBlankClick,
  assertCurrent,
  onError,
  onScale,
  frameRef,
  annotation,
  presentation,
  fitLeftInset = 0,
  fitTopInset = 0,
  fitMargin = 0,
  anchor,
}: PreviewRecovery & {
  image?: RenderedSlide;
  name: string;
  zoom: PreviewZoom;
  page: number;
  count: number;
  busy: boolean;
  error: string;
  onCancel?: () => void;
  onPage?: (page: number) => void;
  onBlankClick?: () => void;
  assertCurrent: () => void;
  onError: (message: string) => void;
  onScale?: (percent: number) => void;
  frameRef?: RefCallback<HTMLDivElement>;
  annotation?: SlideAnnotation;
  presentation?: boolean;
  fitLeftInset?: number;
  fitTopInset?: number;
  fitMargin?: number;
  anchor?: RefObject<PresentationZoomAnchor | null>;
}) {
  const { container, viewport } = usePreviewViewport();
  usePresentationPan(container, false);
  const fit = typeof zoom !== "number";
  const scale = image
    ? fit
      ? Math.min(
          Math.max(1, (viewport.width || 640) - fitLeftInset - 2 * fitMargin) / image.width,
          Math.max(1, (viewport.height || 480) - fitTopInset - 2 * fitMargin) / image.height,
        )
      : Math.max(0.1, Math.min(16, zoom / 100))
    : 1;
  const wheelState = useRef({ image, page, count, onPage, scale });
  wheelState.current = { image, page, count, onPage, scale };
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    return bindPresentationPageWheel(
      element,
      () => {
        const state = wheelState.current;
        return (
          !!state.onPage &&
          !!state.image &&
          state.image.width * state.scale <= element.clientWidth + 0.5 &&
          state.image.height * state.scale <= element.clientHeight + 0.5
        );
      },
      (direction) => {
        const state = wheelState.current;
        const target = state.page + direction;
        if (target >= 1 && target <= state.count) state.onPage?.(target);
      },
    );
  }, [container]);
  const plane = usePresentationPlane(
    container,
    viewport,
    {
      width: (image?.width ?? 0) * scale,
      height: (image?.height ?? 0) * scale,
    },
    { left: fit ? fitLeftInset : 0, top: fit ? fitTopInset : 0 },
    anchor,
  );
  useEffect(() => {
    onScale?.(scale * 100);
  }, [scale, onScale]);
  return (
    <PreviewScrollArea
      ref={container}
      className="za-preview-slide-scroll"
      aria-label="幻灯片阅读画布"
      aria-busy={busy}
      tabIndex={presentation ? undefined : 0}
      onClick={(event) => {
        if (
          onBlankClick &&
          event.target instanceof Element &&
          !event.target.closest("[data-slide-frame],button")
        ) {
          onBlankClick();
          event.currentTarget.focus({ preventScroll: true });
        }
      }}
      onKeyDown={
        onPage
          ? (event) => {
              if (
                event.target !== event.currentTarget &&
                !(
                  event.target instanceof HTMLElement &&
                  event.target.hasAttribute("data-slide-key-target")
                )
              )
                return;
              previewPageKey(
                event,
                page,
                count,
                (next) => {
                  event.currentTarget.focus({ preventScroll: true });
                  onPage(next);
                },
                { vertical: true, descendants: true },
              );
            }
          : undefined
      }
    >
      {error ? (
        <PreviewUnavailable message={error} onDownload={onDownload} onRetry={onRetry} />
      ) : !image ? (
        <PreviewLoading
          message={count ? `正在渲染第 ${page} 页…` : "正在排版幻灯片…"}
          onCancel={onCancel}
        />
      ) : (
        <div
          className="za-preview-slide-plane"
          style={{ width: plane.width, height: plane.height }}
        >
          <div
            ref={frameRef}
            data-slide-frame=""
            style={{ position: "absolute", left: plane.left, top: plane.top }}
          >
            <img
              src={image.url}
              alt={`${name} · 第 ${image.page} 页`}
              className="za-preview-slide za-preview-frame-content"
              data-ready="true"
              style={{
                width: `${image.width * scale}px`,
                aspectRatio: `${image.width} / ${image.height}`,
              }}
              onLoad={() => {
                try {
                  assertCurrent();
                } catch {
                  onError("此预览已失效，请重新打开文件。");
                }
              }}
              onError={() => onError("此页未能显示，请下载原件查看。")}
            />
            {annotation && image.page === page && (
              <div className="za-preview-slide-annotations">
                <SlideAnnotationLayer key={`${page}:${annotation.enabled}`} {...annotation} />
              </div>
            )}
          </div>
          {!presentation && scale >= SLIDE_PIXEL_GRID_SCALE && (
            <div
              aria-hidden="true"
              className="za-preview-slide-pixel-grid"
              style={{
                backgroundSize: `${scale}px ${scale}px`,
                backgroundPosition: `${plane.left}px ${plane.top}px`,
              }}
            />
          )}
        </div>
      )}
    </PreviewScrollArea>
  );
}
