import type { WorkbenchNavigationPortal } from "@liveagent/ui/application/workbenchNavigationPortal";
import { Globe, Loader2, X } from "@liveagent/ui/components/IconSet";
import {
  WorkspaceMainPanel,
  WorkspacePanelGroup,
  WorkspaceToolsPanel,
} from "@liveagent/ui/components/project-tools/WorkspacePanels";
import { Button } from "@liveagent/ui/components/ui/button";
import { StatusNotice } from "@liveagent/ui/components/ui/status-notice";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WindowsTitleBar } from "../components/WindowsTitleBar";
import { canOpenWorkbenchBrowser } from "../components/workbench-browser/WorkbenchBrowserPane";
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

const BrowserPane = lazy(async () => ({
  default: (await import("../components/workbench-browser/WorkbenchBrowserPane"))
    .WorkbenchBrowserPane,
}));

type Props = Pick<
  import("@/lib/desktopRemoteHost").DesktopRemoteHost,
  "accountNavigation" | "onAccountSurface"
> & {
  initialView?: "cron-hub";
  settings: AppSettings;
  environment: DesktopEnvironment;
  selectedDeviceMissing?: boolean;
  environments: DesktopEnvironment[];
  selectionLease: string;
  expiresAt: number;
  selectionError?: string;
  headerLeadingActions?: ReactNode;
  navigationUpdate?: ReactNode;
  settingsNavigation?: WorkbenchNavigationPortal;
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
  const selectedDeviceMissing = Boolean(props.selectedDeviceMissing);
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
  const [browser, setBrowser] = useState<{ id: string; url: string } | null>(null);
  const [browserWidth, setBrowserWidth] = useState(520);
  const [browserConnection, setBrowserConnection] = useState<Awaited<
    ReturnType<typeof createDesktopRemoteHost>
  > | null>(null);
  const target = useMemo(
    () => ({ deviceId, selectionLease, expiresAt, selectionError, gatewayUrl, gatewayPort }),
    [deviceId, selectionLease, expiresAt, selectionError, gatewayUrl, gatewayPort],
  );
  const mountedTarget = useRef<typeof target | undefined>(undefined);
  // A listed device can reconnect on its current lease without discarding its workbench.
  const canStartOrKeep =
    !selectedDeviceMissing && (online || mountedTarget.current === target);
  const currentProps = useRef(props);
  currentProps.current = props;

  useEffect(() => {
    const { deviceId, selectionLease, expiresAt, selectionError, gatewayUrl, gatewayPort } = target;
    const snapshot = currentProps.current;
    if (
      snapshot.environment.device_id !== deviceId ||
      snapshot.settings.remote.gatewayUrl !== gatewayUrl ||
      snapshot.settings.remote.gatewayPort !== gatewayPort ||
      snapshot.selectionLease !== selectionLease ||
      snapshot.expiresAt !== expiresAt ||
      snapshot.selectionError !== selectionError
    )
      return;
    const controller = new AbortController();
    let workbench: { dispose(): void } | undefined;
    let host: Awaited<ReturnType<typeof createDesktopRemoteHost>> | undefined;
    let removeStyles: (() => void) | undefined;
    let timer: number | undefined;
    const dispose = () => {
      if (mountedTarget.current === target) mountedTarget.current = undefined;
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
    setBrowser(null);
    setBrowserConnection(null);
    setError("");
    setHeaderTarget(null);
    setWindowTarget(null);
    setUpdateTarget(null);
    if (selectionError) {
      setLoading(false);
      setError(selectionError);
      return dispose;
    }
    if (selectedDeviceMissing) {
      setLoading(false);
      setError("设备控制权限已失效，请重新授权设备或切换工作台。");
      return dispose;
    }
    if (
      !canStartOrKeep ||
      !isDesktopRemoteTargetAuthorized(snapshot.environment, selectionLease, expiresAt)
    ) {
      setLoading(false);
      setError(
        snapshot.environment.online
          ? "控制权限已过期，请重新选择并验证此设备。"
          : "设备离线，请在设备上线后重新连接。",
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
      setBrowserConnection(host);
      mountedTarget.current = target;
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
  }, [target, canStartOrKeep, selectedDeviceMissing]);

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
      <div className={loading || error ? "hidden" : "min-h-0 flex-1"}>
        <WorkspacePanelGroup
          open={Boolean(browser && browserConnection)}
          width={browserWidth}
          onWidthChange={setBrowserWidth}
          onClose={() => setBrowser(null)}
        >
          <WorkspaceMainPanel>
            <div ref={container} className="h-full min-h-0 w-full" />
          </WorkspaceMainPanel>
          <WorkspaceToolsPanel>
            {browser && browserConnection && !loading && !error ? (
              <section className="flex h-full min-h-0 flex-col">
                <header className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-xs">
                  <span className="truncate">{environment.name} · 浏览器</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="关闭浏览器"
                    onClick={() => setBrowser(null)}
                  >
                    <X className="size-4" />
                  </Button>
                </header>
                <Suspense fallback={null}>
                  <BrowserPane
                    key={browser.id}
                    id={browser.id}
                    url={browser.url}
                    active
                    scope={selectionLease}
                    onNavigate={() => {}}
                    onOpenTab={(url) => setBrowser({ id: createUuid(), url })}
                    openPrivateBrowserPort={browserConnection.openPrivateBrowserPort}
                  />
                </Suspense>
              </section>
            ) : null}
          </WorkspaceToolsPanel>
        </WorkspacePanelGroup>
      </div>
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
              {browserConnection && canOpenWorkbenchBrowser() ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-pressed={Boolean(browser)}
                  onClick={() =>
                    setBrowser((current) => (current ? null : { id: createUuid(), url: "" }))
                  }
                >
                  <Globe className="size-4" /> 浏览器
                </Button>
              ) : null}
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
      {updateTarget
        ? createPortal(
            <div data-desktop-remote-chrome-slot="update" className="contents">
              {props.navigationUpdate}
            </div>,
            updateTarget,
          )
        : null}
    </div>
  );
}
