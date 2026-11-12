import { Minus, Plus } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  fitMermaidViewBox,
  formatMermaidViewBox,
  type MermaidPoint,
  type MermaidViewBox,
  mermaidZoomAnchor,
  panMermaidViewBox,
  parseMermaidViewBox,
  zoomMermaidViewBox,
} from "../../lib/mermaidViewBox";
import { TooltipButton } from "../ui/tooltip-button";
import { useMermaidConfig } from "./MermaidTheme";
import { renderMermaid } from "./mermaidRenderer";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const CANVAS_PADDING = 16;
type Viewport = { zoom: number; viewBox: MermaidViewBox };

export function useMermaidSvg(chart: string, id: string, enabled: boolean) {
  const config = useMermaidConfig();
  const [result, setResult] = useState<{
    chart: string;
    background: string;
    svg?: string;
    error?: true;
  }>();
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const background = String(config.themeVariables?.background ?? "#ffffff");
    void renderMermaid(id, chart, config)
      .then((svg) => {
        if (current && svg) setResult({ chart, svg, background });
      })
      .catch(() => {
        if (current) setResult({ chart, background, error: true });
      });
    return () => {
      current = false;
    };
  }, [chart, config, enabled, id]);
  return enabled && result?.chart === chart ? result : undefined;
}

