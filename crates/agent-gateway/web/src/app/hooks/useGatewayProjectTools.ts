import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import { expandedPathsForFileTreePath } from "@liveagent/ui/components/project-tools/rightDockModel";
import { useWorkspaceFileOpening } from "@liveagent/ui/components/project-tools/useWorkspaceFileOpening";
import { useWorkspaceTabs } from "@liveagent/ui/components/project-tools/useWorkspaceTabs";
import type { ToastTone } from "@liveagent/ui/components/ui/toast-manager";
import { isWorkspacePreviewPath } from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import { workspaceImageRelativePathForCopy } from "@liveagent/ui/components/workspace-editor/workspaceImageViewer";
import { t as translate } from "@liveagent/ui/i18n/index";
import { useChangedFilesActions } from "@liveagent/ui/lib/chat/useChangedFilesActions";
import { useChatFileLinkNavigation } from "@liveagent/ui/lib/chat/useChatFileLinkNavigation";
import {
  useComposerActions,
  useInsertCodeReviewSkill,
} from "@liveagent/ui/lib/chat/useComposerActions";
import type { useConversationRightDock } from "@liveagent/ui/lib/projectTools/useConversationRightDock";
import { useRightDockSettings } from "@liveagent/ui/lib/projectTools/useRightDockSettings";
import type { MutableRefObject } from "react";
import { useCallback, useMemo } from "react";

import type { AgentStatus } from "@/lib/gatewayTypes";
import { type AppSettings, workspaceProjectPathKey } from "@/lib/settings";
import { createGatewayWorkspaceActivityClient } from "@/lib/workspace-activity/gatewayWorkspaceActivityClient";

import { asErrorMessage } from "../chatEventUtils";
import { isLocalDraftConversationId } from "../gatewayLocalDraft";
import { isMobileSidebarLayout } from "../historyUtils";
import type { useGatewayChatConfiguration } from "./useGatewayChatConfiguration";
import type { useGatewayClients } from "./useGatewayClients";
import { useProjectToolsRuntime } from "./useProjectToolsRuntime";

type UseGatewayProjectToolsOptions = {
  activeWorkspaceProjectPath: string;
  addNotify: (type: ToastTone, message: string) => void;
  api: ReturnType<typeof useGatewayClients>["api"];
  codeReviewSkill: ReturnType<typeof useGatewayChatConfiguration>["codeReviewSkill"];
  composerRef: MutableRefObject<MentionComposerHandle | null>;
  displayedConversationId: string;
  workspaceOwner: string;
  displayedConversationWorkdir: string;
  terminalIdentity?: { conversationId?: string; runId?: string } | null;
  isAgentMode: boolean;
  resetProjectToolsRuntimeRef: MutableRefObject<() => void>;
  dock: ReturnType<typeof useConversationRightDock>;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  settings: AppSettings;
  settingsSyncReady: boolean;
  status: AgentStatus | null;
  terminalClient: ReturnType<typeof useGatewayClients>["terminalClient"];
};

