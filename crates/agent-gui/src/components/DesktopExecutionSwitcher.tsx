import {
  Check,
  ChevronDown,
  Cloud,
  Loader2,
  MonitorSmartphone,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import { useLocale } from "@liveagent/ui/i18n";
import { useState } from "react";
import type { DesktopEnvironment } from "../lib/relay/desktopExecution";

type Props = {
  environments: DesktopEnvironment[];
  localDeviceId: string;
  selectedDeviceId: string;
  cloudSelected?: boolean;
  onOpenCloud?: () => void;
  authorizedDeviceIds?: ReadonlySet<string>;
  onSwitch: (environment: DesktopEnvironment) => Promise<void>;
};

export function DesktopExecutionSwitcher({
  environments,
  localDeviceId,
  selectedDeviceId,
  cloudSelected = false,
  onOpenCloud,
  authorizedDeviceIds = new Set(),
  onSwitch,
}: Props) {
  const { locale } = useLocale();
  const text = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const localLabel = text("此电脑", "This computer");
  const [pending, setPending] = useState<DesktopEnvironment | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = environments.find((item) => item.device_id === selectedDeviceId);
  const cloudLabel = text("云端", "Cloud");
  const label = cloudSelected
    ? cloudLabel
    : current?.device_id === localDeviceId
      ? localLabel
      : (current?.name ?? localLabel);

  const switchError = (cause: unknown) =>
    cause instanceof Error ? cause.message : text("切换失败", "Could not switch devices");

  function chooseDevice(environment: DesktopEnvironment) {
    const local = environment.device_id === localDeviceId;
    const authorized = authorizedDeviceIds.has(environment.device_id);
    if (!cloudSelected && environment.device_id === selectedDeviceId && (local || authorized))
      return;
    if (local || authorized || !environment.online) {
      void onSwitch(environment).catch((cause) => toast.error(switchError(cause)));
      return;
    }
    setPending(environment);
    setError("");
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      await onSwitch(pending);
      setPending(null);
    } catch (cause) {
      setError(switchError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <TooltipButton
              variant="outline"
              className="h-8 max-w-[min(220px,24vw)] shrink-0 gap-2 bg-background/95 px-3 shadow-sm max-[640px]:w-8 max-[640px]:px-0 [-webkit-app-region:no-drag]"
              tooltip={label}
              tooltipSide="bottom"
              aria-label={text(`切换工作台，当前：${label}`, `Switch workbench, current: ${label}`)}
            />
          }
        >
          {cloudSelected ? (
            <Cloud className="size-4 shrink-0" />
          ) : (
            <MonitorSmartphone className="size-4 shrink-0" />
          )}
          <span className="truncate text-xs max-[640px]:hidden">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 max-[640px]:hidden" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-60 max-w-[calc(100vw-1rem)]"
          data-cloud-view-navigation=""
        >
          {environments.map((environment) => {
            const selected = !cloudSelected && environment.device_id === selectedDeviceId;
            return (
              <DropdownMenuItem
                key={environment.device_id}
                aria-current={selected || undefined}
                className="min-h-9 gap-2 text-xs max-[640px]:min-h-11"
                onClick={() => chooseDevice(environment)}
              >
                <MonitorSmartphone className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {environment.device_id === localDeviceId ? localLabel : environment.name}
                </span>
                <span
                  className={
                    environment.online
                      ? "shrink-0 text-emerald-600"
                      : "shrink-0 text-muted-foreground"
                  }
                >
                  {environment.online ? text("在线", "Online") : text("离线", "Offline")}
                </span>
                <Check
                  aria-hidden
                  className={selected ? "size-3.5 shrink-0" : "invisible size-3.5 shrink-0"}
                />
              </DropdownMenuItem>
            );
          })}
          {onOpenCloud && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                aria-current={cloudSelected || undefined}
                className="min-h-9 gap-2 text-xs max-[640px]:min-h-11"
                onClick={() => {
                  if (!cloudSelected) onOpenCloud();
                }}
              >
                <Cloud className="size-3.5 shrink-0" />
                <span className="flex-1">{cloudLabel}</span>
                {cloudSelected && <Check aria-hidden className="size-3.5 shrink-0" />}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {pending && (
        <Dialog open onOpenChange={(value) => !value && !busy && setPending(null)}>
          <DialogContent
            className="max-w-[380px] p-5"
            closeDisabled={busy}
            closeLabel={text("关闭", "Close")}
            data-cloud-view-navigation=""
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
