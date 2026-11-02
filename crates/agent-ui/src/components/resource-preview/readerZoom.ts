export function nextReaderZoom(percent: number, delta: number, maximum = 400, minimum = 25) {
  return (
    Math.round(
      Math.max(
        minimum,
        Math.min(maximum, percent * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.003)),
      ) * 10,
    ) / 10
  );
}

/** Native non-passive listener: React's delegated wheel handler cannot cancel browser zoom. */
export function bindReaderZoom(
  element: HTMLElement,
  percent: number | (() => number),
  maximum: number,
  change: (value: number | "fit-width") => void,
  options: { capture?: boolean; readOnlyTextInput?: boolean; minimum?: number } = {},
) {
  const minimum = options.minimum ?? 25;
  const readPercent = () => (typeof percent === "function" ? percent() : percent);
  let observed = readPercent();
  let current = observed;
  const sync = () => {
    const next = readPercent();
    if (next !== observed) current = next;
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
    sync();
    pinch = { distance: distance(event), percent: current };
  };
  const move = (event: TouchEvent) => {
    if (event.touches.length !== 2 || !pinch || pinch.distance <= 0) return;
    event.preventDefault();
    current =
      Math.round(
        Math.max(minimum, Math.min(maximum, (pinch.percent * distance(event)) / pinch.distance)) *
          10,
      ) / 10;
    change(current);
  };
  const end = () => {
    pinch = null;
  };
  const wheel = (event: WheelEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    sync();
    current = nextReaderZoom(
      current,
      event.deltaY * (event.deltaMode === 1 ? 16 : 1),
      maximum,
      minimum,
    );
    change(current);
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
    sync();
    if (event.key === "0") change("fit-width");
    else {
      current = nextReaderZoom(current, event.key === "-" ? 60 : -60, maximum, minimum);
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
    element.removeEventListener("wheel", wheel, options.capture);
    element.removeEventListener("keydown", key, options.capture);
    element.removeEventListener("touchstart", start);
    element.removeEventListener("touchmove", move);
    element.removeEventListener("touchend", end);
    element.removeEventListener("touchcancel", end);
  };
}