export function useGatewayProjectTools({
  activeWorkspaceProjectPath,
  addNotify,
  api,
  codeReviewSkill,
  composerRef,
  displayedConversationId,
  workspaceOwner,
  displayedConversationWorkdir,
  terminalIdentity,
  isAgentMode,
  resetProjectToolsRuntimeRef,
  dock,
  setSettings,
  settings,
  settingsSyncReady,
  status,
  terminalClient,
}: UseGatewayProjectToolsOptions) {
  const { rightDockOpen, setRightDockOpen } = dock;
  const terminalProjectPath = isAgentMode
    ? displayedConversationWorkdir.trim() || activeWorkspaceProjectPath.trim()
    : "";
  const terminalProjectPathKey = terminalProjectPath
    ? workspaceProjectPathKey(terminalProjectPath)
    : "";
  const {
    rightDockProjectState,
    rightDockFileTreeState,
    rightDockFileTreeOpen,
    associatedSshHostIds,
    handleChatTranscriptWidthChange,
    handleRightDockWidthChange,
    handleRightDockProjectStateChange,
    handleRightDockFileTreeStateChange,
    handleSshProjectHostIdsChange,
  } = useRightDockSettings({ settings, setSettings, terminalProjectPathKey, dock });
  const rightDockSshTunnelOpen = Boolean(rightDockProjectState.tools.sshTunnel);
  const projectToolsDisabledMessage = !settingsSyncReady
    ? translate("projectTools.settingsSyncing", settings.locale)
    : !isAgentMode
      ? translate("projectTools.agentModeRequired", settings.locale)
      : !terminalProjectPath
        ? translate("projectTools.projectRequired", settings.locale)
        : undefined;
  const terminalDisabledMessage =
    projectToolsDisabledMessage ??
    (!settings.remote.enableWebTerminal
      ? translate("projectTools.webTerminalDisabled", settings.locale)
      : undefined);
  const webTerminalSessionsEnabled =
    settings.remote.enableWebTerminal || settings.remote.enableWebSshTerminal;
  const runtime = useProjectToolsRuntime({
    workspaceOwner,
    conversationId: displayedConversationId,
    terminalClient,
    settingsSyncReady,
    isAgentMode,
    webTerminalSessionsEnabled,
    statusOnline: status?.online,
    statusSessionId: status?.session_id,
    terminalProjectPath,
    terminalProjectPathKey,
    terminalIdentity,
    rightDockFileTreeOpen,
    rightDockSshTunnelOpen,
  });
  resetProjectToolsRuntimeRef.current = runtime.resetTerminalSessions;
  const tabbedWorkspace = isAgentMode && Boolean(terminalClient);
  const restoreTabs =
    tabbedWorkspace &&
    settingsSyncReady &&
    Boolean(status?.online && terminalProjectPathKey && displayedConversationId) &&
    !isLocalDraftConversationId(displayedConversationId);
  const revealWorkspace = useCallback(() => setRightDockOpen(true), [setRightDockOpen]);
  const workspaceTabs = useWorkspaceTabs(
    workspaceOwner,
    runtime.workspaceViewScope,
    revealWorkspace,
    restoreTabs
      ? {
          projectPathKey: terminalProjectPathKey,
          workdir: terminalProjectPath,
          open: rightDockOpen,
          setOpen: setRightDockOpen,
        }
      : undefined,
  );
  const { openFile, openTree, activate } = workspaceTabs;
  const { hideWorkspaceSshTerminalOverlay } = runtime;
  const { openFileTab, openWorkspaceEditorFile, openWorkspaceFilePreview } =
    useWorkspaceFileOpening({
      tabbed: tabbedWorkspace,
      openFile,
      closeTerminalOverlay: hideWorkspaceSshTerminalOverlay,
      openEditorOverlay: runtime.openWorkspaceEditorFile,
      openPreviewOverlay: runtime.openWorkspaceFilePreview,
    });
  const handleOpenWorkspaceFile = useCallback(
    (path: string, imagePaths?: string[], temporary = false) => {
      const request = {
        projectPathKey: terminalProjectPathKey,
        workdir: terminalProjectPath,
        path,
        imagePaths,
      };
      if (openFileTab(request, isWorkspacePreviewPath(path) ? "preview" : "source", temporary))
        return;
      runtime.handleOpenWorkspaceFile(path, imagePaths);
      if (isMobileSidebarLayout()) setRightDockOpen(false);
    },
    [
      openFileTab,
      runtime.handleOpenWorkspaceFile,
      setRightDockOpen,
      terminalProjectPath,
      terminalProjectPathKey,
    ],
  );

  const gitDisabledMessage = !settings.remote.enableWebGit
    ? translate("projectTools.webGitDisabled", settings.locale)
    : undefined;
  const tunnelEnabled = settingsSyncReady && settings.remote.enableWebTunnels === true;
  const tunnelDisabledMessage = !settingsSyncReady
    ? translate("chat.runtime.tunnelSettingsSyncing", settings.locale)
    : !settings.remote.enableWebTunnels
      ? translate("projectTools.tunnelWebDisabled", settings.locale)
      : undefined;
  const workspaceActivityClient = useMemo(
    () => (api ? createGatewayWorkspaceActivityClient(api) : null),
    [api],
  );
  const {
    gitReviewFocusRequest,
    handleGitReviewFocusRequestHandled,
    handleChangedFileReveal: revealLegacyTree,
    changedFilesActions: legacyChangedFilesActions,
  } = useChangedFilesActions({
    terminalProjectPathKey,
    workspaceViewScope: runtime.workspaceViewScope,
    setRightDockOpen,
    onDockToolStateChange: handleRightDockProjectStateChange,
    onOpenFile: handleOpenWorkspaceFile,
  });
  const selectWorkspacePath = useCallback(
    (path: string) => {
      const relative = workspaceImageRelativePathForCopy(terminalProjectPath, path);
      if (
        !relative ||
        /^(?:[a-z]:[/\\]|[/\\])/i.test(relative) ||
        relative.split("/").includes("..")
      )
        return;
      handleRightDockFileTreeStateChange({
        selectedPath: relative,
        expandedPaths: [
          ...new Set([
            ...rightDockFileTreeState.expandedPaths,
            ...expandedPathsForFileTreePath(relative),
          ]),
        ],
        bumpRevision: true,
      });
    },
    [handleRightDockFileTreeStateChange, rightDockFileTreeState.expandedPaths, terminalProjectPath],
  );
  const handleChangedFileReveal = useCallback(
    (path: string) => {
      if (!tabbedWorkspace) return revealLegacyTree(path);
      selectWorkspacePath(path);
      openTree();
      revealWorkspace();
    },
    [openTree, revealLegacyTree, revealWorkspace, selectWorkspacePath, tabbedWorkspace],
  );
  const handleOpenWorkspaceDiff = useCallback(
    (path: string, temporary = false) => {
      if (
        !gitDisabledMessage &&
        openFileTab(
          { projectPathKey: terminalProjectPathKey, workdir: terminalProjectPath, path },
          "diff",
          temporary,
        )
      ) {
        selectWorkspacePath(path);
      }
    },
    [
      gitDisabledMessage,
      openFileTab,
      selectWorkspacePath,
      terminalProjectPath,
      terminalProjectPathKey,
    ],
  );
  const changedFilesActions = useMemo(
    () =>
      tabbedWorkspace
        ? {
            onOpenFile: handleOpenWorkspaceFile,
            onRevealInFileTree: handleChangedFileReveal,
            onOpenDiff: (path: string | null) => {
              if (path && !gitDisabledMessage) handleOpenWorkspaceDiff(path);
              else {
                activate(null);
                legacyChangedFilesActions.onOpenDiff?.(path);
              }
            },
          }
        : legacyChangedFilesActions,
    [
      activate,
      gitDisabledMessage,
      handleChangedFileReveal,
      handleOpenWorkspaceDiff,
      handleOpenWorkspaceFile,
      legacyChangedFilesActions,
      tabbedWorkspace,
    ],
  );
  const notifyChatFileLinkError = useCallback(
    (message: string) => addNotify("error", message),
    [addNotify],
  );
  const readChatFileLinkError = useCallback(
    (error: unknown) => asErrorMessage(error, "The linked file could not be opened."),
    [],
  );
  const handleOpenChatFileLink = useChatFileLinkNavigation({
    conversationId: displayedConversationId,
    conversationWorkdir: displayedConversationWorkdir,
    resolveWorkdirOnHost: true,
    readStagedAttachments: true,
    workspaceOwner,
    terminalProjectPathKey,
    notifyError: notifyChatFileLinkError,
    onRevealInFileTree: handleChangedFileReveal,
    onSelectInFileTree: tabbedWorkspace ? selectWorkspacePath : undefined,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    getErrorMessage: readChatFileLinkError,
  });
  const composerActions = useComposerActions(composerRef);
  const handleRightDockInsertCodeReviewSkill = useInsertCodeReviewSkill({
    composerRef,
    codeReviewSkill,
    setSettings,
  });
  const handleRightDockClose = useCallback(() => {
    setRightDockOpen(false);
  }, [setRightDockOpen]);

  return {
    ...runtime,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    tabbedWorkspace,
    workspaceTabs,
    handleOpenWorkspaceDiff,
    handleOpenWorkspaceFile,
    ...composerActions,
    associatedSshHostIds,
    changedFilesActions,
    gitDisabledMessage,
    gitReviewFocusRequest,
    handleChatTranscriptWidthChange,
    handleGitReviewFocusRequestHandled,
    handleOpenChatFileLink,
    handleRightDockClose,
    handleRightDockFileTreeStateChange,
    handleRightDockInsertCodeReviewSkill,
    handleRightDockProjectStateChange,
    handleRightDockWidthChange,
    handleSshProjectHostIdsChange,
    projectToolsDisabledMessage,
    rightDockFileTreeState,
    rightDockProjectState,
    terminalDisabledMessage,
    terminalProjectPath,
    terminalProjectPathKey,
    tunnelDisabledMessage,
    tunnelEnabled,
    workspaceActivityClient,
  };
}
