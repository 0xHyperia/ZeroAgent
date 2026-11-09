import {
  type DragEventHandler,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../i18n";
import { ArrowLeft, Maximize2, Minimize2, X } from "../IconSet";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { ConversationReaderLayout } from "./conversationReaderLayout";
import { PreviewToolbarMount } from "./PreviewChrome";
import "./conversation-reader-panel.css";

export type ConversationReaderPanelProps = {
  title: ReactNode;
  description: string;
  closeLabel?: string;
  backToLibrary?: boolean;
  backLabel?: string;
  headerActions?: ReactNode;
  continueAction?: { label: string; disabled: boolean; onClick: () => void };
  subtitle?: ReactNode;
  details?: ReactNode;
  className?: string;
  returnFocusTo?: HTMLElement;
  onTitleDragStart?: DragEventHandler<HTMLHeadingElement>;
  onClose: () => void;
  children: ReactNode;
};

export function ConversationReaderPanel(props: ConversationReaderPanelProps) {
  const readerLayout = useContext(ConversationReaderLayout);
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
  const returnFocusTo = useRef(props.returnFocusTo);
  returnFocusTo.current = props.returnFocusTo;
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
    const previous = document.activeElement;
    const element = reader.current;
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      const shouldRestore =
        document.activeElement === document.body || element?.contains(document.activeElement);
      const trigger = returnFocusTo.current ?? previous;
      if (shouldRestore && trigger instanceof HTMLElement) {
        requestAnimationFrame(() => {
          if (
            !element?.isConnected &&
            document.activeElement === document.body &&
            trigger.isConnected &&
            !trigger.closest("[inert]")
          )
            trigger.focus({ preventScroll: true });
        });
      }
    };
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
            {props.onTitleDragStart ? (
              <h2
                id={titleId}
                className="cloud-reader-draggable-title"
                draggable
                onDragStart={props.onTitleDragStart}
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
