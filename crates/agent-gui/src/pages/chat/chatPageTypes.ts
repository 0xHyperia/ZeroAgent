import type { Context } from "@earendil-works/pi-ai";
import type { ReactNode } from "react";
import type { AppUpdateController } from "../../lib/appUpdates";
import type { RelayDashboardStats, RelayUser } from "../../lib/relay/client";
import type { AppSettings } from "../../lib/settings";
import type { SectionId } from "../settings/types";

export type ChatPageProps = {
  relayUser: RelayUser;
  relayStats: RelayDashboardStats | null;
  onRefreshRelayAccount: () => Promise<void>;
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  getMcpSettings: () => AppSettings["mcp"];
  getToolPolicies: () => AppSettings["system"]["toolPolicies"];
  context: Context;
  setContext: (next: Context) => void;
  onOpenSettings: (section?: SectionId, providerId?: string) => void;
  onToggleTheme: () => void;
  headerLeadingActions?: ReactNode;
  onExecutionBusyChange?: (busy: boolean) => void;
  appUpdate?: AppUpdateController;
  onRunningConversationCountChange?: (count: number) => void;
};
