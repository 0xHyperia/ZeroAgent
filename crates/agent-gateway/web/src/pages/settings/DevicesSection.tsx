import {
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  SquarePen,
  Trash2,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ExecutionEnvironment,
  getExecutionEnvironments,
  mergeExecutionPresence,
  renameExecutionDevice,
  revokeExecutionDevice,
  subscribeExecutionPresence,
} from "../../lib/executionTargets";

function formatLastSeen(value?: string) {
  if (!value) return "暂无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "暂无记录"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function DevicesSection({
  onDirectoryChanged,
}: {
  onDirectoryChanged?: () => void | Promise<void>;
}) {
  const [devices, setDevices] = useState<ExecutionEnvironment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState("");
  const { confirm, dialog } = useConfirmDialog();
  const presenceRef = useRef<Parameters<typeof mergeExecutionPresence>[1]>([]);

  const loadDevices = useCallback(async (options: { background?: boolean } = {}) => {
    if (!options.background) {
      setLoading(true);
      setError("");
    }
    try {
      const environments = await getExecutionEnvironments();
      setDevices(
        mergeExecutionPresence(environments, presenceRef.current).filter(
          (item) => item.runtime_kind === "device_agent",
        ),
      );
    } catch (cause) {
      if (!options.background) {
        setError(cause instanceof Error ? cause.message : "加载设备失败");
      }
    } finally {
      if (!options.background) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    const timer = window.setInterval(() => {
      void loadDevices({ background: true });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [loadDevices]);

  useEffect(
    () =>
      subscribeExecutionPresence((presence) => {
        presenceRef.current = presence;
        setDevices((current) => mergeExecutionPresence(current, presence));
      }),
    [],
  );

  async function saveName(device: ExecutionEnvironment) {
    const name = draftName.trim();
    if (!device.device_id || !name || busyId) return;
    setBusyId(device.device_id);
    setError("");
    try {
      await renameExecutionDevice(device.device_id, name);
      setDevices((current) =>
        current.map((item) => (item.device_id === device.device_id ? { ...item, name } : item)),
      );
      setEditingId("");
      await onDirectoryChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重命名设备失败");
    } finally {
      setBusyId("");
    }
  }

  async function revoke(device: ExecutionEnvironment, trigger: HTMLElement) {
    if (!device.device_id || busyId) return;
    if (
      !(await confirm({
        title: "撤销设备授权？",
        description: `“${device.name}”会立即断开。`,
        confirmLabel: "撤销授权",
        cancelLabel: "取消",
        preferCancel: true,
        touchActions: true,
        returnFocusOnCancel: () => trigger,
      }))
    )
      return;
    setBusyId(device.device_id);
    setError("");
    try {
      await revokeExecutionDevice(device.device_id);
      setDevices((current) => current.filter((item) => item.device_id !== device.device_id));
      await onDirectoryChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "撤销设备失败");
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="space-y-4 border-t border-border/70 pt-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold">我的设备</h3>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => void loadDevices()}
          disabled={loading}
          aria-label="刷新设备"
          title="刷新设备"
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
      {!loading && !error && devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          尚未注册设备。登录 ZeroAgent 桌面客户端后，设备会自动出现在这里。
        </p>
      ) : null}

      <div className="grid gap-2">
        {devices.map((device) => {
          const id = device.device_id ?? "";
          const editing = editingId === id;
          return (
            <div
              key={id}
              className="settings-card-row settings-devices-card-row flex min-w-0 items-center gap-3 rounded-md border border-border/70 p-3 max-820:grid max-820:grid-cols-settings-devices-card-row"
            >
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${device.online ? "bg-emerald-500/10" : "bg-muted/60"}`}
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full ${device.online ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                />
              </div>
              <div className="settings-devices-card-main min-w-0 flex-1 max-820:min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  {editing ? (
                    <form
                      className="flex min-w-0 flex-1 gap-2 pointer-coarse:flex-wrap"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveName(device);
                      }}
                    >
                      <Input
                        value={draftName}
                        onChange={(event) => setDraftName(event.target.value)}
                        maxLength={100}
                        autoFocus
                        aria-label="设备名称"
                        className="h-8 min-w-0 pointer-coarse:h-11 pointer-coarse:basis-full pointer-coarse:text-base"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        className="pointer-coarse:min-h-11"
                        disabled={!draftName.trim() || Boolean(busyId)}
                      >
                        保存
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="pointer-coarse:min-h-11"
                        disabled={Boolean(busyId)}
                        onClick={() => setEditingId("")}
                      >
                        取消
                      </Button>
                    </form>
                  ) : (
                    <span
                      className="truncate text-sm font-medium pointer-coarse:whitespace-normal pointer-coarse:[overflow-wrap:anywhere]"
                      title={device.name}
                    >
                      {device.name}
                    </span>
                  )}
                </div>
                {!editing ? (
                  <div className="settings-devices-card-meta mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{device.online ? "在线" : "离线"}</span>
                    <span>
                      {[device.platform, device.version].filter(Boolean).join(" · ") || "未知平台"}
                    </span>
                    <span>最后活动：{formatLastSeen(device.last_seen_at)}</span>
                  </div>
                ) : null}
              </div>
              {!editing ? (
                <div className="settings-devices-card-actions flex shrink-0 flex-wrap items-center justify-end gap-1 max-820:col-span-full max-820:w-full max-820:[&_>_button]:min-w-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="重命名设备"
                    aria-label="重命名设备"
                    className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    disabled={Boolean(busyId)}
                    onClick={() => {
                      setEditingId(id);
                      setDraftName(device.name);
                    }}
                  >
                    <SquarePen className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="撤销设备"
                    aria-label="撤销设备"
                    disabled={Boolean(busyId)}
                    onClick={(event) => void revoke(device, event.currentTarget)}
                    className="text-destructive hover:text-destructive pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                  >
                    {busyId === id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {dialog}
    </section>
  );
}
