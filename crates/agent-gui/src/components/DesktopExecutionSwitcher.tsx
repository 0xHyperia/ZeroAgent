import { ChevronDown, Loader2, MonitorSmartphone } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useLocale } from "@liveagent/ui/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DesktopEnvironment } from "../lib/relay/desktopExecution";

type Props = {
  environments: DesktopEnvironment[];
  localDeviceId: string;
  selectedDeviceId: string;
  authorizedDeviceIds?: ReadonlySet<string>;
  onSwitch: (environment: DesktopEnvironment) => Promise<void>;
};

export function DesktopExecutionSwitcher({
  environments,
  localDeviceId,
  selectedDeviceId,
  authorizedDeviceIds = new Set(),
  onSwitch,
}: Props) {
  const { locale } = useLocale();
  const text = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const localLabel = text("此电脑", "This computer");
  const menuRootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<DesktopEnvironment | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useMemo(() => {
    const environment =
      environments.find((item) => item.device_id === selectedDeviceId) ??
      environments.find((item) => item.device_id === localDeviceId);
    return environment;
  }, [environments, localDeviceId, selectedDeviceId]);
  const label = current?.device_id === localDeviceId ? localLabel : (current?.name ?? localLabel);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      await onSwitch(pending);
      setPending(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : text("切换失败", "Could not switch devices"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div ref={menuRootRef} className="relative">
        <Button
          variant="outline"
          className="h-8 max-w-[min(260px,28vw)] gap-2 bg-background/95 px-3 shadow-sm max-[900px]:w-8 max-[900px]:px-0"
          title={label}
          aria-label={text(`选择设备，当前：${label}`, `Choose device, current: ${label}`)}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <MonitorSmartphone className="h-4 w-4" />
          <span className="truncate text-xs max-[900px]:hidden">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 max-[900px]:hidden" />
        </Button>
        {open && (
          <div className="layer-popover absolute left-0 top-full mt-2 max-h-[60vh] w-60 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg">
            {environments.map((environment) => (
              <button
                type="button"
                key={environment.device_id}
                aria-current={environment.device_id === selectedDeviceId ? "true" : undefined}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-xs hover:bg-accent"
                onClick={() => {
                  if (
                    environment.device_id === selectedDeviceId &&
                    (environment.device_id === localDeviceId ||
                      authorizedDeviceIds.has(environment.device_id))
                  ) {
                    setOpen(false);
                    return;
                  }
                  setOpen(false);
                  if (environment.device_id === localDeviceId) {
                    void onSwitch(environment);
                    return;
                  }
                  if (authorizedDeviceIds.has(environment.device_id)) {
                    void onSwitch(environment);
                    return;
                  }
                  if (!environment.online) {
                    void onSwitch(environment);
                    return;
                  }
                  setPending(environment);
                  setError("");
                }}
              >
                <MonitorSmartphone className="h-3.5 w-3.5" />
                <span className="min-w-0 flex-1 truncate">
                  {environment.device_id === localDeviceId ? localLabel : environment.name}
                </span>
                <span className={environment.online ? "text-emerald-600" : "text-muted-foreground"}>
                  {environment.online ? text("在线", "Online") : text("离线", "Offline")}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {pending && (
        <Dialog open onOpenChange={(value) => !value && !busy && setPending(null)}>
          <DialogContent
            className="max-w-[380px] p-5"
            closeDisabled={busy}
            closeLabel={text("关闭", "Close")}
            showCloseButton
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1 pr-8">
                <DialogTitle className="text-sm font-semibold">
                  {text("确认切换设备", "Switch devices")}
                </DialogTitle>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {pending.device_id === localDeviceId ? localLabel : pending.name}
                </p>
              </div>
            </div>
            <DialogDescription className="mt-5 text-xs text-muted-foreground">
              {text("将在所选设备中继续操作。", "Continue in the selected device workspace.")}
            </DialogDescription>
            {error && (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setPending(null)}>
                {text("取消", "Cancel")}
              </Button>
              <Button disabled={busy} onClick={() => void confirm()}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {text("确认切换", "Switch")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
