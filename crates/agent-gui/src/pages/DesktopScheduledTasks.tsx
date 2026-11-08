import type { CronRunRecord, ScheduledConversationRun } from "@liveagent/ui/lib/automation/types";
import type { TranscriptMessageJump } from "@liveagent/ui/lib/transcript-virtual/useTranscriptMessageJump";
import { type ReactNode, useMemo, useState } from "react";
import { CloudScheduleWorkspace } from "@/components/cloudchat/CloudScheduleWorkspace";
import { DeviceScheduleEditor } from "@/components/cloudchat/DeviceScheduleEditor";
import { type CloudChatRoute, cloudChatRouteHref, readCloudChatRoute } from "@/lib/cloudChatRoute";
import { desktopDeviceSchedules } from "../lib/relay/desktopDeviceSchedules";
import type { AppSettings } from "../lib/settings";

type Route = Extract<CloudChatRoute, { page: "tasks" }>;
const routeBase = new URL("http://workbench.invalid/");

export function DesktopScheduledTasks({
  owner,
  settings,
  onBack,
  onOpenDeviceConversation,
  renderDeviceConversation,
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
  onBack: () => void;
  onOpenDeviceConversation: (id: string) => void;
  renderDeviceConversation: (
    id: string,
    run: CronRunRecord,
    jump?: TranscriptMessageJump,
    scheduledRun?: ScheduledConversationRun,
  ) => ReactNode;
  mobileRail?: ReactNode;
  previewOpen?: boolean;
  onPinSidebar?: () => void;
  sidebarTarget?: HTMLElement | null;
  sidebarOnly?: boolean;
  hideSidebar?: boolean;
  onActivate?: () => void;
}) {
  const device = useMemo(
    () => desktopDeviceSchedules(owner, settings.locale),
    [owner, settings.locale],
  );
  const storageKey = `zeroagent.desktop.task-route:${owner}`;
  const [route, setRoute] = useState<Route>(() => {
    const href = sessionStorage.getItem(storageKey);
    if (href?.startsWith("/tasks")) {
      const saved = readCloudChatRoute(new URL(href, routeBase));
      if (saved.page === "tasks" && (!saved.id || saved.target === device.targetId))
        return { ...saved, scope: undefined };
    }
    return { page: "tasks" };
  });

  return (
    <CloudScheduleWorkspace
      owner={owner}
      locale={settings.locale}
      fontScale={settings.customSettings.fontScale.sidebar}
      route={route}
      onNavigate={(next) => {
        setRoute(next);
        if (!sidebarOnly || next.id)
          sessionStorage.setItem(storageKey, cloudChatRouteHref(next, routeBase));
        if (sidebarOnly && next.id) onActivate?.();
      }}
      onBack={onBack}
      onOpenConversation={onOpenDeviceConversation}
      onOpenResultResource={() => undefined}
      device={device}
      onOpenDeviceConversation={onOpenDeviceConversation}
      renderDeviceConversation={sidebarOnly ? undefined : renderDeviceConversation}
      renderDeviceEditor={(props) => <DeviceScheduleEditor settings={settings} {...props} />}
      defaultCreationTarget={device.targetId}
      environments={[]}
      onOpenDevice={async () => undefined}
      currentModel={{ name: "", model: "", keyId: 0 }}
      models={[]}
      schedules={null}
      includeCloud={false}
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
