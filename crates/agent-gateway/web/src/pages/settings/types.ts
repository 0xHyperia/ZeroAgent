import type { SttSettingsService } from "@liveagent/ui/lib/stt/types";
import type { RelayDashboardStats, RelayUser } from "../../lib/relay/client";
import type { AppSettings, SttProviderId } from "../../lib/settings";
import type { WebSettingsSaveState } from "../../lib/webSettings";

export type SetSettingsFn = (updater: (prev: AppSettings) => AppSettings) => void;

export type SectionId =
  | "account"
  | "system"
  | "systemTools"
  | "stt"
  | "providers"
  | "agents"
  | "ssh"
  | "memory"
  | "hooks"
  | "cron"
  | "devices"
  | "remote";

export type SettingsPageProps = {
  settings: AppSettings;
  setSettings: SetSettingsFn;
  saveState: WebSettingsSaveState;
  onBack: () => void;
  initialSection?: SectionId;
  onSectionChange?: (section: SectionId) => void;
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
