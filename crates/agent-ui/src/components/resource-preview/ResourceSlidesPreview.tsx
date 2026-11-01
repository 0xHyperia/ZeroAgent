import { useContext, useEffect, useRef, useState } from "react";
import { ChevronRight, LayoutGrid, PanelLeft, Play, X } from "../IconSet";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewToolbarMount } from "./PreviewChrome";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewScrollArea } from "./PreviewScrollArea";
import {
  PreviewPageControls,
  PreviewToolbar,
  PreviewZoomControl,
  previewPageKey,
} from "./PreviewToolbar";
import { boundedPreviewScale, previewScale } from "./previewGeometry";
import { createResourcePreviewWorker } from "./previewWorkerClient";
import { usePreviewReadingState } from "./readingSession";
import { usePreviewViewport } from "./usePreviewViewport";

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
  },
) {
  const [page, setPage] = usePreviewReadingState("slidePage", 1);
  const [zoom, setZoom] = usePreviewReadingState("slideZoom", "fit-page");
  const [count, setCount] = useState(0);
  const [svg, setSVG] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [outline, setOutline] = useState(false);
  const [grid, setGrid] = usePreviewReadingState("slideGrid", false);
  const [presenting, setPresenting] = useState(false);
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
      let result = await worker.request({ type: "load", kind: "pptx", bytes });
      assertCurrent();
      if (controller.signal.aborted || generation.current !== seq) return;
      const pages = result.slideCount ?? 0;
      if (!pages || pages > 150) throw new Error("幻灯片页数超出预览范围。");
      const restored = Math.max(1, Math.min(initialPage.current, pages));
      if (restored !== 1) result = await worker.request({ type: "slide", index: restored - 1 });
      assertCurrent();
      if (controller.signal.aborted || generation.current !== seq) return;
      setPage(restored);
      setCount(pages);
      setSVG(result.svg ?? "");
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
  }, [bytes, assertCurrent, setPage]);

  async function navigate(target: number) {
    if (!client.current || !Number.isInteger(target) || target < 1 || target > count) return;
    const seq = ++generation.current;
    setPage(target);
    setSVG("");
    setBusy(true);
    setError("");
    try {
      const result = await client.current.request({ type: "slide", index: target - 1 });
      assertCurrent();
      if (lifetime.current?.aborted || generation.current !== seq) return;
      setSVG(result.svg ?? "");
    } catch (cause) {
      if (!lifetime.current?.aborted && generation.current === seq)
        setError(cause instanceof Error ? cause.message : "此页未能打开。");
    } finally {
      if (!lifetime.current?.aborted && generation.current === seq) setBusy(false);
    }
  }

  useEffect(() => {
    if (!setFileMenu) return;
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
  }, [setFileMenu, setGrid, grid, count]);
  return (
    <>
      <PreviewToolbar label="幻灯片" detail="只读">
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
      <div className="za-preview-slides-layout">
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
}) {
  const [image, setImage] = useState<{ url: string; width: number; height: number } | null>(null);
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
          <img
            src={image.url}
            alt={name}
            className="za-preview-slide"
            style={{ width: `${image.width * scale}px` }}
            onLoad={() => {
              try {
                assertCurrent();
              } catch {
                onError("此预览已失效，请重新打开文件。");
              }
            }}
            onError={() => onError("此页未能显示，请下载原件查看。")}
          />
        </div>
      )}
    </PreviewScrollArea>
  );
}
