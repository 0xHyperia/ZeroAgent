import { ApplicationView, type ApplicationViewId } from "@liveagent/ui/application/ApplicationView";
import { AppWorkbenchChrome } from "@liveagent/ui/application/AppWorkbenchChrome";
import { BrandMark } from "@liveagent/ui/application/BrandMark";
import { SettingsWorkspace } from "@liveagent/ui/application/SettingsWorkspace";
import { useNavigationPreview } from "@liveagent/ui/application/useNavigationPreview";
import {
  useWorkbenchAccountDestination,
  useWorkbenchAccountSurface,
} from "@liveagent/ui/application/useWorkbenchAccountSurface";
import { WorkbenchAccountSidebar } from "@liveagent/ui/application/WorkbenchFeatureSidebar";
import { WorkbenchNavigationMount } from "@liveagent/ui/application/WorkbenchNavigationMount";
import { WorkbenchNavigationRail } from "@liveagent/ui/application/WorkbenchNavigationRail";
import { WorkbenchBody, WorkbenchShell } from "@liveagent/ui/application/WorkbenchShell";
import {
  createWorkbenchNavigationItem,
  DEVICE_WORKBENCH_NAVIGATION,
  type WorkbenchNavigationId,
} from "@liveagent/ui/application/workbenchNavigation";
import { useWorkbenchNavigationTarget } from "@liveagent/ui/application/workbenchNavigationPortal";
import { AppErrorBoundary } from "@liveagent/ui/components/AppErrorBoundary";
import { ChangedFilesActionsProvider } from "@liveagent/ui/components/chat/ChangedFilesCard";
import { ConversationViewTabs } from "@liveagent/ui/components/chat/ConversationViewTabs";
import type {
  ClarifyContext,
  RunClarifyTurn,
} from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import { FileDropOverlay } from "@liveagent/ui/components/chat/FileDropOverlay";
import { HistoryShareModal } from "@liveagent/ui/components/chat/HistoryShareModal";
import { NavigationHistoryButtons } from "@liveagent/ui/components/chat/NavigationHistoryButtons";
import { SharedHistoryManagerModal } from "@liveagent/ui/components/chat/SharedHistoryManagerModal";
import { TaskProgressBar } from "@liveagent/ui/components/chat/TaskProgressBar";
import { TranscriptLatestButton } from "@liveagent/ui/components/chat/TranscriptLatestButton";
import { WorkspaceCloneModal } from "@liveagent/ui/components/chat/WorkspaceCloneModal";
import { WorkspaceCloneTaskOverlay } from "@liveagent/ui/components/chat/WorkspaceCloneTaskOverlay";
import { WorkspaceProjectSettingsModal } from "@liveagent/ui/components/chat/WorkspaceProjectSettingsModal";
import { SquarePen } from "@liveagent/ui/components/IconSet";
import { ProjectToolsPanelToggle } from "@liveagent/ui/components/project-tools/ProjectToolsPanelToggle";
import { RightDockPanel } from "@liveagent/ui/components/project-tools/RightDockPanel";
import { MIN_DOCKED_WORKSPACE_WITH_CAPTIONS } from "@liveagent/ui/components/project-tools/rightDockModel";
import { DeviceWorkbenchLayout } from "@liveagent/ui/components/project-tools/WorkspacePanels";
import { useWorkspaceTabPresentation } from "@liveagent/ui/components/project-tools/WorkspaceTabPresentation";
import { DeviceConversationImageSurface } from "@liveagent/ui/components/resource-preview/DeviceConversationImageSurface";
import { DeviceUiTranscript } from "@liveagent/ui/components/sandboxed-ui/DeviceUiTranscript";
import { TrajectoryView } from "@liveagent/ui/components/trajectory/TrajectoryView";
import { Button } from "@liveagent/ui/components/ui/button";
import { DropdownMenuItem } from "@liveagent/ui/components/ui/dropdown-menu";
import { ScrollArea } from "@liveagent/ui/components/ui/scroll-area";
import { useSidebar } from "@liveagent/ui/components/ui/sidebar";
import { SkipToComposerLink } from "@liveagent/ui/components/ui/skip-link";
import { StatusNotice } from "@liveagent/ui/components/ui/status-notice";
import { Toaster } from "@liveagent/ui/components/ui/toaster";
import { PaneChrome } from "@liveagent/ui/components/workbench/PaneChrome";
import {
  type ProjectToolPaneEnvironment,
  ProjectToolPaneHost,
} from "@liveagent/ui/components/workbench/ProjectToolPaneHost";
import { UnsupportedPaneSurface } from "@liveagent/ui/components/workbench/surfaces/UnsupportedPaneSurface";
import { WorkbenchCanvas } from "@liveagent/ui/components/workbench/WorkbenchCanvas";
import { WorkbenchEmptyState } from "@liveagent/ui/components/workbench/WorkbenchEmptyState";
import { requestWorkspaceRevision } from "@liveagent/ui/components/workspace-editor/requestWorkspaceRevision";
import type { WorkspaceDocumentRevision } from "@liveagent/ui/components/workspace-editor/WorkspaceFilePreviewOverlay";
import { WorkspaceOverlayHost } from "@liveagent/ui/components/workspace-editor/WorkspaceOverlayHost";
import { isWorkspacePreviewPath } from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import { DEVICE_COMPOSER_CAPABILITIES } from "@liveagent/ui/contracts/composerPresentation";
import type { FileRuntimeSummary } from "@liveagent/ui/contracts/fileRuntime";
import { useIsMobile } from "@liveagent/ui/hooks/use-mobile";
import { LocaleContext, t as translate } from "@liveagent/ui/i18n/index";
import type { ProjectToolTextGenerationClient } from "@liveagent/ui/lib/ai/projectToolTextGeneration";
import {
  type CheckpointRewindClient,
  CheckpointRewindProvider,
  type CheckpointRewoundInfo,
  formatCheckpointRewoundNotification,
} from "@liveagent/ui/lib/chat/checkpointRewind";
import type { ComposerCommandHost } from "@liveagent/ui/lib/chat/composerCommands";
import { searchPersistedConversations } from "@liveagent/ui/lib/chat/conversationSearch";
import { QUICK_OPEN_MAX_FILES } from "@liveagent/ui/lib/chat/fileQuickOpenSearch";
import type { ChatHistorySearchResponse } from "@liveagent/ui/lib/chat/historySearch";
import { rememberSshHostNames } from "@liveagent/ui/lib/chat/sshManagerDisplay";
import { nextThinkingLevel } from "@liveagent/ui/lib/chat/thinkingLevels";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { mergePendingUploadedFiles } from "@liveagent/ui/lib/chat/uploadedFiles";
import { useWorkbenchCommandPalette } from "@liveagent/ui/lib/chat/useWorkbenchCommandPalette";
import {
  activateRightDockTab,
  isFocusInRightDock,
  RIGHT_DOCK_TERMINAL_LAUNCHER,
  resolveCloseContextTarget,
  resolveTerminalToggle,
} from "@liveagent/ui/lib/chat/workbenchCommands";
import { parseModelValue } from "@liveagent/ui/lib/models/modelValue";
import {
  type DevicePluginsClient,
  workspaceTrustFromDevicePlugins,
} from "@liveagent/ui/lib/plugins/devicePlugins";
import { kbrainResourceHostCapabilities } from "@liveagent/ui/lib/resourceHost";
import {
  DEVICE_WEB_HIDDEN_SETTINGS_SECTIONS,
  getWorkbenchSettingsSections,
} from "@liveagent/ui/lib/settings/settingsSearchIndex";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import type { SttSettingsService } from "@liveagent/ui/lib/stt/types";
import {
  mergeTerminalSession,
  reconcileSshTerminalSessions,
  removeTerminalSession,
} from "@liveagent/ui/lib/terminal/sessionStore";
import { toTrajectoryMessages } from "@liveagent/ui/lib/trajectory/transcriptMessages";
import { useConversationViewState } from "@liveagent/ui/lib/trajectory/useConversationViewState";
import {
  hitTestWorkbenchDrop,
  leasedProjectToolKinds,
  projectToolSurfaceTitleKey,
} from "@liveagent/ui/lib/workbench/index";
import {
  isProjectToolSurface,
  type PaneRecord,
  PROJECT_TOOL_SURFACE_KINDS,
} from "@liveagent/ui/lib/workbench/types";
import { ChatComposerBar } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { FloorNavRail } from "@liveagent/ui/pages/chat/transcript/FloorNavRail";
import {
  CHAT_TRANSCRIPT_WIDTH_CSS_VAR,
  TranscriptWidthControls,
} from "@liveagent/ui/pages/chat/transcript/TranscriptWidthControls";
import { DeviceModelPreferencesDialog } from "@liveagent/ui/pages/settings/DeviceModelPreferencesDialog";
import { SettingsPage } from "@liveagent/ui/pages/settings/SettingsPage";
import {
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  gatewayImageErrorNotice,
  type TrustedGatewayImageIdentity,
  useWebImageStudioHost,
} from "@/agent-ui-adapters/imageStudio";
import { createGatewayTrajectoryHost } from "@/agent-ui-adapters/trajectory";
import { ConnectedDeviceTasks } from "@/components/cloudchat/ConnectedDeviceTasks";
import { DesktopHostSlot } from "@/components/DesktopHostSlot";
import { ExecutionEnvironmentSwitcher } from "@/components/ExecutionEnvironmentSwitcher";
import { useGatewayDeviceImages } from "@/components/GatewayDeviceImages";
import { GatewayTranscript } from "@/components/GatewayTranscript";
import { MobileSidebarUpdate } from "@/components/mobile/MobileAppExperience";
import { FirstRunOnboarding } from "@/components/onboarding/FirstRunOnboarding";
import { executeClarifyPromptTurn } from "@/lib/chat/clarifyPromptTurn";
import { gatewayOrigin, getDesktopRemoteHost } from "@/lib/desktopRemoteHost";
import { useGatewayImageIdentity } from "@/lib/imageIdentity";
import { isEmbeddedMobileRuntime } from "@/lib/mobileRuntime";
import { bindRelayKeysToSettings } from "@/lib/relay/providers";
import {
  getNextTheme,
  getRightDockFileTreeState,
  getSshProjectHostIds,
  updateExecutionModeFromChatSelection,
  updateRightDockFileTreeState,
  updateSshProjectHostIds,
  updateSystem,
  updateWorkspaceResourceSettings,
  workspaceProjectPathKey,
} from "@/lib/settings";
import {
  liveTrajectoryAuthoritativeRevision,
  liveTrajectoryEvents,
  subscribeLiveTrajectory,
} from "@/lib/trajectory/liveTrajectory";
import {
  GATEWAY_CHAT_FRAME_CLASS,
  GATEWAY_EMBEDDED_SHELL_CLASS,
  GATEWAY_MAIN_BACKDROP_CLASS,
  GATEWAY_MAIN_SHELL_CLASS,
  GATEWAY_SETTINGS_OVERLAY_CLASS,
  GATEWAY_SHELL_CLASS,
  GATEWAY_TRANSCRIPT_LATEST_BOTTOM,
  GATEWAY_TRANSCRIPT_SCROLL_CLASS,
} from "@/lib/webStyleClasses";
import { WorkdirPickerModal } from "@/pages/settings/WorkdirPickerModal";
import { openUrl } from "@/shims/tauriOpener";
import {
  settingsHostAdapter,
  WEB_SETTINGS_EXCLUDED_ANCHORS,
} from "../agent-ui-adapters/settingsExtension";
import { ConversationStatsBarHost } from "./ConversationStatsBarHost";
import { asErrorMessage } from "./chatEventUtils";
import { CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS } from "./constants";
import type { GatewayAppViewModel } from "./GatewayApp";
import {
  GatewayDeviceConnectionNotice,
  GatewaySavedDeviceDraftNotice,
} from "./GatewayDeviceConnectionNotice";
import { isLocalDraftConversationId } from "./gatewayLocalDraft";
import { HistorySwitchLoadingOverlay } from "./HistorySwitchLoadingOverlay";
import { useWindowFileDropGuard } from "./hooks/useWindowFileDropGuard";
import { sendComposerCommandTurn } from "./sendComposerCommandTurn";
import { GatewaySidebarContainer } from "./sidebar/GatewaySidebarContainer";
import { UserMenu } from "./UserMenu";
import { WebGoalBarHost } from "./WebGoalBarHost";
import { createWebComposerCommandHost } from "./webComposerCommandHost";
import {
  GatewayConversationPaneHost,
  type GatewayConversationPaneHostContext,
  type GatewayConversationPrimarySurface,
} from "./workbench/GatewayConversationPaneHost";
import { GatewayTerminalPaneHost } from "./workbench/GatewayTerminalPaneHost";
import { sessionWorkbench } from "./workbench/sessionWorkbench";

const DESKTOP_ACCOUNT_PREVIEW_DESTINATIONS: readonly WorkbenchNavigationId[] = [
  ...DEVICE_WORKBENCH_NAVIGATION,
  "library",
  "customize",
];

