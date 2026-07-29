import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Cloud, Loader2, MonitorSmartphone, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  type ExecutionEnvironment,
  type ExecutionSelection,
  type ExecutionWorkspace,
  resolveExecutionTarget,
} from "@/lib/executionTargets";

type Props = {
  environments: ExecutionEnvironment[];
  selection: ExecutionSelection | null;
  activeWorkspaceId?: string;
  disabled?: boolean;
  onSwitch: (environment: ExecutionEnvironment, workspace: ExecutionWorkspace) => Promise<unknown>;
};

export function ExecutionEnvironmentSwitcher({
  environments,
  selection,
  activeWorkspaceId = "",
  disabled,
  onSwitch,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const [pending, setPending] = useState<{
    environment: ExecutionEnvironment;
    workspace: ExecutionWorkspace;
  } | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const current = useMemo(
    () => resolveExecutionTarget(environments, selection, activeWorkspaceId),
    [activeWorkspaceId, environments, selection],
  );

  useEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }
    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportPadding = 8;
      const gap = 8;
      const width = Math.min(380, window.innerWidth - viewportPadding * 2);
      const left = Math.min(
        Math.max(viewportPadding, rect.left),
        window.innerWidth - width - viewportPadding,
      );
      const availableBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
      const availableAbove = rect.top - gap - viewportPadding;
      if (availableBelow < 180 && availableAbove > availableBelow) {
        setMenuPosition({
          left,
          bottom: window.innerHeight - rect.top + gap,
          width,
          maxHeight: Math.min(520, Math.max(120, availableAbove)),
        });
        return;
      }
      setMenuPosition({
        left,
        top: rect.bottom + gap,
        width,
        maxHeight: Math.min(520, Math.max(120, availableBelow)),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  function choose(environment: ExecutionEnvironment, workspace: ExecutionWorkspace) {
    if (!environment.online || disabled) return;
    if (
      environment.runtime_kind === selection?.runtime_kind &&
      (environment.device_id ?? "") === (selection.device_id ?? "") &&
      workspace.id ===
        (selection.runtime_kind === "device_agent" ? activeWorkspaceId : selection.workspace_id)
    ) {
      setOpen(false);
      return;
    }
    setPending({ environment, workspace });
    setError("");
    setOpen(false);
  }

  async function confirm() {
    if (!pending) return;
    setSubmitting(true);
    setError("");
    try {
      await onSwitch(pending.environment, pending.workspace);
      setPending(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "切换失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="relative">
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          className="h-8 max-w-[min(18rem,42vw)] gap-1.5 rounded-lg px-2 text-muted-foreground hover:text-foreground"
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
        >
          {current.environment?.runtime_kind === "web_chat" ? (
            <Cloud className="h-4 w-4 shrink-0" />
          ) : (
            <MonitorSmartphone className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate text-xs font-medium">
            {current.environment?.name ?? "选择执行环境"}
            {current.workspace ? ` / ${current.workspace.name}` : ""}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>

        {open && menuPosition
          ? createPortal(
              <div
                className="fixed z-[1000] overflow-y-auto rounded-md border bg-popover p-1 shadow-xl"
                style={menuPosition}
              >
                {environments.map((environment) => (
                  <div key={`${environment.runtime_kind}:${environment.device_id ?? "web"}`}>
                    <div className="flex items-center gap-2 px-2 pb-1 pt-2 text-xs font-medium">
                      {environment.runtime_kind === "web_chat" ? (
                        <Cloud className="h-3.5 w-3.5" />
                      ) : (
                        <MonitorSmartphone className="h-3.5 w-3.5" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{environment.name}</span>
                      <span
                        className={
                          environment.online ? "text-emerald-600" : "text-muted-foreground"
                        }
                      >
                        {environment.online ? "在线" : "离线"}
                      </span>
                    </div>
                    {environment.workspaces.map((workspace) => (
                      <button
                        key={workspace.id}
                        type="button"
                        disabled={!environment.online}
                        className="flex w-full items-center gap-2 rounded-sm px-7 py-2 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                        onClick={() => choose(environment, workspace)}
                      >
                        <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                        {workspace.path && (
                          <span className="max-w-[160px] truncate text-muted-foreground">
                            {workspace.path}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                ))}
              </div>,
              document.body,
            )
          : null}
      </div>

      {pending && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-[380px] rounded-md border bg-background p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">确认切换执行环境</h2>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {pending.environment.name} / {pending.workspace.name}
                </p>
              </div>
              <button
                type="button"
                title="关闭"
                className="text-muted-foreground"
                onClick={() => setPending(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-5 text-xs text-muted-foreground">将在所选设备和工作区中继续操作。</p>
            {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPending(null)}>
                取消
              </Button>
              <Button disabled={submitting} onClick={() => void confirm()}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                确认切换
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
