import { Loader2 } from "@liveagent/ui/components/IconSet";
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
  headerLeadingActions?: ReactNode;
  onSelectionInvalid?: () => void;
};

/** Desktop chrome around the exact, independently bundled WebUI device workbench. */
export function RemoteDeviceWorkbench(props: Props) {
  const { environment, selectionLease, expiresAt, headerLeadingActions } = props;
  const deviceId = environment.device_id;
  const online = environment.online;
  const gatewayUrl = props.settings.remote.gatewayUrl;
  const gatewayPort = props.settings.remote.gatewayPort;
  const container = useRef<HTMLDivElement>(null);
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const [windowTarget, setWindowTarget] = useState<HTMLElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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
    const dispose = () => {
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
    if (
      !isDesktopRemoteTargetAuthorized({ device_id: deviceId, online }, selectionLease, expiresAt)
    ) {
      setLoading(false);
      setError(
        online ? "控制权限已过期，请重新选择并验证此设备。" : "设备离线，请在设备上线后重新连接。",
      );
      return dispose;
    }
    const timer = window.setTimeout(
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
        ...currentProps.current,
        signal: controller.signal,
        onHeaderTarget: setHeaderTarget,
        onWindowControlsTarget: setWindowTarget,
        onSelectionInvalid(reason) {
          setError(reason);
          setLoading(false);
          currentProps.current.onSelectionInvalid?.();
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
      setError(cause instanceof Error ? cause.message : "连接远程设备失败。");
      setLoading(false);
      currentProps.current.onSelectionInvalid?.();
      dispose();
    });
    return () => {
      window.clearTimeout(timer);
      dispose();
    };
  }, [deviceId, online, selectionLease, expiresAt, gatewayUrl, gatewayPort]);

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
        <div
          role="status"
          className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground"
        >
          {error}
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
    </div>
  );
}
