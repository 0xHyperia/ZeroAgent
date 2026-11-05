import { Archive, Info, Keyboard, Shield } from "@liveagent/ui/components/IconSet";
import type { SettingsSectionDefinition, UiExtensionSlots } from "@liveagent/ui/contracts/registry";
import type { ReactNode } from "react";
import { isMacOsTauri, MacOsTitleBarSpacer } from "../components/MacOsTitleBarSpacer";
import { LegacyHistoryImportSettings } from "../lib/kbrain/LegacyHistoryImportSettings";
import { AboutSection } from "../pages/settings/AboutSection";
import { AccountSection } from "../pages/settings/AccountSection";
import { BackupSyncSection } from "../pages/settings/BackupSyncSection";
import { GlobalShortcutsSection } from "../pages/settings/GlobalShortcutsSection";
import { RelayProvidersSection } from "../pages/settings/RelayProvidersSection";
import type { SettingsPageProps } from "../pages/settings/types";

export function createSettingsExtension(props: SettingsPageProps): {
  surface: "desktop";
  iconClassName: string;
  slots: UiExtensionSlots;
  sections: SettingsSectionDefinition<void>[];
  renderProviders: (options: {
    initialProviderId?: string;
    onInitialProviderHandled: () => void;
  }) => ReactNode;
} {
  const {
    settings,
    setSettings,
    appUpdate,
    releaseAnnouncement,
    reloadSettings,
    relayUser,
    relayStats,
    onRelayUserChange,
    onRelayStatsChange,
  } = props;
  return {
    surface: "desktop",
    iconClassName: "size-3.5",
    slots: {
      sidebarLeading: isMacOsTauri() ? (
        <div data-tauri-drag-region className="h-38px shrink-0" />
      ) : null,
      mainLeading: <MacOsTitleBarSpacer />,
    },
    renderProviders: () => (
      <RelayProvidersSection
        settings={settings}
        setSettings={setSettings}
        onOpenModelPreferences={props.onOpenModelPreferences}
      />
    ),
    sections: [
      {
        id: "account",
        groupKey: "settings.groupGeneral",
        groupOrder: 10,
        order: 5,
        labelKey: "settings.navAccount",
        icon: <Shield className="h-3.5 w-3.5" />,
        render: () => (
          <AccountSection
            settings={settings}
            user={relayUser}
            stats={relayStats}
            onUserChange={onRelayUserChange}
            onStatsChange={onRelayStatsChange}
          />
        ),
      },
      {
        id: "shortcuts",
        groupKey: "settings.groupOther",
        groupOrder: 50,
        order: 10,
        labelKey: "settings.navShortcuts",
        icon: <Keyboard className="size-3.5" />,
        render: () => <GlobalShortcutsSection />,
      },
      {
        id: "backup",
        groupKey: "settings.groupOther",
        groupOrder: 50,
        order: 15,
        labelKey: "settings.navBackup",
        icon: <Archive className="size-3.5" />,
        render: () => (
          <>
            <BackupSyncSection
              settings={settings}
              setSettings={setSettings}
              reloadSettings={reloadSettings}
            />
            <LegacyHistoryImportSettings />
          </>
        ),
      },
      {
        id: "about",
        groupKey: "settings.groupOther",
        groupOrder: 50,
        order: 20,
        labelKey: "settings.navAbout",
        icon: <Info className="size-3.5" />,
        render: () => (
          <AboutSection
            settings={settings}
            setSettings={setSettings}
            appUpdate={appUpdate}
            releaseAnnouncement={releaseAnnouncement}
          />
        ),
      },
    ],
  };
}
