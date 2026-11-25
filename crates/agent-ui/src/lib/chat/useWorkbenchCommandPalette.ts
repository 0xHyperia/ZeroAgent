import { useEffect, useRef } from "react";
import {
  isWorkbenchNavigationLocationOpenable,
  parseNavigationLocation,
  useNavigationHistory,
  workbenchNavigationLocation,
} from "../navigation/navigationHistory";
import type { SidebarShortcutId, SidebarShortcuts } from "../settings/sidebarShortcuts";
import { isMacLikePlatform } from "../shared/platform";
import {
  getShortcutCommand,
  matchesShortcutCommand,
  type ShortcutCommandId,
} from "../shortcuts/shortcutCommands";
import { isKeyEventHandledElsewhere } from "../shortcuts/shortcutKeys";
import { type CommandPaletteCapability, isCommandPaletteSuppressed } from "./commandPalette";
import {
  type BuildCommandPaletteActionsInput,
  buildCommandPaletteActions,
} from "./commandPaletteActions";
import type { QuickOpenFileSource } from "./fileQuickOpenSearch";

type WorkbenchPaletteOptions = {
  scopeKey?: string;
  visible: boolean;
  isCurrentScope?: () => boolean;
  searchConversations?: CommandPaletteCapability["searchConversations"];
  activeView: "chat" | `${SidebarShortcutId}-hub`;
  conversationId: string;
  isDraft: boolean;
  hasConversation: (id: string) => boolean;
  openConversation: (id: string) => void;
  visibleHubs: SidebarShortcuts;
  openHub: (hub: `${SidebarShortcutId}-hub`) => void;
  workspace?: {
    projectPathKey: string;
    tabs: readonly { id: string; kind: string }[];
    activeFileTabId?: string | null;
    openTab: (id: string) => void;
    files: Omit<QuickOpenFileSource, "scopeKey">;
  };
  actions: Omit<BuildCommandPaletteActionsInput, "isMac" | "navigation">;
  resolveCloseActiveContext?: (origin?: Element | null) => (() => void) | undefined;
};

const PALETTE_KEY_COMMANDS: readonly ShortcutCommandId[] = [
  "newConversation",
  "openSettings",
  "toggleRightPanel",
  "toggleTerminal",
  "closeActiveContext",
  "cycleThinkingLevel",
  "cycleTheme",
  "zoomIn",
  "zoomOut",
  "zoomReset",
];

/** The hosts resolve the existing entry points and authorization for every visit. */
export function useWorkbenchCommandPalette(options: WorkbenchPaletteOptions) {
  const { scopeKey, visible, workspace, conversationId, isDraft, activeView } = options;
  const canNavigate = () => visible && (options.isCurrentScope?.() ?? true);
  const activeFile = workspace?.tabs.find(
    (tab) => tab.id === workspace.activeFileTabId && tab.kind === "file",
  );
  const navigation = useNavigationHistory({
    scopeKey,
    location: visible
      ? workbenchNavigationLocation({
          activeView,
          conversationId,
          isDraft,
          file:
            workspace && activeFile
              ? { projectPathKey: workspace.projectPathKey, tabId: activeFile.id }
              : undefined,
        })
      : null,
    isValid: (location) =>
      canNavigate() &&
      isWorkbenchNavigationLocationOpenable(location, {
        hasConversation: options.hasConversation,
        visibleHubs: options.visibleHubs,
        hasFile: (file) =>
          workspace?.projectPathKey === file.projectPathKey &&
          workspace.tabs.some((tab) => tab.id === file.tabId && tab.kind === "file"),
      }),
    navigate: (location) => {
      if (!canNavigate()) return;
      const target = parseNavigationLocation(location);
      if (target?.kind === "view") options.openHub(target.view);
      else if (target?.kind === "file") workspace?.openTab(target.tabId);
      else if (target?.kind === "conversation") options.openConversation(target.conversationId);
    },
  });
  const paletteScopeKey =
    scopeKey && visible ? JSON.stringify([scopeKey, workspace?.projectPathKey]) : undefined;
  const commandPalette: CommandPaletteCapability | undefined = paletteScopeKey
    ? {
        scopeKey: paletteScopeKey,
        isCurrent: canNavigate,
        searchConversations: options.searchConversations,
        getActions: (origin) =>
          canNavigate()
            ? buildCommandPaletteActions({
                ...options.actions,
                onCloseActiveContext:
                  options.resolveCloseActiveContext?.(origin) ?? options.actions.onCloseActiveContext,
                isMac: isMacLikePlatform(),
                navigation,
              })
            : [],
        files: workspace
          ? {
              scopeKey: paletteScopeKey,
              listFiles: workspace.files.listFiles,
              openFile: (path) => {
                if (canNavigate()) workspace.files.openFile(path);
              },
            }
          : undefined,
      }
    : undefined;
  const paletteRef = useRef(commandPalette);
  paletteRef.current = commandPalette;
  useEffect(() => {
    if (!paletteScopeKey) return;
    const isMac = isMacLikePlatform();
    const handleKey = (event: KeyboardEvent) => {
      if (isKeyEventHandledElsewhere(event) || isCommandPaletteSuppressed()) return;
      const origin = event.target instanceof Element ? event.target : null;
      if (origin?.closest(
        '[hidden], [inert], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
      )) {
        return;
      }
      const command = PALETTE_KEY_COMMANDS.find((id) => matchesShortcutCommand(event, id, isMac));
      if (!command) return;
      const actionId = getShortcutCommand(command)?.paletteActionId;
      const action = paletteRef.current?.getActions(origin).find(({ id }) => id === actionId);
      if (!action) return;
      event.preventDefault();
      if (!event.repeat || command === "zoomIn" || command === "zoomOut") action.run();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [paletteScopeKey]);
  return { commandPalette, navigation };
}