function midpoint(a: MermaidPoint, b: MermaidPoint) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: MermaidPoint, b: MermaidPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function MermaidDiagram({ svg, fullscreen = false }: { svg: string; fullscreen?: boolean }) {
  const { t } = useLocale();
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgHostRef = useRef<HTMLDivElement>(null);
  const original = useRef<MermaidViewBox | null>(null);
  const diagramBounds = useRef<MermaidViewBox | null>(null);
  const pointers = useRef(new Map<number, MermaidPoint>());
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const host = svgHostRef.current;
    if (!host) return;
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
    const viewBox = parseMermaidViewBox(parsed.getAttribute("viewBox"));
    if (!viewBox) return;
    const element = document.importNode(parsed, true);
    element.setAttribute("preserveAspectRatio", "xMidYMid meet");
    element.setAttribute("width", "100%");
    element.setAttribute("height", "100%");
    element.style.cssText = "width:100%;height:100%;max-width:none;display:block";
    host.replaceChildren(element);
    if (!fullscreen) {
      host.style.aspectRatio = `${viewBox.width} / ${viewBox.height}`;
      host.style.setProperty("--mermaid-width", `${viewBox.width}px`);
      host.style.setProperty("--mermaid-ratio", String(viewBox.width / viewBox.height));
      host.toggleAttribute("data-wide", viewBox.width >= 720);
      return;
    }
    const previousBounds = diagramBounds.current;
    const sameDiagram =
      previousBounds?.x === viewBox.x &&
      previousBounds.y === viewBox.y &&
      previousBounds.width === viewBox.width &&
      previousBounds.height === viewBox.height;
    diagramBounds.current = viewBox;
    const resize = (preservePosition: boolean) => {
      const fitted = fitMermaidViewBox(
        viewBox,
        { width: host.clientWidth, height: host.clientHeight },
        CANVAS_PADDING,
      );
      original.current = fitted;
      setViewport((previous) => {
        const zoom = preservePosition ? (previous?.zoom ?? 1) : 1;
        const next = zoomMermaidViewBox(fitted, zoom);
        if (previous && zoom > 1) {
          // Keep the center of the part being read on viewport resize or a theme swap.
          next.x = previous.viewBox.x + (previous.viewBox.width - next.width) / 2;
          next.y = previous.viewBox.y + (previous.viewBox.height - next.height) / 2;
        }
        return { zoom, viewBox: next };
      });
    };
    resize(sameDiagram);
    const observer = new ResizeObserver(() => resize(true));
    observer.observe(host);
    return () => observer.disconnect();
  }, [svg, fullscreen]);

  useLayoutEffect(() => {
    if (viewport)
      svgHostRef.current?.firstElementChild?.setAttribute(
        "viewBox",
        formatMermaidViewBox(viewport.viewBox),
      );
  }, [viewport]);

  const updateZoom = useCallback((factor: number, point?: MermaidPoint, pan?: MermaidPoint) => {
    const rect = svgHostRef.current?.getBoundingClientRect();
    if (!rect) return;
    setViewport((current) => {
      if (!current) return current;
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom * factor));
      if (zoom <= 1 && original.current) {
        return { zoom, viewBox: zoomMermaidViewBox(original.current, zoom) };
      }
      const anchor =
        point &&
        mermaidZoomAnchor(current.viewBox, { x: point.x - rect.left, y: point.y - rect.top }, rect);
      const zoomed = zoomMermaidViewBox(current.viewBox, zoom / current.zoom, anchor);
      return { zoom, viewBox: pan ? panMermaidViewBox(zoomed, pan, rect) : zoomed };
    });
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !fullscreen) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      event.stopPropagation();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      updateZoom(Math.exp(-delta * 0.003), { x: event.clientX, y: event.clientY });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [fullscreen, updateZoom]);

  const zoom = viewport?.zoom ?? 1;
  return (
    <div className="za-mermaid-view" data-fullscreen={fullscreen || undefined}>
      <div
        ref={viewportRef}
        className="za-mermaid-canvas"
        data-pannable={(fullscreen && zoom > 1) || undefined}
        data-dragging={dragging || undefined}
        data-liveagent-mermaid-viewport=""
        onPointerDown={(event) => {
          if (!fullscreen || event.button !== 0 || pointers.current.size >= 2) return;
          if (event.pointerType !== "touch" && zoom <= 1) return;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(zoom > 1);
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous) return;
          const next = { x: event.clientX, y: event.clientY };
          pointers.current.set(event.pointerId, next);
          const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
          if (other) {
            const start = midpoint(previous, other);
            const end = midpoint(next, other);
            updateZoom(distance(next, other) / Math.max(distance(previous, other), 1), start, {
              x: end.x - start.x,
              y: end.y - start.y,
            });
          } else if (zoom > 1) {
            setDragging(true);
            updateZoom(1, undefined, { x: next.x - previous.x, y: next.y - previous.y });
          }
        }}
        onLostPointerCapture={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size === 0) setDragging(false);
        }}
      >
        <div
          ref={svgHostRef}
          data-streamdown={fullscreen ? undefined : "mermaid"}
          className="za-mermaid-svg"
          role="img"
          aria-label={t("chat.markdown.mermaidDiagram")}
        />
      </div>
      {fullscreen && (
        <div className="za-mermaid-zoom">
          <TooltipButton
            size="icon-sm"
            variant="ghost"
            className="za-mermaid-zoom-step"
            tooltip={t("chat.imageViewer.zoomOut")}
            aria-label={t("chat.imageViewer.zoomOut")}
            disabled={zoom <= MIN_ZOOM}
            onClick={() => updateZoom(1 / 1.25)}
          >
            <Minus className="size-4" />
          </TooltipButton>
          <TooltipButton
            variant="ghost"
            className="za-mermaid-zoom-ratio"
            tooltip={t("chat.imageViewer.reset")}
            aria-label={`${Math.round(zoom * 100)}% · ${t("chat.imageViewer.reset")}`}
            onClick={() => {
              if (original.current) setViewport({ zoom: 1, viewBox: original.current });
            }}
          >
            {Math.round(zoom * 100)}%
          </TooltipButton>
          <TooltipButton
            size="icon-sm"
            variant="ghost"
            className="za-mermaid-zoom-step"
            tooltip={t("chat.imageViewer.zoomIn")}
            aria-label={t("chat.imageViewer.zoomIn")}
            disabled={zoom >= MAX_ZOOM}
            onClick={() => updateZoom(1.25)}
          >
            <Plus className="size-4" />
          </TooltipButton>
        </div>
      )}
    </div>
  );
}
