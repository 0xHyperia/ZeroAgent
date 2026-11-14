import { ChevronRight, MonitorSmartphone } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { DropdownMenuItem } from "@liveagent/ui/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { StatusNotice } from "@liveagent/ui/components/ui/status-notice";
import { useLocale } from "@liveagent/ui/i18n";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { useEffect, useId, useRef, useState } from "react";
import type { CloudSpaceItem } from "../../lib/cloudSpace";
import type { ExecutionEnvironment } from "../../lib/executionTargets";
import {
  type PendingWorkspaceHandoff,
  readPendingWorkspaceHandoffs,
  savePendingWorkspaceHandoff,
  type WorkspaceHandoff,
  WorkspaceHandoffRejected,
} from "../../lib/workspaceHandoff";

export type WorkspaceHandoffSource = Pick<CloudSpaceItem, "kind" | "target_id" | "name"> & {
  artifactNumber?: number;
};
type HandoffDestination = Pick<PendingWorkspaceHandoff, "deviceId" | "workspaceId"> &
  Partial<Pick<PendingWorkspaceHandoff, "deviceName" | "workspaceName" | "workspacePath">>;

const TARGET_PATH_CLASS = "whitespace-normal [overflow-wrap:anywhere]";
const TARGET_OPTIONS_CLASS =
  "w-[var(--anchor-width,16rem)] max-w-[var(--available-width,100vw)] [&_[role=listbox]]:min-w-0";

function matchesSelectedPath(expected: string | undefined, current: string | undefined) {
  return !expected || expected === current;
}

function hasWorkspaceDirectory(path: string | undefined): path is string {
  return Boolean(path?.trim());
}

function hasPublishedWorkspace(device: ExecutionEnvironment) {
  return device.workspaces.some((item) => hasWorkspaceDirectory(item.path));
}

