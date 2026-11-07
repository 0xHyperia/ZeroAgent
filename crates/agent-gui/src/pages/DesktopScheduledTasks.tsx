import type { CronRunRecord, ScheduledConversationRun } from "@liveagent/ui/lib/automation/types";
import type { TranscriptMessageJump } from "@liveagent/ui/lib/transcript-virtual/useTranscriptMessageJump";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { CloudScheduleWorkspace } from "@/components/cloudchat/CloudScheduleWorkspace";
import { DeviceScheduleEditor } from "@/components/cloudchat/DeviceScheduleEditor";
import { type CloudChatRoute, cloudChatRouteHref, readCloudChatRoute } from "@/lib/cloudChatRoute";
import { createCloudChatProjectsClient } from "@/lib/cloudChatProjects";
import { createCloudChatRunsClient } from "@/lib/cloudChatRuns";
import { createCloudSchedulesClient } from "@/lib/cloudSchedules";
import { createCloudSpaceClient } from "@/lib/cloudSpace";
import type { DesktopTaskConversation } from "@/lib/desktopRemoteHost";
import type { ExecutionEnvironment } from "@/lib/executionTargets";
import { relayProviderKeyId } from "@/lib/relay/providers";
import { openDesktopCloudConnection } from "../lib/relay/desktopCloudHost";
import { desktopDeviceSchedules } from "../lib/relay/desktopDeviceSchedules";
import type { AppSettings } from "../lib/settings";

type Route = Extract<CloudChatRoute, { page: "tasks" }>;
const routeBase = new URL("http://workbench.invalid/");

export function DesktopScheduledTasks({
  owner,
  settings,
  environments,
  onBack,
  onOpenDeviceConversation,
  renderDeviceConversation,
  onOpenRemoteTasks,
  onOpenAccountResult,
  renderTaskConversation,
  mobileRail,
  previewOpen,
  onPinSidebar,
  sidebarTarget,
  sidebarOnly,
  hideSidebar,
  onActivate,
}: {
  owner: number;
  settings: AppSettings;
  environments: ExecutionEnvironment[];
  onBack: () => void;
  onOpenDeviceConversation: (id: string) => void;
  renderDeviceConversation: (
    id: string,
    run: CronRunRecord,
    jump?: TranscriptMessageJump,
    scheduledRun?: ScheduledConversationRun,
  ) => ReactNode;
  onOpenRemoteTasks: (environment: ExecutionEnvironment) => Promise<void>;
  onOpenAccountResult: (href: string) => void;
  renderTaskConversation: (conversation: DesktopTaskConversation) => ReactNode;
  mobileRail?: ReactNode;
  previewOpen?: boolean;
  onPinSidebar?: () => void;
  sidebarTarget?: HTMLElement | null;
  sidebarOnly?: boolean;
  hideSidebar?: boolean;
  onActivate?: () => void;
}) {
  const storageKey = `zeroagent.desktop.task-route:${owner}`;
  const [route, setRoute] = useState<Route>(() => {
    const href = sessionStorage.getItem(storageKey);
    if (!href?.startsWith("/tasks")) return { page: "tasks" };
    const saved = readCloudChatRoute(new URL(href, routeBase));
    return saved.page === "tasks" ? saved : { page: "tasks" };
  });
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [taskConversation, setTaskConversation] = useState<DesktopTaskConversation>();
  const [clients, setClients] = useState<{
    schedules: ReturnType<typeof createCloudSchedulesClient>;
    runs: ReturnType<typeof createCloudChatRunsClient>;
    space: ReturnType<typeof createCloudSpaceClient>;
    projects: ReturnType<typeof createCloudChatProjectsClient>;
  }>();
  const device = useMemo(
    () => desktopDeviceSchedules(owner, settings.locale),
    [owner, settings.locale],
  );
  // A retry opens a fresh native connection without resetting the task view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly replaces the native connection.
  useEffect(() => {
    const controller = new AbortController();
    void openDesktopCloudConnection(controller.signal)
      .then((connection) => {
        if (controller.signal.aborted) return;
        if (connection.session.user.id !== owner) {
          connection.dispose();
          throw new Error("Account changed");
        }
        const guard = () => {
          if (!connection.isCurrent()) throw new Error("Account changed");
        };
        const request: typeof connection.request = async (path, init) => {
          const response = await connection.request(path, init);
          if (response.status === 401 && connection.isCurrent()) {
            connection.dispose();
            setClients(undefined);
            setFailed(true);
          }
          return response;
        };
        setClients({
          schedules: createCloudSchedulesClient(request, () => guard),
          runs: createCloudChatRunsClient(request),
          space: createCloudSpaceClient(request, () => guard),
          projects: createCloudChatProjectsClient(request, () => guard),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [owner, attempt]);

  const models = settings.customProviders.flatMap((provider) => {
    const keyId = relayProviderKeyId(provider.id);
    return keyId
      ? provider.models
          .filter((model) => provider.activeModels.includes(model.id))
          .map((model) => ({ name: model.displayName || model.id, model: model.id, keyId }))
      : [];
  });
  const selected = settings.selectedModel;
  const currentModel = models.find(
    (item) =>
      item.model === selected?.model &&
      item.keyId === relayProviderKeyId(selected.customProviderId ?? ""),
  ) ??
    models[0] ?? { name: "", model: "", keyId: 0 };

  return (
    <CloudScheduleWorkspace
      owner={owner}
      route={route}
      onNavigate={(next) => {
        setRoute(next);
        if (!sidebarOnly || next.id)
          sessionStorage.setItem(storageKey, cloudChatRouteHref(next, routeBase));
        if (sidebarOnly && next.id) onActivate?.();
      }}
      onBack={onBack}
      onOpenConversation={(id) =>
        onOpenAccountResult(cloudChatRouteHref({ page: "chat", id }, routeBase))
      }
      onSelectConversation={(selection) =>
        setTaskConversation((current) => ({
          ...selection,
          resource:
            current?.id === selection.id && current.runId === selection.runId
              ? current.resource
              : undefined,
        }))
      }
      renderConversation={
        sidebarOnly
          ? undefined
          : (id) => renderTaskConversation(taskConversation?.id === id ? taskConversation : { id })
      }
      onOpenResultResource={(id, resource) =>
        setTaskConversation((current) => ({
          ...(current?.id === id ? current : undefined),
          id,
          resource: { ...resource },
        }))
      }
      runClient={clients?.runs}
      space={clients?.space}
      projects={clients?.projects}
      schedules={clients?.schedules ?? null}
      onRetryCloud={
        failed
          ? () => {
              setFailed(false);
              setAttempt((value) => value + 1);
            }
          : undefined
      }
      device={device}
      onOpenDeviceConversation={onOpenDeviceConversation}
      renderDeviceConversation={sidebarOnly ? undefined : renderDeviceConversation}
      renderDeviceEditor={(props) => <DeviceScheduleEditor settings={settings} {...props} />}
      defaultCreationTarget={device.targetId}
      environments={environments}
      onOpenDevice={onOpenRemoteTasks}
      locale={settings.locale}
      fontScale={settings.customSettings.fontScale.sidebar}
      models={models}
      currentModel={currentModel}
      mobileRail={mobileRail}
      previewOpen={previewOpen}
      onPinSidebar={onPinSidebar}
      sidebarTarget={sidebarTarget}
      sidebarOnly={sidebarOnly}
      hideSidebar={hideSidebar}
      hostSidebarTrigger
    />
  );
}
