import "@liveagent/ui/i18n/namespaces/settings";
import { SHORTCUT_COMMANDS } from "../shortcuts/shortcutCommands";

export const DEVICE_WEB_HIDDEN_SETTINGS_SECTIONS = ["remote", "stt"] as const;

export type DiscoverableSettingsSection = { id: string; labelKey: string };

const WORKBENCH_SETTINGS_SECTIONS = {
  account: "settings.navAccount",
  system: "settings.navSystem",
  providers: "settings.navProviders",
  agents: "settings.navAgents",
  usage: "settings.navUsage",
  skills: "settings.navSkills",
  mcp: "settings.navMcp",
  devicePlugins: "settings.devicePlugins.title",
  planning: "settings.navPlanning",
  memory: "settings.navMemory",
  systemTools: "settings.navSystemTools",
  webSearch: "settings.navWebSearch",
  permissions: "settings.navPermissions",
  stt: "settings.navStt",
  hooks: "settings.navHooks",
  cron: "settings.navCron",
  ssh: "settings.navSsh",
  remote: "settings.navRemote",
  devices: "settings.navAgentManagement",
  shortcuts: "settings.navShortcuts",
  backup: "settings.navBackup",
  about: "settings.navAbout",
} as const;

export function settingsSectionLabel(id: keyof typeof WORKBENCH_SETTINGS_SECTIONS) {
  return WORKBENCH_SETTINGS_SECTIONS[id];
}

type WorkbenchSettingsCapabilities = {
  surface: "desktop" | "web";
  usage: boolean;
  devicePlugins: boolean;
  webSearch: boolean;
  permissions: boolean;
};

export function getWorkbenchSettingsSections({
  surface,
  usage,
  devicePlugins,
  webSearch,
  permissions,
}: WorkbenchSettingsCapabilities): DiscoverableSettingsSection[] {
  const hidden = new Set<string>(
    surface === "desktop"
      ? ["devices"]
      : [...DEVICE_WEB_HIDDEN_SETTINGS_SECTIONS, "backup", "about"],
  );
  if (!usage) hidden.add("usage");
  if (!devicePlugins) hidden.add("devicePlugins");
  if (!webSearch) hidden.add("webSearch");
  if (!permissions) hidden.add("permissions");
  return Object.entries(WORKBENCH_SETTINGS_SECTIONS)
    .filter(([id]) => !hidden.has(id))
    .map(([id, labelKey]) => ({ id, labelKey }));
}

type SettingsSearchEntry = {
  section: string;
  anchor: string;
  labelKey: string;
  keywords: string;
};

export function shortcutCommandSettingsAnchor(commandId: string) {
  return `shortcut-${commandId}`;
}

