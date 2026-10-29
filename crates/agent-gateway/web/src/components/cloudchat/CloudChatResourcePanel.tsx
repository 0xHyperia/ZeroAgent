import { X } from "@liveagent/ui/components/IconSet";
import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "@liveagent/ui/components/ui/sheet";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

export const CloudChatResourcePresentation = createContext<"panel" | "page">("panel");

export function CloudChatResourcePanel(props: {
  title: ReactNode;
  description: string;
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const presentation = useContext(CloudChatResourcePresentation);
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
  if (presentation === "page") {
    return (
      <section data-cloud-resource-page="" className="cloud-resource-page">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-medium tracking-tight">{props.title}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{props.description}</p>
          </div>
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
        className="w-[420px] max-w-full gap-0"
        data-cloud-resource-panel=""
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <SheetTitle className="truncate text-base font-medium">{props.title}</SheetTitle>
            <SheetDescription className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {props.description}
            </SheetDescription>
          </div>
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
