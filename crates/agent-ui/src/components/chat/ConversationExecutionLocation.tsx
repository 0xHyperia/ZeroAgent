import { type ReactNode, useRef, useState } from "react";
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
import { Sheet, SheetHeader, SheetPanel, SheetPopup, SheetTitle, SheetTrigger } from "../ui/sheet";

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

function LocationAction({
  sheet,
  closeOnClick,
  children,
  ...props
}: {
  sheet: boolean;
  closeOnClick?: boolean;
  className: string;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-current"?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  if (!sheet) {
    return (
      <DropdownMenuItem closeOnClick={closeOnClick} {...props}>
        {children}
      </DropdownMenuItem>
    );
  }
  return (
    <Button
      variant="ghost"
      {...props}
      className={`h-auto w-full justify-start whitespace-normal rounded-xl px-3 text-left ${props.className}`}
    >
      {children}
    </Button>
  );
}

export function ConversationExecutionLocation({
  current,
  choices,
  disabled,
  retryDirectory,
  onManageDevices,
  compact = false,
  mobileSheet = false,
}: {
  current: ExecutionLocation;
  choices?: readonly ExecutionLocationChoice[];
  disabled?: boolean;
  retryDirectory?: () => Promise<unknown>;
  onManageDevices?: () => void;
  compact?: boolean;
  mobileSheet?: boolean;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [pending, setPending] = useState<string>();
  const pendingRef = useRef(false);
  const [failure, setFailure] = useState<FailedExecutionLocation>();
  const [refreshing, setRefreshing] = useState(false);
  const Icon = icons[current.kind];
  const name = locationText(current);
  const label = zh ? `执行位置 · ${name}` : `Execution location · ${name}`;
  const switchLabel = zh ? `切换工作台 · ${name}` : `Switch workbench · ${name}`;
  const showDeviceType = compact && !mobileSheet && current.kind === "device";
  const content = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span
        className={
          showDeviceType
            ? "flex min-w-0 flex-col items-start gap-0.5 leading-tight"
            : "min-w-0 truncate"
        }
      >
        {showDeviceType && (
          <span className="font-medium text-foreground">{zh ? "远程设备" : "Remote device"}</span>
        )}
        <span className="max-w-full truncate">{current.name}</span>
      </span>
      {current.workspace && (
        <span className="min-w-0 truncate max-[520px]:sr-only">· {current.workspace}</span>
      )}
    </>
  );
  if (!choices?.length && !retryDirectory && !onManageDevices) {
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
    ? choices?.find(
        (choice) => choice.id === failure.id && choice.retryIdentity === failure.identity,
      )
    : undefined;
  const originalDeviceOffline = Boolean(
    failure?.deviceId &&
      choices?.some((choice) => choice.deviceId === failure.deviceId && choice.offline),
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

  const onOpenChange = (next: boolean) => {
    openRef.current = next;
    setOpen(next);
    if (!next) setFailure(undefined);
  };
  const actionHeight = mobileSheet ? "min-h-11" : "min-h-9";
  const trigger = (
    <Button
      data-conversation-execution-location="workbench"
      variant="ghost"
      className={`shrink-0 gap-1.5 rounded-lg px-2 text-xs text-muted-foreground ${
        mobileSheet
          ? compact
            ? "h-11 min-w-11 max-w-44"
            : "h-11 min-w-11 max-w-28 max-[380px]:max-w-24"
          : "h-8 min-w-0 max-w-44 max-[640px]:max-w-28"
      }`}
      title={switchLabel}
      aria-label={switchLabel}
      disabled={disabled}
    />
  );
  const triggerContent = (
    <>
      {content}
      <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
    </>
  );
  const entries = (
    <>
      {retryDirectory && (
        <>
          <p role="status" className="px-2.5 py-2 text-xs text-muted-foreground">
            {refreshing
              ? zh
                ? "正在加载设备…"
                : "Loading devices…"
              : zh
                ? "暂时无法加载设备。"
                : "Couldn't load devices."}
          </p>
          <LocationAction
            sheet={mobileSheet}
            className={actionHeight}
            closeOnClick={false}
            disabled={refreshing || pending !== undefined}
            onClick={() => {
              setRefreshing(true);
              void retryDirectory()
                .catch(() => undefined)
                .finally(() => setRefreshing(false));
            }}
          >
            {zh ? "重新加载设备" : "Reload devices"}
          </LocationAction>
          {choices?.length ? <DropdownMenuSeparator /> : null}
        </>
      )}
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
            <LocationAction
              sheet={mobileSheet}
              className={actionHeight}
              closeOnClick={false}
              disabled={disabled || pending !== undefined}
              aria-label={zh ? `重试 ${failure.name}` : `Retry ${failure.name}`}
              onClick={() => void choose(originalChoice)}
            >
              {zh ? "重试" : "Retry"}
            </LocationAction>
          )}
          <DropdownMenuSeparator />
        </div>
      )}
      {choices?.map((choice) => {
        const ChoiceIcon = icons[choice.kind];
        return (
          <LocationAction
            sheet={mobileSheet}
            key={choice.id}
            closeOnClick={false}
            disabled={choice.offline || !!choice.unavailable || pending !== undefined}
            aria-current={choice.selected || undefined}
            className={mobileSheet ? "min-h-12 py-2 gap-3" : "min-h-9 gap-2"}
            onClick={() => void choose(choice)}
          >
            <ChoiceIcon aria-hidden="true" className="size-4 shrink-0" />
            <span
              className={mobileSheet ? "min-w-0 flex-1 break-words" : "min-w-0 flex-1 truncate"}
              title={locationText(choice)}
            >
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
          </LocationAction>
        );
      })}
      {onManageDevices && (
        <>
          <DropdownMenuSeparator />
          {!retryDirectory && !choices?.some((choice) => choice.kind === "device") && (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">
              {zh
                ? "登录 ZeroAgent 桌面端后，设备会出现在这里。"
                : "Sign in to ZeroAgent on your desktop to see the device here."}
            </p>
          )}
          <LocationAction
            sheet={mobileSheet}
            className={actionHeight}
            disabled={pending !== undefined}
            onClick={() => {
              onOpenChange(false);
              onManageDevices();
            }}
          >
            {zh ? "管理设备" : "Manage devices"}
          </LocationAction>
        </>
      )}
    </>
  );
  if (mobileSheet) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger render={trigger}>{triggerContent}</SheetTrigger>
        <SheetPopup
          side="bottom"
          data-cloud-view-navigation=""
          data-browser-back-surface=""
          className="za-mobile-choice-sheet"
          closeLabel={zh ? "关闭" : "Close"}
        >
          <SheetHeader className="px-5 pb-2 pt-6 pr-16">
            <SheetTitle>{zh ? "选择设备" : "Choose a device"}</SheetTitle>
          </SheetHeader>
          <SheetPanel className="px-2 pb-2 pt-0">{entries}</SheetPanel>
        </SheetPopup>
      </Sheet>
    );
  }
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger render={trigger}>{triggerContent}</DropdownMenuTrigger>
      <DropdownMenuContent
        data-cloud-view-navigation=""
        className="w-64 max-w-[calc(100vw-1rem)]"
        align="start"
      >
        {entries}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
