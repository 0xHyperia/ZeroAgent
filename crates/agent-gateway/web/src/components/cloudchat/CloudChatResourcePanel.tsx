import { ArrowLeft, Maximize2, Minimize2, X } from "@liveagent/ui/components/IconSet";
import { PreviewToolbarMount } from "@liveagent/ui/components/resource-preview/PreviewChrome";
import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "@liveagent/ui/components/ui/sheet";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { useLocale } from "@liveagent/ui/i18n";
import { type ReactNode, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type CloudResourceDragIdentity,
  writeCloudResourceDragPayload,
} from "@/lib/cloudResourceDrag";
import { CloudChatReaderLayout, CloudChatResourcePresentation } from "./CloudChatReaderContext";

export { CloudChatResourcePresentation } from "./CloudChatReaderContext";

export function CloudChatResourcePanel(props: {
  title: ReactNode;
  description: string;
  closeLabel?: string;
  backToLibrary?: boolean;
  backLabel?: string;
  wide?: boolean;
  headerActions?: ReactNode;
  continueAction?: { label: string; disabled: boolean; onClick: () => void };
  subtitle?: ReactNode;
  details?: ReactNode;
  className?: string;
  dragResource?: CloudResourceDragIdentity;
  onClose: () => void;
  children: ReactNode;
}) {
  const presentation = useContext(CloudChatResourcePresentation);
  const readerLayout = useContext(CloudChatReaderLayout);
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const backLabel = props.backLabel ?? copy("返回资料空间", "Back to library");
  const showBack = Boolean(props.backLabel || props.backToLibrary);
  const closeLabel = props.closeLabel ?? copy("关闭资料面板", "Close resource panel");
  const expandLabel = readerLayout?.expanded
    ? copy("恢复并排阅读", "Return to split view")
    : copy("展开阅读", "Expand reader");
  const titleId = useId();
  const reader = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [leadingTarget, setLeadingTarget] = useState<HTMLDivElement | null>(null);
  const [optionsTarget, setOptionsTarget] = useState<HTMLDivElement | null>(null);
  const [pageTarget, setPageTarget] = useState<HTMLDivElement | null>(null);
  const [fileMenu, setFileMenu] = useState<ReactNode>(null);
  const toolbarMount = useMemo(
    () => ({
      target: toolbarTarget,
      leadingTarget,
      optionsTarget,
      inspectorOpen: !!props.details,
      pageTarget,
      fileMenu,
      setFileMenu,
    }),
    [toolbarTarget, leadingTarget, optionsTarget, props.details, pageTarget, fileMenu],
  );
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
  const { continueAction } = props;
  const headerContinue = continueAction ? (
    <Button
      variant="outline"
      size="sm"
      className="cloud-reader-continue-action"
      disabled={continueAction.disabled}
      onClick={continueAction.onClick}
    >
      {continueAction.label}
    </Button>
  ) : null;
  if (presentation === "inline") {
    return (
      <PreviewToolbarMount.Provider value={toolbarMount}>
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
            {showBack ? (
              <Button
                ref={closeButton}
                variant="ghost"
                size="icon-sm"
                className="cloud-reader-back"
                data-cloud-reader-return=""
                onClick={props.onClose}
                aria-label={backLabel}
                tooltip={props.backLabel ? undefined : backLabel}
              >
                <ArrowLeft className="size-4" />
              </Button>
            ) : null}
            <div className="cloud-reader-heading">
              {props.dragResource ? (
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
              ) : (
                <h2 id={titleId} title={typeof props.title === "string" ? props.title : undefined}>
                  {props.title}
                </h2>
              )}
              <div className="cloud-reader-subtitle">{props.subtitle ?? props.description}</div>
            </div>
            <div ref={setToolbarTarget} className="cloud-reader-format-tools" />
            <div ref={setLeadingTarget} className="cloud-reader-leading-tools" />
            <div className="cloud-reader-actions">
              {headerContinue}
              {props.headerActions}
            </div>
            <div ref={setOptionsTarget} className="cloud-reader-options-tools" />
            <div className="cloud-reader-window-actions">
              {readerLayout?.canSplit ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={expandLabel}
                  tooltip={expandLabel}
                  onClick={readerLayout.toggleExpanded}
                >
                  {readerLayout.expanded ? (
                    <Minimize2 className="size-4" />
                  ) : (
                    <Maximize2 className="size-4" />
                  )}
                </Button>
              ) : null}
              {!showBack ? (
                <Button
                  ref={closeButton}
                  variant="ghost"
                  size="icon-sm"
                  data-cloud-reader-return=""
                  onClick={props.onClose}
                  aria-label={closeLabel}
                  title={closeLabel}
                >
                  <X className="size-4" />
                </Button>
              ) : null}
            </div>
          </header>
          <div className="za-reader-stage">
            <div className="cloud-reader-body">{props.children}</div>
            {props.details}
            <div ref={setPageTarget} className="cloud-reader-bottom-tools" />
          </div>
          {continueAction && !props.details ? (
            <footer className="cloud-reader-compact-action">
              <Button
                size="lg"
                className="min-h-11 rounded-full"
                disabled={continueAction.disabled}
                onClick={continueAction.onClick}
              >
                {continueAction.label}
              </Button>
            </footer>
          ) : null}
        </section>
      </PreviewToolbarMount.Provider>
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
          {headerContinue}
          {props.headerActions}
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            {copy("返回对话", "Back to chat")}
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
          {headerContinue}
          {props.headerActions}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={props.onClose}
            aria-label={closeLabel}
            title={closeLabel}
            className="shrink-0"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-5">
          {props.children}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
