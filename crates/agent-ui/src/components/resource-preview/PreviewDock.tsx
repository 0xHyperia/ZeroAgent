import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import { GripVertical } from "../IconSet";
import "./preview-dock.css";

/** Quiet floating transport/tools surface shared by image and media readers. */
export function PreviewDock({
  label,
  className = "",
  draggable = false,
  children,
}: {
  label: string;
  className?: string;
  draggable?: boolean;
  children: ReactNode;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const dock = useRef<HTMLFieldSetElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const detached = draggable && position !== undefined;
  const place = useCallback((x: number, y: number) => {
    if (!dock.current) return;
    const { width, height } = dock.current.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(window.innerWidth - width - 8, x)),
      y: Math.max(48, Math.min(window.innerHeight - height - 8, y)),
    });
  }, []);
  useEffect(() => {
    if (!draggable) return;
    const move = (event: PointerEvent) => {
      const start = drag.current;
      if (start?.pointer === event.pointerId) {
        place(event.clientX - start.x, event.clientY - start.y);
      }
    };
    const stop = (event: PointerEvent) => {
      if (drag.current?.pointer === event.pointerId) drag.current = null;
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", stop, true);
    document.addEventListener("pointercancel", stop, true);
    return () => {
      drag.current = null;
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", stop, true);
      document.removeEventListener("pointercancel", stop, true);
    };
  }, [draggable, place]);
  useEffect(() => {
    if (!detached || !dock.current) return;
    const element = dock.current;
    const observer = new ResizeObserver(() => {
      setPosition((old) => {
        if (!old) return old;
        const x = Math.max(8, Math.min(old.x, window.innerWidth - element.offsetWidth - 8));
        const y = Math.max(48, Math.min(old.y, window.innerHeight - element.offsetHeight - 8));
        return old.x === x && old.y === y ? old : { x, y };
      });
    });
    observer.observe(document.documentElement);
    observer.observe(element);
    return () => observer.disconnect();
  }, [detached]);
  const gripLabel = zh
    ? "移动工具条。使用方向键移动，Home 恢复原位"
    : "Move toolbar. Use arrow keys to move or Home to reset";
  return (
    <fieldset
      ref={dock}
      className={`za-preview-dock ${className}`}
      aria-label={label}
      data-detached={detached ? "" : undefined}
      style={draggable && position ? { left: position.x, top: position.y } : undefined}
    >
      {draggable && (
        <button
          className="za-preview-dock-grip"
          type="button"
          aria-label={gripLabel}
          title={gripLabel}
          onDoubleClick={() => setPosition(undefined)}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary || !dock.current) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            const rect = dock.current.getBoundingClientRect();
            drag.current = {
              pointer: event.pointerId,
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onLostPointerCapture={(event) => {
            if (event.buttons === 0) drag.current = null;
          }}
          onKeyDown={(event) => {
            if (!dock.current || !/^(Home|Arrow(Up|Down|Left|Right))$/.test(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Home") {
              setPosition(undefined);
              return;
            }
            const { left, top } = dock.current.getBoundingClientRect();
            const step = event.shiftKey ? 36 : 12;
            place(
              left + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
              top + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
            );
          }}
        >
          <GripVertical aria-hidden="true" />
        </button>
      )}
      {children}
    </fieldset>
  );
}
