import { Loader2 } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { StatusNotice } from "@liveagent/ui/components/ui/status-notice";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WindowsTitleBar } from "../components/WindowsTitleBar";
import type { DesktopEnvironment } from "../lib/relay/desktopExecution";
import {
  createDesktopRemoteHost,
  isDesktopRemoteTargetAuthorized,
} from "../lib/relay/desktopRemoteHost";
import {
  attachDesktopRemoteStyles,
  loadDesktopRemoteRuntime,
} from "../lib/relay/desktopRemoteRuntime";
import type { AppSettings } from "../lib/settings";

type Props = {
  settings: AppSettings;
  environment: DesktopEnvironment;
  environments: DesktopEnvironment[];
  selectionLease: string;
  expiresAt: number;
  selectionError?: string;
  headerLeadingActions?: ReactNode;
  navigationUpdate?: ReactNode;
  onSelectionInvalid?: (reason: string) => void;
  onReconnect: () => Promise<void>;
};

function connectionError(cause: unknown) {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === "string" && cause.trim()) return cause;
  return "连接远程设备失败。";
}

/** Desktop chrome around the exact, independently bundled WebUI device workbench. */
export function RemoteDeviceWorkbench(props: Props) {
  const { environment, selectionLease, expiresAt, selectionError, headerLeadingActions } = props;
  const deviceId = environment.device_id;
  const online = environment.online;
  const gatewayUrl = props.settings.remote.gatewayUrl;
  const gatewayPort = props.settings.remote.gatewayPort;
  const container = useRef<HTMLDivElement>(null);
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const [windowTarget, setWindowTarget] = useState<HTMLElement | null>(null);
  const [updateTarget, setUpdateTarget] = useState<HTMLElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const currentProps = useRef(props);
  currentProps.current = props;

  useEffect(() => {
    const snapshot = currentProps.current;
    if (
      snapshot.environment.device_id !== deviceId ||
      snapshot.environment.online !== online ||
      snapshot.settings.remote.gatewayUrl !== gatewayUrl ||
      snapshot.settings.remote.gatewayPort !== gatewayPort
    )
      return;
    const controller = new AbortController();
    let workbench: { dispose(): void } | undefined;
    let host: Awaited<ReturnType<typeof createDesktopRemoteHost>> | undefined;
    let removeStyles: (() => void) | undefined;
    let timer: number | undefined;
    const dispose = () => {
      window.clearTimeout(timer);
      controller.abort();
      workbench?.dispose();
      workbench = undefined;
      host?.dispose();
      host = undefined;
      removeStyles?.();
      removeStyles = undefined;
    };
    setLoading(true);
    setError("");
    setHeaderTarget(null);
    setWindowTarget(null);
    setUpdateTarget(null);
    if (selectionError) {
      setLoading(false);
      setError(selectionError);
      return dispose;
    }
    if (
      !isDesktopRemoteTargetAuthorized({ device_id: deviceId, online }, selectionLease, expiresAt)
    ) {
      setLoading(false);
      setError(
        online ? "控制权限已过期，请重新选择并验证此设备。" : "设备离线，请在设备上线后重新连接。",
      );
      return dispose;
    }
    timer = window.setTimeout(
      () => {
        setError("控制权限已过期，请重新选择并验证此设备。");
        setLoading(false);
        dispose();
      },
      Math.min(expiresAt - Date.now(), 2_147_483_647),
    );
    void (async () => {
      const prepared = await loadDesktopRemoteRuntime();
      if (controller.signal.aborted) return;
      host = await createDesktopRemoteHost({
        ...snapshot,
        signal: controller.signal,
        onHeaderTarget: setHeaderTarget,
        onWindowControlsTarget: setWindowTarget,
        onUpdateTarget: setUpdateTarget,
        onSelectionInvalid(reason) {
          if (controller.signal.aborted) return;
          setError(reason);
          setLoading(false);
          snapshot.onSelectionInvalid?.(reason);
          queueMicrotask(dispose);
        },
      });
      if (controller.signal.aborted) {
        host.dispose();
        return;
      }
      removeStyles = await attachDesktopRemoteStyles(prepared.styles, controller.signal);
      if (controller.signal.aborted || !container.current) return;
      workbench = prepared.factory.createDesktopRemoteRuntime().mount(container.current, host.host);
      setLoading(false);
    })().catch((cause) => {
      if (controller.signal.aborted) return;
      setError(connectionError(cause));
      setLoading(false);
      dispose();
    });
    return () => {
      window.clearTimeout(timer);
      dispose();
    };
  }, [deviceId, online, selectionLease, expiresAt, selectionError, gatewayUrl, gatewayPort]);

  async function reconnect() {
    setReconnecting(true);
    try {
      await currentProps.current.onReconnect();
    } catch (cause) {
      setError(connectionError(cause));
    } finally {
      setReconnecting(false);
    }
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-desktop-remote-workbench="">
      {(loading || error) && (
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-3">
          {headerLeadingActions}
          <span className="min-w-0 flex-1 truncate text-sm">{environment.name}</span>
          <WindowsTitleBar controlsOnly />
        </div>
      )}
      <div ref={container} className={loading || error ? "hidden" : "h-full min-h-0 flex-1"} />
      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在连接远程设备…
        </div>
      ) : null}
      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-sm text-muted-foreground">
          <StatusNotice
            message={error}
            tone="error"
            role="status"
            className="w-full max-w-lg"
            actions={
              <Button
                variant="outline"
                disabled={reconnecting || !online}
                onClick={() => void reconnect()}
              >
                {reconnecting && <Loader2 className="h-4 w-4 animate-spin" />}
                重新连接
              </Button>
            }
          />
        </div>
      ) : null}
      {headerTarget
        ? createPortal(
            <span data-desktop-remote-chrome-slot="device" className="contents">
              {headerLeadingActions}
            </span>,
            headerTarget,
          )
        : null}
      {windowTarget
        ? createPortal(
            <span data-desktop-remote-chrome-slot="window" className="contents">
              <WindowsTitleBar controlsOnly />
            </span>,
            windowTarget,
          )
        : null}
      {updateTarget ? createPortal(props.navigationUpdate, updateTarget) : null}
    </div>
  );
}