export function GatewayAppView({
  viewModel,
  imageStudioIdentity,
}: {
  viewModel: GatewayAppViewModel;
  imageStudioIdentity?: TrustedGatewayImageIdentity;
}) {
  const desktopHost = getDesktopRemoteHost();
  const desktopSettingsTarget = useWorkbenchNavigationTarget(desktopHost?.settingsNavigation);
  const [settingsRailTarget, setSettingsRailTarget] = useState<HTMLDivElement | null>(null);
  const navigationTarget = desktopSettingsTarget ?? settingsRailTarget;
  const imageDeviceUnsupported =
    isEmbeddedMobileRuntime() && viewModel.imageStudioToken.startsWith("selection.");
  const imageDeviceToken = imageDeviceUnsupported ? "" : viewModel.imageStudioToken;
  const identity = useGatewayImageIdentity(imageDeviceToken, imageStudioIdentity);
  const imageStudio = useWebImageStudioHost(
    imageDeviceToken,
    identity.identity,
    viewModel.activeWorkspaceProjectPath,
    (key) => translate(key, viewModel.settings.locale),
  );
  const imageDeviceOnline = viewModel.status?.online;
  const offlineImageDevice = useRef<string | undefined>(undefined);
  const [imageReconnect, setImageReconnect] = useState(0);
  const retryImageIdentity = identity.retry;
  const retryImageHost = imageStudio.retry;
  useEffect(() => {
    if (!imageDeviceToken.startsWith("selection.")) return;
    if (imageDeviceOnline === false) {
      offlineImageDevice.current = imageDeviceToken;
    } else if (imageDeviceOnline && offlineImageDevice.current === imageDeviceToken) {
      offlineImageDevice.current = undefined;
      if (imageStudio.host) setImageReconnect((version) => version + 1);
      else if (identity.identity) retryImageHost();
      else retryImageIdentity();
    }
  }, [
    identity.identity,
    imageDeviceOnline,
    imageDeviceToken,
    imageStudio.host,
    retryImageHost,
    retryImageIdentity,
  ]);
  const chatFrameRef = useRef<HTMLDivElement | null>(null);
  useWindowFileDropGuard();

  const {
    activeFloorKey,
    activeSelectedModel,
    activeView,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    addNotify,
    api,
    approvalBar,
    approvalConversationIds,
    archivedWorkspaceProjectPathKeys,
    associatedSshHostIds,
    availableSkills,
    branchPendingMessageId,
    canDropUpload,
    canEditOfflineDraft,
    canShareHistory,
    cancelChat,
    changedFilesActions,
    chatError,
    setChatError,
    chatProtocolIncompatibleMessage,
    chatRuntimeControlsForCurrentProvider,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    closeSettings,
    codeReviewSkill,
    cancelQueuedChatEdit,
    commitQueuedChatEdit,
    composerCompactionBlocked,
    composerDraftOnly,
    composerInputDisabled,
    composerIsSending,
    composerPlaceholder,
    composerRef,
    confirmDialog,
    contextUsageTokensSource,
    conversationOpenState,
    deviceHistoryOpenFailed,
    openDeviceTaskConversation,
    retryDeviceHistoryOpen,
    savedDeviceDraftNotice,
    retrySavedDeviceDraft,
    currentChatProvider,
    currentModelContextWindow,
    currentModelLabel,
    displayedConversationBusyRef,
    displayedConversationId,
    displayedConversationWorkdir,
    displayedTranscript,
    displayedTranscriptRowCount,
    editQueuedTurn,
    effectiveTheme,
    enabledComposerSkills,
    environments,
    selection,
    relayUser,
    relayStats,
    refreshRelayAccount,
    fileDropDescription,
    fileDropLimitHint,
    fileDropTitle,
    fileInputRef,
    folderInputRef,
    gatewayConnectionLost,
    getCachedComposerDraft,
    verifiedDeviceReplyIdentity,
    takeDeviceReplyDraft,
    registerDevicePaneDraft,
    getDisplayedConversationId,
    getPendingUploadsForConversation,
    replacePendingUpload,
    subscribePendingUploads,
    gitClient,
    gitDisabledMessage,
    gitReviewFocusRequest,
    handleArchiveWorkspaceProject,
    handleBranchConversation,
    handleBrowseWorkspaceProjectInFileTree,
    handleCancelWorkspaceCloneTask,
    handleChatRuntimeControlsChange,
    handleChatTranscriptWidthChange,
    handleCloneWorkspaceProject,
    handleCloseShareModal,
    handleCommitWorkspaceProjectRename,
    handleComposerBusyChange,
    handleCreateWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleDisableSharedHistory,
    handleDismissWorkspaceCloneTask,
    handleEmptyStateSuggestion,
    handleFileDragEnter,
    handleFileDragLeave,
    handleFileDragOver,
    handleFileDrop,
    handleFloorJump,
    handleGitReviewFocusRequestHandled,
    handleImportReadableFiles,
    handleImportSelectedDirectoryFiles,
    handleInsertCodeMention,
    handleLoadEarlierHistory,
    handleLoadSharedHistoryStatus,
    handleLoadUploadedImagePreview,
    handleLoadWorkspaceRemoteBranches,
    handleLogout,
    handleManualCompact,
    handleMoveWorkspaceProjectToGroup,
    handleNewConversationForProject,
    handleOpenChatFileLink,
    handleOpenClonedWorkspace,
    handleOpenCreateWorkspaceProject,
    handleOpenShareModal,
    handleOpenSharedHistoryManager,
    handleOpenSftpFile,
    handleOpenSshTerminal,
    handleOpenWorkspaceFile,
    handleOpenWorkspaceDiff,
    handleOpenWorkspaceFolder,
    handleOpenWorktree,
    handleProjectTerminalSessionsChange,
    updateProjectTerminalSessions,
    handleRefreshSharedHistoryStatuses,
    handleRemoveWorkspaceProject,
    handleRenameWorkspaceGroup,
    handleResendFromEdit,
    handleRightDockClose,
    handleRightDockFileTreeStateChange,
    handleRightDockInsertCodeReviewSkill,
    handleRightDockInsertCommitMention,
    handleRightDockInsertFileMention,
    handleRightDockInsertGitFileMention,
    handleRightDockProjectStateChange,
    handleRightDockWidthChange,
    handleSelectModel,
    handleSelectWorkspaceProject,
    handleSetShareRedactToolContent,
    handleSetSharedHistoryRedactToolContent,
    handleSetWorkspaceProjectPinned,
    handleSettingsTransitionEnd,
    handleSidebarConversationsRemoved,
    handleSidebarLocalDraftDeleted,
    handleSidebarNewConversation,
    handleSidebarOpenResourceHub,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
    handleSidebarSelectConversation,
    handleSshProjectHostIdsChange,
    handleToggleHistoryShare,
    handleToggleWorkspaceGroupCollapsed,
    handleUnarchiveWorkspaceProject,
    handleWorkdirPickerSelect,
    handleWorkspaceEditorClosed,
    handleWorkspaceEditorHide,
    handleWorkspaceFilePreviewClosed,
    handleWorktreeRemoved,
    hideWorkspaceSshTerminalOverlay,
    historyDetailLoadingTitle,
    historyShareToken,
    importFilesForConversation,
    importDeviceConversationFiles,
    isAgentDevExecutionMode,
    isAgentMode,
    isConversationBusy,
    isFileDropActive,
    isImportingPastedTextRef,
    isUploadingFiles,
    uploadingConversationId,
    loadComposerHistoryPrompts,
    loadingOlderHistory,
    localeContextValue,
    manualCompactPending,
    manualCompactTransientConversations,
    mentionableConversations,
    searchMentionableConversations,
    materializeComposerDraftForSend,
    mentionApps,
    missingWorkspaceProjectPathKeys,
    modelOptions,
    moveQueuedTurnUp,
    openSettings,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    overlay,
    pendingUploadedFiles,
    prepareChatRuntime,
    projectPickerOpen,
    projectTerminalSessions,
    projectToolsDisabledMessage,
    queuedChatEditSessionRef,
    queuedChatTurnsForDisplayedConversation,
    queuePaused,
    queueControlPending,
    handleQueuePausedChange,
    removeQueuedTurn,
    requestWorkspaceFilePreviewClose,
    projectSettingsProject,
    rightDockFileTreeState,
    rightDockOpen,
    rightDockProjectState,
    runQueuedTurnNow,
    selectedHistoryHasMore,
    selectedValue,
    selectionForConversation,
    sendChat,
    setActiveFloorKey,
    setCachedComposerDraft,
    setPendingUploadsForConversation,
    setProjectPickerOpen,
    setProjectSettingsProject,
    setRightDockOpen,
    setActiveView,
    setSettings,
    setSharedManagerOpen,
    setSidebarOpen,
    setTranscriptScrollAreaRoot,
    setTranscriptViewport,
    setUserMenuOpen,
    setWorkspaceCreateModalOpen,
    switchExecutionTarget,
    rememberDeviceDrafts,
    settings,
    settingsOpen,
    modelPreferencesOpen,
    setModelPreferencesOpen,
    settingsProviderId,
    settingsSaveState,
    settingsSection,
    settingsAnchor,
    settingsSyncError,
    sftpClient,
    shareConversation,
    shareError,
    shareLoading,
    shareStatus,
    shareUpdating,
    sharedHistoryItems,
    sharedHistoryListError,
    sharedManagerErrors,
    sharedManagerLoadingIds,
    sharedManagerOpen,
    sharedManagerStatuses,
    sharedManagerUpdatingIds,
    sidebarActionError,
    sidebarOpen,
    sidebarSectionsDisabled,
    sidebarStore,
    skillsRootDir,
    status,
    statusError,
    submitCurrentComposerToGuiQueue,
    submitInFlightRef,
    handleConversationStreamEvent,
    handleConversationStreamSync,
    taskProgressSnapshot,
    terminalClient,
    terminalDisabledMessage,
    terminalProjectPath,
    tabbedWorkspace,
    terminalProjectPathKey,
    terminalSessions,
    terminalSessionsLoaded,
    transcriptBusy,
    transcriptError,
    transcriptFloors,
    transcriptFollow,
    transcriptFollowing,
    transcriptHistoryLoading,
    transcriptLiveStartIndex,
    transcriptNavRef,
    transcriptRows,
    transcriptStageRef,
    transcriptStoreRegistry,
    transcriptToolStatus,
    transcriptToolStatusIsCompaction,
    transcriptViewport,
    tunnelDisabledMessage,
    tunnelEnabled,
    updatePendingUploadsForConversation,
    verifyTerminalSessionAlive,
    userAvatarLabel,
    userMenuLabel,
    userMenuOpen,
    workbenchController,
    workdirForConversation,
    workspaceActivityClient,
    workspaceCloneTasks,
    workspaceCreateModalOpen,
    workspaceViewScope,
    workspaceOwner,
    workspaceTabs,
    workspaceEditors,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceFolderDropActive,
    workspaceFolderDropHandlers,
    workspaceProjects,
    workspaceProjectRootClient,
    workspaceRootRevision,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
  } = viewModel;
  const transportInputDisabled =
    sidebarSectionsDisabled || Boolean(chatProtocolIncompatibleMessage);
  const sidebar = useSidebar();
  const compactViewport = useIsMobile();
  const taskDeviceId = selection?.runtime_kind === "device_agent" ? selection.device_id : undefined;
  const taskOwner = relayUser?.id;
  const taskDeviceAuthorization = useRef({ owner: taskOwner, selection });
  taskDeviceAuthorization.current = { owner: taskOwner, selection };
  const requireTaskDevice = useCallback(() => {
    const latest = taskDeviceAuthorization.current;
    if (
      !taskOwner ||
      latest.owner !== taskOwner ||
      !taskDeviceId ||
      latest.selection?.runtime_kind !== "device_agent" ||
      latest.selection.device_id !== taskDeviceId ||
      !latest.selection.selection_lease ||
      (latest.selection.expires_at && !(Date.parse(latest.selection.expires_at) > Date.now()))
    )
      throw new Error(
        settings.locale === "zh-CN"
          ? "设备授权已失效，请重新连接设备。"
          : "The device authorization expired. Reconnect to the device.",
      );
  }, [settings.locale, taskDeviceId, taskOwner]);
  const pluginTarget = selection?.scope === "device" ? selection.target_fingerprint : undefined;
  const devicePlugins = useMemo<DevicePluginsClient | undefined>(() => {
    if (!api || !taskOwner || !taskDeviceId || !pluginTarget) return undefined;
    const checkSelection = () => {
      requireTaskDevice();
      if (
        taskDeviceAuthorization.current.selection?.scope !== "device" ||
        taskDeviceAuthorization.current.selection?.target_fingerprint !== pluginTarget
      ) {
        throw new Error("DEVICE_PLUGIN_SCOPE_CHANGED");
      }
    };
    return {
      installSource: "workspace",
      async operation(request) {
        checkSelection();
        if (!request.workdir) throw new Error("DEVICE_PLUGIN_WORKSPACE_REQUIRED");
        const snapshot = await api.devicePlugins(request);
        checkSelection();
        return snapshot;
      },
      async readSurface(request) {
        checkSelection();
        if (!request.workdir) throw new Error("DEVICE_PLUGIN_WORKSPACE_REQUIRED");
        const result = await api.readDeviceUiSurface(request);
        checkSelection();
        return result;
      },
    };
  }, [api, taskOwner, taskDeviceId, pluginTarget, requireTaskDevice]);
  const projectSettingsPath = projectSettingsProject?.path;
  const projectTrustClient = useMemo(
    () =>
      devicePlugins && projectSettingsPath
        ? workspaceTrustFromDevicePlugins(devicePlugins, projectSettingsPath)
        : undefined,
    [devicePlugins, projectSettingsPath],
  );
  const showDeviceTasks = activeView === "cron-hub" && !!taskOwner && !!taskDeviceId;
  const accountNavigation = desktopHost?.accountNavigation;
  const leaveAccount = (navigate: () => void) => {
    if (accountNavigation) accountNavigation.close(navigate);
    else navigate();
  };
  const accountDestination = useWorkbenchAccountDestination(accountNavigation);
  const compactDeviceHeader =
    compactViewport && !desktopHost && !historyShareToken && !accountDestination;
  const committedDestination = accountDestination ?? activeView;
  const navigationPreview = useNavigationPreview(
    !sidebar.isMobile && !settingsOpen,
    relayUser?.id ?? "device",
    {
      pinnedOpen: sidebar.open,
      destination: committedDestination,
      destinations: accountNavigation
        ? DESKTOP_ACCOUNT_PREVIEW_DESTINATIONS
        : DEVICE_WORKBENCH_NAVIGATION,
    },
  );
  const shownSidebar = navigationPreview.open
    ? navigationPreview.destination
    : committedDestination;
  const showAccountSidebar = !!accountDestination && shownSidebar === accountDestination;
  const accountSidebar =
    shownSidebar === "library" || shownSidebar === "customize" ? shownSidebar : null;
  const openAccountTasks = useCallback(() => setActiveView("cron-hub"), [setActiveView]);
  const accountSurface = useWorkbenchAccountSurface({
    bind: desktopHost?.onAccountSurface,
    enabled: !!accountNavigation,
    sidebarVisible: showAccountSidebar && !sidebar.isMobile,
    sidebarOpen,
    sidebarPreview: navigationPreview.open && showAccountSidebar,
    setSidebarOpen,
    dismissPreview: navigationPreview.dismiss,
    close: accountNavigation?.close,
    openTasks: openAccountTasks,
  });
  const showTaskSidebar = shownSidebar === "cron-hub" && !!taskOwner && !!taskDeviceId;
  const [taskSidebarTarget, setTaskSidebarTarget] = useState<HTMLDivElement | null>(null);
  // SSHManager rows name hosts by their configured name rather than the opaque id.
  rememberSshHostNames(settings.ssh.hosts);
  const sttSettingsService = useMemo<SttSettingsService>(
    () => ({
      runtime: "webui" as const,
      get: async () => settings.stt,
      update: async () => settings.stt,
      test: async () => ({
        result: "network_failed",
        message: "设备 WebUI 暂不提供语音输入配置",
      }),
    }),
    [settings.stt],
  );

  const {
    activeConversationView,
    setActiveConversationView,
    viewForConversation,
    setConversationView,
  } = useConversationViewState(displayedConversationId);
  const trajectoryHost = useMemo(
    () => createGatewayTrajectoryHost(api, handleOpenChatFileLink),
    [api, handleOpenChatFileLink],
  );
  // 正文只在切到轨迹页时才需要；转换本身很轻，跟随转录行 memo 即可。
  const trajectoryMessages = useMemo(() => toTrajectoryMessages(transcriptRows), [transcriptRows]);
  const hasConversationReply =
    displayedConversationId !== "" &&
    !isLocalDraftConversationId(displayedConversationId) &&
    trajectoryMessages.some((message) => message.role === "assistant");
  const renderedConversationView = hasConversationReply ? activeConversationView : "conversation";
  // 实时骨架来自 ChatEvent 流；账本层按事件身份去重，所以与落盘那份合并安全。
  const liveTrajectory = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryEvents(displayedConversationId),
  );
  const trajectoryAuthoritativeRevision = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryAuthoritativeRevision(displayedConversationId),
  );
  const handleSelectExecutionMode = useCallback(
    (mode: "text" | "tools") =>
      setSettings((prev) => updateExecutionModeFromChatSelection(prev, mode)),
    [setSettings],
  );
  const resolveCheckpointAuthorizedRoots = useCallback(async () => {
    const roots: string[] = [];
    const push = (value?: string | null) => {
      const normalized = value?.trim();
      if (normalized && !roots.includes(normalized)) roots.push(normalized);
    };
    push(displayedConversationWorkdir);
    if (
      activeWorkspaceProject &&
      activeWorkspaceProjectPath &&
      activeWorkspaceProjectPath === displayedConversationWorkdir
    ) {
      try {
        const grants = await api.listWorkspaceRootGrants(
          activeWorkspaceProject.id,
          activeWorkspaceProject.path,
        );
        for (const grant of grants) {
          if (grant.state === "active" && grant.access === "write") push(grant.canonicalPath);
        }
      } catch {
        // Keep the primary root when additional grant lookup fails.
      }
    }
    return roots;
  }, [activeWorkspaceProject, activeWorkspaceProjectPath, api, displayedConversationWorkdir]);
  const checkpointClient = useMemo<CheckpointRewindClient>(
    () => ({
      list: (conversationId) => api.listCheckpointTurns(conversationId),
      preview: (params) => api.previewCheckpointRewind(params),
      rewind: (params) => api.rewindCheckpoint(params),
    }),
    [api],
  );

  const handleCheckpointRewound = useCallback(
    (info: CheckpointRewoundInfo) => {
      const notice = formatCheckpointRewoundNotification(info, settings.locale);
      addNotify(notice.level, notice.message);
    },
    [addNotify, settings.locale],
  );
  // 提示词澄清执行器：经 gateway 中继到桌面宿主，用当前会话模型跑一轮纯文本
  // 补全；模型覆盖/回退/错误拍平在 executeClarifyPromptTurn（两宿主共用）。
  const runClarifyTurn = useCallback<RunClarifyTurn>(
    (messages, _signal, onTextDelta) =>
      executeClarifyPromptTurn(
        api,
        settings,
        {
          provider: currentChatProvider,
          model: activeSelectedModel?.model,
          runtimeControls: chatRuntimeControlsForCurrentProvider,
        },
        messages,
        onTextDelta,
      ),
    [
      settings,
      activeSelectedModel,
      currentChatProvider,
      chatRuntimeControlsForCurrentProvider,
      api,
    ],
  );

  const clarifyContext = useMemo<ClarifyContext | undefined>(
    () => (displayedConversationWorkdir ? { workdir: displayedConversationWorkdir } : undefined),
    [displayedConversationWorkdir],
  );

  // --- Session Workbench（多看板分屏）----------------------------------------
  // Pane 标题/无障碍标签取自侧栏权威索引；标题变化需要触发重渲染，所以走
  // useSidebarSelector 而不是 store.peek。
  const sidebarConversationsById = useSidebarSelector(sidebarStore, (snapshot) => snapshot.byId);
  // 与桌面端 workbenchPaneTitle 同口径:chrome 提示、拖拽幽灵与无障碍标签共用。
  const workbenchPaneTitle = useCallback(
    (surface: PaneRecord["surface"]): string => {
      switch (surface.kind) {
        case "conversation":
          return sidebarConversationsById.get(surface.conversationId)?.title?.trim() || "";
        case "fileTree":
        case "gitReview":
        case "tunnel":
        case "sshTunnel":
        case "backgroundTasks":
          return translate(projectToolSurfaceTitleKey(surface.kind), settings.locale);
        case "localTerminal":
          return surface.launchSpec.title?.trim() || surface.launchSpec.shell?.trim() || "Terminal";
        case "sshTerminal":
          return surface.launchSpec.title?.trim() || surface.launchSpec.sshHostId.trim() || "SSH";
        case "unsupported":
          return surface.originalKind;
      }
    },
    [settings.locale, sidebarConversationsById],
  );

  const workbenchHasMultiplePanes =
    sessionWorkbench.enabled && Object.keys(workbenchController.workbench.layout.panes).length >= 2;
  const primarySendInFlightConversationRef = useRef<string | null>(null);

  useEffect(() => {
    const handleQueueEditEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !(event.target instanceof Element))
        return;
      const composer = event.target.closest("[data-file-upload-conversation-id]");
      const session = queuedChatEditSessionRef.current;
      if (
        !session ||
        composer?.getAttribute("data-file-upload-conversation-id") !== session.conversationId
      )
        return;
      event.preventDefault();
      void cancelQueuedChatEdit();
    };
    document.addEventListener("keydown", handleQueueEditEscape);
    return () => document.removeEventListener("keydown", handleQueueEditEscape);
  }, [cancelQueuedChatEdit, queuedChatEditSessionRef]);

  const handlePrimaryComposerSend = useCallback(() => {
    const sendConversationId = getDisplayedConversationId();
    if (primarySendInFlightConversationRef.current === sendConversationId) return;
    // 上传在途只封锁归属会话:背景 Pane 的导入不应吞掉主 Pane 的发送。
    // 归属未知(null)时保守封锁,与旧全局互斥语义一致。
    const uploadBlocksSend =
      isUploadingFiles &&
      (!uploadingConversationId || uploadingConversationId === sendConversationId);
    if (uploadBlocksSend || isImportingPastedTextRef.current) return;
    if (composerInputDisabled || !api) return;
    if (queuedChatEditSessionRef.current?.conversationId === getDisplayedConversationId()) {
      primarySendInFlightConversationRef.current = sendConversationId;
      void (async () => {
        try {
          await commitQueuedChatEdit();
        } finally {
          if (primarySendInFlightConversationRef.current === sendConversationId) {
            primarySendInFlightConversationRef.current = null;
          }
        }
      })();
      return;
    }
    if (
      displayedConversationBusyRef.current ||
      queuedChatTurnsForDisplayedConversation.length > 0
    ) {
      primarySendInFlightConversationRef.current = sendConversationId;
      void (async () => {
        try {
          await submitCurrentComposerToGuiQueue("append");
        } finally {
          if (primarySendInFlightConversationRef.current === sendConversationId) {
            primarySendInFlightConversationRef.current = null;
          }
        }
      })();
      return;
    }
    const isCurrentAgent = api.captureActiveAgentScope();
    primarySendInFlightConversationRef.current = sendConversationId;
    void (async () => {
      try {
        const draft = composerRef.current?.getDraft() ?? null;
        let text: string;
        let files: PendingUploadedFile[];
        let referencedConversations = draft?.conversationMentions ?? [];
        try {
          const materialized = draft
            ? await materializeComposerDraftForSend(
                draft,
                pendingUploadedFiles,
                displayedConversationWorkdir,
                sendConversationId,
                isCurrentAgent,
              )
            : { text: "", uploadedFiles: pendingUploadedFiles, referencedConversations: [] };
          text = materialized.text;
          files = materialized.uploadedFiles;
          referencedConversations = materialized.referencedConversations;
        } catch (error) {
          if (isCurrentAgent()) addNotify("error", asErrorMessage(error, "大段粘贴内容导入失败"));
          return;
        }
        if (!isCurrentAgent() || (!text && files.length === 0)) return;
        if (getDisplayedConversationId() === sendConversationId) {
          composerRef.current?.clear();
        }
        setPendingUploadsForConversation(sendConversationId, []);
        void sendChat(text, {
          isCurrentAgent,
          conversationId: sendConversationId,
          uploadedFiles: files,
          referencedConversations,
          runtimeControls: chatRuntimeControlsForCurrentProvider,
        }).catch(() => {
          if (!isCurrentAgent()) return;
          updatePendingUploadsForConversation(sendConversationId, (current) =>
            mergePendingUploadedFiles(current, files),
          );
        });
      } finally {
        if (primarySendInFlightConversationRef.current === sendConversationId) {
          primarySendInFlightConversationRef.current = null;
        }
      }
    })();
  }, [
    addNotify,
    api,
    chatRuntimeControlsForCurrentProvider,
    commitQueuedChatEdit,
    composerInputDisabled,
    composerRef,
    displayedConversationBusyRef,
    displayedConversationWorkdir,
    getDisplayedConversationId,
    isImportingPastedTextRef,
    isUploadingFiles,
    uploadingConversationId,
    materializeComposerDraftForSend,
    pendingUploadedFiles,
    queuedChatEditSessionRef,
    queuedChatTurnsForDisplayedConversation.length,
    sendChat,
    setPendingUploadsForConversation,
    submitCurrentComposerToGuiQueue,
    updatePendingUploadsForConversation,
  ]);

  const handlePrimaryComposerStop = useCallback(() => {
    const nextQueuedTurn = queuedChatTurnsForDisplayedConversation[0];
    if (nextQueuedTurn && !queuePaused) {
      runQueuedTurnNow(nextQueuedTurn.id);
      return;
    }
    void cancelChat(displayedConversationId);
  }, [
    cancelChat,
    displayedConversationId,
    queuedChatTurnsForDisplayedConversation,
    queuePaused,
    runQueuedTurnNow,
  ]);

  // 背景会话 Pane 的共享上下文(复刻桌面端 buildBackgroundPaneBinding):所有
  // 会话级动作按 Pane 自己的 conversationId 显式路由;页面级机制(选模型、
  // 编辑队列项等)由宿主内部先聚焦本 Pane(focusGuard 口径)。
  const fileReaderOpen =
    workspaceFilePreviewOpen ||
    (rightDockOpen &&
      workspaceTabs.view.tabs.some(
        (tab) =>
          tab.id === workspaceTabs.view.activeId && tab.kind === "file" && tab.mode === "preview",
      ));
  const closeFileReader = useCallback(() => {
    if (workspaceFilePreviewOpen) requestWorkspaceFilePreviewClose();
    if (fileReaderOpen && rightDockOpen) handleRightDockClose();
  }, [
    workspaceFilePreviewOpen,
    requestWorkspaceFilePreviewClose,
    fileReaderOpen,
    rightDockOpen,
    handleRightDockClose,
  ]);
  const fallbackImages = useGatewayDeviceImages({
    api,
    conversationId: displayedConversationId,
    workdir: terminalProjectPath,
    enabled:
      !sessionWorkbench.enabled && renderedConversationView === "conversation" && isAgentMode,
    offline: transportInputDisabled,
    zh: settings.locale === "zh-CN",
    store: transcriptStoreRegistry.get(displayedConversationId),
    importFiles: importDeviceConversationFiles,
    send: sendChat,
    isRunning: () => isConversationBusy(displayedConversationId),
    fileReaderOpen,
    closeFileReader,
  });
  const conversationPaneHostContext: GatewayConversationPaneHostContext = {
    devicePlugins: !transportInputDisabled ? devicePlugins : undefined,
    deviceUiSurface: !transportInputDisabled ? devicePlugins?.readSurface : undefined,
    mobileControls: compactDeviceHeader,
    api,
    registry: transcriptStoreRegistry,
    settings,
    hasModels: modelOptions.length > 0,
    showUsage: isAgentDevExecutionMode,
    isInputDisabled: composerInputDisabled,
    transportInputDisabled,
    canEditOfflineDraft,
    uploadingConversationId,
    inputPlaceholder: composerPlaceholder,
    modelOptions,
    enabledSkills: enabledComposerSkills,
    mentionableConversations,
    searchMentionableConversations,
    mentionApps,
    contextDisplayMode: settings.customSettings.composerContextDisplay,
    commandSafetyMode: settings.system.commandSafetyMode,
    onCommandSafetyModeChange: (mode) =>
      setSettings((prev) =>
        prev.system.commandSafetyMode === mode
          ? prev
          : updateSystem(prev, { commandSafetyMode: mode }),
      ),
    sttProvider: null,
    sttProviderConfigured: false,
    sttTransport: undefined,
    onSttError: setChatError,
    gitClient,
    gitWriteEnabled: settings.remote.enableWebGit,
    gitDisabledMessage,
    workspaceActivityClient,
    onOpenWorktree: handleOpenWorktree,
    onWorktreeRemoved: handleWorktreeRemoved,
    openSettings,
    onOpenFileLink: handleOpenChatFileLink,
    onLoadUploadedImagePreview: handleLoadUploadedImagePreview,
    transcriptContentWidth: settings.customSettings.chatTranscript.width,
    selectionForConversation,
    workdirForConversation,
    isConversationBusy,
    handleConversationStreamEvent,
    handleConversationStreamSync,
    sendChat,
    importDeviceConversationFiles,
    fileReaderOpen,
    closeFileReader,
    cancelChat,
    materializeComposerDraftForSend,
    getPendingUploads: getPendingUploadsForConversation,
    replacePendingUpload:
      transportInputDisabled || historyShareToken ? undefined : replacePendingUpload,
    imageAnnotationAuthority: JSON.stringify([workspaceOwner, workspaceViewScope]),
    subscribePendingUploads,
    updatePendingUploads: updatePendingUploadsForConversation,
    importFilesForConversation,
    getCachedComposerDraft,
    setCachedComposerDraft,
    verifiedDeviceReplyIdentity,
    takeDeviceReplyDraft,
    registerDevicePaneDraft,
    notifyError: (message) => addNotify("error", message),
    trajectoryHost,
  };

  // 文件拖入时按指针命中聚焦会话 Pane,使 overlay 落在焦点输入框(桌面端
  // workbenchNativeDropHoverRef 同口径;Web 走 HTML5 DnD)。
  const lastFileDropHoverPaneRef = useRef<string | null>(null);
  const focusWorkbenchPaneUnderPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!sessionWorkbench.enabled) return;
      const geometry = workbenchController.geometryRef.current;
      const canvasElement = workbenchController.canvasRef.current;
      if (!geometry || !canvasElement) return;
      const canvasRect = canvasElement.getBoundingClientRect();
      const target = hitTestWorkbenchDrop(
        geometry,
        clientX - canvasRect.left,
        clientY - canvasRect.top,
      );
      const paneId =
        target && (target.kind === "pane-center" || target.kind === "pane-edge")
          ? target.paneId
          : null;
      if (!paneId || paneId === lastFileDropHoverPaneRef.current) return;
      lastFileDropHoverPaneRef.current = paneId;
      if (workbenchController.workbench.layoutRef.current.focusedPaneId !== paneId) {
        workbenchController.handleFocusPane(paneId);
      }
    },
    [workbenchController],
  );
  const handleChatFileDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handleFileDragEnter(event);
      focusWorkbenchPaneUnderPoint(event.clientX, event.clientY);
    },
    [focusWorkbenchPaneUnderPoint, handleFileDragEnter],
  );
  const handleChatFileDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handleFileDragOver(event);
      focusWorkbenchPaneUnderPoint(event.clientX, event.clientY);
    },
    [focusWorkbenchPaneUnderPoint, handleFileDragOver],
  );
  const handleChatFileDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      handleFileDragLeave(event);
      lastFileDropHoverPaneRef.current = null;
    },
    [handleFileDragLeave],
  );
  const handleChatFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      lastFileDropHoverPaneRef.current = null;
      handleFileDrop(event);
    },
    [handleFileDrop],
  );

  // 输入框“/”指令宿主：引用只随 api、工作目录和语言变化（输入框按宿主引用重新拉
  // 指令目录），动作与状态读数经 ref 取最新值——sendChat 等每次渲染都是新函数。
  const composerCommandLatestRef = useRef({
    handleManualCompact,
    handleSelectModel,
    isConversationBusy,
    modelOptions,
    runtimeControls: chatRuntimeControlsForCurrentProvider,
    sendChat,
  });
  composerCommandLatestRef.current = {
    handleManualCompact,
    handleSelectModel,
    isConversationBusy,
    modelOptions,
    runtimeControls: chatRuntimeControlsForCurrentProvider,
    sendChat,
  };
  const composerCommandHost = useMemo<ComposerCommandHost>(
    () => ({
      ...createWebComposerCommandHost({
        t: (key) => translate(key, settings.locale),
        client: api ?? undefined,
        devicePlugins,
        getConversationId: () => {
          const id = getDisplayedConversationId();
          return isLocalDraftConversationId(id) ? undefined : id;
        },
        getWorkdir: () => displayedConversationWorkdir || undefined,
        getRuntimeControls: () => composerCommandLatestRef.current.runtimeControls,
        sendTurn: (text, command, runtimeControls) =>
          sendComposerCommandTurn(
            composerCommandLatestRef.current.sendChat,
            (key) => translate(key, settings.locale),
            text,
            command,
            {
              runtimeControls,
              isBusy: () =>
                composerCommandLatestRef.current.isConversationBusy(getDisplayedConversationId()),
            },
          ),
        compact: () => composerCommandLatestRef.current.handleManualCompact(),
        getModelOptions: () => composerCommandLatestRef.current.modelOptions,
        selectModel: (value) => {
          const selection = parseModelValue(value);
          if (selection) composerCommandLatestRef.current.handleSelectModel(selection);
        },
      }),
      // 正在编辑排队消息时，发送是保存编辑，不按指令执行。
      isDraftReserved: () =>
        queuedChatEditSessionRef.current?.conversationId === getDisplayedConversationId(),
    }),
    [
      api,
      devicePlugins,
      displayedConversationWorkdir,
      getDisplayedConversationId,
      queuedChatEditSessionRef,
      settings.locale,
    ],
  );

  const primaryConversationSurface: GatewayConversationPrimarySurface = {
    isSending: composerIsSending,
    // 上传态只归属目标会话:背景 Pane 的导入不在主 Pane 显示"上传中"。
    isUploadingFiles:
      isUploadingFiles &&
      (!uploadingConversationId || uploadingConversationId === displayedConversationId),
    isInputDisabled: composerInputDisabled,
    draftOnly: composerDraftOnly,
    onSend: handlePrimaryComposerSend,
    onStop: handlePrimaryComposerStop,
    onSelectModel: handleSelectModel,
    onSelectExecutionMode: handleSelectExecutionMode,
    onChatRuntimeControlsChange: handleChatRuntimeControlsChange,
    onPrepareChatRuntime: () => {
      if (!api || historyShareToken) return;
      void prepareChatRuntime(
        "composer-focus",
        api,
        CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
      ).catch(() => undefined);
    },
    onComposerBusyChange: handleComposerBusyChange,
    onPickReadableFiles: () => fileInputRef.current?.click(),
    onPickWorkspaceFolder: () => folderInputRef.current?.click(),
    onPasteFiles: handleImportReadableFiles,
    loadHistoryPrompts: loadComposerHistoryPrompts,
    pendingUploadedFiles,
    onRemovePendingUpload: (relativePath) => {
      updatePendingUploadsForConversation(getDisplayedConversationId(), (current) =>
        current.filter((file) => file.relativePath !== relativePath),
      );
    },
    queuedTurns: queuedChatTurnsForDisplayedConversation,
    queuePaused,
    onRunQueuedTurnNow: runQueuedTurnNow,
    onMoveQueuedTurnUp: moveQueuedTurnUp,
    onEditQueuedTurn: editQueuedTurn,
    onRemoveQueuedTurn: removeQueuedTurn,
    onManualCompactConfirm: handleManualCompact,
    manualCompactBlocked: manualCompactPending || composerCompactionBlocked,
    commandHost: composerCommandHost,
    approvalBar,
    taskProgressBar: (
      <TaskProgressBar
        key={displayedConversationId}
        snapshot={taskProgressSnapshot}
        isConversationRunning={transcriptBusy}
      />
    ),
    statsBar: (
      <ConversationStatsBarHost
        key={`stats-${displayedConversationId}`}
        conversationId={displayedConversationId}
        host={trajectoryHost}
        enabled={renderedConversationView !== "trajectory"}
        contextUsageTokensSource={contextUsageTokensSource}
        contextWindow={currentModelContextWindow}
        onManualCompactConfirm={handleManualCompact}
        manualCompactBlocked={manualCompactPending || composerCompactionBlocked}
      />
    ),
    fileDropOverlay: isFileDropActive ? (
      <FileDropOverlay
        variant="composer"
        canDropUpload={canDropUpload}
        title={fileDropTitle}
        description={fileDropDescription}
        limitHint={fileDropLimitHint}
      />
    ) : null,
    transcriptExtras: (
      <>
        <TranscriptWidthControls
          hostRef={transcriptStageRef}
          width={settings.customSettings.chatTranscript.width}
          onWidthChange={handleChatTranscriptWidthChange}
          resizeLabel={
            settings.locale === "en-US" ? "Resize conversation content" : "调整对话正文宽度"
          }
          resetLabel={settings.locale === "en-US" ? "Double-click to reset" : "双击恢复默认宽度"}
          // The history overlay below is a blocking panel layer above the
          // handles; suspend them for exactly as long as it is mounted (#749).
          suspended={conversationOpenState.showOverlay}
        />
        {displayedTranscriptRowCount > 0 && !conversationOpenState.showOverlay ? (
          <FloorNavRail
            conversationId={displayedConversationId}
            floors={transcriptFloors}
            activeRowKey={activeFloorKey}
            bottomOffset="calc(var(--gateway-chat-composer-overlay-height, var(--spacing-176px)) + var(--spacing-12px))"
            scrollViewport={transcriptViewport}
            onJump={handleFloorJump}
          />
        ) : null}
        {conversationOpenState.showOverlay ? (
          <HistorySwitchLoadingOverlay locale={settings.locale} />
        ) : null}
      </>
    ),
    stageRef: transcriptStageRef,
    setTranscriptScrollAreaRoot,
    setTranscriptViewport,
    transcriptViewport,
    isViewportFollowing: transcriptFollow.isFollowing,
    viewportFollowing: transcriptFollowing,
    onJumpToBottom: transcriptFollow.jumpToBottom,
    navRef: transcriptNavRef,
    onAnchorUserRowChange: setActiveFloorKey,
    onResendFromEdit: handleResendFromEdit,
    onBranchConversation: handleBranchConversation,
    branchPendingMessageId,
    onSuggestionSelect: handleEmptyStateSuggestion,
    hasMoreHistory: selectedHistoryHasMore,
    isLoadingMoreHistory: loadingOlderHistory,
    onLoadEarlierHistory: selectedHistoryHasMore ? handleLoadEarlierHistory : undefined,
    isLoading: transcriptHistoryLoading,
    loadingTitle: historyDetailLoadingTitle,
    transcriptError,
    changedFilesActions,
    checkpoint: {
      client: checkpointClient,
      disabled: !displayedConversationId || transcriptBusy,
      resolveAuthorizedRoots: resolveCheckpointAuthorizedRoots,
      onRewound: handleCheckpointRewound,
    },
  };

  // 每个会话 Pane 始终渲染同一宿主(桌面端 RestorableConversationPaneHost
  // 口径):焦点只换 primary 绑定,绝不把页面舞台注入聚焦 Pane,也不按
  // conversationId 做 key(会在焦点切换时拆掉宿主)。终端 / unsupported 走
  // 各自的自包含表面。
  const canReviseDocument = Boolean(
    api &&
      isAgentMode &&
      displayedConversationId &&
      terminalProjectPath &&
      !accountDestination &&
      activeView === "chat" &&
      !transportInputDisabled,
  );
  const revisionScope = canReviseDocument
    ? JSON.stringify([workspaceOwner, workspaceViewScope, displayedConversationId])
    : "";
  const revisionScopeRef = useRef(revisionScope);
  revisionScopeRef.current = revisionScope;
  const requestDocumentRevision = (revision: WorkspaceDocumentRevision) => {
    if (!api || !revisionScope) return Promise.resolve(false);
    const isCurrentAgent = api.captureActiveAgentScope();
    const canSend = () =>
      revisionScopeRef.current === revisionScope &&
      isCurrentAgent() &&
      !isConversationBusy(displayedConversationId);
    return requestWorkspaceRevision(revision, {
      workspaceRoot: terminalProjectPath,
      canSend,
      locale: settings.locale,
      checkFileRuntime: async () => {
        const status = await api.manageSkill<FileRuntimeSummary>({ action: "file-runtime-status" });
        if (typeof status?.ready !== "boolean") throw new Error("Missing file runtime status");
        return status;
      },
      importSources: (sources) =>
        importDeviceConversationFiles(terminalProjectPath, sources, AbortSignal.timeout(60_000)),
      send: async (text, uploadedFiles) => {
        const outcome = await sendChat(text, {
          conversationId: displayedConversationId,
          workdir: terminalProjectPath,
          uploadedFiles,
          isCurrentAgent,
          preserveComposerOnStart: true,
        });
        const observer = revision.observeRun;
        if (observer && !observer.signal.aborted && outcome && outcome.kind !== "failed") {
          const canRead = () => isCurrentAgent() && revisionScopeRef.current === revisionScope;
          const runId =
            outcome.kind === "accepted"
              ? outcome.accepted.runId
              : outcome.kind === "bound" || outcome.kind === "queued_in_gui"
                ? outcome.update.runId
                : undefined;
          if (runId) {
            const store = transcriptStoreRegistry.get(displayedConversationId);
            observer.registerStop(
              () =>
                canRead() &&
                store.getTurn(runId)?.phase !== "settled" &&
                api.cancelChat(displayedConversationId, runId),
            );
            const stop = () => {
              unsubscribe();
              observer.signal.removeEventListener("abort", stop);
            };
            const check = () => {
              if (!canRead() || store.getTurn(runId)?.phase === "settled") {
                stop();
                observer.finish(canRead());
              }
            };
            const unsubscribe = store.subscribe(check);
            observer.signal.addEventListener("abort", stop, { once: true });
            check();
          } else observer.finish(canRead());
        }
        return Boolean(outcome && outcome.kind !== "failed");
      },
    });
  };
  const insertWorkspaceMarkdownSelection = (text: string, path: string, comment?: string) => {
    if (!rightDockOpen) return false;
    const accepted = composerRef.current?.insertWorkspaceExcerpt(text, path, comment);
    if (!accepted) {
      addNotify(
        "error",
        settings.locale === "zh-CN" ? "当前输入框不可用" : "The composer is unavailable",
      );
    }
    return Boolean(accepted);
  };
  const markdownTextGeneration: ProjectToolTextGenerationClient | undefined =
    api && !transportInputDisabled
      ? {
          status: () =>
            currentChatProvider && activeSelectedModel?.model ? "ready" : "unconfigured",
          generate: async ({ systemPrompt, userPrompt, signal }) => {
            const isCurrentAgent = api.captureActiveAgentScope();
            signal?.throwIfAborted();
            const model = activeSelectedModel?.model;
            if (!currentChatProvider || !model || !isCurrentAgent())
              throw new Error("No active model selected.");
            const result = await api.clarifyPromptTurn({
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
              providerId: currentChatProvider.id,
              model,
              runtimeControls: {
                ...chatRuntimeControlsForCurrentProvider,
                reasoning: "off",
                thinkingEnabled: false,
                nativeWebSearchEnabled: false,
                planModeEnabled: false,
              },
            });
            signal?.throwIfAborted();
            if (!isCurrentAgent()) throw new DOMException("Device changed", "AbortError");
            if (result.error_code) throw new Error(result.error_message || result.error_code);
            return result.final_text;
          },
        }
      : undefined;
  const workspacePresentation = useWorkspaceTabPresentation({
    resources: workspaceTabs,
    open: tabbedWorkspace && !accountDestination && activeView === "chat" && rightDockOpen,
    scope: workspaceViewScope,
    owner: workspaceOwner,
    projectPathKey: terminalProjectPathKey,
    comparisonConversationId: displayedConversationId || undefined,
    theme: effectiveTheme,
    gitClient: gitDisabledMessage ? undefined : (gitClient ?? undefined),
    activityClient: workspaceActivityClient,
    nativeFileActions: false,
    onInsertCodeMention: handleInsertCodeMention,
    onInsertMarkdownSelection: insertWorkspaceMarkdownSelection,
    markdownTextGeneration,
    onDocumentRevision: canReviseDocument ? requestDocumentRevision : undefined,
    onError: (message) => addNotify("error", message),
  });
  const deviceWorkspace = tabbedWorkspace
    ? { ...workspacePresentation, onOpenDiff: handleOpenWorkspaceDiff }
    : undefined;
  const terminalWorkspaceProject = workspaceProjects.find(
    (project) => workspaceProjectPathKey(project.path) === terminalProjectPathKey,
  );
  // 项目工具 Pane 的运行环境:与 RightDockPanel 同一批网关 client/回调,按
  // Pane 自己的 ProjectRef 解析项目(见 ProjectToolPaneHost)。终端 client 未
  // 连接时(网关离线)工具 Pane 与终端 Pane 一样不渲染。
  const projectToolPaneEnvironment = useMemo<ProjectToolPaneEnvironment | null>(() => {
    if (!terminalClient) return null;
    return {
      theme: effectiveTheme,
      fontScale: settings.customSettings.fontScale.rightDock,
      workspaceProjects,
      activeProjectPathKey: terminalProjectPathKey,
      clients: {
        terminal: terminalClient,
        git: gitClient,
        tunnel: isAgentMode ? api : null,
        workspaceActivity: workspaceActivityClient,
      },
      capabilities: {
        disabledMessage: projectToolsDisabledMessage,
        terminalDisabledMessage,
        gitWriteEnabled: settings.remote.enableWebGit,
        gitDisabledMessage,
        tunnelEnabled,
        tunnelDisabledMessage,
        tunnelPublicBaseUrl: gatewayOrigin(),
      },
      workspaceProjectRootClient,
      workspaceRootRevision,
      fileTree: {
        getState: (projectPathKey) =>
          getRightDockFileTreeState(settings.customSettings, projectPathKey),
        onStateChange: (projectPathKey, patch) =>
          setSettings((current) => updateRightDockFileTreeState(current, projectPathKey, patch)),
        onInsertFileMention: handleRightDockInsertFileMention,
        onOpenFile: (request) => {
          if (isWorkspacePreviewPath(request.path)) {
            openWorkspaceFilePreview(request);
          } else {
            openWorkspaceEditorFile(request);
          }
        },
        onRevealInFileTree: (projectPathKey, path) => {
          if (projectPathKey === terminalProjectPathKey) {
            changedFilesActions.onRevealInFileTree?.(path);
          }
        },
      },
      git: {
        onInsertCodeReviewSkill: codeReviewSkill ? handleRightDockInsertCodeReviewSkill : undefined,
        onInsertCommitMention: handleRightDockInsertCommitMention,
        onInsertGitFileMention: handleRightDockInsertGitFileMention,
        focusRequest: gitReviewFocusRequest,
        onFocusRequestHandled: handleGitReviewFocusRequestHandled,
      },
      ssh: {
        hosts: settings.ssh.hosts,
        getAssociatedHostIds: (projectPathKey) =>
          getSshProjectHostIds(settings.ssh, projectPathKey),
        onAssociatedHostIdsChange: (projectPathKey, hostIds) =>
          setSettings((prev) => updateSshProjectHostIds(prev, projectPathKey, hostIds)),
        sessions: terminalSessions,
        // 按 React 当前值函数式合并(与 dock 侧 sessionsRef.current 同口径),
        // 避免一次重渲染之间连续到达的 snapshot / reconcile 互相覆盖。
        onSessionSnapshot: (snapshot) =>
          updateProjectTerminalSessions((current) =>
            mergeTerminalSession(current, snapshot.session),
          ),
        onSessionClosed: (sessionId) =>
          updateProjectTerminalSessions((current) => removeTerminalSession(current, sessionId)),
        onSessionsReconcile: (sessions) =>
          updateProjectTerminalSessions((current) =>
            reconcileSshTerminalSessions(current, sessions),
          ),
        onOpenSession: handleOpenSshTerminal,
      },
      openExternal: (url) => {
        void openUrl(url);
      },
    };
  }, [
    api,
    changedFilesActions,
    codeReviewSkill,
    effectiveTheme,
    gitClient,
    gitDisabledMessage,
    gitReviewFocusRequest,
    handleGitReviewFocusRequestHandled,
    handleOpenSshTerminal,
    handleRightDockInsertCodeReviewSkill,
    handleRightDockInsertCommitMention,
    handleRightDockInsertFileMention,
    handleRightDockInsertGitFileMention,
    isAgentMode,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    projectToolsDisabledMessage,
    setSettings,
    settings.customSettings,
    settings.remote.enableWebGit,
    settings.ssh,
    terminalClient,
    terminalDisabledMessage,
    terminalProjectPathKey,
    terminalSessions,
    tunnelDisabledMessage,
    tunnelEnabled,
    updateProjectTerminalSessions,
    workspaceActivityClient,
    workspaceProjectRootClient,
    workspaceProjects,
    workspaceRootRevision,
  ]);

  // 被画板 Pane 租用的项目工具:dock 隐藏对应 tab/内容/入口(与终端租约同口径)。
  const leasedDockTools = useMemo(
    () =>
      leasedProjectToolKinds(
        workbenchController.workbench.layout,
        terminalProjectPathKey,
        PROJECT_TOOL_SURFACE_KINDS,
      ),
    [terminalProjectPathKey, workbenchController.workbench.layout],
  );

  const renderConversationWorkbench = (): ReactNode => {
    const { workbench, dragState } = workbenchController;
    return (
      <WorkbenchCanvas
        canvasRef={workbenchController.canvasRef}
        layout={workbench.layout}
        labels={{
          paneRegion: (pane) => {
            const surface = pane.surface;
            if (surface.kind === "unsupported") {
              return translate("workbench.paneRegionUnsupported", settings.locale);
            }
            const title = workbenchPaneTitle(surface);
            if (surface.kind === "localTerminal" || surface.kind === "sshTerminal") {
              return translate("workbench.paneRegionTerminal", settings.locale).replace(
                "{title}",
                title,
              );
            }
            if (isProjectToolSurface(surface)) {
              return translate("workbench.paneRegionTool", settings.locale).replace(
                "{title}",
                title,
              );
            }
            if (!title) return translate("workbench.paneRegion", settings.locale);
            const workspaceName =
              surface.kind === "conversation"
                ? workspaceProjects
                    .find(
                      (entry) =>
                        workspaceProjectPathKey(entry.path) === surface.project.projectPathKey,
                    )
                    ?.name.trim()
                : undefined;
            if (!workspaceName) {
              return translate("workbench.paneRegionConversation", settings.locale).replace(
                "{title}",
                title,
              );
            }
            return translate("workbench.paneRegionConversationInWorkspace", settings.locale)
              .replace("{title}", title)
              .replace("{workspace}", workspaceName);
          },
          separator: translate("workbench.resizeDivider", settings.locale),
        }}
        renderPaneContent={(pane, paneContext) => {
          const surface = pane.surface;
          if (surface.kind === "localTerminal" || surface.kind === "sshTerminal") {
            if (!terminalClient) return null;
            return (
              <GatewayTerminalPaneHost
                paneId={pane.paneId}
                surface={surface}
                isFocused={paneContext.isFocused}
                isCompact={paneContext.isCompact}
                theme={effectiveTheme}
                client={terminalClient}
                sessions={terminalSessions}
                sessionsLoaded={terminalSessionsLoaded}
                onSessionGhost={verifyTerminalSessionAlive}
                closeRequest={
                  workbenchController.terminalPaneCloseRequest?.paneId === pane.paneId
                    ? {
                        busy: workbenchController.terminalPaneCloseRequest.busy,
                        onConfirm: workbenchController.confirmTerminalPaneClose,
                        onCancel: workbenchController.cancelTerminalPaneClose,
                      }
                    : undefined
                }
              />
            );
          }
          if (isProjectToolSurface(surface)) {
            if (!projectToolPaneEnvironment) return null;
            return (
              <ProjectToolPaneHost
                paneId={pane.paneId}
                surface={surface}
                environment={projectToolPaneEnvironment}
              />
            );
          }
          if (surface.kind === "unsupported") {
            return (
              <UnsupportedPaneSurface paneId={pane.paneId} originalKind={surface.originalKind} />
            );
          }
          const conversationId = surface.conversationId;
          const isPrimary = conversationId === displayedConversationId;
          const panePathKey = surface.project.projectPathKey;
          const blockedMessage = archivedWorkspaceProjectPathKeys.has(panePathKey)
            ? translate("workbench.projectArchived", settings.locale)
            : missingWorkspaceProjectPathKeys.has(panePathKey)
              ? translate("workbench.projectMissing", settings.locale)
              : null;
          return (
            <GatewayConversationPaneHost
              paneId={pane.paneId}
              conversationId={conversationId}
              context={conversationPaneHostContext}
              isPrimary={isPrimary}
              onFocusPane={() => workbenchController.handleFocusPane(pane.paneId)}
              pageComposerRef={isPrimary ? composerRef : undefined}
              primary={isPrimary ? primaryConversationSurface : undefined}
              blockedMessage={blockedMessage}
              trajectoryActive={viewForConversation(conversationId) === "trajectory"}
            />
          );
        }}
        renderPaneChrome={(pane, context) => {
          if (context.paneCount < 2) return null;
          const surface = pane.surface;
          const title = workbenchPaneTitle(surface);
          const paneConversationView =
            surface.kind === "conversation"
              ? viewForConversation(surface.conversationId)
              : "conversation";
          return (
            <PaneChrome
              paneId={pane.paneId}
              title={title}
              isFocused={context.isFocused}
              isCompact={context.isCompact}
              dragHandleLabel={translate("workbench.dragPane", settings.locale)}
              closeLabel={translate("workbench.closePane", settings.locale)}
              onClose={() => workbenchController.requestClosePane(pane.paneId)}
              trajectoryToggle={
                surface.kind === "conversation"
                  ? {
                      isTrajectory: paneConversationView === "trajectory",
                      label:
                        paneConversationView === "trajectory"
                          ? translate("workbench.showConversation", settings.locale)
                          : translate("workbench.showTrajectory", settings.locale),
                      onToggle: () => {
                        if (surface.kind !== "conversation") return;
                        setConversationView(
                          surface.conversationId,
                          paneConversationView === "trajectory" ? "conversation" : "trajectory",
                        );
                      },
                    }
                  : undefined
              }
              onDragHandlePointerDown={(event) => {
                workbenchController.beginPaneDrag(pane, title, {
                  pointerId: event.pointerId,
                  clientX: event.clientX,
                  clientY: event.clientY,
                  currentTarget: event.currentTarget,
                });
              }}
            />
          );
        }}
        onResizeSplit={workbench.resizeSplit}
        onEqualizeSplit={workbench.equalizeSplit}
        onFocusPane={workbenchController.handleFocusPane}
        onGeometryChange={workbenchController.handleGeometryChange}
        dropPreview={
          dragState?.previewRect
            ? { rect: dragState.previewRect, label: dragState.payload.title }
            : null
        }
        emptyState={
          <WorkbenchEmptyState
            title={translate("workbench.emptyTitle", settings.locale)}
            description={translate("workbench.emptyDescription", settings.locale)}
          />
        }
      />
    );
  };

  // 被画布 Pane 租用的会话从 Right Dock 的终端 tab 中隐藏(终端任一时刻只
  // 出现在一个宿主里);Pane 关闭(Detach)释放租约后自动回归 dock。
  const workbenchLeasedDockSessionIds = useMemo(
    () =>
      workbenchController.leasedDockSessionIds.length > 0
        ? new Set(workbenchController.leasedDockSessionIds)
        : undefined,
    [workbenchController.leasedDockSessionIds],
  );

  // 拖拽幽灵:跟随指针的载荷标题,提交/取消后随 dragState 清空。
  const workbenchDragGhost =
    sessionWorkbench.enabled && workbenchController.dragState ? (
      <div
        ref={workbenchController.dragGhostRef}
        data-workbench-drag-ghost=""
        className={cn(
          "layer-popover pointer-events-none fixed max-w-220px",
          "truncate rounded-md border border-border bg-background/95 px-2.5 py-1",
          "text-xs text-foreground shadow-md",
        )}
        style={{
          left: 0,
          top: 0,
          transform: "translate3d(var(--workbench-drag-ghost-x), var(--workbench-drag-ghost-y), 0)",
          willChange: "transform",
        }}
      >
        {workbenchController.dragState.payload.title ||
          translate("chat.pendingTitle", settings.locale)}
      </div>
    ) : null;
  function selectNavigation(
    view: WorkbenchNavigationId,
    mobile = false,
    pin = false,
    href?: string,
  ) {
    if (desktopSettingsTarget && desktopHost?.settingsNavigation?.requestLeave() === false) return;
    if (settingsOpen && closeSettings() === false) return;
    navigationPreview.dismiss();
    if (pin || (!mobile && view === "chat")) setSidebarOpen(true);
    if (view === "library" || view === "customize") {
      accountNavigation?.openDestination(view, href);
      if (mobile) setSidebarOpen(false);
      return;
    }
    leaveAccount(() => {
      if (view === "chat") setActiveView("chat");
      else
        handleSidebarOpenResourceHub(
          view.replace(/-hub$/, "") as Parameters<typeof handleSidebarOpenResourceHub>[0],
        );
      if (mobile) setSidebarOpen(false);
    });
  }

  const renderConnectedTasks = (sidebarOnly = false) =>
    taskOwner && taskDeviceId ? (
      <ConnectedDeviceTasks
        key={`${taskOwner}:${taskDeviceId}`}
        owner={taskOwner}
        deviceId={taskDeviceId}
        label={
          environments.find((environment) => environment.device_id === taskDeviceId)?.name ??
          (settings.locale === "zh-CN" ? "已连接设备" : "Connected device")
        }
        settings={settings}
        sidebarTarget={taskSidebarTarget}
        sidebarOnly={sidebarOnly}
        hideSidebar={!showTaskSidebar}
        previewOpen={navigationPreview.open && showTaskSidebar}
        onActivate={() => selectNavigation("cron-hub")}
        onPinSidebar={() => selectNavigation("cron-hub", false, true)}
        requireCurrent={requireTaskDevice}
        mobileRail={sidebar.isMobile ? renderNavigationRail(true) : undefined}
        onBack={() => setActiveView("chat")}
        onOpenConversation={openDeviceTaskConversation}
        renderConversation={(id, run, messageJump, scheduledRun) => {
          const composerScopeId = `scheduled-task-result:${taskOwner}:${taskDeviceId}:${id}`;
          const latestRun = scheduledRun?.run ?? run;
          return (
            <GatewayConversationPaneHost
              key={composerScopeId}
              paneId="scheduled-task-result"
              conversationId={id}
              context={conversationPaneHostContext}
              isPrimary={false}
              composerScopeId={composerScopeId}
              historyVersion={`${latestRun.id}:${latestRun.state}:${scheduledRun?.preview?.done ?? false}`}
              messageJump={messageJump}
              scheduledRun={scheduledRun}
              isStreamAlreadySubscribed={(conversationId) =>
                conversationId === displayedConversationId ||
                (workbenchHasMultiplePanes &&
                  Object.values(workbenchController.workbench.layout.panes).some(
                    ({ surface }) =>
                      surface.kind === "conversation" && surface.conversationId === conversationId,
                  ))
              }
              blockedMessage={chatProtocolIncompatibleMessage}
              onFocusPane={openDeviceTaskConversation}
            />
          );
        }}
      />
    ) : undefined;

  const renderNavigationRail = (mobile = false) => (
    <WorkbenchNavigationRail
      brand={<BrandMark />}
      activeView={committedDestination}
      destinations={
        accountNavigation
          ? [
              createWorkbenchNavigationItem(
                "library",
                settings.locale === "zh-CN" ? "资料空间" : "Library",
                () => selectNavigation("library", mobile),
              ),
              createWorkbenchNavigationItem(
                "customize",
                settings.locale === "zh-CN" ? "自定义" : "Customize",
                () => selectNavigation("customize", mobile),
              ),
            ]
          : undefined
      }
      shortcuts={settings.customSettings.sidebarShortcuts}
      previewId={navigationPreview.open ? navigationPreview.destination : undefined}
      previewableIds={mobile ? undefined : navigationPreview.previewableIds}
      onSelectView={(view) => selectNavigation(view, mobile)}
      onClose={mobile ? () => setSidebarOpen(false) : undefined}
      footer={
        <>
          {desktopHost?.onUpdateTarget ? (
            <DesktopHostSlot kind="update" />
          ) : (
            <MobileSidebarUpdate />
          )}
          {desktopHost?.onAccountTarget ? (
            <DesktopHostSlot kind="account" />
          ) : (
            <UserMenu
              variant="rail"
              open={userMenuOpen}
              onOpenChange={setUserMenuOpen}
              userMenuLabel={userMenuLabel}
              userAvatarLabel={userAvatarLabel}
              email={relayUser?.email ?? ""}
              balance={relayUser?.balance}
              todayTokens={relayStats?.today_tokens}
              avatarUrl={relayUser?.avatar_url}
              online={Boolean(status?.online)}
              onRefreshAccount={refreshRelayAccount}
              onDismissNavigation={() => setSidebarOpen(false)}
              onOpenAccount={() => openSettings("account")}
              onOpenSettings={() => openSettings("system")}
              onLogout={handleLogout}
            />
          )}
        </>
      }
    />
  );
  const showConversationViews =
    !accountDestination &&
    activeView === "chat" &&
    hasConversationReply &&
    !workbenchHasMultiplePanes;
  const navigationAgentId =
    status?.online && !sidebarSectionsDisabled && !transportInputDisabled && !historyShareToken
      ? api?.getActiveAgent()
      : undefined;
  const deviceNavigationScope = navigationAgentId
    ? JSON.stringify([workspaceOwner, workspaceViewScope, navigationAgentId])
    : undefined;
  const isCurrentDeviceNavigationAgent = deviceNavigationScope
    ? api?.captureActiveAgentScope()
    : undefined;
  const searchDeviceConversations = useCallback(
    (query: string, currentWorkdir: string | undefined, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (!api || !navigationAgentId || api.getActiveAgent() !== navigationAgentId) {
        return Promise.reject(new Error("Device scope changed"));
      }
      const isCurrentAgent = api.captureActiveAgentScope();
      return searchPersistedConversations({
        query,
        currentWorkdir,
        search: (args) =>
          api.memoryManage<ChatHistorySearchResponse>(
            { command: "chat_history_search", args },
            () => !signal.aborted && isCurrentAgent(),
          ),
      });
    },
    [api, navigationAgentId],
  );
  const deviceFilesAvailable = Boolean(
    deviceNavigationScope &&
      terminalProjectPath &&
      terminalProjectPathKey &&
      activeWorkspaceProject &&
      !missingWorkspaceProjectPathKeys.has(terminalProjectPathKey),
  );
  const resolveCloseActiveContext = (origin?: Element | null) => {
    const target = resolveCloseContextTarget({
      activeView,
      paneCount: sessionWorkbench.enabled
        ? Object.keys(workbenchController.workbench.layoutRef.current.panes).length
        : 1,
      rightDockOpen,
      focusInDock: isFocusInRightDock(undefined, origin),
    });
    if (!target) return undefined;
    return () => {
      if (target === "hub") selectNavigation("chat");
      else if (target === "dock") handleRightDockClose();
      else {
        const paneId = workbenchController.workbench.layoutRef.current.focusedPaneId;
        if (paneId) workbenchController.requestClosePane(paneId);
      }
    };
  };
  const nextThinking =
    activeView === "chat" && !transportInputDisabled
      ? nextThinkingLevel({
          reasoningOptions: chatRuntimeReasoningOptions,
          thinkingAlwaysOn: chatRuntimeThinkingAlwaysOn,
          controls: chatRuntimeControlsForCurrentProvider,
        })
      : null;
  const { commandPalette, navigation: deviceNavigation } = useWorkbenchCommandPalette({
    scopeKey: deviceNavigationScope,
    visible: Boolean(
      deviceNavigationScope &&
        !accountDestination &&
        !settingsOpen &&
        !desktopSettingsTarget &&
        !showTaskSidebar,
    ),
    isCurrentScope: isCurrentDeviceNavigationAgent,
    searchConversations: searchDeviceConversations,
    activeView,
    conversationId: displayedConversationId,
    isDraft: isLocalDraftConversationId(displayedConversationId),
    hasConversation: (id) => Boolean(sidebarStore.peek(id) && !isLocalDraftConversationId(id)),
    openConversation: (id) => {
      setRightDockOpen(false);
      handleSidebarSelectConversation(id);
    },
    visibleHubs: settings.customSettings.sidebarShortcuts,
    openHub: selectNavigation,
    resolveCloseActiveContext,
    actions: {
      t: (key) => translate(key, settings.locale),
      onNewConversation: handleSidebarNewConversation,
      onOpenSettings: (section, anchor) =>
        openSettings(section as Parameters<typeof openSettings>[0], undefined, anchor),
      settingsSections: getWorkbenchSettingsSections({
        surface: "web",
        usage: Boolean(settingsHostAdapter.kbrain?.getUsageStats),
        devicePlugins: Boolean(devicePlugins),
        webSearch: Boolean(settingsHostAdapter.kbrain),
        permissions: false,
      }),
      settingsExcludedAnchors: [
        ...WEB_SETTINGS_EXCLUDED_ANCHORS,
        ...(devicePlugins?.readSurface ? [] : ["html-previews"]),
      ],
      onOpenWorkspace: isAgentMode ? handleOpenCreateWorkspaceProject : undefined,
      sidebar: { open: sidebarOpen, onToggle: () => setSidebarOpen((open) => !open) },
      projectTools:
        terminalClient && activeView === "chat"
          ? { open: rightDockOpen, onToggle: () => setRightDockOpen((open) => !open) }
          : undefined,
      onToggleTerminal:
        deviceFilesAvailable && terminalClient && !terminalDisabledMessage
          ? () => {
              const target = resolveTerminalToggle({
                open: activeView === "chat" && rightDockOpen && !workspaceTabs.view.activeId,
                activeTabId: rightDockProjectState.activeTabId,
                tabOrder: rightDockProjectState.tabOrder,
                sessions: projectTerminalSessions.filter(
                  ({ id }) => !workbenchLeasedDockSessionIds?.has(id),
                ),
              });
              if (target.kind === "close") {
                handleRightDockClose();
                return;
              }
              setActiveView("chat");
              workspaceTabs.activate(null);
              setRightDockOpen(true);
              handleRightDockProjectStateChange((current) =>
                activateRightDockTab(current, target.sessionId ?? RIGHT_DOCK_TERMINAL_LAUNCHER),
              );
            }
          : undefined,
      onCycleThinking: nextThinking
        ? () => handleChatRuntimeControlsChange(nextThinking.patch)
        : undefined,
      theme: {
        current: settings.theme,
        onToggle: () => setSettings((prev) => ({ ...prev, theme: getNextTheme(prev.theme) })),
      },
    },
    workspace:
      deviceFilesAvailable && api
        ? {
            projectPathKey: terminalProjectPathKey,
            tabs: workspaceTabs.view.tabs,
            activeFileTabId: rightDockOpen ? workspaceTabs.view.activeId : null,
            openTab: (id) => {
              setActiveView("chat");
              setRightDockOpen(true);
              workspaceTabs.activate(id);
            },
            files: {
              listFiles: (signal) =>
                api.listMentionFiles(
                  terminalProjectPath,
                  QUICK_OPEN_MAX_FILES,
                  "",
                  false,
                  () => !signal.aborted && Boolean(isCurrentDeviceNavigationAgent?.()),
                ),
              openFile: (path) => {
                setActiveView("chat");
                handleOpenWorkspaceFile(path, undefined, true);
              },
            },
          }
        : undefined,
  });
  const [executionSwitcherOpen, setExecutionSwitcherOpen] = useState(false);
  const selectedDeviceId =
    selection?.runtime_kind === "device_agent" ? selection.device_id : undefined;
  const selectedDevice = selectedDeviceId
    ? environments.find((environment) => environment.device_id === selectedDeviceId)
    : undefined;
  const canChooseAnotherDevice =
    !desktopHost &&
    !historyShareToken &&
    selectedDeviceId &&
    environments.some(
      (environment) =>
        environment.runtime_kind === "device_agent" &&
        environment.online &&
        Boolean(environment.device_id && environment.device_id !== selectedDeviceId),
    );
  const executionSwitcher = !desktopHost && !historyShareToken && (
    <ExecutionEnvironmentSwitcher
      environments={environments}
      selection={selection}
      compact={compactDeviceHeader}
      mobileSheet={compactDeviceHeader}
      open={executionSwitcherOpen}
      onOpenChange={setExecutionSwitcherOpen}
      onSwitch={async (environment, workspace) => {
        if (activeView === "chat") {
          const draft = composerRef.current?.getDraft();
          if (draft) setCachedComposerDraft(displayedConversationId, draft);
        }
        await switchExecutionTarget(environment, workspace, { beforeCommit: rememberDeviceDrafts });
        setActiveView("chat");
      }}
    />
  );
  const workbenchChrome = (
    <AppWorkbenchChrome
      settings={settings}
      mobile={compactDeviceHeader}
      sidebarOpen={sidebarOpen}
      onOpenSettings={openSettings}
      onToggleTheme={() =>
        setSettings((prev) => ({
          ...prev,
          theme: getNextTheme(prev.theme),
        }))
      }
      onOpenSidebar={() => setSidebarOpen((open) => !open)}
      navigationActions={
        <>
          {!compactDeviceHeader &&
          commandPalette &&
          (deviceNavigation.canGoBack || deviceNavigation.canGoForward) ? (
            <NavigationHistoryButtons history={deviceNavigation} />
          ) : null}
          {compactDeviceHeader &&
          displayedConversationId &&
          !isLocalDraftConversationId(displayedConversationId) ? (
            <Button
              variant="ghost"
              size="icon"
              className="order-1 size-11 shrink-0"
              aria-label={translate("chat.newConversation", settings.locale)}
              onClick={handleSidebarNewConversation}
            >
              <SquarePen className="size-4.5" />
            </Button>
          ) : undefined}
        </>
      }
      leadingActions={
        <>
          {desktopHost && !accountDestination && <DesktopHostSlot kind="header" />}
          {compactDeviceHeader && executionSwitcher}
          {!compactDeviceHeader && showConversationViews ? (
            <ConversationViewTabs
              active={renderedConversationView}
              onChange={setActiveConversationView}
            />
          ) : null}
        </>
      }
      trailingActions={
        !accountDestination && (
          <>
            <ProjectToolsPanelToggle
              isOpen={rightDockOpen}
              sessionCount={projectTerminalSessions.length}
              disabledMessage={terminalClient ? undefined : projectToolsDisabledMessage}
              className={compactDeviceHeader ? "min-h-11 min-w-11" : "mr-6px max-520:mr-8px"}
              onToggle={() => setRightDockOpen((open) => !open)}
            />
            {!compactDeviceHeader && executionSwitcher}
          </>
        )
      }
      compactActions={
        compactDeviceHeader ? (
          <>
            {showConversationViews && (
              <DropdownMenuItem
                className="min-h-11"
                onClick={() =>
                  setActiveConversationView(
                    renderedConversationView === "trajectory" ? "conversation" : "trajectory",
                  )
                }
              >
                {translate(
                  renderedConversationView === "trajectory"
                    ? "chat.mobileShowConversation"
                    : "chat.mobileShowTrajectory",
                  settings.locale,
                )}
              </DropdownMenuItem>
            )}
          </>
        ) : undefined
      }
    />
  );

  return (
    <LocaleContext.Provider value={localeContextValue}>
      <Toaster />
      <AppErrorBoundary>
        <div className={desktopHost ? GATEWAY_EMBEDDED_SHELL_CLASS : GATEWAY_SHELL_CLASS}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            aria-label={translate("chat.upload.selectFiles", settings.locale)}
            className="gateway-hidden-file-input hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              void handleImportReadableFiles(files);
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={(element) => {
              folderInputRef.current = element;
              element?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            aria-label={translate("chat.upload.selectFolder", settings.locale)}
            className="gateway-hidden-file-input hidden"
            onChange={(event) => {
              handleImportSelectedDirectoryFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
            }}
          />
          {workbenchDragGhost}

          <WorkbenchShell
            ref={navigationPreview.rootRef}
            inert={settingsOpen}
            keyboardNavigation={
              activeView === "chat" &&
              !accountDestination &&
              !historyShareToken &&
              !transportInputDisabled ? (
                <SkipToComposerLink onFocusComposer={() => composerRef.current?.focus()} />
              ) : null
            }
            aria-hidden={settingsOpen || undefined}
            className="gateway-editor-host flex-1"
            data-workbench-edge-to-edge={(sidebar.isMobile && !desktopHost) || undefined}
            windowControls={
              desktopHost && !settingsOpen ? <DesktopHostSlot kind="window" /> : undefined
            }
            navigationRail={
              !sidebar.isMobile ? (
                <WorkbenchNavigationMount target={navigationTarget}>
                  {renderNavigationRail()}
                </WorkbenchNavigationMount>
              ) : null
            }
          >
            <WorkbenchBody>
              {!sidebar.isMobile && !sidebar.open ? (
                <div data-sidebar-hover-edge="" aria-hidden="true" />
              ) : null}
              {!sidebar.isMobile && (showDeviceTasks || showTaskSidebar) && (
                <div ref={setTaskSidebarTarget} data-workbench-sidebar-slot="" />
              )}
              {!showDeviceTasks && showTaskSidebar && renderConnectedTasks(true)}
              {accountNavigation && !sidebar.isMobile && (
                <div
                  ref={accountSurface.setSidebarTarget}
                  data-workbench-sidebar-slot=""
                  data-workbench-account-sidebar=""
                />
              )}
              {accountSidebar && (
                <div
                  className={sidebar.isMobile ? "contents" : undefined}
                  data-workbench-sidebar-slot=""
                  data-workbench-account-fallback={showAccountSidebar || undefined}
                >
                  <WorkbenchAccountSidebar
                    destination={accountSidebar}
                    previewOpen={navigationPreview.open}
                    mobileRail={sidebar.isMobile ? renderNavigationRail(true) : undefined}
                    fontScale={settings.customSettings.fontScale.sidebar}
                    onNavigate={(href) =>
                      selectNavigation(accountSidebar, sidebar.isMobile, false, href)
                    }
                    onPin={() => {
                      if (!showAccountSidebar) selectNavigation(accountSidebar, false, true);
                      else {
                        navigationPreview.dismiss();
                        setSidebarOpen(true);
                      }
                    }}
                  />
                </div>
              )}
              {!showTaskSidebar && !accountSidebar && (!showAccountSidebar || sidebar.isMobile) && (
                <GatewaySidebarContainer
                  mobileRail={sidebar.isMobile ? renderNavigationRail(true) : undefined}
                  previewOpen={navigationPreview.open}
                  onPinPreview={() => selectNavigation(shownSidebar, false, true)}
                  accountMenu={false}
                  pinnedOrder={settings.system.sidebarPinnedOrder}
                  onReorderPinned={(sidebarPinnedOrder) =>
                    setSettings((previous) => ({
                      ...previous,
                      system: { ...previous.system, sidebarPinnedOrder },
                    }))
                  }
                  projectOrder={settings.system.workspaceProjectOrder}
                  onReorderProjects={(workspaceProjectOrder) =>
                    setSettings((previous) => ({
                      ...previous,
                      system: { ...previous.system, workspaceProjectOrder },
                    }))
                  }
                  store={sidebarStore}
                  approvalConversationIds={approvalConversationIds}
                  transientRunningConversations={manualCompactTransientConversations}
                  currentConversationId={displayedConversationId}
                  isOpen={sidebarOpen}
                  fontScale={settings.customSettings.fontScale.sidebar}
                  commandPalette={commandPalette}
                  activeView={shownSidebar as ApplicationViewId}
                  showProjects={isAgentMode}
                  projects={workspaceProjects}
                  workspaceProjectGroups={settings.system.workspaceProjectGroups}
                  activeProjectId={activeWorkspaceProject?.id ?? ""}
                  missingProjectPathKeys={missingWorkspaceProjectPathKeys}
                  projectsCollapsed={settings.customSettings.chatSidebar.projectsCollapsed}
                  workspaceFolderDropActive={workspaceFolderDropActive}
                  workspaceFolderDropHandlers={workspaceFolderDropHandlers}
                  recentCollapsed={settings.customSettings.chatSidebar.recentCollapsed}
                  canShareConversations={canShareHistory}
                  sharedConversationCount={sharedHistoryItems.length}
                  externalErrorMessage={sidebarActionError}
                  connectionLost={gatewayConnectionLost}
                  sectionsDisabled={sidebarSectionsDisabled}
                  isLocalDraftConversationId={isLocalDraftConversationId}
                  onProjectsCollapsedChange={handleSidebarProjectsCollapsedChange}
                  onRecentCollapsedChange={handleSidebarRecentCollapsedChange}
                  onCreateProject={handleOpenCreateWorkspaceProject}
                  onCreateWorkspaceGroup={handleCreateWorkspaceGroup}
                  onRenameWorkspaceGroup={handleRenameWorkspaceGroup}
                  onDeleteWorkspaceGroup={handleDeleteWorkspaceGroup}
                  onMoveProjectToGroup={handleMoveWorkspaceProjectToGroup}
                  onToggleWorkspaceGroupCollapsed={handleToggleWorkspaceGroupCollapsed}
                  onSelectProject={handleSelectWorkspaceProject}
                  onNewConversationForProject={handleNewConversationForProject}
                  onBrowseProjectInFileTree={handleBrowseWorkspaceProjectInFileTree}
                  onConfigureProject={setProjectSettingsProject}
                  onSetProjectPinned={handleSetWorkspaceProjectPinned}
                  onRemoveProject={handleRemoveWorkspaceProject}
                  onArchiveProject={handleArchiveWorkspaceProject}
                  onUnarchiveProject={handleUnarchiveWorkspaceProject}
                  archivedProjectPathKeys={archivedWorkspaceProjectPathKeys}
                  onNewConversation={() => leaveAccount(handleSidebarNewConversation)}
                  onSelectConversation={(id, options) =>
                    leaveAccount(() => handleSidebarSelectConversation(id, options))
                  }
                  onConversationOpenInWorkbenchSplit={
                    sessionWorkbench.enabled
                      ? workbenchController.handleOpenConversationInSplit
                      : undefined
                  }
                  onConversationWorkbenchDragIntent={
                    sessionWorkbench.enabled
                      ? workbenchController.handleConversationDragIntent
                      : undefined
                  }
                  onProjectWorkbenchDragIntent={
                    sessionWorkbench.enabled
                      ? workbenchController.handleProjectDragIntent
                      : undefined
                  }
                  onShareConversation={handleOpenShareModal}
                  onOpenSharedConversations={handleOpenSharedHistoryManager}
                  onLocalDraftDeleted={handleSidebarLocalDraftDeleted}
                  onConversationsRemoved={handleSidebarConversationsRemoved}
                  sidebarShortcuts={settings.customSettings.sidebarShortcuts}
                  onOpenSettings={openSettings}
                  onOpenResourceHub={(resource) =>
                    leaveAccount(() => handleSidebarOpenResourceHub(resource))
                  }
                />
              )}

              {shareConversation ? (
                <HistoryShareModal
                  conversation={shareConversation}
                  share={shareStatus}
                  isLoading={shareLoading}
                  isUpdating={shareUpdating}
                  errorMessage={shareError}
                  onToggle={handleToggleHistoryShare}
                  onRedactToolContentChange={handleSetShareRedactToolContent}
                  onClose={handleCloseShareModal}
                />
              ) : null}

              {sharedManagerOpen ? (
                <SharedHistoryManagerModal
                  conversations={sharedHistoryItems}
                  statuses={sharedManagerStatuses}
                  loadingIds={sharedManagerLoadingIds}
                  updatingIds={sharedManagerUpdatingIds}
                  errors={sharedManagerErrors}
                  listError={sharedHistoryListError}
                  onRefresh={handleRefreshSharedHistoryStatuses}
                  onLoadStatus={handleLoadSharedHistoryStatus}
                  onDisableShare={handleDisableSharedHistory}
                  onSetRedactToolContent={handleSetSharedHistoryRedactToolContent}
                  onClose={() => setSharedManagerOpen(false)}
                />
              ) : null}

              {projectPickerOpen ? (
                <WorkdirPickerModal
                  initialWorkdir={activeWorkspaceProjectPath || settings.system.workdir.trim()}
                  onClose={() => setProjectPickerOpen(false)}
                  onSelect={handleWorkdirPickerSelect}
                />
              ) : null}

              {workspaceCreateModalOpen ? (
                <WorkspaceCloneModal
                  initialParent={activeWorkspaceProjectPath || settings.system.workdir.trim()}
                  canClone={settings.remote.enableWebGit}
                  cloneDisabledMessage={translate(
                    "chat.workspaceCloneWebDisabled",
                    settings.locale,
                  )}
                  onOpenFolder={handleOpenWorkspaceFolder}
                  onClone={handleCloneWorkspaceProject}
                  onLoadBranches={handleLoadWorkspaceRemoteBranches}
                  onClose={() => setWorkspaceCreateModalOpen(false)}
                />
              ) : null}
              <WorkspaceCloneTaskOverlay
                tasks={workspaceCloneTasks}
                onCancel={handleCancelWorkspaceCloneTask}
                onDismiss={handleDismissWorkspaceCloneTask}
                onOpenWorkspace={handleOpenClonedWorkspace}
              />

              {confirmDialog}

              <DeviceWorkbenchLayout
                expanded={deviceWorkspace?.expanded}
                conversationVisible={!accountDestination && activeView === "chat"}
                toolsOpen={Boolean(terminalClient) && rightDockOpen}
                tabbed={tabbedWorkspace}
                chrome={workbenchChrome}
                width={settings.customSettings.rightDock.width}
                onWidthChange={handleRightDockWidthChange}
                onClose={handleRightDockClose}
                minDockedWidth={
                  desktopHost?.onWindowControlsTarget
                    ? MIN_DOCKED_WORKSPACE_WITH_CAPTIONS
                    : undefined
                }
                main={
                  <>
                    {accountNavigation && (
                      <div
                        ref={accountSurface.setTarget}
                        hidden={!accountDestination}
                        inert={!accountDestination}
                        className={accountDestination ? "flex min-h-0 min-w-0 flex-1" : "hidden"}
                        data-workbench-account-content=""
                      />
                    )}
                    <main
                      className={accountDestination ? "hidden" : GATEWAY_MAIN_SHELL_CLASS}
                      inert={!!accountDestination}
                    >
                      <div className={GATEWAY_MAIN_BACKDROP_CLASS} />

                      {activeView === "image-studio-hub" && !imageStudio.host && (
                        <section className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                          <h1 className="text-lg font-semibold">
                            {translate("imageStudio.name", settings.locale)}
                          </h1>
                          <p role="status" className="max-w-lg text-sm text-muted-foreground">
                            {imageDeviceUnsupported
                              ? translate(
                                  "imageStudio.gateway.mobileDeviceUnavailable",
                                  settings.locale,
                                )
                              : identity.pending
                                ? translate("imageStudio.connecting", settings.locale)
                                : identity.error
                                  ? gatewayImageErrorNotice(identity.error, (key) =>
                                      translate(key, settings.locale),
                                    )
                                  : imageStudio.unavailable}
                          </p>
                          {imageDeviceToken && !identity.pending && (
                            <Button
                              variant="outline"
                              onClick={identity.identity ? imageStudio.retry : identity.retry}
                            >
                              {translate("imageStudio.retryConnect", settings.locale)}
                            </Button>
                          )}
                        </section>
                      )}
                      <ApplicationView
                        activeView={activeView}
                        imageStudioHost={
                          imageStudio.host && {
                            ...imageStudio.host,
                            reconnectVersion: imageReconnect,
                            onOpenSettings:
                              identity.identity?.mode === "device"
                                ? undefined
                                : () => openSettings("image-studio"),
                          }
                        }
                        settings={settings}
                        setSettings={setSettings}
                        resourceHost={kbrainResourceHostCapabilities}
                        kbrainSettings={settingsHostAdapter.kbrain}
                        isAgentMode={isAgentMode}
                        initialSkills={availableSkills}
                        initialSkillsRootDir={skillsRootDir}
                        onOpenView={setActiveView}
                        scheduledTasks={showDeviceTasks ? renderConnectedTasks() : undefined}
                        className={
                          activeView === "image-studio-hub" && !imageStudio.host
                            ? "hidden"
                            : "contents"
                        }
                        chat={{
                          containerRef: chatFrameRef,
                          containerProps: {
                            className: `${GATEWAY_CHAT_FRAME_CLASS} zone-font-scale`,
                            style: {
                              "--zone-font-scale": settings.customSettings.fontScale.chat,
                            } as CSSProperties,
                            onDragEnter: handleChatFileDragEnter,
                            onDragOver: handleChatFileDragOver,
                            onDragLeave: handleChatFileDragLeave,
                            onDrop: handleChatFileDrop,
                          },
                          content: (
                            <>
                              <GatewayDeviceConnectionNotice
                                unavailable={sidebarSectionsDisabled}
                                connectionLost={gatewayConnectionLost}
                                agentOnline={status?.online}
                                statusReadFailed={Boolean(statusError)}
                                draftEditable={composerDraftOnly && !approvalBar}
                                deviceName={selectedDevice?.name}
                                onReconnect={() => prepareChatRuntime("manual-reconnect")}
                                onChooseDevice={
                                  canChooseAnotherDevice
                                    ? () => setExecutionSwitcherOpen(true)
                                    : undefined
                                }
                              />
                              {savedDeviceDraftNotice && !sidebarSectionsDisabled ? (
                                <GatewaySavedDeviceDraftNotice
                                  state={savedDeviceDraftNotice.state}
                                  path={savedDeviceDraftNotice.path}
                                  onRetry={retrySavedDeviceDraft}
                                />
                              ) : null}
                              {chatProtocolIncompatibleMessage && !sidebarSectionsDisabled ? (
                                <StatusNotice
                                  tone="error"
                                  message={chatProtocolIncompatibleMessage}
                                  className="mx-5 mt-3 max-sm:mx-3"
                                />
                              ) : null}
                              {settingsSyncError && !sidebarSectionsDisabled ? (
                                <StatusNotice
                                  tone="error"
                                  message={settingsSyncError}
                                  className="mx-5 mt-3 max-sm:mx-3"
                                />
                              ) : null}
                              {deviceHistoryOpenFailed && !sidebarSectionsDisabled ? (
                                <StatusNotice
                                  tone="error"
                                  message={
                                    settings.locale === "zh-CN"
                                      ? "暂时无法读取此设备会话。"
                                      : "Couldn't read this device conversation."
                                  }
                                  description={
                                    settings.locale === "zh-CN"
                                      ? "草稿保留在原会话。历史读取成功后即可继续发送。"
                                      : "Your draft stays in this conversation. Sending is available once history loads."
                                  }
                                  actions={
                                    <Button variant="ghost" onClick={retryDeviceHistoryOpen}>
                                      {settings.locale === "zh-CN" ? "重试" : "Retry"}
                                    </Button>
                                  }
                                  className="mx-5 mt-3 max-sm:mx-3"
                                />
                              ) : !sidebarSectionsDisabled &&
                                chatError &&
                                displayedTranscriptRowCount === 0 ? (
                                <StatusNotice
                                  tone="error"
                                  message={chatError}
                                  className="mx-5 mt-3 max-sm:mx-3"
                                />
                              ) : null}

                              {sessionWorkbench.enabled ? (
                                renderConversationWorkbench()
                              ) : (
                                <DeviceConversationImageSurface
                                  host={fallbackImages}
                                  includeAttachments={Boolean(displayedConversationWorkdir)}
                                >
                                  <DeviceUiTranscript
                                    client={
                                      !transportInputDisabled && displayedConversationWorkdir
                                        ? devicePlugins?.readSurface
                                        : undefined
                                    }
                                    conversationId={displayedConversationId}
                                    workdir={displayedConversationWorkdir}
                                    running={composerIsSending}
                                    htmlPreviews={
                                      settings.customSettings.chatTranscript.htmlPreviews
                                    }
                                  >
                                    <section
                                      ref={transcriptStageRef}
                                      data-conversation-scope=""
                                      className="gateway-transcript-stage relative min-h-0 flex-1 overflow-hidden @container"
                                      // Preferred (persisted) width, so a fresh mount paints at
                                      // the user's width instead of the default.
                                      // TranscriptWidthControls narrows this same variable to
                                      // the stage in a layout effect — see its header.
                                      style={
                                        {
                                          [CHAT_TRANSCRIPT_WIDTH_CSS_VAR]: `${settings.customSettings.chatTranscript.width}px`,
                                        } as CSSProperties
                                      }
                                    >
                                      {renderedConversationView === "trajectory" ? (
                                        <TrajectoryView
                                          conversationId={displayedConversationId}
                                          host={trajectoryHost}
                                          messages={trajectoryMessages}
                                          workdir={displayedConversationWorkdir}
                                          hasMoreMessages={selectedHistoryHasMore}
                                          loadEarlierMessages={
                                            selectedHistoryHasMore
                                              ? handleLoadEarlierHistory
                                              : undefined
                                          }
                                          liveEvents={liveTrajectory}
                                          authoritativeRevision={trajectoryAuthoritativeRevision}
                                        />
                                      ) : (
                                        <div className="relative h-full min-h-0">
                                          <ScrollArea
                                            ref={setTranscriptScrollAreaRoot}
                                            viewportRef={setTranscriptViewport}
                                            viewportProps={{
                                              className: "chat-transcript-viewport",
                                              "aria-label": translate(
                                                "chat.transcript.messages",
                                                settings.locale,
                                              ),
                                            }}
                                            className={GATEWAY_TRANSCRIPT_SCROLL_CLASS}
                                          >
                                            <ChangedFilesActionsProvider
                                              value={changedFilesActions}
                                            >
                                              <CheckpointRewindProvider
                                                client={checkpointClient}
                                                conversationId={displayedConversationId}
                                                disabled={
                                                  !displayedConversationId || transcriptBusy
                                                }
                                                resolveAuthorizedRoots={
                                                  resolveCheckpointAuthorizedRoots
                                                }
                                                onRewound={handleCheckpointRewound}
                                              >
                                                <GatewayTranscript
                                                  conversationId={displayedConversationId}
                                                  rows={transcriptRows}
                                                  liveStartIndex={transcriptLiveStartIndex}
                                                  activeTurnKey={displayedTranscript.activeTurnKey}
                                                  contentWidth={
                                                    settings.customSettings.chatTranscript.width
                                                  }
                                                  isViewportFollowing={transcriptFollow.isFollowing}
                                                  viewportFollowing={transcriptFollowing}
                                                  navRef={transcriptNavRef}
                                                  onAnchorUserRowChange={setActiveFloorKey}
                                                  error={transcriptError}
                                                  toolStatus={transcriptToolStatus}
                                                  toolStatusIsCompaction={
                                                    transcriptToolStatusIsCompaction
                                                  }
                                                  retryAttempts={displayedTranscript.retryAttempts}
                                                  isStreaming={transcriptBusy}
                                                  isLoading={transcriptHistoryLoading}
                                                  loadingTitle={historyDetailLoadingTitle}
                                                  hasModels={modelOptions.length > 0}
                                                  onOpenSettings={openSettings}
                                                  hasMoreHistory={selectedHistoryHasMore}
                                                  isLoadingMoreHistory={loadingOlderHistory}
                                                  onLoadEarlierHistory={
                                                    selectedHistoryHasMore
                                                      ? handleLoadEarlierHistory
                                                      : undefined
                                                  }
                                                  showUsage={isAgentDevExecutionMode}
                                                  usageContextWindow={currentModelContextWindow}
                                                  workspaceRoot={displayedConversationWorkdir}
                                                  onOpenFileLink={handleOpenChatFileLink}
                                                  gitClient={gitClient}
                                                  onLoadUploadedImagePreview={
                                                    handleLoadUploadedImagePreview
                                                  }
                                                  onResendFromEdit={handleResendFromEdit}
                                                  onBranchConversation={handleBranchConversation}
                                                  branchPendingMessageId={branchPendingMessageId}
                                                  onSuggestionSelect={handleEmptyStateSuggestion}
                                                  onQuoteSelection={(text) => {
                                                    composerRef.current?.insertQuote(text);
                                                  }}
                                                  onCommentSelection={(comment) =>
                                                    composerRef.current?.upsertComment?.(comment) !=
                                                    null
                                                  }
                                                />
                                              </CheckpointRewindProvider>
                                            </ChangedFilesActionsProvider>
                                          </ScrollArea>
                                          <TranscriptWidthControls
                                            hostRef={transcriptStageRef}
                                            width={settings.customSettings.chatTranscript.width}
                                            onWidthChange={handleChatTranscriptWidthChange}
                                            resizeLabel={
                                              settings.locale === "en-US"
                                                ? "Resize conversation content"
                                                : "调整对话正文宽度"
                                            }
                                            resetLabel={
                                              settings.locale === "en-US"
                                                ? "Double-click to reset"
                                                : "双击恢复默认宽度"
                                            }
                                            suspended={conversationOpenState.showOverlay}
                                          />
                                          {displayedTranscriptRowCount > 0 &&
                                          !conversationOpenState.showOverlay ? (
                                            <FloorNavRail
                                              conversationId={displayedConversationId}
                                              floors={transcriptFloors}
                                              activeRowKey={activeFloorKey}
                                              bottomOffset="calc(var(--gateway-chat-composer-overlay-height, var(--spacing-176px)) + var(--spacing-12px))"
                                              scrollViewport={transcriptViewport}
                                              onJump={handleFloorJump}
                                            />
                                          ) : null}
                                          {conversationOpenState.showOverlay ? (
                                            <HistorySwitchLoadingOverlay locale={settings.locale} />
                                          ) : null}
                                        </div>
                                      )}
                                      {renderedConversationView === "conversation" &&
                                      displayedTranscriptRowCount > 0 &&
                                      !conversationOpenState.showOverlay &&
                                      !transcriptFollowing ? (
                                        <TranscriptLatestButton
                                          bottom={GATEWAY_TRANSCRIPT_LATEST_BOTTOM}
                                          viewport={transcriptViewport}
                                          onJump={transcriptFollow.jumpToBottom}
                                        />
                                      ) : null}
                                      <ChatComposerBar
                                        focusImagePlacement
                                        presentation="column"
                                        mobileControls={compactDeviceHeader}
                                        capabilities={DEVICE_COMPOSER_CAPABILITIES}
                                        overlayHeightOwnerRef={chatFrameRef}
                                        runClarifyTurn={
                                          settings.customSettings.promptClarifyEnabled
                                            ? runClarifyTurn
                                            : undefined
                                        }
                                        clarifyContext={clarifyContext}
                                        conversationId={displayedConversationId}
                                        // 轨迹页是只读分析视图：挂起输入区（保持挂载，草稿不丢）。
                                        hidden={renderedConversationView === "trajectory"}
                                        composerRef={composerRef}
                                        isSending={composerIsSending}
                                        isUploadingFiles={isUploadingFiles}
                                        isInputDisabled={composerInputDisabled}
                                        draftOnly={composerDraftOnly}
                                        // 麦克风在开启语音输入后显示；点击设置卡片会立即切换当前供应商。
                                        sttSessionKey={displayedConversationId}
                                        sttProvider={null}
                                        sttProviderConfigured={false}
                                        inputPlaceholder={composerPlaceholder}
                                        workdir={displayedConversationWorkdir}
                                        enabledSkills={enabledComposerSkills}
                                        mentionableConversations={mentionableConversations}
                                        searchMentionableConversations={
                                          searchMentionableConversations
                                        }
                                        mentionApps={mentionApps}
                                        commandHost={composerCommandHost}
                                        goalBar={
                                          <WebGoalBarHost
                                            key={`goal-${displayedConversationId}`}
                                            conversationId={
                                              isLocalDraftConversationId(displayedConversationId)
                                                ? undefined
                                                : displayedConversationId
                                            }
                                            client={api ?? undefined}
                                            commandHost={composerCommandHost}
                                            running={composerIsSending}
                                          />
                                        }
                                        executionMode={settings.system.executionMode}
                                        hasModels={modelOptions.length > 0}
                                        currentModelLabel={currentModelLabel}
                                        modelOptions={modelOptions}
                                        selectedValue={selectedValue}
                                        chatRuntimeControls={chatRuntimeControlsForCurrentProvider}
                                        commandSafetyMode={settings.system.commandSafetyMode}
                                        onCommandSafetyModeChange={(mode) =>
                                          setSettings((prev) =>
                                            prev.system.commandSafetyMode === mode
                                              ? prev
                                              : updateSystem(prev, { commandSafetyMode: mode }),
                                          )
                                        }
                                        reasoningOptions={chatRuntimeReasoningOptions}
                                        thinkingAlwaysOn={chatRuntimeThinkingAlwaysOn}
                                        contextUsageTokensSource={contextUsageTokensSource}
                                        contextWindow={currentModelContextWindow}
                                        contextDisplayMode={
                                          settings.customSettings.composerContextDisplay
                                        }
                                        onManualCompactConfirm={handleManualCompact}
                                        manualCompactBlocked={
                                          manualCompactPending || composerCompactionBlocked
                                        }
                                        gitClient={gitClient}
                                        onOpenWorktree={handleOpenWorktree}
                                        onWorktreeRemoved={handleWorktreeRemoved}
                                        gitWriteEnabled={settings.remote.enableWebGit}
                                        gitDisabledMessage={gitDisabledMessage}
                                        workspaceActivityClient={workspaceActivityClient}
                                        onSelectModel={handleSelectModel}
                                        onSelectExecutionMode={handleSelectExecutionMode}
                                        onOpenSettings={openSettings}
                                        onSend={() => {
                                          if (
                                            submitInFlightRef.current ||
                                            isUploadingFiles ||
                                            isImportingPastedTextRef.current ||
                                            composerInputDisabled
                                          ) {
                                            return;
                                          }
                                          if (
                                            queuedChatEditSessionRef.current?.conversationId ===
                                            getDisplayedConversationId()
                                          ) {
                                            submitInFlightRef.current = true;
                                            void (async () => {
                                              try {
                                                await commitQueuedChatEdit();
                                              } finally {
                                                submitInFlightRef.current = false;
                                              }
                                            })();
                                            return;
                                          }
                                          if (
                                            displayedConversationBusyRef.current ||
                                            queuedChatTurnsForDisplayedConversation.length > 0
                                          ) {
                                            submitInFlightRef.current = true;
                                            void (async () => {
                                              try {
                                                await submitCurrentComposerToGuiQueue("append");
                                              } finally {
                                                submitInFlightRef.current = false;
                                              }
                                            })();
                                            return;
                                          }
                                          const isCurrentAgent = api.captureActiveAgentScope();
                                          submitInFlightRef.current = true;
                                          void (async () => {
                                            try {
                                              const draft = composerRef.current?.getDraft() ?? null;
                                              // Capture the send target before the paste import
                                              // awaits: switching conversations mid-import must
                                              // not reroute the message or clear the composer of
                                              // the newly displayed conversation.
                                              const sendConversationId =
                                                getDisplayedConversationId();
                                              let text: string;
                                              let files: PendingUploadedFile[];
                                              let referencedConversations =
                                                draft?.conversationMentions ?? [];
                                              try {
                                                const materialized = draft
                                                  ? await materializeComposerDraftForSend(
                                                      draft,
                                                      pendingUploadedFiles,
                                                      displayedConversationWorkdir,
                                                      sendConversationId,
                                                      isCurrentAgent,
                                                    )
                                                  : {
                                                      text: "",
                                                      uploadedFiles: pendingUploadedFiles,
                                                      referencedConversations: [],
                                                    };
                                                text = materialized.text;
                                                files = materialized.uploadedFiles;
                                                referencedConversations =
                                                  materialized.referencedConversations;
                                              } catch (error) {
                                                if (isCurrentAgent())
                                                  addNotify(
                                                    "error",
                                                    asErrorMessage(error, "大段粘贴内容导入失败"),
                                                  );
                                                return;
                                              }

                                              if (
                                                !isCurrentAgent() ||
                                                (!text && files.length === 0)
                                              ) {
                                                return;
                                              }
                                              if (
                                                getDisplayedConversationId() === sendConversationId
                                              ) {
                                                composerRef.current?.clear();
                                              }
                                              setPendingUploadsForConversation(
                                                sendConversationId,
                                                [],
                                              );
                                              void sendChat(text, {
                                                isCurrentAgent,
                                                conversationId: sendConversationId,
                                                uploadedFiles: files,
                                                referencedConversations,
                                                runtimeControls:
                                                  chatRuntimeControlsForCurrentProvider,
                                              }).catch(() => {
                                                if (!isCurrentAgent()) return;
                                                updatePendingUploadsForConversation(
                                                  sendConversationId,
                                                  (current) =>
                                                    mergePendingUploadedFiles(current, files),
                                                );
                                              });
                                            } finally {
                                              submitInFlightRef.current = false;
                                            }
                                          })();
                                        }}
                                        onStop={() => {
                                          const nextQueuedTurn =
                                            queuedChatTurnsForDisplayedConversation[0];
                                          if (nextQueuedTurn && !queuePaused) {
                                            // Keep WebUI's stop button aligned with the desktop
                                            // composer: stop the active run, then drain the queue.
                                            runQueuedTurnNow(nextQueuedTurn.id);
                                            return;
                                          }
                                          void cancelChat(displayedConversationId);
                                        }}
                                        stopDisabled={transportInputDisabled}
                                        onPrepareChatRuntime={() => {
                                          if (!api || historyShareToken) {
                                            return;
                                          }
                                          void prepareChatRuntime(
                                            "composer-focus",
                                            api,
                                            CHAT_RUNTIME_FOREGROUND_PREPARE_TIMEOUT_MS,
                                          ).catch(() => undefined);
                                        }}
                                        onComposerBusyChange={handleComposerBusyChange}
                                        onChatRuntimeControlsChange={
                                          handleChatRuntimeControlsChange
                                        }
                                        onPickReadableFiles={() => fileInputRef.current?.click()}
                                        onPickWorkspaceFolder={() =>
                                          folderInputRef.current?.click()
                                        }
                                        onPasteFiles={handleImportReadableFiles}
                                        onLoadUploadedImagePreview={handleLoadUploadedImagePreview}
                                        loadHistoryPrompts={loadComposerHistoryPrompts}
                                        pendingUploadedFiles={pendingUploadedFiles}
                                        onReplacePendingUpload={
                                          transportInputDisabled || historyShareToken
                                            ? undefined
                                            : replacePendingUpload
                                        }
                                        imageAnnotationAuthority={JSON.stringify([
                                          workspaceOwner,
                                          workspaceViewScope,
                                        ])}
                                        onRemovePendingUpload={(relativePath) => {
                                          updatePendingUploadsForConversation(
                                            getDisplayedConversationId(),
                                            (current) =>
                                              current.filter(
                                                (file) => file.relativePath !== relativePath,
                                              ),
                                          );
                                        }}
                                        queuedTurns={queuedChatTurnsForDisplayedConversation}
                                        queuePaused={queuePaused}
                                        queueControlPending={queueControlPending}
                                        queueRunDisabled={transportInputDisabled}
                                        onQueuePausedChange={handleQueuePausedChange}
                                        onRunQueuedTurnNow={runQueuedTurnNow}
                                        onMoveQueuedTurnUp={moveQueuedTurnUp}
                                        onEditQueuedTurn={editQueuedTurn}
                                        onRemoveQueuedTurn={removeQueuedTurn}
                                        taskProgressBar={
                                          <TaskProgressBar
                                            key={displayedConversationId}
                                            snapshot={taskProgressSnapshot}
                                            isConversationRunning={transcriptBusy}
                                          />
                                        }
                                        approvalBar={approvalBar}
                                        statsBar={
                                          <ConversationStatsBarHost
                                            // 前缀防与同级 taskProgressBar 的 key（裸会话 id）碰撞：React 对
                                            // 同键兄弟的 keyed diff 会让旧 fiber 逃过删除，DOM 残留逐次累积。
                                            key={`stats-${displayedConversationId}`}
                                            conversationId={displayedConversationId}
                                            host={trajectoryHost}
                                            // 轨迹视图下输入区隐藏，状态栏无需拉取。
                                            enabled={renderedConversationView !== "trajectory"}
                                            contextUsageTokensSource={contextUsageTokensSource}
                                            contextWindow={currentModelContextWindow}
                                            onManualCompactConfirm={handleManualCompact}
                                            manualCompactBlocked={
                                              manualCompactPending || composerCompactionBlocked
                                            }
                                          />
                                        }
                                        fileDropOverlay={
                                          isFileDropActive ? (
                                            <FileDropOverlay
                                              variant="composer"
                                              canDropUpload={canDropUpload}
                                              title={fileDropTitle}
                                              description={fileDropDescription}
                                              limitHint={fileDropLimitHint}
                                            />
                                          ) : null
                                        }
                                      />
                                    </section>
                                  </DeviceUiTranscript>
                                </DeviceConversationImageSurface>
                              )}
                            </>
                          ),
                        }}
                        workspaceOverlays={
                          <WorkspaceOverlayHost
                            locale={settings.locale}
                            theme={effectiveTheme}
                            workspaceViewScope={workspaceViewScope}
                            workspaceEditors={workspaceEditors}
                            onWorkspaceEditorPreviewFile={openWorkspaceFilePreview}
                            onWorkspaceEditorInsertCodeMention={handleInsertCodeMention}
                            onWorkspaceEditorHide={handleWorkspaceEditorHide}
                            onWorkspaceEditorClose={handleWorkspaceEditorClosed}
                            workspaceFilePreviewMounted={workspaceFilePreviewMounted}
                            workspaceFilePreviewOpenRequest={workspaceFilePreviewOpenRequest}
                            workspaceFilePreviewOpen={workspaceFilePreviewOpen}
                            onWorkspaceFilePreviewOpenEditor={openWorkspaceEditorFile}
                            onWorkspaceFilePreviewRequestClose={requestWorkspaceFilePreviewClose}
                            onWorkspaceFilePreviewClose={handleWorkspaceFilePreviewClosed}
                            workspaceSshTerminalMounted={workspaceSshTerminalMounted}
                            workspaceSshTerminalOpenRequest={workspaceSshTerminalOpenRequest}
                            workspaceSshTerminalOpen={workspaceSshTerminalOpen}
                            terminalProjectPathKey={terminalProjectPathKey}
                            terminalClient={terminalClient}
                            sftpClient={sftpClient}
                            terminalSessions={terminalSessions}
                            onWorkspaceSshTerminalHide={hideWorkspaceSshTerminalOverlay}
                            onSshTerminalOpenFile={handleOpenSftpFile}
                            sshTerminalPaneLeasedSessionIds={workbenchLeasedDockSessionIds}
                            onSshTerminalFocusLeasedSession={
                              sessionWorkbench.enabled
                                ? workbenchController.focusTerminalPaneForSession
                                : undefined
                            }
                            onSshTerminalSessionTabDragStart={
                              sessionWorkbench.enabled
                                ? workbenchController.handleTerminalTabDragIntent
                                : undefined
                            }
                          />
                        }
                      />
                    </main>
                  </>
                }
                tools={
                  terminalClient ? (
                    <RightDockPanel
                      devicePlugins={!transportInputDisabled ? devicePlugins : undefined}
                      workspace={deviceWorkspace}
                      workspaceViewScope={workspaceViewScope}
                      isOpen={!accountDestination && activeView === "chat" && rightDockOpen}
                      fontScale={settings.customSettings.fontScale.rightDock}
                      projectPathKey={terminalProjectPathKey}
                      cwd={terminalProjectPath}
                      workspaceProject={terminalWorkspaceProject}
                      workspaceProjectRootClient={workspaceProjectRootClient}
                      workspaceRootRevision={workspaceRootRevision}
                      sessions={terminalSessions}
                      sessionsLoaded={terminalSessionsLoaded}
                      leasedSessionIds={workbenchLeasedDockSessionIds}
                      leasedTools={leasedDockTools}
                      theme={effectiveTheme}
                      disabledMessage={projectToolsDisabledMessage}
                      terminalDisabledMessage={terminalDisabledMessage}
                      projectState={rightDockProjectState}
                      fileTreeState={rightDockFileTreeState}
                      sshHosts={settings.ssh.hosts}
                      associatedSshHostIds={associatedSshHostIds}
                      client={terminalClient}
                      gitClient={gitClient}
                      gitWriteEnabled={settings.remote.enableWebGit}
                      gitDisabledMessage={gitDisabledMessage}
                      tunnelClient={isAgentMode ? api : null}
                      tunnelEnabled={tunnelEnabled}
                      tunnelDisabledMessage={tunnelDisabledMessage}
                      tunnelPublicBaseUrl={gatewayOrigin()}
                      workspaceActivityClient={workspaceActivityClient}
                      onProjectStateChange={handleRightDockProjectStateChange}
                      onFileTreeStateChange={handleRightDockFileTreeStateChange}
                      onSshProjectHostIdsChange={handleSshProjectHostIdsChange}
                      onOpenSshSession={handleOpenSshTerminal}
                      onSessionsChange={handleProjectTerminalSessionsChange}
                      onTerminalTabDragStart={
                        sessionWorkbench.enabled
                          ? workbenchController.handleTerminalTabDragIntent
                          : undefined
                      }
                      onNewTerminalDragStart={
                        sessionWorkbench.enabled
                          ? workbenchController.handleNewTerminalDragIntent
                          : undefined
                      }
                      onOpenTerminalInWorkbench={
                        sessionWorkbench.enabled
                          ? workbenchController.handleOpenTerminalInSplit
                          : undefined
                      }
                      onToolDragStart={
                        sessionWorkbench.enabled && terminalProjectPath.trim()
                          ? workbenchController.handleToolDragIntent
                          : undefined
                      }
                      onOpenToolInWorkbench={
                        sessionWorkbench.enabled && terminalProjectPath.trim()
                          ? workbenchController.handleOpenToolInSplit
                          : undefined
                      }
                      onOpenNewTerminalInWorkbench={
                        sessionWorkbench.enabled
                          ? workbenchController.handleOpenNewTerminalInSplit
                          : undefined
                      }
                      onSessionGhost={verifyTerminalSessionAlive}
                      onInsertFileMention={handleRightDockInsertFileMention}
                      onOpenFile={handleOpenWorkspaceFile}
                      gitReviewFocusRequest={gitReviewFocusRequest}
                      onGitReviewFocusRequestHandled={handleGitReviewFocusRequestHandled}
                      onInsertCodeReviewSkill={
                        codeReviewSkill ? handleRightDockInsertCodeReviewSkill : undefined
                      }
                      onInsertCommitMention={handleRightDockInsertCommitMention}
                      onInsertGitFileMention={handleRightDockInsertGitFileMention}
                      onClose={handleRightDockClose}
                    />
                  ) : null
                }
              />
            </WorkbenchBody>
          </WorkbenchShell>

          {projectSettingsProject ? (
            <WorkspaceProjectSettingsModal
              project={projectSettingsProject}
              settings={settings}
              skills={availableSkills}
              rootClient={workspaceProjectRootClient}
              trustClient={projectTrustClient}
              rootClientUnavailableDescription={
                workspaceProjectRootClient
                  ? undefined
                  : translate(
                      "chat.workspaceSettingsDirectoriesGatewayDescription",
                      settings.locale,
                    )
              }
              onClose={() => setProjectSettingsProject(null)}
              onRenameProject={(name) => {
                handleCommitWorkspaceProjectRename(projectSettingsProject, name);
              }}
              onSave={(draft) => {
                setSettings((prev) =>
                  updateWorkspaceResourceSettings(prev, projectSettingsProject.path, draft),
                );
              }}
            />
          ) : null}

          {settingsOpen && relayUser ? (
            <div
              className={cn(
                GATEWAY_SETTINGS_OVERLAY_CLASS,
                // Keep the settled transform at none: a transformed settings scroller
                // can leave blank rasterized regions on Android Chrome.
                overlay === "open" ? "opacity-100! transform-none!" : "",
              )}
              onTransitionEnd={handleSettingsTransitionEnd}
            >
              <SettingsWorkspace
                navigationRef={setSettingsRailTarget}
                windowControls={
                  desktopHost ? (
                    <div className="settings-window-chrome">
                      <div className="h-full flex-1" data-tauri-drag-region />
                      <DesktopHostSlot kind="window" />
                    </div>
                  ) : undefined
                }
              >
                <SettingsPage
                  runtimeKind="device_agent"
                  onOpenModelPreferences={() => setModelPreferencesOpen(true)}
                  onOpenScheduledTasks={
                    taskOwner && taskDeviceId
                      ? () => selectNavigation("cron-hub", sidebar.isMobile)
                      : undefined
                  }
                  imageClient={
                    identity.identity?.mode === "device" ? undefined : imageStudio.host?.client
                  }
                  registerLeaveGuard={viewModel.registerSettingsLeaveGuard}
                  settings={{
                    ...settings,
                    system: { ...settings.system, workspaceProjects },
                  }}
                  settingsHost={{
                    ...settingsHostAdapter,
                    devicePlugins,
                    devicePluginScope: JSON.stringify([taskOwner, taskDeviceId, pluginTarget]),
                    devicePluginWorkdir: terminalProjectPath || undefined,
                    usageScope: JSON.stringify([
                      taskOwner,
                      taskDeviceId,
                      selection?.target_fingerprint,
                    ]),
                  }}
                  setSettings={setSettings}
                  saveState={settingsSaveState}
                  onBack={closeSettings}
                  initialSection={settingsSection}
                  initialAnchor={settingsAnchor}
                  initialProviderId={settingsProviderId}
                  hiddenSections={[...DEVICE_WEB_HIDDEN_SETTINGS_SECTIONS]}
                  relayUser={relayUser}
                  relayStats={relayStats}
                  onRelayUserChange={() => void refreshRelayAccount()}
                  onRelayStatsChange={() => void refreshRelayAccount()}
                  sttSettingsService={sttSettingsService}
                  onAgentDirectoryChanged={async () => {
                    if (!api) return;
                    await api.listAgents();
                  }}
                />
              </SettingsWorkspace>
            </div>
          ) : null}
          {modelPreferencesOpen ? (
            <DeviceModelPreferencesDialog
              settings={settings}
              setSettings={setSettings}
              client={imageStudio.host?.client}
              onClose={() => setModelPreferencesOpen(false)}
            />
          ) : null}
          {relayUser ? (
            <FirstRunOnboarding
              userId={relayUser.id}
              onSyncKeys={async (keys, groups) => {
                const next = await bindRelayKeysToSettings(settings, keys, groups, true);
                setSettings(() => next);
              }}
            />
          ) : null}
        </div>
      </AppErrorBoundary>
    </LocaleContext.Provider>
  );
}
