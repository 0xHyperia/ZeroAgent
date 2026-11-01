import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export function constrainReaderPosition(
  point: { x: number; y: number },
  bounds: { width: number; height: number },
  size: { width: number; height: number },
) {
  return {
    x: Math.max(8, Math.min(point.x, bounds.width - size.width - 8)),
    y: Math.max(64, Math.min(point.y, bounds.height - size.height - 8)),
  };
}

export function useReaderFloatingPosition(visible: boolean) {
  const root = useRef<HTMLFieldSetElement>(null),
    bar = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const constrain = useCallback((point: { x: number; y: number }) => {
    const bounds = root.current?.getBoundingClientRect(),
      size = bar.current?.getBoundingClientRect();
    return bounds && size ? constrainReaderPosition(point, bounds, size) : point;
  }, []);
  useEffect(() => {
    if (!visible || !root.current) return;
    const observer = new ResizeObserver(() => setPosition((old) => (old ? constrain(old) : old)));
    observer.observe(root.current);
    if (bar.current) observer.observe(bar.current);
    return () => observer.disconnect();
  }, [visible, constrain]);
  const origin = () => {
    const bounds = root.current?.getBoundingClientRect(),
      rect = bar.current?.getBoundingClientRect();
    return bounds && rect
      ? { x: rect.left - bounds.left, y: rect.top - bounds.top }
      : { x: 8, y: 64 };
  };
  return {
    root,
    bar,
    style: position
      ? ({ left: position.x, top: position.y, bottom: "auto", transform: "none" } as CSSProperties)
      : undefined,
    handle: {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (event.button !== 0) return;
        event.preventDefault();
        const start = origin();
        drag.current = {
          id: event.pointerId,
          x: event.clientX - start.x,
          y: event.clientY - start.y,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const start = drag.current;
        if (start?.id === event.pointerId)
          setPosition(constrain({ x: event.clientX - start.x, y: event.clientY - start.y }));
      },
      onPointerUp() {
        drag.current = null;
      },
      onPointerCancel() {
        drag.current = null;
      },
      onLostPointerCapture() {
        drag.current = null;
      },
      onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const start = origin(),
          step = event.shiftKey ? 24 : 8;
        setPosition(
          constrain({
            x:
              start.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
            y: start.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
          }),
        );
      },
    },
  };
}
