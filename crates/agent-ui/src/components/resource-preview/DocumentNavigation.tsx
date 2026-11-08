import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { PanelLeft } from "../IconSet";
import { ScrollArea } from "../ui/scroll-area";
import { TooltipButton as Button } from "../ui/tooltip-button";

/** The rail and its preview share one pointer boundary, including the path between them. */
export function DocumentNavigation(props: {
  label: string;
  pinned: boolean;
  onPinned: (pinned: boolean) => void;
  count: number;
  current: number;
  activeKey?: string;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [preview, setPreview] = useState(false);
  const navigationId = useId();
  const rail = useRef<HTMLButtonElement>(null);
  const pin = useRef<HTMLElement>(null);
  const nav = useRef<HTMLElement>(null);
  const pendingFocus = useRef<"rail" | "current" | null>(null);
  const open = props.pinned || preview;
  useLayoutEffect(() => {
    if (props.pinned && pendingFocus.current === "current") {
      pendingFocus.current = null;
      (nav.current?.querySelector<HTMLElement>("[aria-current]") ?? pin.current)?.focus({
        preventScroll: true,
      });
    } else if (!open && pendingFocus.current === "rail") {
      pendingFocus.current = null;
      rail.current?.focus({ preventScroll: true });
    }
  }, [open, props.pinned]);
  function collapse() {
    pendingFocus.current = "rail";
    if (props.pinned) props.onPinned(false);
    setPreview(false);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection changes must reveal the current item inside the already mounted navigation.
  useEffect(() => {
    if (open) nav.current?.querySelector("[aria-current]")?.scrollIntoView?.({ block: "nearest" });
  }, [open, props.current, props.activeKey]);
  const ticks = Math.min(24, Math.max(1, props.count));
  const activeTick = Math.min(
    ticks - 1,
    Math.floor(((props.current - 1) / Math.max(1, props.count)) * ticks),
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: This pointer boundary groups navigation controls, rather than form fields.
    <div
      role="group"
      aria-label={`${props.label}预览区域`}
      className="za-document-navigation-zone"
      data-open={open}
      data-pinned={props.pinned}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setPreview(true);
      }}
      onPointerLeave={(event) => {
        const focused = document.activeElement;
        if (focused === rail.current || !event.currentTarget.contains(focused)) setPreview(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPreview(false);
      }}
      onKeyDown={(event) => {
        if (!open || event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        collapse();
      }}
    >
      <button
        ref={rail}
        type="button"
        className="za-document-navigation-rail"
        aria-label={`展开${props.label}`}
        aria-expanded={open}
        aria-controls={open ? navigationId : undefined}
        onClick={() => {
          pendingFocus.current = "current";
          props.onPinned(true);
        }}
      >
        {Array.from({ length: ticks }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: These fixed ruler marks never contain identity or state.
          <span key={index} data-current={index === activeTick} />
        ))}
      </button>
      {open ? (
        <aside id={navigationId} className="za-document-navigation" aria-label={props.label}>
          <header>
            <strong>{props.title}</strong>
            {props.actions}
            <Button
              ref={pin}
              variant="ghost"
              size="icon-sm"
              tooltip={props.pinned ? "收起目录" : "固定目录"}
              aria-label={props.pinned ? `收起${props.label}` : `固定${props.label}`}
              onClick={() => {
                if (props.pinned) collapse();
                else props.onPinned(true);
              }}
            >
              <PanelLeft className="size-4" />
            </Button>
          </header>
          <ScrollArea
            className="za-document-navigation-scroll"
            contentClassName="za-reader-panel-scroll-content"
          >
            <nav ref={nav}>{props.children}</nav>
          </ScrollArea>
        </aside>
      ) : null}
    </div>
  );
}
