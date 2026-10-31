import { Maximize2, Minimize2, X } from "@liveagent/ui/components/IconSet";
import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "@liveagent/ui/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@liveagent/ui/components/ui/tooltip";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  type CloudResourceDragIdentity,
  writeCloudResourceDragPayload,
} from "@/lib/cloudResourceDrag";
import { CloudChatReaderLayout } from "./CloudChatResourceWorkbench";

export const CloudChatResourcePresentation = createContext<"panel" | "page" | "inline">("panel");

export function CloudChatResourcePanel(props: {
  title: ReactNode;
  description: string;
  closeLabel?: string;
  wide?: boolean;
  headerActions?: ReactNode;
  subtitle?: ReactNode;
  className?: string;
  dragResource?: CloudResourceDragIdentity;
  onClose: () => void;
  children: ReactNode;
}) {
  const presentation = useContext(CloudChatResourcePresentation);
  const readerLayout = useContext(CloudChatReaderLayout);
  const titleId = useId();
  const reader = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (presentation !== "inline") return;
    const previous = document.activeElement;
    const element = reader.current;
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      const shouldRestore =
        document.activeElement === document.body || element?.contains(document.activeElement);
      if (shouldRestore && previous instanceof HTMLElement) {
        requestAnimationFrame(() => {
          if (
            (document.activeElement === document.body ||
              element?.contains(document.activeElement)) &&
            previous.isConnected &&
            !previous.closest("[inert]")
          )
            previous.focus({ preventScroll: true });
        });
      }
    };
  }, [presentation]);
  const [compact, setCompact] = useState(
    () =>
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(max-width: 1099px)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 1099px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  if (presentation === "inline") {
    return (
      <section
        ref={reader}
        aria-labelledby={titleId}
        data-cloud-resource-panel=""
        data-cloud-resource-inline=""
        className={`cloud-resource-reader ${props.className ?? ""}`}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            if (readerLayout?.expanded) readerLayout.toggleExpanded();
            else props.onClose();
          }
        }}
      >
        <header className="cloud-reader-header">
          <div className="cloud-reader-heading">
            {props.dragResource ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <h2
                      id={titleId}
                      className="cloud-reader-draggable-title"
                      draggable
                      onDragStart={(event) => {
                        if (
                          !props.dragResource ||
                          !writeCloudResourceDragPayload(event.dataTransfer, [props.dragResource])
                        )
                          event.preventDefault();
                      }}
                    >
                      {props.title}
                    </h2>
                  }
                />
                <TooltipContent side="bottom">拖到对话中引用；也可使用“引用”按钮</TooltipContent>
              </Tooltip>
            ) : (
              <h2 id={titleId} title={typeof props.title === "string" ? props.title : undefined}>
                {props.title}
              </h2>
            )}
            <div className="cloud-reader-subtitle">{props.subtitle ?? props.description}</div>
          </div>
          <div className="cloud-reader-actions">{props.headerActions}</div>
          <div className="cloud-reader-window-actions">
            {readerLayout?.canSplit ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={readerLayout.expanded ? "恢复并排阅读" : "展开阅读"}
                title={readerLayout.expanded ? "恢复并排阅读" : "展开阅读"}
                onClick={readerLayout.toggleExpanded}
              >
                {readerLayout.expanded ? (
                  <Minimize2 className="size-4" />
                ) : (
                  <Maximize2 className="size-4" />
                )}
              </Button>
            ) : null}
            <Button
              ref={closeButton}
              variant="ghost"
              size="icon-sm"
              onClick={props.onClose}
              aria-label={props.closeLabel ?? "关闭资料面板"}
              title="关闭阅读"
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>
        <div className="cloud-reader-body">{props.children}</div>
      </section>
    );
  }
  if (presentation === "page") {
    return (
      <section data-cloud-resource-page="" className="cloud-resource-page">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-medium tracking-tight">{props.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{props.description}</p>
          </div>
          {props.headerActions}
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            返回对话
          </Button>
        </header>
        <div className="cloud-resource-page-content">{props.children}</div>
      </section>
    );
  }
  return (
    <Sheet
      open
      modal={compact}
      disablePointerDismissal={!compact}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <SheetPopup
        side="right"
        showBackdrop={compact}
        showCloseButton={false}
        className={
          props.wide ? "w-[min(960px,100vw)] max-w-full gap-0" : "w-[420px] max-w-full gap-0"
        }
        data-cloud-resource-panel=""
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <SheetTitle className="truncate text-base font-medium">{props.title}</SheetTitle>
            <SheetDescription className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {props.description}
            </SheetDescription>
          </div>
          {props.headerActions}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={props.onClose}
            aria-label={props.closeLabel ?? "关闭资料面板"}
            title="关闭"
            className="shrink-0"
          >
            <X className="size-4" />
            <span className="sr-only">关闭</span>
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-5">
          {props.children}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
