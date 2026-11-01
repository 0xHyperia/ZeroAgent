import { type ReactNode, useContext, useEffect, useRef } from "react";
import { ChevronDown, X } from "../IconSet";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { PreviewToolbarMount } from "./PreviewChrome";
import { getResourceFileIcon } from "./ResourceFileIcon";
import "./resource-preview.css";

export function ResourceTitleMenu({ name, children }: { name: string; children: ReactNode }) {
  const chrome = useContext(PreviewToolbarMount);
  const Icon = getResourceFileIcon(name);
  return (
    <Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <TooltipTrigger
              render={<Button variant="ghost" size="sm" className="za-reader-title-menu" />}
            />
          }
          aria-label={`文件菜单：${name}`}
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
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const fallback = close.current
      ?.closest(".za-reader-stage")
      ?.previousElementSibling?.querySelector<HTMLButtonElement>(".za-reader-title-menu");
    close.current?.focus({ preventScroll: true });
    return () => {
      const target = previous instanceof HTMLElement && previous.isConnected ? previous : fallback;
      if (target?.isConnected && !target.closest("[inert]")) target.focus({ preventScroll: true });
    };
  }, []);
  return (
    <>
      <button
        type="button"
        className="za-reader-inspector-dismiss"
        aria-label="返回文件阅读画布"
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
            aria-label={`关闭${title}`}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="za-reader-inspector-content">{children}</div>
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
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除“{props.name}”？</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
            保留文件
          </Button>
          <Button variant="destructive" disabled={props.busy} onClick={props.onConfirm}>
            {props.busy ? "正在删除…" : props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
