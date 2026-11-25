import "@liveagent/ui/i18n/namespaces/projectTools";
import {
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Minus from "~icons/lucide/minus";
import Plus from "~icons/lucide/plus";
import RotateCw from "~icons/lucide/rotate-cw";
import Scan from "~icons/lucide/scan";
import { useLocale } from "../../i18n";
import {
  Copy,
  Download,
  ExternalLink,
  Info,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  X,
} from "../IconSet";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { floatingSurfaceClassName } from "../ui/menu-surface";
import { toast } from "../ui/toast-manager";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewIdentityContext, PreviewToolbarMount } from "./PreviewChrome";
import { PreviewDock } from "./PreviewDock";
import { PreviewLoading } from "./PreviewFeedback";
import { PreviewToolbar, PreviewZoomControl } from "./PreviewToolbar";
import { nextReaderZoom } from "./readerZoom";
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
  decodedDimensions?: { width: number; height: number };
  assertCurrent: () => void;
  onError: (message: string) => void;
  onCancel?: () => void;
  onDownload?: () => void;
  onViewSource?: () => void;
  thumbnail?: boolean;
  conversation?: {
    focusArea?: { width: number; height: number; offsetY: number };
    interactiveOverlay?: boolean;
    overlay?: (style: CSSProperties, size: Props["dimensions"]) => ReactNode;
    onNavigate?: (offset: -1 | 1) => void;
  };
};

export default function ResourceImagePreview(props: Props) {
  return props.thumbnail ? <ImageCover {...props} /> : <ImageCanvas {...props} />;
}

