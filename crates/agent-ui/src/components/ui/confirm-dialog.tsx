import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogActions,
  AlertDialogBody,
  AlertDialogClose,
  AlertDialogCloseButton,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import { Button } from "./button";

export type ConfirmDialogOptions = {
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  detail?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  closeLabel?: string;
  hideCancel?: boolean;
  /** Give the safe cancel action primary emphasis and render confirmation as destructive text. */
  preferCancel?: boolean;
  touchActions?: boolean;
  returnFocusOnCancel?: () => HTMLElement | null;
};

type PendingConfirmDialog = ConfirmDialogOptions & {
  resolve: (confirmed: boolean) => void;
};

function ConfirmDialog(
  props: ConfirmDialogOptions & { onCancel: () => void; onConfirm: () => void },
) {
  const {
    title,
    subtitle,
    description,
    detail,
    confirmLabel,
    cancelLabel,
    closeLabel = cancelLabel,
    hideCancel = false,
    preferCancel = false,
    touchActions = false,
    returnFocusOnCancel,
    onCancel,
    onConfirm,
  } = props;
  const actionHeight = touchActions ? "h-11 md:h-8" : "h-8";
  const cancelAction = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);

  useLayoutEffect(() => {
    if (!returnFocusOnCancel) return;
    return () => {
      if (!cancelled.current) return;
      // Allow the enclosing menu and dialog to complete their own focus restoration first.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const target = returnFocusOnCancel();
          if (
            target?.isConnected &&
            !target.closest('[inert], [aria-hidden="true"]') &&
            !target.ownerDocument.activeElement?.closest('[role="alertdialog"][data-open]')
          ) {
            target.focus({ preventScroll: true });
          }
        });
      });
    };
  }, [returnFocusOnCancel]);

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) {
          cancelled.current = true;
          onCancel();
        }
      }}
    >
      <AlertDialogContent
        layout="confirmation"
        initialFocus={preferCancel && !hideCancel ? cancelAction : undefined}
      >
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          <AlertDialogHeader className="pr-14">
            <AlertDialogTitle className="break-words">{title}</AlertDialogTitle>
            {subtitle ? (
              <div className="break-words text-xs leading-relaxed text-muted-foreground">
                {subtitle}
              </div>
            ) : null}
          </AlertDialogHeader>

          {description || detail ? (
            <AlertDialogBody>
              <AlertDialogDescription className="space-y-2.5" render={<div />}>
                {description ? (
                  <div className="text-sm leading-relaxed text-foreground">{description}</div>
                ) : null}
                {detail ? (
                  <div
                    className={cn(
                      "break-all rounded-md bg-muted/50 px-2.5 py-1.5",
                      "font-mono text-xs leading-5 text-muted-foreground",
                    )}
                  >
                    {detail}
                  </div>
                ) : null}
              </AlertDialogDescription>
            </AlertDialogBody>
          ) : null}
        </div>

        <AlertDialogCloseButton
          label={closeLabel}
          className="za-confirmation-close absolute right-4 top-4 z-10 text-muted-foreground hover:text-foreground"
        />

        <AlertDialogFooter>
          <AlertDialogActions>
            {hideCancel ? null : (
              <AlertDialogClose
                render={
                  <Button
                    ref={cancelAction}
                    type="button"
                    variant={preferCancel ? "default" : "outline"}
                    className={actionHeight}
                    autoFocus
                  />
                }
              >
                {cancelLabel}
              </AlertDialogClose>
            )}
            <Button
              type="button"
              variant={preferCancel ? "ghost" : "destructive"}
              onClick={onConfirm}
              className={cn(
                actionHeight,
                preferCancel && "text-destructive hover:bg-destructive/10 hover:text-destructive",
              )}
            >
              {confirmLabel}
            </Button>
          </AlertDialogActions>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirmDialog | null>(null);
  const pendingRef = useRef<PendingConfirmDialog | null>(null);

  const close = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(confirmed);
  }, []);

  const confirm = useCallback((options: ConfirmDialogOptions) => {
    return new Promise<boolean>((resolve) => {
      pendingRef.current?.resolve(false);
      const next = { ...options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  useEffect(() => {
    return () => {
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    };
  }, []);

  const dialog = pending ? (
    <ConfirmDialog
      title={pending.title}
      subtitle={pending.subtitle}
      description={pending.description}
      detail={pending.detail}
      confirmLabel={pending.confirmLabel}
      cancelLabel={pending.cancelLabel}
      closeLabel={pending.closeLabel}
      hideCancel={pending.hideCancel}
      preferCancel={pending.preferCancel}
      touchActions={pending.touchActions}
      returnFocusOnCancel={pending.returnFocusOnCancel}
      onCancel={() => close(false)}
      onConfirm={() => close(true)}
    />
  ) : null;

  return { confirm, dialog };
}
