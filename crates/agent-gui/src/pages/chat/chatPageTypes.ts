import type { Context } from "@liveagent/app/lib/agentTypes";
import type { ImageStudioHost } from "@liveagent/ui/application/imageStudioHost";
import type {
  WorkbenchAccountNavigation,
  WorkbenchAccountSurface,
} from "@liveagent/ui/application/workbenchAccountSurface";
import type { WorkbenchNavigationPortal } from "@liveagent/ui/application/workbenchNavigationPortal";
import type { CronRunRecord, ScheduledConversationRun } from "@liveagent/ui/lib/automation/types";
import type { ResourceHostCapabilities } from "@liveagent/ui/lib/resourceHost";
import type { TranscriptMessageJump } from "@liveagent/ui/lib/transcript-virtual/useTranscriptMessageJump";
import type { ReactNode, RefObject } from "react";
import type { AppUpdateController } from "../../lib/appUpdates";
import type { RelayDashboardStats, RelayUser } from "../../lib/relay/client";
import type { AppSettings, SttProviderId } from "../../lib/settings";
import type { SectionId } from "../settings/types";

export type ChatPageProps = {
  /** Keep the local runtime serving remote clients while another device is visible. */
  active?: boolean;
  settingsNavigation?: WorkbenchNavigationPortal;
  scheduledTasksNavigationRef?: RefObject<(() => void) | null>;
  relayUser: RelayUser;
  relayStats: RelayDashboardStats | null;
  onRefreshRelayAccount: () => Promise<void>;
  settings: AppSettings;
  resourceHost?: ResourceHostCapabilities;
  imageStudioHost?: ImageStudioHost;
  conversationImageStudioHost?: ImageStudioHost;
  onImageStudioWorkspaceChange?: (workspace: string) => void;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  sttProviderOverride?: SttProviderId | null;
  getMcpSettings: () => AppSettings["mcp"];
  getToolPolicies: () => AppSettings["system"]["toolPolicies"];
  context: Context;
  setContext: (next: Context) => void;
  onOpenSettings: (section?: SectionId, providerId?: string) => void;
  onToggleTheme: () => void;
  headerLeadingActions?: ReactNode;
  registerExecutionDeparture?: (captureDraft: () => void) => () => void;
  accountNavigation?: WorkbenchAccountNavigation;
  onAccountSurface?: (surface: WorkbenchAccountSurface | null) => void;
  renderScheduledTasks?: (navigation: {
    onBack: () => void;
    onOpenDeviceConversation: (id: string) => void;
    renderDeviceConversation: (
      id: string,
      run: CronRunRecord,
      jump?: TranscriptMessageJump,
      scheduledRun?: ScheduledConversationRun,
    ) => ReactNode;
    mobileRail?: ReactNode;
    previewOpen: boolean;
    onPinSidebar: () => void;
    sidebarTarget?: HTMLElement | null;
    sidebarOnly?: boolean;
    hideSidebar?: boolean;
    onActivate?: () => void;
  }) => ReactNode;
  onExecutionBusyChange?: (busy: boolean) => void;
  appUpdate?: AppUpdateController;
  onRunningConversationCountChange?: (count: number) => void;
};