function ImageCanvas(props: Props) {
  const { locale, t } = useLocale();
  const zh = locale === "zh-CN";
  const chrome = useContext(PreviewToolbarMount);
  const registerEscapeHandler = chrome?.registerEscapeHandler;
  const { mime, workspaceImageActions } = useContext(PreviewIdentityContext);
  const copyAbsolutePath = workspaceImageActions?.onCopyAbsolutePath;
  const copyRelativePath = workspaceImageActions?.onCopyRelativePath;
  const workspaceTab = Boolean(chrome?.workspaceTab && !props.conversation);
  const workspaceInset = props.document ? 24 : 12;
  const { container, viewport, sideInset } = usePreviewViewport();
  const [view, setView] = useState<ImageView>(initialImageView);
  const [ready, setReady] = useState(Boolean(props.decodedDimensions));
  const [moving, setMoving] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [actionsPortal, setActionsPortal] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState(props.decodedDimensions ?? props.dimensions);
  const focusArea = props.conversation?.focusArea;
  const left = focusArea ? 0 : workspaceTab ? workspaceInset : 16;
  const top = focusArea ? 0 : workspaceTab ? workspaceInset : props.conversation ? 12 : 64;
  const bottom = focusArea ? 0 : workspaceTab ? workspaceInset : props.conversation ? 12 : 68;
  const geometry = imageViewGeometry(
    size,
    {
      width: Math.max(0, viewport.width - sideInset - left * 2),
      height: Math.max(0, viewport.height - top - bottom),
    },
    view.rotation,
    focusArea,
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
  const wheelZoom = useRef<{ frame: number; percent: number; x: number; y: number } | null>(null);
  const image = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const alive = useRef(false);
  const closeInfo = useCallback(() => {
    setShowInfo(false);
    canvasRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!showInfo) return;
    return registerEscapeHandler?.(() => {
      closeInfo();
      return true;
    });
  }, [closeInfo, registerEscapeHandler, showInfo]);

  const authorized = useCallback(() => {
    try {
      latest.current.props.assertCurrent();
      return true;
    } catch {
      latest.current.props.onError("此预览已失效，请重新打开文件。");
      return false;
    }
  }, []);
  const cancelWheelZoom = useCallback(() => {
    if (!wheelZoom.current) return;
    cancelAnimationFrame(wheelZoom.current.frame);
    wheelZoom.current = null;
  }, []);
  const commit = useCallback(
    (next: ImageView) => {
      cancelWheelZoom();
      if (!authorized()) return;
      const geometry = imageViewGeometry(
        latest.current.geometry.size,
        latest.current.geometry.viewport,
        next.rotation,
        latest.current.geometry.fitArea,
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
    [authorized, cancelWheelZoom],
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
    if (!workspaceImageActions || !container.current) return;
    const element = container.current;
    let wasFullscreen = document.fullscreenElement === element;
    const onFullscreenChange = () => {
      const next = document.fullscreenElement === element;
      if (wasFullscreen && !next) canvasRef.current?.focus({ preventScroll: true });
      wasFullscreen = next;
      setFullscreen(next);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [container, workspaceImageActions]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const anchor = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect();
      return {
        x: clientX - rect.left - left - latest.current.geometry.viewport.width / 2,
        y: clientY - rect.top - top - latest.current.geometry.viewport.height / 2,
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
        wheelZoom.current = {
          frame:
            wheelZoom.current?.frame ??
            requestAnimationFrame(() => {
              const next = wheelZoom.current;
              wheelZoom.current = null;
              if (next) zoom(next.percent, anchor(next.x, next.y));
            }),
          percent: nextReaderZoom(
            wheelZoom.current?.percent ?? latest.current.scale * 100,
            event.deltaY,
            400,
            10,
            "document",
            event.deltaMode,
          ),
          x: event.clientX,
          y: event.clientY,
        };
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
      cancelWheelZoom();
      element.removeEventListener("wheel", wheel);
      if (movingTimer.current) clearTimeout(movingTimer.current);
      pointers.current.clear();
      drag.current = null;
      pinch.current = null;
    };
  }, [container, cancelWheelZoom, commit, zoom, settleMotion, left, top]);

  const point = (event: { clientX: number; clientY: number }) => {
    const rect = container.current?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0) - left - geometry.viewport.width / 2,
      y: event.clientY - (rect?.top ?? 0) - top - geometry.viewport.height / 2,
    };
  };
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (!ready || (event.pointerType === "mouse" && event.button !== 0) || !authorized()) return;
    if (event.target instanceof Element && event.target.closest("[data-image-gesture-exempt]"))
      return;
    cancelWheelZoom();
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
      if (current.scale <= current.geometry.fit + 0.001 && props.conversation?.onNavigate) {
        props.conversation.onNavigate(key === "arrowup" || key === "arrowleft" ? -1 : 1);
      } else
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
  const rotate = (direction: -1 | 1) =>
    commit({ ...bounded, rotation: bounded.rotation + direction * 90, x: 0, y: 0 });
  const reset = () => commit(initialImageView);
  const run = (action: () => void | Promise<void>, fallback: string) => {
    if (!authorized()) return;
    void (async () => {
      try {
        await action();
      } catch (error) {
        toast.error(error instanceof Error && error.message ? error.message : fallback);
      }
    })();
  };
  const toggleFullscreen = () =>
    run(
      () =>
        document.fullscreenElement === container.current
          ? document.exitFullscreen()
          : container.current?.requestFullscreen(),
      t("workspaceFilePreview.fullscreenFailed"),
    );
  const exitFullscreenLabel = t("chat.imageViewer.exitFullscreen");
  const fileImageActions =
    workspaceImageActions && !props.conversation ? workspaceImageActions : null;
  const actionsLabel = zh ? "图像操作" : "Image actions";
  const menuItem = (
    Icon: ComponentType<{ className?: string }>,
    label: string,
    action: () => void,
  ) => (
    <DropdownMenuItem onClick={action}>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {label}
    </DropdownMenuItem>
  );
  const imageCommands = (
    <>
      <DropdownMenuItem onClick={() => rotate(-1)}>
        <RotateCw className="size-4 shrink-0 -scale-x-100" aria-hidden="true" />
        {t("workspaceFilePreview.rotateLeft")}
      </DropdownMenuItem>
      {menuItem(RotateCw, t("workspaceFilePreview.rotateRight"), () => rotate(1))}
      {menuItem(Scan, t("workspaceFilePreview.resetImage"), reset)}
      {props.onViewSource &&
        menuItem(ExternalLink, zh ? "查看源码" : "View source", props.onViewSource)}
      {fileImageActions && (
        <>
          <DropdownMenuSeparator />
          {props.onDownload &&
            menuItem(Download, t("workspaceFilePreview.downloadImage"), props.onDownload)}
          {menuItem(Copy, t("workspaceFilePreview.copyImage"), () =>
            run(fileImageActions.onCopy, t("workspaceFilePreview.copyImageFailed")),
          )}
          {copyAbsolutePath &&
            menuItem(Copy, t("workspaceFilePreview.copyImageAbsolutePath"), () =>
              run(copyAbsolutePath, t("workspaceFilePreview.copyPathFailed")),
            )}
          {copyRelativePath &&
            menuItem(Copy, t("workspaceFilePreview.copyImageRelativePath"), () =>
              run(copyRelativePath, t("workspaceFilePreview.copyPathFailed")),
            )}
          {fileImageActions.onOpenInSystemViewer &&
            menuItem(ExternalLink, t("workspaceFilePreview.openInSystemImageViewer"), () => {
              if (authorized()) fileImageActions.onOpenInSystemViewer?.();
            })}
          <DropdownMenuSeparator />
          {menuItem(Info, t("workspaceFilePreview.imageInfo"), () => {
            if (authorized()) setShowInfo(true);
          })}
          {(fullscreen || container.current?.ownerDocument.fullscreenEnabled) &&
            menuItem(
              fullscreen ? Minimize2 : Maximize2,
              fullscreen ? exitFullscreenLabel : t("workspaceFilePreview.fullscreen"),
              toggleFullscreen,
            )}
        </>
      )}
    </>
  );
  const actionsMenu = (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open)
          setActionsPortal(
            actionsTrigger.current?.closest<HTMLElement>('[data-slot="sheet-popup"]') ?? null,
          );
      }}
    >
      <DropdownMenuTrigger
        ref={actionsTrigger}
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={actionsLabel}
            tooltip={actionsLabel}
            disabled={!ready}
            className="za-image-actions-trigger"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent
        align="end"
        className="za-image-actions-menu"
        portalContainer={actionsPortal ?? undefined}
      >
        {imageCommands}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const imageTools = (
    <>
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
        onClick={() => rotate(1)}
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
        onClick={reset}
      >
        <Scan />
      </Button>
      {props.onViewSource ? (
        <Button variant="ghost" size="sm" onClick={props.onViewSource}>
          查看源码
        </Button>
      ) : null}
    </>
  );
  const canvas = (
    <div
      ref={canvasRef}
      className="za-image-canvas"
      role={props.conversation?.interactiveOverlay ? "group" : "img"}
      aria-label={
        zh
          ? `${props.name}，${Math.round(scale * 100)}%，可缩放和平移`
          : `${props.name}, ${Math.round(scale * 100)}%, zoom and pan available`
      }
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
          Math.abs(scale - geometry.fit) < 0.001 ? (geometry.fit < 0.99 ? 100 : 200) : "fit-page",
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
      {ready && props.conversation?.overlay?.(imageStyle, size)}
    </div>
  );
  return (
    <>
      <PreviewToolbar label={zh ? "图像" : "Image"} detail={`${size.width} × ${size.height}`}>
        <PreviewZoomControl
          label={zh ? "图像缩放" : "Image zoom"}
          value={bounded.zoom}
          fitWidth={false}
          actualPercent={scale * 100}
          maxPercent={400}
          zoomCurve="document"
          percentages={[25, 50, 100, 150, 200]}
          gestures={false}
          onChange={(next) => zoom(typeof next === "number" ? next : "fit-page")}
        />
        {workspaceTab && actionsMenu}
      </PreviewToolbar>
      <div
        ref={container}
        className="za-image-workspace"
        style={
          {
            "--za-image-side-inset": `${sideInset}px`,
            "--za-workspace-image-inset": `${workspaceInset}px`,
          } as CSSProperties
        }
        data-moving={moving}
        data-ready={ready && (!props.decodedDimensions || viewport.width > 0)}
        data-fullscreen={fullscreen || undefined}
        data-can-pan={scale > geometry.fit + 0.001}
        data-conversation-image={props.conversation ? "" : undefined}
        data-workspace-image={workspaceTab ? (props.document ? "svg" : "raster") : undefined}
      >
        {fileImageActions ? (
          <ContextMenu
            disabled={!ready}
            onOpenChange={(open) => {
              if (open)
                setActionsPortal(
                  canvasRef.current?.closest<HTMLElement>('[data-slot="sheet-popup"]') ?? null,
                );
            }}
          >
            <ContextMenuTrigger render={canvas} />
            <ContextMenuContent
              className="za-image-actions-menu"
              portalContainer={(fullscreen ? container.current : actionsPortal) ?? undefined}
            >
              {imageCommands}
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          canvas
        )}
        {fullscreen && (
          <Button
            variant="ghost"
            size="icon"
            className="za-image-exit-fullscreen"
            aria-label={exitFullscreenLabel}
            tooltip={exitFullscreenLabel}
            onClick={toggleFullscreen}
          >
            <Minimize2 className="size-4" aria-hidden="true" />
          </Button>
        )}
        {showInfo && fileImageActions && (
          <aside
            aria-label={t("workspaceFilePreview.imageInfo")}
            className={`za-image-info absolute right-3 top-3 z-10 w-64 max-w-[calc(100%-1.5rem)] p-3 text-xs ${floatingSurfaceClassName}`}
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{t("workspaceFilePreview.imageInfo")}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                tooltip={t("workspaceFilePreview.close")}
                aria-label={t("workspaceFilePreview.close")}
                onClick={closeInfo}
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-muted-foreground">
              <dt>{t("workspaceFilePreview.fileName")}</dt>
              <dd className="truncate text-right text-foreground">{props.name}</dd>
              <dt>{t("workspaceFilePreview.dimensions")}</dt>
              <dd className="text-right text-foreground">
                {size.width} × {size.height}
              </dd>
              <dt>{t("workspaceFilePreview.fileSize")}</dt>
              <dd className="text-right text-foreground">
                {new Intl.NumberFormat(zh ? "zh-CN" : "en", { style: "unit", unit: "byte" }).format(
                  fileImageActions.sizeBytes,
                )}
              </dd>
              <dt>{t("workspaceFilePreview.fileType")}</dt>
              <dd className="truncate text-right text-foreground">{mime}</dd>
            </dl>
          </aside>
        )}
        {!ready ? (
          <div className="za-image-loading">
            <PreviewLoading
              message="正在解码图像…"
              onCancel={props.onCancel}
              skeleton={workspaceTab ? "media" : undefined}
            />
          </div>
        ) : null}
        {!props.conversation && !workspaceTab && (
          <div className="za-image-dock-position">
            <PreviewDock label="图像查看工具" className="za-image-tools">
              {imageTools}
              {fileImageActions && actionsMenu}
            </PreviewDock>
          </div>
        )}
      </div>
    </>
  );
}

function ImageCover(props: Props) {
  const { container, viewport } = usePreviewViewport();
  const scale = Math.min(
    (viewport.width || 168) / props.dimensions.width,
    (viewport.height || 100) / props.dimensions.height,
  );
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
    <div ref={container} className="za-image-cover" data-ready={ready}>
      {props.document ? (
        <iframe
          className="za-image-cover-content"
          sandbox=""
          referrerPolicy="no-referrer"
          title={props.name}
          srcDoc={props.document}
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: props.dimensions.width,
            height: props.dimensions.height,
            maxWidth: "none",
            transform: `translate(-50%, -50%) scale(${scale})`,
          }}
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
