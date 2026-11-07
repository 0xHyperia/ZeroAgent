import type { AppSettings } from "@liveagent/ui/lib/settings/types";
import type { CronRunRecord, ScheduledConversationRun } from "@liveagent/ui/lib/automation/types";
import type { TranscriptMessageJump } from "@liveagent/ui/lib/transcript-virtual/useTranscriptMessageJump";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { backend } from "../../lib/automation/backend";
import {
  type CloudChatRoute,
  cloudChatRouteHref,
  readCloudChatRoute,
} from "../../lib/cloudChatRoute";
import { getDesktopRemoteHost } from "../../lib/desktopRemoteHost";
import { createDeviceScheduleHost } from "../../lib/deviceScheduleHost";
import { readCloudChatLocation, useCloudChatHistory } from "../../lib/useCloudChatHistory";
import { CloudScheduleWorkspace } from "./CloudScheduleWorkspace";
import { DeviceScheduleEditor } from "./DeviceScheduleEditor";

const routeBase = new URL("http://workbench.invalid/");
type Route = Extract<CloudChatRoute, { page: "tasks" }>;

export function ConnectedDeviceTasks({
  owner,
  deviceId,
  label,
  settings,
  requireCurrent,
  mobileRail,
  sidebarTarget,
  sidebarOnly = false,
  hideSidebar,
  previewOpen,
  onActivate,
  onPinSidebar,
  onBack,
  onOpenConversation,
  renderConversation,
}: {
  owner: number;
  deviceId: string;
  label: string;
  settings: AppSettings;
  requireCurrent: () => void;
  mobileRail?: ReactNode;
  sidebarTarget?: HTMLElement | null;
  sidebarOnly?: boolean;
  hideSidebar?: boolean;
  previewOpen?: boolean;
  onActivate?: () => void;
  onPinSidebar?: () => void;
  onBack: () => void;
  onOpenConversation: (id: string) => void;
  renderConversation: (
    id: string,
    run: CronRunRecord,
    jump?: TranscriptMessageJump,
    scheduledRun?: ScheduledConversationRun,
  ) => ReactNode;
}) {
  const storageKey = `zeroagent.device.task-route:${owner}:${deviceId}`;
  const browserHistory = !getDesktopRemoteHost();
  const [route, setRoute] = useState<Route>(() => {
    if (browserHistory) {
      const { route: linked } = readCloudChatLocation(owner);
      if (linked.page === "tasks" && linked.deviceView && linked.target === deviceId) return linked;
    }
    const stored = window.sessionStorage.getItem(storageKey);
    if (stored?.startsWith("/tasks")) {
      const parsed = readCloudChatRoute(new URL(stored, routeBase));
      if (parsed.page === "tasks") return parsed;
    }
    return { page: "tasks" };
  });
  const locale = settings.locale;
  const device = useMemo(
    () => createDeviceScheduleHost({ backend, targetId: deviceId, label, locale, requireCurrent }),
    [deviceId, label, locale, requireCurrent],
  );
  useEffect(() => {
    if (!sidebarOnly)
      window.sessionStorage.setItem(storageKey, cloudChatRouteHref(route, routeBase));
  }, [route, storageKey, sidebarOnly]);
  useCloudChatHistory({
    owner,
    active: browserHistory && !sidebarOnly,
    listen: browserHistory && !sidebarOnly,
    route: { ...route, target: deviceId, deviceView: true },
    conversation: "",
    apply: ({ route: next }) => {
      if (next.page === "tasks" && next.deviceView && next.target === deviceId) setRoute(next);
    },
    isDirty: () => false,
    confirm: (navigate) => navigate(),
  });

  return (
    <CloudScheduleWorkspace
      owner={owner}
      locale={locale}
      fontScale={settings.customSettings.fontScale.sidebar}
      route={route}
      onNavigate={(next) => {
        setRoute(next);
        if (sidebarOnly && next.id) {
          window.sessionStorage.setItem(storageKey, cloudChatRouteHref(next, routeBase));
          onActivate?.();
        }
      }}
      sidebarTarget={sidebarTarget}
      sidebarOnly={sidebarOnly}
      hideSidebar={hideSidebar}
      previewOpen={previewOpen}
      onPinSidebar={onPinSidebar}
      onBack={onBack}
      onOpenConversation={onOpenConversation}
      onOpenResultResource={() => undefined}
      device={device}
      onOpenDeviceConversation={onOpenConversation}
      renderDeviceConversation={sidebarOnly ? undefined : renderConversation}
      renderDeviceEditor={(props) => <DeviceScheduleEditor settings={settings} {...props} />}
      defaultCreationTarget={deviceId}
      environments={[]}
      onOpenDevice={async () => undefined}
      currentModel={{ name: "", model: "", keyId: 0 }}
      models={[]}
      schedules={null}
      includeCloud={false}
      mobileRail={mobileRail}
      hostSidebarTrigger
    />
  );
}
