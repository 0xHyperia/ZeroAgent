import { type ReactNode, type Ref, type RefObject, useContext, useEffect, useRef } from "react";
import { useLocale } from "../../i18n";
import { ChevronDown, X } from "../IconSet";
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { PreviewToolbarMount } from "./PreviewChrome";
import { getResourceFileIcon } from "./ResourceFileIcon";
import "./resource-preview.css";

export function ResourceTitleMenu({
  name,
  children,
  triggerRef,
}: {
  name: string;
  children: ReactNode;
  triggerRef?: Ref<HTMLElement>;
}) {
  const { locale } = useLocale();
  const chrome = useContext(PreviewToolbarMount);
  const Icon = getResourceFileIcon(name);
  return (
    <Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <TooltipTrigger
              render={
                <Button
                  ref={triggerRef}
                  variant="ghost"
                  size="sm"
                  className="za-reader-title-menu"
                />
              }
            />
          }
          aria-label={locale === "zh-CN" ? `文件菜单：${name}` : `File menu for ${name}`}
        >
          <Icon className="size-4 shrink-0" />
          <span className="truncate">{name}</span>
          <ChevronDown className="size-3 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
          {chrome?.fileMenu}
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
      <TooltipContent side="bottom" className="max-w-sm break-words">
        {name}
      </TooltipContent>
    </Tooltip>
  );
}

export function ResourceInspector({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { locale } = useLocale();
  const close = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const panel = close.current?.closest(".za-reader-inspector");
    const stage = panel?.closest(".za-reader-stage");
    const previous = document.activeElement;
    if (
      previous instanceof HTMLElement &&
      stage?.parentElement?.contains(previous) &&
      !panel?.contains(previous)
    )
      opener.current = previous;
    close.current?.focus({ preventScroll: true });
    return () => {
      queueMicrotask(() => {
        const active = document.activeElement;
        if (panel?.isConnected || (active !== document.body && active !== document.documentElement))
          return;
        const previousControl = opener.current;
        // Version history replaces the file menu while the inspector is open.
        const fileMenu = stage?.previousElementSibling?.querySelector<HTMLButtonElement>(
          ".za-reader-title-menu:not(:disabled)",
        );
        const target =
          previousControl?.isConnected && !previousControl.closest("[inert]")
            ? previousControl
            : fileMenu;
        if (target?.isConnected && !target.closest("[inert]"))
          target.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        className="za-reader-inspector-dismiss"
        aria-label={locale === "zh-CN" ? "返回文件阅读画布" : "Return to the reader"}
        onClick={onClose}
      />
      <aside
        className="za-reader-inspector"
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header>
          <h3>{title}</h3>
          <Button
            ref={close}
            variant="ghost"
            size="icon-sm"
            aria-label={locale === "zh-CN" ? `关闭${title}` : `Close ${title}`}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <ScrollArea
          className="za-reader-inspector-scroll"
          contentClassName="za-reader-panel-scroll-content"
        >
          <div className="za-reader-inspector-content">{children}</div>
        </ScrollArea>
      </aside>
    </>
  );
}

/** Draft removal is immediate; destructive original/family deletion uses this explicit decision. */
export function ResourceDeleteDialog(props: {
  open: boolean;
  busy: boolean;
  name: string;
  description: string;
  confirmLabel: string;
  feedback?: ReactNode;
  confirmDisabled?: boolean;
  returnFocus?: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { locale } = useLocale();
  const english = locale === "en-US";
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.confirmDisabled) cancel.current?.focus({ preventScroll: true });
  }, [props.confirmDisabled]);
  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onCancel();
      }}
    >
      <AlertDialogContent initialFocus={cancel} finalFocus={props.returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {english ? `Delete “${props.name}”?` : `删除“${props.name}”？`}
          </AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        {props.feedback ? <AlertDialogBody>{props.feedback}</AlertDialogBody> : null}
        <AlertDialogFooter>
          <Button ref={cancel} variant="outline" disabled={props.busy} onClick={props.onCancel}>
            {props.confirmDisabled
              ? english
                ? "Close"
                : "关闭"
              : english
                ? "Keep file"
                : "保留文件"}
          </Button>
          <Button
            variant="destructive"
            disabled={props.busy || props.confirmDisabled}
            onClick={props.onConfirm}
          >
            {props.busy ? (english ? "Deleting…" : "正在删除…") : props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
