import "@liveagent/ui/i18n/namespaces/projectTools";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import type { DeviceUiDocument } from "../../lib/plugins/deviceUiSurface";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

const PreviewDocument = lazy(() => import("./DeviceUiPreviewDocument"));

type Props = {
  label: string;
  load: () => Promise<DeviceUiDocument>;
};

export function DeviceUiPreviewDialog({ label, load }: Props) {
  const { t } = useLocale();
  const trigger = useRef<HTMLButtonElement>(null);
  const [opening, setOpening] = useState<{ load: Props["load"] }>();
  const open = opening?.load === load;
  const [view, setView] = useState<{
    opening?: typeof opening;
    document?: DeviceUiDocument;
    failed?: boolean;
  }>({});
  const currentView = view.opening === opening ? view : {};
  useEffect(() => {
    if (!open) return;
    let current = true;
    void Promise.resolve()
      .then(load)
      .then(
        (document) => {
          if (current) setView({ opening, document });
        },
        () => {
          if (current) setView({ opening, failed: true });
        },
      );
    return () => {
      current = false;
    };
  }, [load, open, opening]);
  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpening({ load })}
      >
        {label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setOpening(undefined);
            setView({});
          }
        }}
      >
        <DialogContent
          layout="fullscreen-mobile"
          showCloseButton
          closeLabel={t("sandboxedUi.device.close")}
          finalFocus={trigger}
          className="flex h-[min(44rem,85dvh)] max-w-4xl flex-col overflow-hidden"
        >
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
          </DialogHeader>
          {open && currentView.failed ? (
            <p role="alert" className="px-5 pb-4 text-sm text-muted-foreground">
              {t("sandboxedUi.panelError.generic")}
            </p>
          ) : (
            <Suspense
              fallback={
                <p role="status" className="px-5 text-sm">
                  …
                </p>
              }
            >
              {open && currentView.document ? (
                <PreviewDocument document={currentView.document} title={label} />
              ) : (
                <p role="status" className="px-5 text-sm">
                  …
                </p>
              )}
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
