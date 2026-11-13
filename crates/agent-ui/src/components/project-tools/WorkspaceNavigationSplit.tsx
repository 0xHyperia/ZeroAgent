import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useIsMobile } from "../../hooks/use-mobile";
import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";
import { X } from "../IconSet";
import { Button } from "../ui/button";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet";

export const DEFAULT_WORKSPACE_NAVIGATION_WIDTH = 250;
const MINIMUM_WIDTH = 200;
// The stacked header, filter, Git controls and one touch row need nearly 280px.
const STACKED_FILE_TREE_MIN_HEIGHT = 288;

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
  children: (compactFilter: boolean) => ReactNode;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
}) {
  const { locale, t } = useLocale();
  const mobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; startX: number; startWidth: number } | null>(null);
  const [parentWidth, setParentWidth] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null);
  const [compactFilter, setCompactFilter] = useState(false);
  useLayoutEffect(() => {
    if (!sheet) return;
    const observer = new ResizeObserver(([{ contentRect }]) => {
      setCompactFilter(
        sheet.ownerDocument.documentElement.dataset.zeroagentKeyboard === "open" &&
          contentRect.height < STACKED_FILE_TREE_MIN_HEIGHT,
      );
    });
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [sheet]);

  useLayoutEffect(() => {
    if (mobile) return;
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => setParentWidth(parent.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [mobile]);

  if (mobile) {
    const title = t("projectTools.fileTreeTitle");
    const closeLabel = locale === "zh-CN" ? "关闭文件树" : "Close file tree";
    return (
      <Sheet
        open
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <SheetContent
          ref={setSheet}
          data-browser-back-surface=""
          data-right-workspace-tree=""
          data-workspace-tree-compact-filter={compactFilter || undefined}
          className="w-full max-w-none border-0 p-0 pt-[var(--zeroagent-safe-area-top,0px)] pr-[var(--zeroagent-safe-area-right,0px)] pb-[var(--zeroagent-safe-area-bottom,0px)] pl-[var(--zeroagent-safe-area-left,0px)]"
          showCloseButton={false}
          aria-describedby={undefined}
        >
          <div
            data-workspace-tree-header=""
            className="flex shrink-0 items-center justify-between border-b border-border px-3"
          >
            <SheetTitle className={cn("text-sm", compactFilter && "sr-only")}>{title}</SheetTitle>
            <Button
              variant="ghost"
              size="icon"
              className="size-11"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>
          {children(compactFilter)}
        </SheetContent>
      </Sheet>
    );
  }

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
      {children(false)}
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
