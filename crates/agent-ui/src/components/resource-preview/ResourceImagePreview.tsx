import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Minus from "~icons/lucide/minus";
import Plus from "~icons/lucide/plus";
import RotateCw from "~icons/lucide/rotate-cw";
import Scan from "~icons/lucide/scan";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewDock } from "./PreviewDock";
import { PreviewLoading } from "./PreviewFeedback";
import { PreviewToolbar, PreviewZoomControl } from "./PreviewToolbar";
import {
  boundImageView,
  type ImageView,
  imageViewGeometry,
  initialImageView,
  zoomImageView,
} from "./resourceImageGeometry";
import { usePreviewViewport } from "./usePreviewViewport";
import "./resource-image-preview.css";

type Props = {
  url?: string;
  document?: string;
  name: string;
  dimensions: { width: number; height: number };
  assertCurrent: () => void;
  onError: (message: string) => void;
  onCancel?: () => void;
  onViewSource?: () => void;
  thumbnail?: boolean;
};

export default function ResourceImagePreview(props: Props) {
  return props.thumbnail ? <ImageCover {...props} /> : <ImageCanvas {...props} />;
}

function ImageCanvas(props: Props) {
  const { container, viewport, sideInset } = usePreviewViewport();
  const [view, setView] = useState<ImageView>(initialImageView);
  const [ready, setReady] = useState(false);
  const [moving, setMoving] = useState(false);
  const [size, setSize] = useState(props.dimensions);
  const geometry = imageViewGeometry(
    size,
    {
      width: Math.max(0, viewport.width - sideInset - 32),
      height: Math.max(0, viewport.height - 132),
    },
    view.rotation,
  );
  const bounded = boundImageView(view, geometry);
  const scale = bounded.zoom === "fit-page" ? geometry.fit : bounded.zoom / 100;
  const latest = useRef({ view: bounded, geometry, scale, props });
  latest.current = { view: bounded, geometry, scale, props };
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ point: { x: number; y: number }; view: ImageView } | null>(null);
  const pinch = useRef<{
    distance: number;
    center: { x: number; y: number };
    view: ImageView;
    scale: number;
  } | null>(null);
  const movingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const alive = useRef(false);

  const authorized = useCallback(() => {
    try {
      latest.current.props.assertCurrent();
      return true;
    } catch {
      latest.current.props.onError("此预览已失效，请重新打开文件。");
      return false;
    }
  }, []);
  const commit = useCallback(
    (next: ImageView) => {
      if (!authorized()) return;
      const geometry = imageViewGeometry(
        latest.current.geometry.size,
        latest.current.geometry.viewport,
        next.rotation,
      );
      const bounded = boundImageView(next, geometry);
      latest.current = {
        ...latest.current,
        view: bounded,
        geometry,
        scale: bounded.zoom === "fit-page" ? geometry.fit : bounded.zoom / 100,
      };
      setView(bounded);
    },
    [authorized],
  );
  const zoom = useCallback(
    (next: ImageView["zoom"], anchor = { x: 0, y: 0 }) => {
      const current = latest.current;
      commit(zoomImageView(current.view, next, anchor, current.geometry));
    },
    [commit],
  );
  const settleMotion = useCallback(() => {
    setMoving(true);
    if (movingTimer.current) clearTimeout(movingTimer.current);
    movingTimer.current = setTimeout(() => {
      movingTimer.current = null;
      if (alive.current && !pointers.current.size) setMoving(false);
    }, 120);
  }, []);
  const loaded = useCallback(() => {
    if (!authorized()) return;
    const element = image.current;
    if (element?.naturalWidth && element.naturalHeight) {
      if (
        element.naturalWidth > 8192 ||
        element.naturalHeight > 8192 ||
        element.naturalWidth * element.naturalHeight > 16_000_000
      ) {
        latest.current.props.onError("图片尺寸不适合当前预览，请下载原件查看。");
        return;
      }
      // Natural dimensions include the decoder's orientation, unlike raw EXIF header dimensions.
      setSize({ width: element.naturalWidth, height: element.naturalHeight });
    }
    setReady(true);
  }, [authorized]);
  useLayoutEffect(() => {
    alive.current = true;
    if (image.current?.complete && image.current.naturalWidth) loaded();
    return () => {
      alive.current = false;
    };
  }, [loaded]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const anchor = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect();
      return {
        x: clientX - rect.left - 16 - latest.current.geometry.viewport.width / 2,
        y: clientY - rect.top - 64 - latest.current.geometry.viewport.height / 2,
      };
    };
    const wheel = (event: WheelEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest("button,[role=menu],input"))
      )
        return;
      const factor =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? latest.current.geometry.viewport.height
            : 1;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        settleMotion();
        zoom(
          latest.current.scale *
            Math.exp(-Math.max(-120, Math.min(120, event.deltaY * factor)) * 0.003) *
            100,
          anchor(event.clientX, event.clientY),
        );
      } else if (latest.current.scale > latest.current.geometry.fit + 0.001) {
        event.preventDefault();
        settleMotion();
        commit({
          ...latest.current.view,
          x: latest.current.view.x - (event.shiftKey ? event.deltaY : event.deltaX) * factor,
          y: latest.current.view.y - (event.shiftKey ? 0 : event.deltaY) * factor,
        });
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", wheel);
      if (movingTimer.current) clearTimeout(movingTimer.current);
      pointers.current.clear();
      drag.current = null;
      pinch.current = null;
    };
  }, [container, commit, zoom, settleMotion]);

  const point = (event: { clientX: number; clientY: number }) => {
    const rect = container.current?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0) - 16 - geometry.viewport.width / 2,
      y: event.clientY - (rect?.top ?? 0) - 64 - geometry.viewport.height / 2,
    };
  };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (!ready || (event.pointerType === "mouse" && event.button !== 0) || !authorized()) return;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, point(event));
    setMoving(true);
    const points = [...pointers.current.values()];
    if (points.length === 1) drag.current = { point: points[0], view: latest.current.view };
    else if (points.length === 2)
      pinch.current = {
        distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
        center: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 },
        view: latest.current.view,
        scale: latest.current.scale,
      };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, point(event));
    const points = [...pointers.current.values()];
    if (points.length === 2 && pinch.current && pinch.current.distance > 0) {
      const original = pinch.current;
      const scale = Math.max(
        0.01,
        Math.min(
          8,
          (original.scale * Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)) /
            original.distance,
        ),
      );
      commit({
        ...original.view,
        zoom: scale * 100,
        x:
          (points[0].x + points[1].x) / 2 -
          ((original.center.x - original.view.x) * scale) / original.scale,
        y:
          (points[0].y + points[1].y) / 2 -
          ((original.center.y - original.view.y) * scale) / original.scale,
      });
    } else if (points.length === 1 && drag.current) {
      commit({
        ...latest.current.view,
        x: drag.current.view.x + points[0].x - drag.current.point.x,
        y: drag.current.view.y + points[0].y - drag.current.point.y,
      });
    }
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    pinch.current = null;
    const remaining = [...pointers.current.values()][0];
    drag.current = remaining ? { point: remaining, view: latest.current.view } : null;
    if (!remaining) setMoving(false);
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.altKey) return;
    const current = latest.current;
    const key = event.key.toLowerCase();
    if (["+", "=", "-", "0"].includes(key)) {
      if (key === "0") commit(initialImageView);
      else zoom(current.scale * (key === "-" ? 1 / 1.25 : 1.25) * 100);
    } else if (!event.ctrlKey && !event.metaKey && key === "1") zoom(100);
    else if (!event.ctrlKey && !event.metaKey && key.startsWith("arrow")) {
      commit({
        ...current.view,
        x: current.view.x + (key === "arrowleft" ? 40 : key === "arrowright" ? -40 : 0),
        y: current.view.y + (key === "arrowup" ? 40 : key === "arrowdown" ? -40 : 0),
      });
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const transform = `translate(-50%, -50%) translate(${bounded.x}px, ${bounded.y}px) rotate(${bounded.rotation}deg)`;
  const imageStyle = { width: size.width * scale, height: size.height * scale, transform };
  return (
    <>
      <PreviewToolbar label="图像" detail={`${size.width} × ${size.height}`}>
        <PreviewZoomControl
          label="图像缩放"
          value={bounded.zoom}
          fitWidth={false}
          actualPercent={scale * 100}
          maxPercent={800}
          percentages={[25, 50, 75, 100, 150, 200, 400, 800]}
          gestures={false}
          onChange={(next) => zoom(typeof next === "number" ? next : "fit-page")}
        />
      </PreviewToolbar>
      <div
        ref={container}
        className="za-image-workspace"
        style={{ "--za-image-side-inset": `${sideInset}px` } as CSSProperties}
        data-moving={moving}
        data-ready={ready}
        data-can-pan={scale > geometry.fit + 0.001}
      >
        <div
          className="za-image-canvas"
          role="img"
          aria-label={`${props.name}，${Math.round(scale * 100)}%，可缩放和平移`}
          aria-busy={!ready}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: this named image canvas provides local zoom/pan keyboard controls.
          tabIndex={0}
          onKeyDown={keyboard}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
          onDoubleClick={(event) =>
            zoom(
              Math.abs(scale - geometry.fit) < 0.001
                ? geometry.fit < 0.99
                  ? 100
                  : 200
                : "fit-page",
              point(event),
            )
          }
        >
          {props.document ? (
            <iframe
              className="za-image-content"
              sandbox=""
              referrerPolicy="no-referrer"
              title={props.name}
              srcDoc={props.document}
              style={imageStyle}
              onLoad={loaded}
            />
          ) : (
            <img
              ref={image}
              className="za-image-content za-preview-image"
              src={props.url}
              alt={props.name}
              draggable={false}
              decoding="async"
              style={imageStyle}
              onLoad={loaded}
              onError={() => props.onError("图片未能解码，请下载原件查看。网页预览不会修改原件。")}
            />
          )}
        </div>
        {!ready ? (
          <div className="za-image-loading">
            <PreviewLoading message="正在解码图像…" onCancel={props.onCancel} />
          </div>
        ) : null}
        <div className="za-image-dock-position">
          <PreviewDock label="图像查看工具" className="za-image-tools">
            <Button
              variant="ghost"
              size="icon"
              tooltip="缩小"
              tooltipShortcut="−"
              aria-label="缩小图像"
              disabled={!ready || scale <= 0.01001}
              onClick={() => zoom((scale / 1.25) * 100)}
            >
              <Minus />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              tooltip="放大"
              tooltipShortcut="+"
              aria-label="放大图像"
              disabled={!ready || scale >= 8}
              onClick={() => zoom(scale * 1.25 * 100)}
            >
              <Plus />
            </Button>
            <span className="za-image-tool-divider" aria-hidden="true" />
            <Button
              variant="ghost"
              size="icon"
              tooltip="顺时针旋转"
              aria-label="旋转图像"
              disabled={!ready}
              onClick={() =>
                commit({ ...bounded, rotation: (bounded.rotation + 90) % 360, x: 0, y: 0 })
              }
            >
              <RotateCw />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              tooltip="重置视图"
              tooltipShortcut="0"
              aria-label="重置图像视图"
              disabled={!ready}
              onClick={() => commit(initialImageView)}
            >
              <Scan />
            </Button>
            {props.onViewSource ? (
              <Button variant="ghost" size="sm" onClick={props.onViewSource}>
                查看源码
              </Button>
            ) : null}
          </PreviewDock>
        </div>
      </div>
    </>
  );
}

function ImageCover(props: Props) {
  const [ready, setReady] = useState(false);
  const loaded = () => {
    try {
      props.assertCurrent();
      setReady(true);
    } catch {
      props.onError("此预览已失效，请重新打开文件。");
    }
  };
  return (
    <div className="za-image-cover" data-ready={ready}>
      {props.document ? (
        <iframe
          className="za-image-cover-content"
          sandbox=""
          referrerPolicy="no-referrer"
          title={props.name}
          srcDoc={props.document}
          onLoad={loaded}
        />
      ) : (
        <img
          className="za-image-cover-content"
          src={props.url}
          alt={props.name}
          draggable={false}
          onLoad={loaded}
          onError={() => props.onError("图片未能解码，请下载原件查看。")}
        />
      )}
      {!ready ? (
        <div className="za-image-loading">
          <PreviewLoading message="正在解码图像…" />
        </div>
      ) : null}
    </div>
  );
}
