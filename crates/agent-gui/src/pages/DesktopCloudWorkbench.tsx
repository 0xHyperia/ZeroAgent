import { AppHeaderFrame } from "@liveagent/ui/application/AppWorkbenchChrome";
import { Button } from "@liveagent/ui/components/ui/button";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DesktopCloudHost } from "@/lib/desktopRemoteHost";
import { isMacOsTauri } from "../components/MacOsTitleBarSpacer";
import { WindowsTitleBar } from "../components/WindowsTitleBar";
import { openDesktopCloudHost } from "../lib/relay/desktopCloudHost";
import {
  attachDesktopRemoteStyles,
  loadDesktopRemoteRuntime,
} from "../lib/relay/desktopRemoteRuntime";
import type { AppSettings } from "../lib/settings";

type Props = {
  active: boolean;
  accountId: number;
  settings: AppSettings;
  headerLeadingActions?: ReactNode;
  updateClientPreferences: NonNullable<DesktopCloudHost["updateClientPreferences"]>;
} & Pick<
  DesktopCloudHost,
  | "getHandoffEnvironments"
  | "sendWorkspaceHandoff"
  | "onLogout"
  | "onUserChange"
  | "registerNavigationGuard"
>;

export function DesktopCloudWorkbench(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef<{
    dispose(): void;
    setActive?(active: boolean): void;
  } | null>(null);
  const stylesheet = useRef<Awaited<ReturnType<typeof attachDesktopRemoteStyles>> | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  const [windowTarget, setWindowTarget] = useState<HTMLElement | null>(null);
  const { active, accountId, getHandoffEnvironments } = props;
  const handoffTargets = useMemo(() => getHandoffEnvironments?.() ?? [], [getHandoffEnvironments]);
  const currentHandoffTargets = useRef(handoffTargets);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reconnect creates a fresh transport.
  useEffect(() => {
    const controller = new AbortController();
    let retire: (() => void) | undefined;
    let removeStyles: Awaited<ReturnType<typeof attachDesktopRemoteStyles>> | undefined;
    let mountFailed = false;
    const fail = () => {
      if (controller.signal.aborted || mountFailed) return;
      mountFailed = true;
      retire?.();
      removeStyles?.();
      setReady(false);
      setFailed(true);
    };
    setFailed(false);
    setReady(false);
    setHeaderTarget(null);
    setWindowTarget(null);
    void (async () => {
      const prepared = await loadDesktopRemoteRuntime();
      if (controller.signal.aborted) return;
      const { host, dispose } = await openDesktopCloudHost(
        {
          onLogout: () => latest.current.onLogout(),
          onUserChange: (user) => latest.current.onUserChange(user),
          registerNavigationGuard: latest.current.registerNavigationGuard,
        },
        controller.signal,
      );
      retire = dispose;
      if (host.accountUser.id !== accountId) throw new Error("Cloud workbench account changed");
      removeStyles = await attachDesktopRemoteStyles(prepared.styles, controller.signal);
      if (controller.signal.aborted || !container.current) return;
      mounted.current = prepared.factory.createDesktopRemoteRuntime().mount(container.current, {
        ...host,
        initialActive: latest.current.active,
        nativeTitlebarInset: isMacOsTauri(),
        onHeaderTarget: (target) => {
          if (!controller.signal.aborted && !mountFailed) setHeaderTarget(target);
        },
        onWindowControlsTarget: (target) => {
          if (!controller.signal.aborted && !mountFailed) setWindowTarget(target);
        },
        onMountReady: () => {
          if (!controller.signal.aborted && !mountFailed) setReady(true);
        },
        onMountError: fail,
        clientPreferences: () => ({
          locale: latest.current.settings.locale,
          theme: latest.current.settings.theme,
        }),
        updateClientPreferences: (preferences) =>
          latest.current.updateClientPreferences(preferences),
        getHandoffEnvironments: () => currentHandoffTargets.current,
        sendWorkspaceHandoff: latest.current.sendWorkspaceHandoff
          ? async (request) => {
              const send = latest.current.sendWorkspaceHandoff;
              if (!send) throw new Error("Workspace transfer is unavailable");
              return send(request);
            }
          : undefined,
      });
      mounted.current.setActive?.(latest.current.active);
      stylesheet.current = removeStyles;
      stylesheet.current.setEnabled(latest.current.active);
    })().catch(fail);
    return () => {
      controller.abort();
      mounted.current?.dispose();
      mounted.current = null;
      stylesheet.current = null;
      retire?.();
      removeStyles?.();
    };
  }, [accountId, attempt]);
  useEffect(() => {
    currentHandoffTargets.current = handoffTargets;
    stylesheet.current?.setEnabled(active);
    mounted.current?.setActive?.(active);
  }, [active, handoffTargets]);

  const inCloudHeader = ready && headerTarget !== null && windowTarget !== null;

  return (
    <div
      hidden={!active}
      inert={!active}
      className={active ? "flex size-full min-h-0 flex-col" : "hidden"}
      data-desktop-cloud-workbench=""
    >
      {active &&
        (inCloudHeader ? (
          <>
            {createPortal(props.headerLeadingActions, headerTarget)}
            {createPortal(<WindowsTitleBar controlsOnly />, windowTarget)}
          </>
        ) : (
          <AppHeaderFrame>
            <div className="flex h-full items-center gap-3 px-4">
              {isMacOsTauri() && <div aria-hidden="true" className="w-18 shrink-0" />}
              {props.headerLeadingActions}
              <div data-tauri-drag-region="" className="h-full min-w-0 flex-1" />
              <WindowsTitleBar controlsOnly />
            </div>
          </AppHeaderFrame>
        ))}
      <div ref={container} className={ready ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"} />
      {!ready && (
        <div
          className="grid flex-1 place-items-center p-8 text-sm text-muted-foreground"
          role="status"
        >
          {failed ? (
            <div className="space-y-3 text-center">
              <p>
                {props.settings.locale === "zh-CN"
                  ? "暂时无法打开账户内容。"
                  : "Account content is temporarily unavailable."}
              </p>
              <div className="flex justify-center gap-2">
                <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
                  {props.settings.locale === "zh-CN" ? "重新连接" : "Reconnect"}
                </Button>
              </div>
            </div>
          ) : props.settings.locale === "zh-CN" ? (
            "正在打开云端工作台…"
          ) : (
            "Opening the cloud workbench…"
          )}
        </div>
      )}
    </div>
  );
}
