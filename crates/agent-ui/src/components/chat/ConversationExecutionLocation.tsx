import { useRef, useState } from "react";
import { useLocale } from "../../i18n";
import { Check, ChevronDown, Cloud, FolderOpen, Loader2, MonitorSmartphone } from "../IconSet";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const icons = { cloud: Cloud, device: MonitorSmartphone, workspace: FolderOpen };

export type ExecutionLocation = {
  kind: keyof typeof icons;
  name: string;
  workspace?: string;
};

export type ExecutionLocationChoice = ExecutionLocation & {
  id: string;
  selected?: boolean;
  offline?: boolean;
  unavailable?: string;
  deviceId?: string;
  retryIdentity?: string;
  choose?: () => unknown;
};

type FailedExecutionLocation = {
  id: string;
  deviceId?: string;
  identity?: string;
  name: string;
  message: string;
};

function locationText(location: ExecutionLocation) {
  return [location.name, location.workspace].filter(Boolean).join(" · ");
}

export function ConversationExecutionLocation({
  current,
  choices,
  disabled,
}: {
  current: ExecutionLocation;
  choices?: readonly ExecutionLocationChoice[];
  disabled?: boolean;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [pending, setPending] = useState<string>();
  const pendingRef = useRef(false);
  const [failure, setFailure] = useState<FailedExecutionLocation>();
  const Icon = icons[current.kind];
  const name = locationText(current);
  const label = zh ? `执行位置 · ${name}` : `Execution location · ${name}`;
  const switchLabel = zh ? `切换工作台 · ${name}` : `Switch workbench · ${name}`;
  const content = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{current.name}</span>
      {current.workspace && (
        <span className="min-w-0 truncate max-[520px]:sr-only">· {current.workspace}</span>
      )}
    </>
  );
  if (!choices?.length) {
    return (
      <span
        data-conversation-execution-location="bound"
        className="inline-flex h-8 min-w-0 max-w-56 items-center gap-1.5 px-2 text-xs text-muted-foreground"
        title={label}
      >
        <span className="sr-only">{zh ? "执行位置" : "Execution location"}</span>
        {content}
      </span>
    );
  }

  const originalChoice = failure
    ? choices.find(
        (choice) => choice.id === failure.id && choice.retryIdentity === failure.identity,
      )
    : undefined;
  const originalDeviceOffline = Boolean(
    failure?.deviceId &&
      choices.some((choice) => choice.deviceId === failure.deviceId && choice.offline),
  );
  const canRetry = originalChoice?.choose && !originalChoice.offline && !originalChoice.unavailable;
  const retryHint = canRetry
    ? undefined
    : originalChoice?.offline || originalDeviceOffline
      ? zh
        ? "设备离线。恢复连接后可重试。"
        : "Device offline. Retry when it reconnects."
      : zh
        ? "执行位置已变化，请重新选择。"
        : "This execution location changed. Choose a location again.";

  async function choose(choice: ExecutionLocationChoice) {
    if (disabled || choice.offline || choice.unavailable || pendingRef.current) return;
    if (!choice.choose) {
      openRef.current = false;
      setOpen(false);
      setFailure(undefined);
      return;
    }
    pendingRef.current = true;
    setPending(choice.id);
    if (choice !== originalChoice) setFailure(undefined);
    try {
      await choice.choose();
      openRef.current = false;
      setOpen(false);
      setFailure(undefined);
    } catch (cause) {
      if (!openRef.current) return;
      setFailure({
        id: choice.id,
        deviceId: choice.deviceId,
        identity: choice.retryIdentity,
        name: locationText(choice),
        message:
          cause instanceof Error && cause.message
            ? cause.message
            : zh
              ? "暂时无法连接所选执行位置，请重试。"
              : "Couldn't connect to this execution location. Try again.",
      });
    } finally {
      pendingRef.current = false;
      setPending(undefined);
    }
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        openRef.current = next;
        setOpen(next);
        if (!next) setFailure(undefined);
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            data-conversation-execution-location="workbench"
            variant="ghost"
            className="h-8 min-w-0 max-w-44 shrink-0 gap-1.5 rounded-lg px-2 text-xs text-muted-foreground max-[520px]:h-10"
            title={switchLabel}
            aria-label={switchLabel}
            disabled={disabled}
          />
        }
      >
        {content}
        <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64 max-w-[calc(100vw-1rem)]" align="start">
        {failure && (
          <div className="sticky top-0 z-10 bg-popover">
            <div role={pending ? "status" : "alert"} className="space-y-1 px-2.5 py-2 text-xs">
              <p
                className="line-clamp-2 break-words font-medium text-foreground"
                title={failure.name}
              >
                {failure.name}
              </p>
              {pending ? (
                <p className="text-muted-foreground">{zh ? "正在连接…" : "Connecting…"}</p>
              ) : (
                <>
                  <p className="line-clamp-3 break-words text-destructive" title={failure.message}>
                    {failure.message}
                  </p>
                  {retryHint && <p className="text-muted-foreground">{retryHint}</p>}
                </>
              )}
            </div>
            {canRetry && originalChoice && (
              <DropdownMenuItem
                className="min-h-9 max-[520px]:min-h-11"
                closeOnClick={false}
                disabled={disabled || pending !== undefined}
                aria-label={zh ? `重试 ${failure.name}` : `Retry ${failure.name}`}
                onClick={() => void choose(originalChoice)}
              >
                {zh ? "重试" : "Retry"}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </div>
        )}
        {choices.map((choice) => {
          const ChoiceIcon = icons[choice.kind];
          return (
            <DropdownMenuItem
              key={choice.id}
              closeOnClick={false}
              disabled={choice.offline || !!choice.unavailable || pending !== undefined}
              aria-current={choice.selected || undefined}
              className="min-h-9 gap-2 max-[520px]:min-h-11"
              onClick={() => void choose(choice)}
            >
              <ChoiceIcon aria-hidden="true" className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={locationText(choice)}>
                {locationText(choice)}
              </span>
              {(choice.offline || choice.unavailable) && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {choice.offline ? (zh ? "离线" : "Offline") : choice.unavailable}
                </span>
              )}
              {pending === choice.id ? (
                <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
              ) : (
                choice.selected && <Check aria-hidden="true" className="size-4 shrink-0" />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
