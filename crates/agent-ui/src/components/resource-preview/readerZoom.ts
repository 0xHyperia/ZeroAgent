export type ReaderZoomCurve = "document" | "pdf" | "camera" | "text";

export function nextReaderZoom(
  percent: number,
  delta: number,
  maximum = 400,
  minimum = 25,
  curve: ReaderZoomCurve = "text",
  deltaMode = 0,
) {
  const factor =
    curve === "camera"
      ? 2 **
        Math.max(-1, Math.min(1, -delta * (deltaMode === 1 ? 0.5 : deltaMode === 2 ? 10 : 0.02)))
      : Math.exp(
          curve === "pdf"
            ? -0.005 * Math.max(-20, Math.min(20, delta))
            : -(curve === "document" ? 0.01 : 0.003) *
                Math.max(-100, Math.min(100, delta * (deltaMode === 1 ? 16 : 1))),
        );
  return Math.max(minimum, Math.min(maximum, percent * factor));
}

/** Native non-passive listener: React's delegated wheel handler cannot cancel browser zoom. */
export function bindReaderZoom(
  element: HTMLElement,
  percent: number | (() => number),
  maximum: number,
  change: (value: number | "fit-width") => void,
  options: {
    capture?: boolean;
    readOnlyTextInput?: boolean;
    minimum?: number;
    curve?: ReaderZoomCurve;
    frameUpdates?: boolean;
    snap?: readonly number[];
    onAnchor?: (x: number, y: number) => void;
  } = {},
) {
  const minimum = options.minimum ?? 25;
  const readPercent = () => (typeof percent === "function" ? percent() : percent);
  let observed = readPercent();
  let current = observed;
  let lastInput = -Infinity;
  let frame: number | null = null;
  let pending: { value: number; x: number; y: number } | null = null;
  function cancelFrame() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pending = null;
  }
  function emit(value: number, x: number, y: number) {
    const displayed = options.snap?.find((stop) => Math.abs(value - stop) <= 0.02 * stop) ?? value;
    if (!options.frameUpdates) {
      options.onAnchor?.(x, y);
      change(displayed);
      return;
    }
    pending = { value: displayed, x, y };
    frame ??= requestAnimationFrame(() => {
      frame = null;
      const next = pending;
      pending = null;
      if (!next || next.value === readPercent()) return;
      options.onAnchor?.(next.x, next.y);
      change(next.value);
    });
  }
  const sync = () => {
    const next = readPercent();
    if (next !== observed && !options.snap) current = next;
    observed = next;
  };
  let pinch: { distance: number; percent: number } | null = null;
  const distance = (event: TouchEvent) =>
    Math.hypot(
      event.touches[0].clientX - event.touches[1].clientX,
      event.touches[0].clientY - event.touches[1].clientY,
    );
  const start = (event: TouchEvent) => {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    cancelFrame();
    current = readPercent();
    pinch = { distance: distance(event), percent: current };
  };
  const move = (event: TouchEvent) => {
    if (event.touches.length !== 2 || !pinch || pinch.distance <= 0) return;
    event.preventDefault();
    const next =
      Math.round(
        Math.max(minimum, Math.min(maximum, (pinch.percent * distance(event)) / pinch.distance)) *
          10,
      ) / 10;
    if (next !== current)
      emit(
        next,
        (event.touches[0].clientX + event.touches[1].clientX) / 2,
        (event.touches[0].clientY + event.touches[1].clientY) / 2,
      );
    current = next;
  };
  const end = () => {
    pinch = null;
  };
  const wheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    sync();
    if (options.snap && event.timeStamp - lastInput >= 200) current = readPercent();
    lastInput = event.timeStamp;
    const next = nextReaderZoom(
      current,
      event.deltaY,
      maximum,
      minimum,
      options.curve,
      event.deltaMode,
    );
    if (next !== current) emit(next, event.clientX, event.clientY);
    current = next;
  };
  const key = (event: KeyboardEvent) => {
    if (
      !(event.ctrlKey || event.metaKey) ||
      event.altKey ||
      event.defaultPrevented ||
      !["+", "=", "-", "0"].includes(event.key)
    )
      return;
    if (
      event.target instanceof Element &&
      event.target.closest("input,textarea,[contenteditable=true]") &&
      !(options.readOnlyTextInput && event.target.closest("textarea[readonly]"))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    cancelFrame();
    current = readPercent();
    if (event.key === "0") change("fit-width");
    else {
      const stops = options.snap;
      const out = event.key === "-";
      current = stops
        ? out
          ? Math.max(minimum, ...stops.filter((stop) => stop < current))
          : (stops.find((stop) => stop > current) ?? maximum)
        : nextReaderZoom(current, out ? 60 : -60, maximum, minimum);
      change(current);
    }
  };
  element.addEventListener("wheel", wheel, { passive: false, capture: options.capture });
  element.addEventListener("keydown", key, options.capture);
  element.addEventListener("touchstart", start, { passive: false });
  element.addEventListener("touchmove", move, { passive: false });
  element.addEventListener("touchend", end);
  element.addEventListener("touchcancel", end);
  return () => {
    cancelFrame();
    element.removeEventListener("wheel", wheel, options.capture);
    element.removeEventListener("keydown", key, options.capture);
    element.removeEventListener("touchstart", start);
    element.removeEventListener("touchmove", move);
    element.removeEventListener("touchend", end);
    element.removeEventListener("touchcancel", end);
  };
}