export function WorkspaceHandoffMenuItem({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  const { locale } = useLocale();
  return (
    <DropdownMenuItem className="gap-2" disabled={disabled} onClick={onClick}>
      <MonitorSmartphone className="size-4" />
      {locale === "zh-CN" ? "发送到工作区" : "Send to workspace"}
    </DropdownMenuItem>
  );
}

export function WorkspaceHandoffDialog({
  owner,
  source,
  targets,
  read,
  send,
  onClose,
}: {
  owner: number;
  source: WorkspaceHandoffSource;
  targets: readonly ExecutionEnvironment[];
  read: (signal: AbortSignal) => Promise<{ blob: Blob; filename: string }>;
  send: (request: WorkspaceHandoff) => Promise<string | null>;
  onClose: () => void;
}) {
  const { locale } = useLocale();
  const label = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const deviceControlId = useId();
  const workspaceControlId = useId();
  const workspacePathId = useId();
  const storageScope = `zeroagent.handoff:${owner}:${source.kind}:${source.target_id}:`;
  const [pending, setPending] = useState(() => readPendingWorkspaceHandoffs(storageScope));
  const initial = pending.length === 1 ? pending[0] : undefined;
  const [destination, setDestination] = useState<HandoffDestination>(() => ({
    deviceId: initial?.deviceId ?? "",
    deviceName: initial?.deviceName,
    workspaceId: initial?.workspaceId ?? "",
    workspaceName: initial?.workspaceName,
    workspacePath: initial?.workspacePath,
  }));
  const { deviceId, workspaceId } = destination;
  const [action, setAction] = useState<"check" | "copy" | null>(null);
  const busy = action !== null;
  const [receipt, setReceipt] = useState<{
    path: string;
    target: string;
    workspacePath?: string;
  }>();
  const [error, setError] = useState("");
  const [rejectedDirectory, setRejectedDirectory] = useState<HandoffDestination>();
  const [missing, setMissing] = useState(false);
  const work = useRef<AbortController | null>(null);
  const workspaceTrigger = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const pendingNotice = useRef<HTMLDivElement>(null);
  const liveTargets = useRef(targets);
  liveTargets.current = targets;
  useEffect(() => () => work.current?.abort(), []);
  const devices = targets.filter((item) => item.runtime_kind === "device_agent" && item.device_id);
  const selected = devices.find((item) => item.device_id === deviceId);
  const workspace = selected?.workspaces.find((item) => item.id === workspaceId);
  const availableInDirectory = !!selected?.online && !!workspace;
  const active = pending.find(
    (item) => item.deviceId === deviceId && item.workspaceId === workspaceId,
  );
  const otherPending = pending.filter((item) => item !== active);

  const deviceName = selected?.name ?? active?.deviceName ?? destination.deviceName;
  const workspaceName = workspace?.name ?? active?.workspaceName ?? destination.workspaceName;
  const workspacePath = active?.workspacePath ?? destination.workspacePath ?? workspace?.path;
  const currentPath = workspace?.path;
  const pathPublished = hasWorkspaceDirectory(currentPath);
  const directoryUnavailable = availableInDirectory && !pathPublished;
  const workspaceMoved = pathPublished && !matchesSelectedPath(workspacePath, currentPath);
  const directoryRejected = (targetDevice: string, targetId: string, path?: string) =>
    rejectedDirectory?.deviceId === targetDevice &&
    rejectedDirectory.workspaceId === targetId &&
    rejectedDirectory.workspacePath === path;
  const staleDirectory = directoryRejected(deviceId, workspaceId, workspace?.path);
  const canReachTarget =
    availableInDirectory &&
    hasWorkspaceDirectory(workspacePath) &&
    pathPublished &&
    !workspaceMoved &&
    !staleDirectory;
  useEffect(() => {
    if (
      !busy &&
      staleDirectory &&
      (document.activeElement === document.body || document.activeElement === confirmButton.current)
    )
      workspaceTrigger.current?.focus({ preventScroll: true });
  }, [busy, staleDirectory]);
  let unavailableMessage = "";
  if (!active && deviceId) {
    if (!selected?.online) {
      unavailableMessage = label(
        "所选设备暂不可用。等待设备恢复连接，或选择其他设备。",
        "The selected device is unavailable. Wait for it to reconnect or choose another device.",
      );
    } else if (!selected.workspaces.length || (workspaceId && !workspace)) {
      unavailableMessage = label(
        "所选设备上的工作区暂不可用。等待工作区恢复，或选择其他目标。",
        "The workspace on the selected device is unavailable. Wait for it to return or choose another destination.",
      );
    } else if (directoryUnavailable || !hasPublishedWorkspace(selected)) {
      unavailableMessage = label(
        "设备尚未公布所选目录的路径。等待设备同步后重试，或选择其他工作区。",
        "The device hasn't published the selected directory path. Wait for it to sync or choose another workspace.",
      );
    } else if (workspaceMoved && !error) {
      unavailableMessage = label(
        "工作区的目录路径已变化。请重新选择工作区。",
        "The workspace directory path changed. Choose the workspace again.",
      );
    }
  } else if (
    !deviceId &&
    devices.some((item) => item.online && item.workspaces.length > 0) &&
    !devices.some((item) => item.online && hasPublishedWorkspace(item))
  ) {
    unavailableMessage = label(
      "在线设备尚未公布工作区路径。请在设备上打开工作区，等待目录同步。",
      "Online devices haven't published workspace paths. Open a workspace on the device and wait for it to sync.",
    );
  }

  function chooseDestination(next: HandoffDestination) {
    setDestination(next);
    setError("");
    setMissing(false);
  }

  function forgetPending(item: PendingWorkspaceHandoff) {
    window.sessionStorage.removeItem(item.storageKey);
    setPending((current) => current.filter((entry) => entry.storageKey !== item.storageKey));
  }

  async function submit(retryCopy = false) {
    if (work.current || !canReachTarget || !selected || !workspace || !workspacePath || receipt)
      return;
    const prior = active;
    if (retryCopy && !prior) return;
    const checkOnly = !!prior && !retryCopy;
    const abort = new AbortController();
    work.current = abort;
    setAction(checkOnly ? "check" : "copy");
    setError("");
    setMissing(false);
    const operationId = prior?.operationId ?? createUuid();
    const target = { deviceId, workspaceId, workspacePath, operationId, signal: abort.signal };
    const names = prior
      ? { deviceName: prior.deviceName, workspaceName: prior.workspaceName }
      : { deviceName: selected.name, workspaceName: workspace.name };
    let pendingRecord = prior;
    let dispatch = false;
    try {
      let result: string | null;
      if (checkOnly) {
        result = await send({ ...target, checkOnly: true });
      } else {
        const { blob, filename } = await read(abort.signal);
        abort.signal.throwIfAborted();
        if (blob.size > 32 * 1024 * 1024) throw new WorkspaceHandoffRejected("too-large");
        const currentDevice = liveTargets.current.find(
          (item) => item.runtime_kind === "device_agent" && item.device_id === deviceId,
        );
        const currentWorkspace = currentDevice?.workspaces.find((item) => item.id === workspaceId);
        if (
          !currentDevice?.online ||
          !currentWorkspace ||
          !matchesSelectedPath(workspacePath, currentWorkspace.path)
        )
          return;
        pendingRecord = savePendingWorkspaceHandoff(
          storageScope,
          { deviceId, workspaceId, operationId, ...names, workspacePath },
          prior,
        );
        const recorded = pendingRecord;
        setPending((current) => [
          ...current.filter((entry) => entry.storageKey !== recorded.storageKey),
          recorded,
        ]);
        dispatch = true;
        result = await send({ ...target, filename, blob });
      }
      if (abort.signal.aborted) return;
      if (result === null && checkOnly) {
        setMissing(true);
        return;
      }
      if (!result) throw new Error("Workspace transfer result is unknown");
      if (pendingRecord) forgetPending(pendingRecord);
      setReceipt({
        path: result,
        target: `${names.deviceName} · ${names.workspaceName}`,
        workspacePath,
      });
    } catch (cause) {
      if (!abort.signal.aborted) {
        // Native invokes can cross module realms. Only the explicit transport rejection
        // flag means a copy did not start, and it cannot dismiss an earlier uncertain copy.
        const reason =
          cause && typeof cause === "object" && "workspaceHandoffReason" in cause
            ? cause.workspaceHandoffReason
            : null;
        if (reason && dispatch && !prior && pendingRecord) forgetPending(pendingRecord);
        if (reason === "target-changed" && !prior)
          setRejectedDirectory({ deviceId, workspaceId, workspacePath });
        switch (reason) {
          case "target":
          case "authorization":
            setError(
              label(
                "所选工作区暂不可用。请检查设备连接和权限。",
                "Check the selected device and workspace permissions.",
              ),
            );
            break;
          case "target-changed":
            setError(
              prior
                ? label(
                    "设备上的原目录已变化。恢复原路径后再核对。",
                    "The original directory changed. Restore its path before checking again.",
                  )
                : label(
                    "设备上的目录已变化。列表更新后，请重新选择工作区。",
                    "The directory changed on the device. Choose it again once the list updates.",
                  ),
            );
            break;
          case "gateway-upgrade":
            setError(
              label(
                "服务器需要更新后才能核对目标目录。",
                "The gateway needs an update to confirm the destination directory.",
              ),
            );
            break;
          case "device-upgrade":
            setError(
              label(
                "请更新目标设备上的 ZeroAgent 后再传输。",
                "Update ZeroAgent on the target device before transferring.",
              ),
            );
            break;
          case "too-large":
            setError(
              label("工作区交接支持最大 32 MB 的文件。", "Transfers support files up to 32 MB."),
            );
            break;
          case "request":
            setError(
              label(
                "设备拒绝了本次复制。请检查目标工作区。",
                "The device rejected the copy. Check the target workspace.",
              ),
            );
            break;
          default:
            if (checkOnly)
              setError(
                label(
                  "暂时无法核对设备上的回执，请稍后再试。",
                  "Couldn't check the device receipt. Try again.",
                ),
              );
            else if (!dispatch)
              setError(
                label(
                  "未能读取原件或准备传输。请重试。",
                  "Couldn't read the original or prepare the transfer. Try again.",
                ),
              );
        }
      }
    } finally {
      if (work.current === abort) work.current = null;
      if (!abort.signal.aborted) setAction(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        layout="fullscreen-mobile"
        showCloseButton
        closeDisabled={busy}
        closeLabel={label("关闭", "Close")}
        className="flex max-h-[min(90dvh,44rem)] flex-col overflow-hidden max-[720px]:max-h-none max-[720px]:max-w-svw"
      >
        <DialogHeader>
          <DialogTitle>{label("发送到工作区", "Send to workspace")}</DialogTitle>
          <DialogDescription className="break-words">
            {source.name}
            {source.artifactNumber === undefined
              ? null
              : label(` · 版本 ${source.artifactNumber}`, ` · Version ${source.artifactNumber}`)}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {receipt ? (
            <div role="status" className="space-y-2">
              <p className="font-medium">{label("已复制到工作区", "Copied to workspace")}</p>
              <p className={`text-sm text-muted-foreground ${TARGET_PATH_CLASS}`}>
                {receipt.target}
              </p>
              {receipt.workspacePath && (
                <p className={`text-xs text-muted-foreground ${TARGET_PATH_CLASS}`}>
                  {receipt.workspacePath}
                </p>
              )}
              <p className="break-all rounded-lg bg-muted p-3 text-sm">{receipt.path}</p>
            </div>
          ) : (
            <>
              {otherPending.length > 0 && (
                <section
                  className="space-y-1"
                  aria-label={label("待核对的传输", "Unconfirmed transfers")}
                >
                  <p className="text-sm font-medium">
                    {label("待核对的传输", "Unconfirmed transfers")}
                  </p>
                  <ul className="divide-y divide-border/60">
                    {otherPending.map((item) => {
                      const { deviceName, workspaceName } = item;
                      return (
                        <li key={item.storageKey}>
                          <Button
                            variant="ghost"
                            className="h-auto min-h-11 w-full min-w-0 justify-between gap-2 px-2 py-2 text-left font-normal"
                            disabled={busy}
                            onClick={() => {
                              chooseDestination({
                                deviceId: item.deviceId,
                                workspaceId: item.workspaceId,
                                deviceName,
                                workspaceName,
                                workspacePath: item.workspacePath,
                              });
                              requestAnimationFrame(() =>
                                pendingNotice.current?.focus({ preventScroll: true }),
                              );
                            }}
                          >
                            <span className={`min-w-0 ${TARGET_PATH_CLASS}`}>
                              {deviceName} · {workspaceName}
                              {item.workspacePath && (
                                <span className="block text-xs text-muted-foreground">
                                  {item.workspacePath}
                                </span>
                              )}
                            </span>
                            <ChevronRight
                              className="size-4 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
              <div className="space-y-1.5">
                <label htmlFor={deviceControlId} className="block text-sm font-medium">
                  {label("设备", "Device")}
                </label>
                <Select
                  value={deviceId || null}
                  disabled={busy || !devices.length}
                  onValueChange={(value) => {
                    const device = devices.find((item) => item.device_id === value);
                    if (!device?.online || !hasPublishedWorkspace(device)) return;
                    chooseDestination({
                      deviceId: value,
                      deviceName: device.name,
                      workspaceId: "",
                    });
                  }}
                >
                  <SelectTrigger
                    id={deviceControlId}
                    aria-label={label("设备", "Device")}
                    className="h-auto min-h-11 w-full gap-2"
                  >
                    <SelectValue
                      className={`min-w-0 text-left ${TARGET_PATH_CLASS}`}
                      placeholder={label("选择设备", "Choose device")}
                    >
                      {deviceName}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent className={TARGET_OPTIONS_CLASS}>
                    {devices.map((item) => (
                      <SelectItem
                        key={item.device_id}
                        value={item.device_id}
                        disabled={!item.online || !hasPublishedWorkspace(item)}
                        className={`min-h-11 ${TARGET_PATH_CLASS}`}
                      >
                        {item.name}
                        {!item.online
                          ? label(" · 离线", " · Offline")
                          : !item.workspaces.length
                            ? label(" · 无可用工作区", " · No workspaces")
                            : !hasPublishedWorkspace(item)
                              ? label(" · 未公布目录路径", " · Directory paths unavailable")
                              : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor={workspaceControlId} className="block text-sm font-medium">
                  {label("工作区", "Workspace")}
                </label>
                <Select
                  value={(workspaceMoved || staleDirectory) && !active ? null : workspaceId || null}
                  disabled={busy || !selected?.online || !hasPublishedWorkspace(selected)}
                  onValueChange={(value) => {
                    const next = selected?.workspaces.find((item) => item.id === value);
                    if (
                      !next ||
                      !hasWorkspaceDirectory(next.path) ||
                      directoryRejected(deviceId, next.id, next.path)
                    )
                      return;
                    chooseDestination({
                      ...destination,
                      workspaceId: value,
                      workspaceName: next.name,
                      workspacePath: next.path,
                    });
                  }}
                >
                  <SelectTrigger
                    id={workspaceControlId}
                    ref={workspaceTrigger}
                    aria-label={label("工作区", "Workspace")}
                    aria-describedby={workspacePath ? workspacePathId : undefined}
                    className="h-auto min-h-11 w-full gap-2"
                  >
                    <SelectValue
                      className={`min-w-0 text-left ${TARGET_PATH_CLASS}`}
                      placeholder={label("选择工作区", "Choose workspace")}
                    >
                      {workspaceName}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent className={TARGET_OPTIONS_CLASS}>
                    {selected?.workspaces.map((item) => (
                      <SelectItem
                        key={item.id}
                        value={item.id}
                        disabled={
                          !hasWorkspaceDirectory(item.path) ||
                          directoryRejected(deviceId, item.id, item.path)
                        }
                        className={`min-h-11 ${TARGET_PATH_CLASS}`}
                        description={
                          <span className={`block ${TARGET_PATH_CLASS}`}>
                            {hasWorkspaceDirectory(item.path)
                              ? item.path
                              : label("未公布目录路径", "Directory path unavailable")}
                          </span>
                        }
                      >
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {workspacePath && (
                  <p
                    id={workspacePathId}
                    className={`px-1 text-xs text-muted-foreground ${TARGET_PATH_CLASS}`}
                  >
                    {workspacePath}
                  </p>
                )}
              </div>
              {!devices.length && !pending.length && !deviceId && (
                <p className="text-sm text-muted-foreground">
                  {label("账户暂无可选设备。", "No devices are available for this account.")}
                </p>
              )}
              {unavailableMessage && (
                <StatusNotice compact tone="warning" message={unavailableMessage} />
              )}
              {active && !busy && (
                <StatusNotice
                  ref={pendingNotice}
                  tabIndex={-1}
                  compact
                  tone="warning"
                  message={
                    workspaceMoved
                      ? label(
                          "原工作区的目录路径已变化。恢复原路径后可以核对这次传输。",
                          "The original workspace directory path changed. Restore its path to check this transfer.",
                        )
                      : directoryUnavailable
                        ? label(
                            "设备暂未公布原目录路径。恢复后可继续核对原传输。",
                            "The device hasn't published the original directory path. Check the same transfer once it returns.",
                          )
                        : !canReachTarget
                          ? label(
                              "原目标暂不可用。恢复连接或权限后可核对这次传输。",
                              "The original destination is unavailable. Check this transfer when the connection or access is restored.",
                            )
                          : missing
                            ? label(
                                "设备暂未找到回执。可稍后再核对，或用原编号重试复制。",
                                "The device hasn't found a receipt. Check again later or retry the same copy.",
                              )
                            : label(
                                "结果待核对。核对只读取设备回执。",
                                "The result is unconfirmed. Check the receipt on the device.",
                              )
                  }
                  actions={
                    missing ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="max-sm:min-h-11"
                        disabled={!canReachTarget}
                        onClick={() => void submit(true)}
                      >
                        {label("重试复制", "Retry copy")}
                      </Button>
                    ) : null
                  }
                />
              )}
              {error && <StatusNotice compact tone="error" message={error} />}
            </>
          )}
        </DialogBody>
        <DialogFooter className="max-[720px]:border-t max-[720px]:border-border/60">
          <DialogActions className="max-sm:[&>button]:min-h-11">
            <Button variant={receipt ? "default" : "ghost"} disabled={busy} onClick={onClose}>
              {receipt ? label("完成", "Done") : label("取消", "Cancel")}
            </Button>
            {!receipt && (
              <Button
                ref={confirmButton}
                disabled={!canReachTarget || busy}
                onClick={() => void submit()}
              >
                {action
                  ? action === "check"
                    ? label("正在核对…", "Checking…")
                    : label("正在传输…", "Transferring…")
                  : active
                    ? label("核对传输", "Check transfer")
                    : label("确认复制", "Confirm copy")}
              </Button>
            )}
          </DialogActions>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
