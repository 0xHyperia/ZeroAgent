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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { useLocale } from "@liveagent/ui/i18n";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { useEffect, useRef, useState } from "react";
import type { CloudSpaceItem } from "../../lib/cloudSpace";
import type { ExecutionEnvironment } from "../../lib/executionTargets";
import type { WorkspaceHandoff } from "../../lib/workspaceHandoff";

export type WorkspaceHandoffSource = Pick<CloudSpaceItem, "kind" | "target_id" | "name">;

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
  send: (request: WorkspaceHandoff) => Promise<string>;
  onClose: () => void;
}) {
  const { locale } = useLocale();
  const label = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const [deviceId, setDeviceId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [unknown, setUnknown] = useState(false);
  const work = useRef<AbortController | null>(null);
  useEffect(() => () => work.current?.abort(), []);
  const devices = targets.filter((item) => item.runtime_kind === "device_agent" && item.device_id);
  const selected = devices.find((item) => item.device_id === deviceId);
  const workspace = selected?.workspaces.find((item) => item.id === workspaceId);
  const storageKey = `zeroagent.handoff:${owner}:${source.kind}:${source.target_id}:${deviceId}:${workspaceId}`;

  async function submit() {
    if (work.current || !selected?.online || !workspace || path) return;
    const abort = new AbortController();
    work.current = abort;
    setBusy(true);
    setError("");
    let dispatch = false;
    try {
      const { blob, filename } = await read(abort.signal);
      abort.signal.throwIfAborted();
      if (blob.size > 32 * 1024 * 1024)
        throw new Error(
          label("工作区交接支持最大 32 MB 的文件。", "Transfers support files up to 32 MB."),
        );
      const operationId = sessionStorage.getItem(storageKey) ?? createUuid();
      sessionStorage.setItem(storageKey, operationId);
      dispatch = true;
      const result = await send({
        deviceId,
        workspaceId,
        operationId,
        filename,
        blob,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      sessionStorage.removeItem(storageKey);
      setPath(result);
      setUnknown(false);
    } catch (cause) {
      if (!abort.signal.aborted) {
        setUnknown(dispatch || sessionStorage.getItem(storageKey) !== null);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (work.current === abort) work.current = null;
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        layout="fullscreen-mobile"
        showCloseButton
        closeDisabled={busy}
        closeLabel={label("关闭", "Close")}
      >
        <DialogHeader>
          <DialogTitle>{label("发送到工作区", "Send to workspace")}</DialogTitle>
          <DialogDescription className="break-words">{source.name}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {path ? (
            <div role="status" className="space-y-2">
              <p className="font-medium">{label("已复制到工作区", "Copied to workspace")}</p>
              <p className="text-sm text-muted-foreground">
                {selected?.name} · {workspace?.name}
              </p>
              <p className="break-all rounded-lg bg-muted p-3 text-sm">{path}</p>
            </div>
          ) : (
            <>
              <Select
                value={deviceId || null}
                disabled={busy}
                onValueChange={(value) => {
                  setDeviceId(value ?? "");
                  setWorkspaceId("");
                  setUnknown(false);
                  setError("");
                }}
              >
                <SelectTrigger aria-label={label("设备", "Device")} className="min-h-11 w-full">
                  <SelectValue placeholder={label("选择设备", "Choose device")}>
                    {selected?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {devices.map((item) => (
                    <SelectItem
                      key={item.device_id}
                      value={item.device_id}
                      disabled={!item.online || !item.workspaces.length}
                    >
                      {item.name}
                      {!item.online
                        ? label(" · 离线", " · Offline")
                        : !item.workspaces.length
                          ? label(" · 无可用工作区", " · No workspaces")
                          : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={workspaceId || null}
                disabled={busy || !selected?.online}
                onValueChange={(value) => {
                  setWorkspaceId(value ?? "");
                  setUnknown(false);
                  setError("");
                }}
              >
                <SelectTrigger
                  aria-label={label("工作区", "Workspace")}
                  className="min-h-11 w-full"
                >
                  <SelectValue placeholder={label("选择工作区", "Choose workspace")}>
                    {workspace?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {selected?.workspaces.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!devices.length && (
                <p className="text-sm text-muted-foreground">
                  {label("账户暂无可选设备。", "No devices are available for this account.")}
                </p>
              )}
              {unknown && (
                <p role="status" className="text-sm text-muted-foreground">
                  {label(
                    "结果待核对。再次确认会复用同一次传输。",
                    "The result is unconfirmed. Checking again uses the same transfer.",
                  )}
                </p>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogActions>
            <Button variant={path ? "default" : "ghost"} disabled={busy} onClick={onClose}>
              {path ? label("完成", "Done") : label("取消", "Cancel")}
            </Button>
            {!path && (
              <Button
                disabled={!selected?.online || !workspace || busy}
                onClick={() => void submit()}
              >
                {busy
                  ? label("正在传输…", "Transferring…")
                  : unknown
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
