import type { ImageStudioClient } from "@liveagent/ui/lib/imaging/types";
import type { SttSettingsService } from "@liveagent/ui/lib/stt/types";
import type { RelayDashboardStats, RelayUser } from "../../lib/relay/client";
import type { AppSettings, SttProviderId } from "../../lib/settings";
import type { WebSettingsSaveState } from "../../lib/webSettings";

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "webSearch"
  | "account"
  | "system"
  | "shortcuts"
  | "skills"
  | "devicePlugins"
  | "mcp"
  | "systemTools"
  | "permissions"
  | "usage"
  | "stt"
  | "providers"
  | "model-preferences"
  | "agents"
  | "ssh"
  | "memory"
  | "hooks"
  | "cron"
  | "image-studio"
  | "planning"
  | "devices"
  | "cua"
  | "remote";

import type { SettingsHostAdapter } from "@liveagent/ui/pages/settings/kbrainSettingsAdapter";

export type SettingsPageProps = {
  presentation?: "workbench" | "page";
  settings: AppSettings;
  settingsHost?: SettingsHostAdapter;
  imageClient?: ImageStudioClient;
  onOpenModelPreferences?: () => void;
  onOpenScheduledTasks?: () => void;
  registerLeaveGuard?: (guard: () => boolean) => () => void;
  setSettings: SetSettingsFn;
  saveState: WebSettingsSaveState;
  onBack: () => void;
  backLabel?: string;
  initialSection?: SectionId;
  initialAnchor?: string;
  onSectionChange?: (section: SectionId) => void;
  mobileDetail?: boolean;
  onMobileDetailChange?: (detail: boolean) => void;
  initialProviderId?: string;
  hiddenSections?: SectionId[];
  relayUser: RelayUser;
  relayStats: RelayDashboardStats | null;
  onRelayUserChange: (user: RelayUser) => void;
  onRelayStatsChange: (stats: RelayDashboardStats) => void;
  runtimeKind?: "web_chat" | "device_agent";
  onAgentDirectoryChanged?: () => void | Promise<void>;
  sttSettingsService: SttSettingsService;
  /** 临时切换语音输入运行供应商，不触发配置保存。 */
  onSttProviderChange?: (provider: SttProviderId) => void;
};

export type SettingsSectionProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState?: WebSettingsSaveState;
};
