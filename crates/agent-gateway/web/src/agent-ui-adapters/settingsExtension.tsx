import { Keyboard, MonitorSmartphone, Shield } from "@liveagent/ui/components/IconSet";
import { onDemand } from "@liveagent/ui/components/OnDemand";
import type { SettingsSectionDefinition, UiExtensionSlots } from "@liveagent/ui/contracts/registry";
import { settingsSectionLabel, shortcutCommandSettingsAnchor } from "@liveagent/ui/lib/settings/settingsSearchIndex";
import { BROWSER_UNSUPPORTED_SHORTCUTS } from "@liveagent/ui/lib/shortcuts/shortcutCommands";
import type { ShortcutCommandsSectionProps } from "@liveagent/ui/pages/settings/ShortcutCommandsSection";
import type { KBrainWebSearchUpdate } from "@liveagent/ui/lib/providers/webSearchFallback";
import {
  configureResourceHostCapabilities,
  kbrainResourceHostCapabilities,
} from "@liveagent/ui/lib/resourceHost";
import type {
  GatewaySettingsSyncPayload,
  GatewaySettingsSyncUpdatePayload,
} from "@liveagent/ui/lib/settings/sync";
import type {
  KBrainMemoryConfig,
  KBrainMemoryOrganizerConfig,
  KBrainSettingsAdapter,
  KBrainSettingsDocument,
  PermissionRule,
} from "@liveagent/ui/pages/settings/kbrainSettingsAdapter";
import type { ReactNode } from "react";
import { getGatewayWebSocketClient } from "../lib/gatewaySocket";
import { loadToken } from "../lib/storage";
import { AccountSection } from "../pages/settings/AccountSection";
import { DevicesSection } from "../pages/settings/DevicesSection";
import { RelayProvidersSection } from "../pages/settings/RelayProvidersSection";
import type { SettingsPageProps } from "../pages/settings/types";
import { gatewaySkillsAdapter } from "./kbrainSkills";

export const WEB_SETTINGS_EXCLUDED_ANCHORS = [
  ...BROWSER_UNSUPPORTED_SHORTCUTS.map(shortcutCommandSettingsAnchor),
  "run-completion-sound",
  "preferred-workspace-editor",
  "file-runtime",
];

const ShortcutCommandsSection = onDemand<ShortcutCommandsSectionProps>(
  async () =>
    (await import("@liveagent/ui/pages/settings/ShortcutCommandsSection")).ShortcutCommandsSection,
);

export function createSettingsExtension(props: SettingsPageProps): {
  surface: "web";
  iconClassName: string;
  slots: UiExtensionSlots;
  sections: SettingsSectionDefinition<void>[];
  excludedSearchAnchors: readonly string[];
  renderProviders: (options: {
    initialProviderId?: string;
    onInitialProviderHandled: () => void;
  }) => ReactNode;
} {
  return {
    surface: "web",
    excludedSearchAnchors: WEB_SETTINGS_EXCLUDED_ANCHORS,
    iconClassName: "size-4",
    slots: {},
    renderProviders: () => (
      <RelayProvidersSection
        settings={props.settings}
        setSettings={props.setSettings}
        cloudChatMode={props.runtimeKind === "web_chat"}
        onOpenModelPreferences={props.onOpenModelPreferences}
      />
    ),
    sections: [
      {
        id: "account",
        groupKey: "settings.groupGeneral",
        groupOrder: 10,
        order: 5,
        labelKey: settingsSectionLabel("account"),
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
      ...(props.runtimeKind === "device_agent"
        ? [{
            id: "shortcuts",
            groupKey: "settings.groupOther",
            groupOrder: 50,
            order: 10,
            labelKey: settingsSectionLabel("shortcuts"),
            icon: <Keyboard className="size-4" />,
            showSaveIndicator: false,
            render: () => <ShortcutCommandsSection excludeCommandIds={BROWSER_UNSUPPORTED_SHORTCUTS} />,
          } satisfies SettingsSectionDefinition<void>]
        : []),
      {
        id: "devices",
        groupKey: "settings.groupConnectivity",
        groupOrder: 40,
        order: 30,
        labelKey: settingsSectionLabel("devices"),
        icon: <MonitorSmartphone className="size-4" />,
        showSaveIndicator: false,
        render: () => <DevicesSection onDirectoryChanged={props.onAgentDirectoryChanged} />,
      },
    ],
  };
}

configureResourceHostCapabilities({
  ...kbrainResourceHostCapabilities,
  skillsAdapter: gatewaySkillsAdapter,
});

let searchClient: ReturnType<typeof getGatewayWebSocketClient> | undefined;
let searchTarget: string | undefined;
let searchScope: object | undefined;

function toKBrainSettingsDocument(document: GatewaySettingsSyncPayload): KBrainSettingsDocument {
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
    memory: document.kbrainMemory,
    memoryOrganizer: document.kbrainMemoryOrganizer,
    webSearch: document.settingsSyncProtocol ? document.kbrainWebSearch : undefined,
  };
}

