import { useEffect, useRef, useState } from "react";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
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
  const [maxPercent, setMaxPercent] = useState<number>();
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

  return (
    <>
      <PreviewToolbar label="幻灯片" detail="只读">
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
        />
      </PreviewToolbar>
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
      />
      <p className="za-preview-caption">静态预览；特殊字体、动画和嵌入对象请用原应用查看。</p>
    </>
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
}) {
  const [image, setImage] = useState<{ url: string; width: number; height: number } | null>(null);
  const { container, viewport } = usePreviewViewport<HTMLElement>();
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
  return (
    <section
      ref={container}
      className="za-preview-slide-scroll"
      aria-label="幻灯片阅读画布"
      aria-busy={busy}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: focus scopes page shortcuts to this reading canvas
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
    </section>
  );
}
