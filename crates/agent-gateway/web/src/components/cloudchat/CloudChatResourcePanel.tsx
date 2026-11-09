import { X } from "@liveagent/ui/components/IconSet";
import {
  ConversationReaderPanel,
  type ConversationReaderPanelProps,
} from "@liveagent/ui/components/resource-preview/ConversationReaderPanel";
import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "@liveagent/ui/components/ui/sheet";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { useLocale } from "@liveagent/ui/i18n";
import { useContext, useEffect, useState } from "react";
import {
  type CloudResourceDragIdentity,
  writeCloudResourceDragPayload,
} from "@/lib/cloudResourceDrag";
import { CloudChatResourcePresentation } from "./CloudChatReaderContext";

export { CloudChatResourcePresentation } from "./CloudChatReaderContext";

export function CloudChatResourcePanel(
  props: Omit<ConversationReaderPanelProps, "onTitleDragStart"> & {
    wide?: boolean;
    dragResource?: CloudResourceDragIdentity;
  },
) {
  const presentation = useContext(CloudChatResourcePresentation);
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const closeLabel = props.closeLabel ?? copy("关闭资料面板", "Close resource panel");
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
    const { dragResource, wide: _wide, ...panelProps } = props;
    return (
      <ConversationReaderPanel
        {...panelProps}
        onTitleDragStart={
          dragResource
            ? (event) => {
                if (!writeCloudResourceDragPayload(event.dataTransfer, [dragResource]))
                  event.preventDefault();
              }
            : undefined
        }
      />
    );
  }
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
