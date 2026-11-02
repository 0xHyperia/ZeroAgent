import {
  createContext,
  type RefObject,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import {
  clampSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  sidebarWidthBounds,
  sidebarWidthStore,
} from "../../lib/sidebar/width";
import { LabelTooltip } from "./label-tooltip";
import "./sidebar-resize.css";

export function useSidebarWidthLayout(
  ref: RefObject<HTMLElement | null>,
  disabled = false,
  compactAt = 0,
) {
  const preferred = useSyncExternalStore(
    sidebarWidthStore.subscribe,
    sidebarWidthStore.getSnapshot,
    sidebarWidthStore.getServerSnapshot,
  );
  const [host, setHost] = useState({ width: 0, compact: false });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const compact = compactAt > 0 && window.innerWidth <= compactAt;
      setHost((current) =>
        current.width === width && current.compact === compact ? current : { width, compact },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref, compactAt]);
  const { min, max } = sidebarWidthBounds(host.width);
  return {
    width: clampSidebarWidth(preferred, max),
    min,
    max,
    enabled: !disabled && !host.compact,
  };
}

export const SidebarResizeContext = createContext<ReturnType<typeof useSidebarWidthLayout> | null>(
  null,
);

/** Sibling of the clipped navigation surface, so its hit area can straddle the boundary. */
export function SidebarResizeHandle() {
  const layout = useContext(SidebarResizeContext);
  return layout?.enabled ? <ResizeHandle layout={layout} /> : null;
}

function ResizeHandle({ layout }: { layout: ReturnType<typeof useSidebarWidthLayout> }) {
  const { t } = useLocale();
  const element = useRef<HTMLDivElement>(null);
  const latest = useRef(layout);
  latest.current = layout;
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    id: number;
    start: number;
    width: number;
    original: number;
    next: number;
    moved: boolean;
    frame: number | null;
  } | null>(null);
  const finish = useCallback((persist: boolean, unmounting = false) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    if (active.frame !== null) cancelAnimationFrame(active.frame);
    if (active.moved)
      sidebarWidthStore.set(
        persist ? clampSidebarWidth(active.next, latest.current.max) : active.original,
        persist,
      );
    if (element.current?.hasPointerCapture?.(active.id))
      element.current.releasePointerCapture(active.id);
    if (!unmounting) setDragging(false);
  }, []);
  useLayoutEffect(() => {
    if (!dragging) return;
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const hidden = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [dragging, finish]);
  useLayoutEffect(() => () => finish(false, true), [finish]);
  const reset = () =>
    sidebarWidthStore.set(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, latest.current.max), true);
  return (
    <>
      <LabelTooltip
        label={t("layout.resetWidthHint")}
        side="right"
        disabled={dragging}
        render={
          // biome-ignore lint/a11y/useSemanticElements: An adjustable separator requires pointer capture and keyboard/value semantics that hr cannot expose.
          <div
            ref={element}
            role="separator"
            tabIndex={0}
            className="sidebar-resize-handle"
            data-resizing={dragging || undefined}
            aria-label={t("sidebar.resizeWidth")}
            aria-description={t("sidebar.resizeWidthHint")}
            aria-orientation="vertical"
            aria-valuemin={layout.min}
            aria-valuemax={layout.max}
            aria-valuenow={layout.width}
            onDoubleClick={reset}
            onPointerDown={(event) => {
              if (
                event.button !== 0 ||
                drag.current ||
                event.currentTarget.closest('[inert], [aria-hidden="true"]')
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = {
                id: event.pointerId,
                start: event.clientX,
                width: latest.current.width,
                original: sidebarWidthStore.getSnapshot(),
                next: latest.current.width,
                moved: false,
                frame: null,
              };
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const active = drag.current;
              if (!active || event.pointerId !== active.id) return;
              event.preventDefault();
              active.next = clampSidebarWidth(
                active.width + event.clientX - active.start,
                latest.current.max,
              );
              if (!active.moved && Math.abs(event.clientX - active.start) < 2) return;
              active.moved = true;
              if (active.frame === null)
                active.frame = requestAnimationFrame(() => {
                  if (drag.current !== active) return;
                  active.frame = null;
                  sidebarWidthStore.set(active.next);
                });
            }}
            onPointerUp={(event) => {
              if (drag.current?.id === event.pointerId) finish(true);
            }}
            onPointerCancel={(event) => {
              if (drag.current?.id === event.pointerId) finish(false);
            }}
            onLostPointerCapture={() => finish(false)}
            onKeyDown={(event) => {
              if (drag.current || event.altKey || event.ctrlKey || event.metaKey) return;
              const step = event.shiftKey ? 40 : 10;
              const next =
                event.key === "ArrowLeft"
                  ? layout.width - step
                  : event.key === "ArrowRight"
                    ? layout.width + step
                    : event.key === "Home"
                      ? layout.min
                      : event.key === "End"
                        ? layout.max
                        : null;
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                reset();
              } else if (next !== null) {
                event.preventDefault();
                event.stopPropagation();
                sidebarWidthStore.set(clampSidebarWidth(next, layout.max), true);
              }
            }}
          />
        }
      />
      {dragging
        ? createPortal(<div className="sidebar-resize-shield" aria-hidden="true" />, document.body)
        : null}
    </>
  );
}
