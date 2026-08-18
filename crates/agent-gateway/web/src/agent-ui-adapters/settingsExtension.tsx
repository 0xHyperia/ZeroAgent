import { MonitorSmartphone, Shield } from "@liveagent/ui/components/IconSet";
import type { SettingsSectionDefinition, UiExtensionSlots } from "@liveagent/ui/contracts/registry";
import type { ReactNode } from "react";
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
    iconClassName: "h-4 w-4",
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
        icon: <MonitorSmartphone className="h-4 w-4" />,
        showSaveIndicator: false,
        render: () => <DevicesSection onDirectoryChanged={props.onAgentDirectoryChanged} />,
      },
    ],
  };
}
