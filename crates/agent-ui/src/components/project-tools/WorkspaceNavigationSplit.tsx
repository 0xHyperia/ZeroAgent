import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";

export const DEFAULT_WORKSPACE_NAVIGATION_WIDTH = 250;
const MINIMUM_WIDTH = 200;

export function workspaceNavigationWidth(width: number, containerWidth: number) {
  const maximum = Math.floor(containerWidth * 0.6);
  return Math.max(0, Math.min(maximum, Math.max(MINIMUM_WIDTH, Math.round(width))));
}

export function WorkspaceNavigationSplit({
  children,
  width,
  onWidthChange,
  onClose,
}: {
  children: ReactNode;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}) {
  const { locale, t } = useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; startX: number; startWidth: number } | null>(null);
  const [parentWidth, setParentWidth] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => setParentWidth(parent.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const shown = parentWidth ? workspaceNavigationWidth(preview ?? width, parentWidth) : width;
  const minimum = Math.min(MINIMUM_WIDTH, shown);
  const maximum = Math.max(shown, Math.floor(parentWidth * 0.6));
  return (
    <div
      ref={ref}
      data-right-workspace-tree=""
      className="relative flex min-h-0 max-w-[60%] shrink-0 flex-col border-l border-border bg-background"
      style={{ width: shown }}
    >
      {children}
      <hr
        tabIndex={0}
        aria-label={locale === "zh-CN" ? "调整文件树宽度" : "Resize file tree"}
        aria-orientation="vertical"
        aria-valuemin={minimum}
        aria-valuemax={maximum}
        aria-valuenow={shown}
        title={t("layout.resetWidthHint")}
        data-workspace-navigation-divider=""
        className={cn(
          "absolute inset-y-0 -left-px z-10 m-0 h-full w-2 cursor-col-resize touch-none border-0 outline-none before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-transparent hover:before:bg-ring/60 focus-visible:before:bg-ring",
          preview !== null && "before:bg-ring",
        )}
        onDoubleClick={() => onWidthChange(DEFAULT_WORKSPACE_NAVIGATION_WIDTH)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = { pointer: event.pointerId, startX: event.clientX, startWidth: shown };
          event.currentTarget.setPointerCapture(event.pointerId);
          setPreview(shown);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (current?.pointer !== event.pointerId) return;
          setPreview(current.startWidth + current.startX - event.clientX);
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          if (current?.pointer !== event.pointerId) return;
          drag.current = null;
          setPreview(null);
          const requested = current.startWidth + current.startX - event.clientX;
          if (requested < minimum && requested < current.startWidth) onClose();
          else if (requested !== current.startWidth)
            onWidthChange(workspaceNavigationWidth(requested, parentWidth));
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setPreview(null);
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 24 : 8;
          switch (event.key) {
            case "ArrowLeft":
              onWidthChange(Math.min(maximum, shown + step));
              break;
            case "ArrowRight":
              onWidthChange(Math.max(minimum, shown - step));
              break;
            case "Home":
              onWidthChange(minimum);
              break;
            case "End":
              onWidthChange(maximum);
              break;
            case "Enter":
              onWidthChange(DEFAULT_WORKSPACE_NAVIGATION_WIDTH);
              break;
            case "Escape": {
              if (!drag.current) return;
              event.currentTarget.releasePointerCapture(drag.current.pointer);
              break;
            }
            default:
              return;
          }
          event.preventDefault();
          event.stopPropagation();
        }}
      />
    </div>
  );
}
