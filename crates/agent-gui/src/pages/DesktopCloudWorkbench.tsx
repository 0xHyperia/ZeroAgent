import { Button } from "@liveagent/ui/components/ui/button";
import { useEffect, useRef, useState } from "react";
import type {
  DesktopAccountLayout,
  DesktopCloudHost,
  DesktopTaskConversation,
} from "@/lib/desktopRemoteHost";
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
  taskConversation?: DesktopTaskConversation;
  updateClientPreferences: NonNullable<DesktopCloudHost["updateClientPreferences"]>;
  accountLayout?: DesktopAccountLayout;
  onLocationChange?: (href: string) => void;
  onOpenScheduledTasks: () => void;
} & Pick<
  DesktopCloudHost,
  | "getEnvironments"
  | "onSwitch"
  | "onOpenDeviceTasks"
  | "onOpenDeviceSettings"
  | "getHandoffEnvironments"
  | "sendWorkspaceHandoff"
  | "onLogout"
  | "onUserChange"
>;

export function DesktopCloudWorkbench(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef<{
    dispose(): void;
    setActive?(active: boolean): void;
    setAccountLayout?(layout: DesktopAccountLayout): void;
    setTaskConversation?(conversation: DesktopTaskConversation): void;
  } | null>(null);
  const stylesheet = useRef<Awaited<ReturnType<typeof attachDesktopRemoteStyles>> | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const { active, accountId, accountLayout, taskConversation } = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reconnect creates a fresh transport.
  useEffect(() => {
    const controller = new AbortController();
    let retire: (() => void) | undefined;
    let removeStyles: Awaited<ReturnType<typeof attachDesktopRemoteStyles>> | undefined;
    setError("");
    setReady(false);
    void (async () => {
      const prepared = await loadDesktopRemoteRuntime();
      if (controller.signal.aborted) return;
      const { host, dispose } = await openDesktopCloudHost(
        {
          getEnvironments: () => latest.current.getEnvironments(),
          onSwitch: (environment) => latest.current.onSwitch(environment),
          onOpenDeviceTasks: (environment) => latest.current.onOpenDeviceTasks(environment),
          onLogout: () => latest.current.onLogout(),
          onUserChange: (user) => latest.current.onUserChange(user),
          onHeaderTarget: () => undefined,
          onLocationChange: (href) => latest.current.onLocationChange?.(href),
        },
        controller.signal,
      );
      retire = dispose;
      if (host.accountUser.id !== accountId) throw new Error("Cloud workbench account changed");
      removeStyles = await attachDesktopRemoteStyles(prepared.styles, controller.signal);
      if (controller.signal.aborted || !container.current) return;
      mounted.current = prepared.factory.createDesktopRemoteRuntime().mount(container.current, {
        ...host,
        taskConversation: latest.current.taskConversation,
        accountLayout: latest.current.accountLayout,
        initialActive: latest.current.active,
        clientPreferences: () => ({
          locale: latest.current.settings.locale,
          theme: latest.current.settings.theme,
        }),
        updateClientPreferences: (preferences) =>
          latest.current.updateClientPreferences(preferences),
        onOpenScheduledTasks: () => latest.current.onOpenScheduledTasks(),
        onOpenDeviceSettings: (section) => latest.current.onOpenDeviceSettings?.(section),
        getHandoffEnvironments: () => latest.current.getHandoffEnvironments?.() ?? [],
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
      setReady(true);
    })().catch((cause) => {
      if (controller.signal.aborted) return;
      retire?.();
      removeStyles?.();
      setError(cause instanceof Error ? cause.message : String(cause));
    });
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
    stylesheet.current?.setEnabled(active);
    mounted.current?.setActive?.(active);
  }, [active]);
  useEffect(() => {
    if (accountLayout) mounted.current?.setAccountLayout?.(accountLayout);
  }, [accountLayout]);
  useEffect(() => {
    if (taskConversation) mounted.current?.setTaskConversation?.(taskConversation);
  }, [taskConversation]);

  return (
    <div
      hidden={!active}
      inert={!active}
      className={active ? "flex size-full min-h-0 flex-col" : "hidden"}
      data-desktop-cloud-workbench=""
    >
      <div ref={container} className={ready ? "flex min-h-0 flex-1 flex-col" : "hidden"} />
      {!ready && (
        <div
          className="grid flex-1 place-items-center p-8 text-sm text-muted-foreground"
          role="status"
        >
          {error ? (
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
            taskConversation ? (
              "正在读取任务对话…"
            ) : (
              "正在打开账户内容…"
            )
          ) : taskConversation ? (
            "Loading task conversation…"
          ) : (
            "Opening account content…"
          )}
        </div>
      )}
    </div>
  );
}
