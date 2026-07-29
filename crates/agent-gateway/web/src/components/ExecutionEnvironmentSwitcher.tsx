import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Cloud, MonitorSmartphone } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  type ExecutionEnvironment,
  type ExecutionSelection,
  type ExecutionWorkspace,
} from "@/lib/executionTargets";

type Props = {
  environments: ExecutionEnvironment[];
  selection: ExecutionSelection | null;
  disabled?: boolean;
  onSwitch: (environment: ExecutionEnvironment, workspace: ExecutionWorkspace) => Promise<unknown>;
};

export function ExecutionEnvironmentSwitcher({
  environments,
  selection,
  disabled,
  onSwitch,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [switchingKey, setSwitchingKey] = useState("");

  const current = useMemo(
    () =>
      environments.find(
        (environment) =>
          environment.runtime_kind === selection?.runtime_kind &&
          (environment.device_id ?? "") === (selection?.device_id ?? ""),
      ),
    [environments, selection],
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
      const width = Math.min(300, window.innerWidth - viewportPadding * 2);
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
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  async function choose(environment: ExecutionEnvironment) {
    if (!environment.online || disabled) return;
    if (
      environment.runtime_kind === selection?.runtime_kind &&
      (environment.device_id ?? "") === (selection.device_id ?? "")
    ) {
      setOpen(false);
      return;
    }
    const key = `${environment.runtime_kind}:${environment.device_id ?? "web"}`;
    setSwitchingKey(key);
    setError("");
    try {
      const workspace = environment.workspaces[0] ?? { id: "", name: "" };
      await onSwitch(environment, workspace);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "切换失败");
    } finally {
      setSwitchingKey("");
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
          {current?.runtime_kind === "web_chat" ? (
            <Cloud className="h-4 w-4 shrink-0" />
          ) : (
            <MonitorSmartphone className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate text-xs font-medium">
            {current?.name ?? "选择设备"}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>

        {open && menuPosition
          ? createPortal(
              <div
                ref={menuRef}
                className="fixed z-[1000] overflow-y-auto rounded-md border bg-popover p-1 shadow-xl"
                style={menuPosition}
              >
                {environments.map((environment) => {
                  const key = `${environment.runtime_kind}:${environment.device_id ?? "web"}`;
                  const selected =
                    environment.runtime_kind === selection?.runtime_kind &&
                    (environment.device_id ?? "") === (selection?.device_id ?? "");
                  const switching = switchingKey === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      disabled={!environment.online || Boolean(switchingKey)}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-xs transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                      onClick={() => void choose(environment)}
                    >
                      {environment.runtime_kind === "web_chat" ? (
                        <Cloud className="h-3.5 w-3.5" />
                      ) : (
                        <MonitorSmartphone className="h-3.5 w-3.5" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{environment.name}</span>
                      <span
                        title={environment.online ? "在线" : "离线"}
                        aria-label={environment.online ? "在线" : "离线"}
                        className={
                          environment.online
                            ? "h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                            : "h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/45"
                        }
                      />
                      {switching ? (
                        <span className="text-muted-foreground">...</span>
                      ) : selected ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                      ) : null}
                    </button>
                  );
                })}
                {error ? <p className="px-2 pb-1 pt-1 text-xs text-destructive">{error}</p> : null}
              </div>,
              document.body,
            )
          : null}
      </div>
    </>
  );
}