// Rows available whenever the owning section is visible. The SettingsShell
// filters out sections that the current host or device cannot present.
const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  {
    section: "system",
    anchor: "appearance",
    labelKey: "settings.appearance",
    keywords: "theme dark light color scheme 主题 深色 浅色",
  },
  {
    section: "system",
    anchor: "language",
    labelKey: "settings.language",
    keywords: "locale english chinese 中文 英文",
  },
  {
    section: "system",
    anchor: "sidebar-shortcuts",
    labelKey: "settings.sidebarShortcuts",
    keywords: "sidebar skills mcp cron planning",
  },
  {
    section: "system",
    anchor: "font-family",
    labelKey: "settings.fontFamily",
    keywords: "font typeface monospace",
  },
  {
    section: "system",
    anchor: "font-size",
    labelKey: "settings.fontSize",
    keywords: "font size text size scale",
  },
  {
    section: "system",
    anchor: "run-completion-sound",
    labelKey: "settings.runCompletionSound",
    keywords: "notification sound chime 通知 提示音",
  },
  {
    section: "system",
    anchor: "preferred-workspace-editor",
    labelKey: "settings.preferredWorkspaceEditor",
    keywords: "editor ide vscode cursor 编辑器",
  },
  {
    section: "system",
    anchor: "html-previews",
    labelKey: "settings.htmlPreviews",
    keywords: "html preview session widget render 预览",
  },
  {
    section: "agents",
    anchor: "agents-global",
    labelKey: "settings.agentsGlobalTab",
    keywords: "prompt system prompt instructions",
  },
  {
    section: "usage",
    anchor: "usage-stats",
    labelKey: "settings.navUsage",
    keywords: "usage tokens cost 用量 费用",
  },
  {
    section: "agents",
    anchor: "agents-projects",
    labelKey: "settings.agentsProjectsTab",
    keywords: "project prompt instructions",
  },
  {
    section: "planning",
    anchor: "planner-sidebar",
    labelKey: "planner.settings.showInSidebar",
    keywords: "calendar planner sidebar",
  },
  {
    section: "planning",
    anchor: "planner-week-start",
    labelKey: "planner.display.weekStart",
    keywords: "calendar week monday sunday",
  },
  {
    section: "planning",
    anchor: "planner-week-numbers",
    labelKey: "planner.display.weekNumbers",
    keywords: "calendar week number",
  },
  {
    section: "memory",
    anchor: "memory-switch",
    labelKey: "settings.memorySwitchTitle",
    keywords: "memory remember recall",
  },
  {
    section: "webSearch",
    anchor: "web-search-provider",
    labelKey: "settings.webSearch.provider",
    keywords: "search web engine",
  },
  {
    section: "systemTools",
    anchor: "ai-approval-mode",
    labelKey: "settings.aiApproval.mode",
    keywords: "approve approval tools mode 审批",
  },
  {
    section: "systemTools",
    anchor: "ai-approval-model",
    labelKey: "settings.aiApproval.model",
    keywords: "approve approval tools model 审批 模型",
  },
  {
    section: "permissions",
    anchor: "permission-rules",
    labelKey: "settings.permissions.title",
    keywords: "allow deny rules permission",
  },
  {
    section: "stt",
    anchor: "stt-enable",
    labelKey: "settings.stt.enable",
    keywords: "voice speech dictation microphone",
  },
  {
    section: "stt",
    anchor: "stt-service",
    labelKey: "settings.stt.sectionService",
    keywords: "voice speech service provider",
  },
  {
    section: "hooks",
    anchor: "hooks-lifecycle",
    labelKey: "settings.search.entry.hooks",
    keywords: "hook script webhook lifecycle",
  },
  {
    section: "cron",
    anchor: "cron-tasks",
    labelKey: "settings.search.entry.cronTasks",
    keywords: "cron schedule timer recurring",
  },
  {
    section: "ssh",
    anchor: "ssh-hosts",
    labelKey: "settings.search.entry.sshHosts",
    keywords: "ssh remote host server key",
  },
  {
    section: "about",
    anchor: "desktop-setup-guide",
    labelKey: "settings.setupGuide.title",
    keywords: "setup onboarding guide first run 入门 指引",
  },
  ...SHORTCUT_COMMANDS.map((command) => ({
    section: "shortcuts",
    anchor: shortcutCommandSettingsAnchor(command.id),
    labelKey: command.labelKey,
    keywords: "shortcut keybinding hotkey keyboard",
  })),
];

export function searchSettingsIndex(
  query: string,
  sections: readonly { id: string; labelKey: string }[],
  translate: (key: string) => string,
  excludedAnchors: readonly string[] = [],
) {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  return listSettingsIndexEntries(sections, translate, excludedAnchors)
    .flatMap((match) => {
      const { entry, label, sectionLabel } = match;
      const normalizedLabel = label.toLocaleLowerCase();
      const searchable = `${normalizedLabel} ${sectionLabel} ${entry.keywords}`.toLocaleLowerCase();
      if (!tokens.every((token) => searchable.includes(token))) return [];
      const score = tokens.filter((token) => normalizedLabel.includes(token)).length;
      return [{ entry, label, sectionLabel, score }];
    })
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

export function listSettingsIndexEntries(
  sections: readonly DiscoverableSettingsSection[],
  translate: (key: string) => string,
  excludedAnchors: readonly string[] = [],
) {
  const sectionLabels = new Map(sections.map(({ id, labelKey }) => [id, translate(labelKey)]));
  const excluded = new Set(excludedAnchors);
  return SETTINGS_SEARCH_INDEX.flatMap((entry) => {
    const sectionLabel = sectionLabels.get(entry.section);
    if (!sectionLabel || excluded.has(entry.anchor)) return [];
    return [{ entry, label: translate(entry.labelKey), sectionLabel }];
  });
}