const computerSettingsAdapter: KBrainSettingsAdapter = {
  isKbrain: true,
  runtimeConnection: () => null,
  getConnection: () => null,
  webSearchScope: () => {
    const client = getGatewayWebSocketClient(loadToken().trim());
    const target = client.getActiveAgent();
    if (client !== searchClient || target !== searchTarget) {
      searchClient = client;
      searchTarget = target;
      searchScope = {};
    }
    return searchScope;
  },
  async getSettings() {
    const document = await getGatewayWebSocketClient(loadToken().trim()).getSettings();
    return toKBrainSettingsDocument(document);
  },
  async updateSettings(update, baseline) {
    // Gateway carries the K-brain memory switch as `kbrainMemory` and the organizer
    // schedule as `kbrainMemoryOrganizer`: its `memory` key is ZeroAgent's own settings.
    const { memory, memoryOrganizer, webSearch, ...rest } = update as Omit<
      GatewaySettingsSyncUpdatePayload,
      "kbrainMemoryOrganizer"
    > & {
      webSearch?: KBrainWebSearchUpdate;
      memory?: KBrainMemoryConfig;
      memoryOrganizer?: Partial<KBrainMemoryOrganizerConfig>;
    };
    if (webSearch && (!baseline?.settingsSyncProtocol || !baseline.configurationRevision))
      throw new Error("ZEROAGENT_CONFIGURATION_VERSION_REQUIRED");
    const receipt = await getGatewayWebSocketClient(loadToken().trim()).updateSettings({
      ...(webSearch ? { kbrainWebSearch: webSearch } : {}),
      ...rest,
      ...(memory ? { kbrainMemory: memory } : {}),
      ...(baseline?.settingsSyncProtocol
        ? {
            settingsSyncProtocol: baseline.settingsSyncProtocol,
            configurationRevision: baseline.configurationRevision,
            uiPreferencesRevision: baseline.uiPreferencesRevision,
          }
        : {}),
      // A partial schedule is forwarded as is; K-brain keeps the field left out.
      ...(memoryOrganizer
        ? { kbrainMemoryOrganizer: memoryOrganizer as KBrainMemoryOrganizerConfig }
        : {}),
    });
    if (webSearch && receipt?.snapshot) return toKBrainSettingsDocument(receipt.snapshot);
    return this.getSettings();
  },
};

type WirePermissionRule = {
  id: string;
  rule: string;
  effect: PermissionRule["effect"];
  scope: PermissionRule["scope"];
  created_at?: string;
  source_session?: string;
};

function permissionRuleFromWire(rule: WirePermissionRule): PermissionRule {
  return {
    id: rule.id,
    rule: rule.rule,
    effect: rule.effect,
    scope: rule.scope,
    ...(rule.created_at ? { createdAt: rule.created_at } : {}),
    ...(rule.source_session ? { sourceSession: rule.source_session } : {}),
  };
}

const gatewayClient = () => getGatewayWebSocketClient(loadToken().trim());

// Settings → 权限 on the WebUI: the desktop (or a direct K-brain target) answers through
// the Gateway; an old desktop is refused by the Gateway with an "update ZeroAgent" message.
computerSettingsAdapter.listPermissionRules = async ({ workspace }) => {
  const list = await gatewayClient().permissionRules<{
    project_root?: string;
    rules?: WirePermissionRule[];
  }>("list", workspace ? { workspace } : {});
  return {
    ...(list.project_root ? { projectRoot: list.project_root } : {}),
    rules: (list.rules ?? []).map(permissionRuleFromWire),
  };
};
computerSettingsAdapter.addPermissionRule = async (input) =>
  permissionRuleFromWire(
    await gatewayClient().permissionRules<WirePermissionRule>("add", { ...input }),
  );
computerSettingsAdapter.deletePermissionRule = async (ref) => {
  await gatewayClient().permissionRules("delete", { ...ref });
};

// Settings → 用量统计 on the WebUI, read-only through the Gateway. The desktop (or a
// direct K-brain target) answers `available: false` for a K-brain without the capability;
// the Gateway checks the selected device's usage-statistics capability.
computerSettingsAdapter.getUsageStats = (query) =>
  gatewayClient().usageStats({ days: query.days, timezone: query.timezone });

export const settingsHostAdapter = { isKbrain: true as const, kbrain: computerSettingsAdapter };
