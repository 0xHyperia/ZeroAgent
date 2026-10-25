import { MonitorSmartphone, Shield } from "@liveagent/ui/components/IconSet";
import type { SettingsSectionDefinition, UiExtensionSlots } from "@liveagent/ui/contracts/registry";
import {
  configureResourceHostCapabilities,
  nativeResourceHostCapabilities,
} from "@liveagent/ui/lib/resourceHost";
import type { GatewaySettingsSyncUpdatePayload } from "@liveagent/ui/lib/settings/sync";
import type { KBrainSettingsAdapter } from "@liveagent/ui/pages/settings/kbrainSettingsAdapter";
import type { ReactNode } from "react";
import { getGatewayWebSocketClient } from "../lib/gatewaySocket";
import { loadToken } from "../lib/storage";
import { AccountSection } from "../pages/settings/AccountSection";
import { DevicesSection } from "../pages/settings/DevicesSection";
import { RelayProvidersSection } from "../pages/settings/RelayProvidersSection";
import type { SettingsPageProps } from "../pages/settings/types";

export function createSettingsExtension(props: SettingsPageProps): {
  surface: "web";
  iconClassName: string;
  slots: UiExtensionSlots;
  sections: SettingsSectionDefinition<void>[];
  renderProviders: (options: {
    initialProviderId?: string;
    onInitialProviderHandled: () => void;
  }) => ReactNode;
} {
  return {
    surface: "web",
    iconClassName: "size-4",
    slots: {},
    renderProviders: () => (
      <RelayProvidersSection settings={props.settings} setSettings={props.setSettings} />
    ),
    sections: [
      {
        id: "account",
        groupKey: "settings.groupGeneral",
        groupOrder: 10,
        order: 5,
        labelKey: "settings.navAccount",
        icon: <Shield className="h-4 w-4" />,
        showSaveIndicator: false,
        render: () => (
          <AccountSection
            user={props.relayUser}
            stats={props.relayStats}
            onUserChange={props.onRelayUserChange}
            onStatsChange={props.onRelayStatsChange}
          />
        ),
      },
      {
        id: "devices",
        groupKey: "settings.groupConnectivity",
        groupOrder: 40,
        order: 30,
        labelKey: "settings.navAgentManagement",
        icon: <MonitorSmartphone className="size-4" />,
        showSaveIndicator: false,
        render: () => <DevicesSection onDirectoryChanged={props.onAgentDirectoryChanged} />,
      },
    ],
  };
}

configureResourceHostCapabilities(nativeResourceHostCapabilities);

const computerSettingsAdapter: KBrainSettingsAdapter = {
  isKbrain: true,
  runtimeConnection: () => null,
  getConnection: () => null,
  async getSettings() {
    const document = await getGatewayWebSocketClient(loadToken().trim()).getSettings();
    return {
      ...(document.settingsSyncProtocol
        ? {
            settingsSyncProtocol: document.settingsSyncProtocol,
            configurationRevision: document.configurationRevision,
            uiPreferencesRevision: document.uiPreferencesRevision,
          }
        : {}),
      mode: "kbrain",
      defaultModel: "",
      defaultProvider: "",
      providers: [],
      models: document.customProviders.flatMap((p) =>
        p.models
          .filter((m) => !p.activeModels || p.activeModels.includes(m.id))
          .map((m) => ({ provider: p.id, id: m.id, name: m.displayName || m.id })),
      ),
      aiApproval: document.aiApproval,
      computer: document.computer,
    };
  },
  async updateSettings(update, baseline) {
    await getGatewayWebSocketClient(loadToken().trim()).updateSettings({
      ...(update as GatewaySettingsSyncUpdatePayload),
      ...(baseline?.settingsSyncProtocol
        ? {
            settingsSyncProtocol: baseline.settingsSyncProtocol,
            configurationRevision: baseline.configurationRevision,
            uiPreferencesRevision: baseline.uiPreferencesRevision,
          }
        : {}),
    });
    return this.getSettings();
  },
};

export const settingsHostAdapter = { isKbrain: true as const, kbrain: computerSettingsAdapter };
