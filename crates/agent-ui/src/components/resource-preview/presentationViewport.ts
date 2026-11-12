import { type RefObject, useLayoutEffect, useRef } from "react";

export type PresentationZoomAnchor = { x: number; y: number };
type Size = { width: number; height: number };
export type PresentationCamera = PresentationZoomAnchor & { scale: number };

/** PowerPoint uses the original slide frame throughout both presentation views. */
export function presentationGridGeometry(count: number, slide: Size) {
  const columns = Math.min(4, Math.max(1, count));
  const rows = Math.ceil(count / columns);
  const gap = 120;
  const labelHeight = 72;
  return {
    columns,
    gap,
    labelHeight,
    width: columns * slide.width + (columns - 1) * gap,
    height: rows * (slide.height + labelHeight) + Math.max(0, rows - 1) * gap,
  };
}

export function presentationGridSlideCenter(
  page: number,
  slide: Size,
  grid: ReturnType<typeof presentationGridGeometry>,
) {
  const index = page - 1;
  return {
    x: (index % grid.columns) * (slide.width + grid.gap) + slide.width / 2,
    y:
      Math.floor(index / grid.columns) * (slide.height + grid.labelHeight + grid.gap) +
      grid.labelHeight +
      slide.height / 2,
  };
}

export function centerPresentationCamera(
  view: Size,
  point: PresentationZoomAnchor,
  scale: number,
  topInset = 0,
  leftInset = 0,
): PresentationCamera {
  return {
    x: (view.width + leftInset) / 2 - point.x * scale,
    y: (view.height + topInset) / 2 - point.y * scale,
    scale,
  };
}

export function animatePresentationCamera(
  from: PresentationCamera,
  to: PresentationCamera,
  anchor: PresentationZoomAnchor,
  draw: (value: PresentationCamera, progress: number) => void,
  done?: () => void,
) {
  const duration = 260;
  let start: number | undefined;
  let frame = requestAnimationFrame(tick);
  function tick(time: number) {
    start ??= time;
    const progress = Math.max(0, Math.min(1, (time - start) / duration));
    const eased = 1 - (1 - progress) ** 3;
    const scale = from.scale * (to.scale / from.scale) ** eased;
    const offset = (key: "x" | "y") =>
      (from[key] + anchor[key] * from.scale) * (1 - eased) +
      (to[key] + anchor[key] * to.scale) * eased -
      anchor[key] * scale;
    draw({ x: offset("x"), y: offset("y"), scale }, eased);
    if (progress < 1) frame = requestAnimationFrame(tick);
    else done?.();
  }
  return () => cancelAnimationFrame(frame);
}

export function bindPresentationPageWheel(
  element: HTMLElement,
  fits: () => boolean,
  advance: (direction: number) => void,
) {
  let lastEvent = -Infinity;
  let lastPage = -Infinity;
  let direction = 0;
  let accumulated = 0;
  const wheel = (event: WheelEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    if (
      !fits() ||
      (event.target instanceof Element && event.target.closest("input,textarea,form,[role=menu]"))
    ) {
      accumulated = 0;
      return;
    }
    if (event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    const delta =
      event.deltaY *
      (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
    if (event.timeStamp - lastEvent >= 200 || direction !== Math.sign(delta)) {
      accumulated = 0;
      lastPage = -Infinity;
    }
    lastEvent = event.timeStamp;
    direction = Math.sign(delta);
    accumulated += delta;
    if (Math.abs(accumulated) < 40 || event.timeStamp - lastPage < 200) return;
    accumulated = 0;
    lastPage = event.timeStamp;
    advance(direction);
  };
  element.addEventListener("wheel", wheel, { passive: false });
  return () => element.removeEventListener("wheel", wheel);
}

export function usePresentationPlane(
  container: RefObject<HTMLDivElement | null>,
  viewport: Size,
  scene: Size,
  fitInsets: { left: number; top: number },
  anchor?: RefObject<PresentationZoomAnchor | null>,
) {
  const { width, height } = scene;
  const left = Math.max(0, (viewport.width + fitInsets.left - width) / 2);
  const top = Math.max(0, (viewport.height + fitInsets.top - height) / 2);
  const previous = useRef<{
    width: number;
    height: number;
    left: number;
    top: number;
    viewport: Size;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element || !viewport.width || !viewport.height || !width || !height) return;
    const before = previous.current;
    const pointer = anchor?.current;
    if (anchor) anchor.current = null;
    const rect = element.getBoundingClientRect();
    const x = pointer ? pointer.x - rect.left : viewport.width / 2;
    const y = pointer ? pointer.y - rect.top : viewport.height / 2;
    const relativeX = before
      ? (before.scrollLeft + (pointer ? x : before.viewport.width / 2) - before.left) / before.width
      : 0.5;
    const relativeY = before
      ? (before.scrollTop + (pointer ? y : before.viewport.height / 2) - before.top) / before.height
      : 0.5;
    element.scrollLeft = left + relativeX * width - x;
    element.scrollTop = top + relativeY * height - y;
    const current = {
      width,
      height,
      left,
      top,
      viewport,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
    };
    previous.current = current;
    const remember = () => {
      current.scrollLeft = element.scrollLeft;
      current.scrollTop = element.scrollTop;
    };
    element.addEventListener("scroll", remember, { passive: true });
    return () => element.removeEventListener("scroll", remember);
  }, [anchor, container, height, left, top, viewport, width]);

  return {
    width: Math.max(viewport.width, left + width),
    height: Math.max(viewport.height, top + height),
    left,
    top,
  };
}

export function usePresentationPan(container: RefObject<HTMLDivElement | null>, primary: boolean) {
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    let pointer: { id: number; x: number; y: number; left: number; top: number } | null = null;
    let dragging = false;
    let suppressClick = false;

    function start(event: PointerEvent) {
      suppressClick = false;
      if (
        event.pointerType !== "mouse" ||
        !(event.button === 1 || (primary && event.button === 0)) ||
        !element ||
        (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)
      )
        return;
      if (event.button === 1) event.preventDefault();
      pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: element.scrollLeft,
        top: element.scrollTop,
      };
    }
    function move(event: PointerEvent) {
      if (!element || pointer?.id !== event.pointerId) return;
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      if (!dragging) {
        if (Math.hypot(dx, dy) < 5) return;
        dragging = true;
        element.setPointerCapture(event.pointerId);
        element.dataset.panning = "";
      }
      event.preventDefault();
      element.scrollLeft = pointer.left - dx;
      element.scrollTop = pointer.top - dy;
    }
    function finish(event: PointerEvent) {
      if (pointer?.id !== event.pointerId || (event.type === "pointerleave" && dragging)) return;
      suppressClick = dragging && event.type === "pointerup";
      pointer = null;
      dragging = false;
      if (element) delete element.dataset.panning;
    }
    function click(event: MouseEvent) {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    element.addEventListener("pointerdown", start);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", finish);
    element.addEventListener("pointercancel", finish);
    element.addEventListener("pointerleave", finish);
    element.addEventListener("lostpointercapture", finish);
    element.addEventListener("click", click, true);
    return () => {
      element.removeEventListener("pointerdown", start);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", finish);
      element.removeEventListener("pointercancel", finish);
      element.removeEventListener("pointerleave", finish);
      element.removeEventListener("lostpointercapture", finish);
      element.removeEventListener("click", click, true);
    };
  }, [container, primary]);
}
