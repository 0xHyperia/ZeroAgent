import { ApplicationRail } from "@liveagent/ui/application/ApplicationRail";
import { BrandMark } from "@liveagent/ui/application/BrandMark";
import { useApplicationViewState } from "@liveagent/ui/application/useApplicationViewState";
import { createWorkbenchNavigationItem } from "@liveagent/ui/application/workbenchNavigation";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import { Button } from "@liveagent/ui/components/ui/button";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import { SidebarProvider, useSidebar } from "@liveagent/ui/components/ui/sidebar";
import { StatusNotice } from "@liveagent/ui/components/ui/status-notice";
import { type ToastTone, toast } from "@liveagent/ui/components/ui/toast-manager";
import { LocaleContext, t as translate, useLocaleContextValue } from "@liveagent/ui/i18n/index";
import {
  clearCommandRecoveries,
  moveCommandRecovery,
} from "@liveagent/ui/lib/chat/composerCommandRecovery";
import { searchMentionConversations } from "@liveagent/ui/lib/chat/conversationSearch";
import { describeChatRunFailure } from "@liveagent/ui/lib/chat/modelConfigRejection";
import {
  clearSearchJumpTarget,
  getSearchJumpTargetSnapshot,
  resolveSearchJumpRowKey,
  subscribeSearchJumpTarget,
} from "@liveagent/ui/lib/chat/searchJumpTarget";
import { buildToolApprovalRequestJson } from "@liveagent/ui/lib/chat/toolApprovalArgs";
import { UploadedImagePreviewScope } from "@liveagent/ui/lib/chat/uploadedImagePreview";
import { useMentionApps } from "@liveagent/ui/lib/chat/useMentionApps";
import { useScrollFollow } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import { loadThinkingLiveSupplement } from "@liveagent/ui/lib/models/thinkingLive";
import { releaseProjectToolFromDock } from "@liveagent/ui/lib/projectTools/releaseProjectToolFromDock";
import { useConversationRightDock } from "@liveagent/ui/lib/projectTools/useConversationRightDock";
import { cn } from "@liveagent/ui/lib/shared/utils";
import type { ConversationOpenRequest } from "@liveagent/ui/lib/sidebar/openController";
import {
  type ConversationOpenState,
  createConversationOpenController,
} from "@liveagent/ui/lib/sidebar/openController";
import { createSidebarStore } from "@liveagent/ui/lib/sidebar/store";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import {
  sortTerminalSessions,
  terminalSessionBelongsToProject,
} from "@liveagent/ui/lib/terminal/sessionStore";
import { useWorkspaceProjectDeletion } from "@liveagent/ui/lib/useWorkspaceProjectRemoval";
import { projectToolSurfaceTitleKey } from "@liveagent/ui/lib/workbench/projectToolSurfaces";
import { useWorkspaceProjectSettingsActions } from "@liveagent/ui/lib/workspaceProjectRemoval";
import type { ChatQueueTurnPreview } from "@liveagent/ui/pages/chat/ChatComposerBar";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { TrustedGatewayImageIdentity } from "@/agent-ui-adapters/imageStudio";
import { createGatewayWorkspaceProjectRootClient } from "@/agent-ui-adapters/workspaceProjectRoots";
import { GatewayCloudWorkspace } from "@/components/GatewayCloudWorkspace";
import type { GatewayTranscriptNavHandle } from "@/components/GatewayTranscript";
import { ACCOUNT_CHANGED_EVENT, ACCOUNT_SESSION_STORAGE_KEY } from "@/lib/accountRequest";
import { pushWorkbenchLocation } from "@/lib/browserMobileBack";
import { registerAskUserQuestionAnswerHandler } from "@/lib/chat/askUserQuestionBridge";
import type { HistoryWindowState } from "@/lib/chat/historyWindow";
import {
  buildMcpElicitationRequestJson,
  readMcpElicitationFieldErrors,
  registerMcpElicitationAnswerHandler,
} from "@/lib/chat/mcpElicitationBridge";
import { registerPlanDecisionHandler } from "@/lib/chat/planModeBridge";
import { createActivityStore } from "@/lib/chat/stream/activityStore";
import {
  ChatCommandPipeline,
  type PendingChatCommand,
} from "@/lib/chat/stream/chatCommandPipeline";
import type { ChatCommandUpdate } from "@/lib/chat/stream/streamTypes";
import { createTranscriptStoreRegistry } from "@/lib/chat/stream/useConversationChat";
import { registerToolApprovalDecisionHandler } from "@/lib/chat/toolApprovalBridge";
import { transcriptRowsToJumpCandidates } from "@/lib/chat/transcript/searchJumpCandidates";
import {
  cloudChatRouteHref,
  DEFAULT_EXTENSION_LOCATION,
  deviceWorkbenchRouteTarget,
  readCloudChatRoute,
} from "@/lib/cloudChatRoute";
import { CLOUD_SPACE_HOME } from "@/lib/cloudSpace";
import { getDesktopRemoteHost } from "@/lib/desktopRemoteHost";
import type {
  AgentStatus,
  ChatEvent,
  ChatQueueItemSummary,
  ChatQueueSnapshot,
  HistoryDetail,
} from "@/lib/gatewayTypes";
import { parseHistoryShareToken } from "@/lib/historyShare";
import { isEmbeddedMobileRuntime, MOBILE_BACK_EVENT, mobileHaptic } from "@/lib/mobileRuntime";
import {
  getRelayDashboardStats,
  getRelayProfile,
  RELAY_SESSION_EXPIRED_EVENT,
  type RelayDashboardStats,
  type RelayUser,
} from "@/lib/relay/client";
import {
  parseSelectedModelJson,
  resolveEffectiveTheme,
  type SelectedModel,
  type WorkspaceProject,
  workspaceProjectPathKey,
} from "@/lib/settings";
import { createIdleSidebarBackend, createWebSidebarBackend } from "@/lib/sidebar/webSidebarBackend";
import { importReadableFiles } from "@/lib/uploadReadableFiles";
import { GATEWAY_MAIN_SHELL_CLASS, GATEWAY_SHELL_CLASS } from "@/lib/webStyleClasses";
import { AccountLoginPage } from "@/pages/AccountLoginPage";
import { CloudChatPage } from "@/pages/CloudChatPage";
import { GatewayLoadingCard, GatewayLoadingScreen } from "@/pages/GatewayLoadingScreen";
import { SharedHistoryPage } from "@/pages/SharedHistoryPage";
import {
  asErrorMessage,
  readTunnelManagerToolChange,
  resolveActiveModelSelection,
} from "./chatEventUtils";
import { HISTORY_LIST_PAGE_SIZE, PROTECTED_DRAFT_CONVERSATION } from "./constants";
import { GatewayAppView } from "./GatewayAppView";
import {
  createGatewayChatCommandActions,
  type QueuedEditSession,
} from "./gatewayChatCommandActions";
import { createGatewayConversationActions } from "./gatewayConversationActions";
import {
  clearGatewayConversationSelection,
  failedVisibleGatewayHistoryOpen,
  type GatewayHistoryOpenAttempt,
  gatewayDeviceTaskChatReturnHref,
  loadGatewayConversationSelection,
  resolveGatewayConversationLanding,
  resolveGatewayConversationRestoreTarget,
  saveGatewayConversationSelection,
} from "./gatewayConversationRestore";
import {
  clearGatewayDeviceDraft,
  clearGatewayDeviceDraftsForAccount,
  createGatewayDevicePaneDraftRegistry,
  type GatewayDeviceDraftScope,
  type GatewayDeviceDraftTarget,
  type GatewayDeviceReplyIdentity,
  type GatewaySavedDeviceDraftState,
  gatewayLocalDraftCaptureTarget,
  listGatewayLocalDeviceDrafts,
  planGatewaySavedDeviceDraftRecovery,
  readGatewayDeviceDraft,
  readGatewayDeviceReplyDraft,
  resolveGatewayDraftWorkspace,
  restoreGatewayDeviceDraft,
  saveGatewayDeviceDraft,
} from "./gatewayDeviceDraftRecovery";
import { findDeviceDraftProject } from "./gatewayDeviceDraftWorkspace";
import {
  createOpenConversationInitial,
  createRefreshDisplayedConversationHistorySnapshot,
} from "./gatewayHistoryWindowActions";
import {
  createGatewayHomeConversationState,
  createLocalDraftConversationId,
  isLocalDraftConversationId,
} from "./gatewayLocalDraft";
import { resolveVisibleConversationId } from "./historyUtils";
import { resolveConversationUploadWorkdir } from "./hooks/uploadWorkdirRouting";
import { useDirectoryDropActions } from "./hooks/useDirectoryDropActions";
import { useGatewayChatConfiguration } from "./hooks/useGatewayChatConfiguration";
import { useGatewayChatPresentation } from "./hooks/useGatewayChatPresentation";
import { useGatewayClients } from "./hooks/useGatewayClients";
import {
  type ManualCompactPendingRequest,
  useGatewayConversationRuntime,
} from "./hooks/useGatewayConversationRuntime";
import { useGatewayConversationState } from "./hooks/useGatewayConversationState";
import { useGatewayHistoryReconciliation } from "./hooks/useGatewayHistoryReconciliation";
import { useGatewayProjectTools } from "./hooks/useGatewayProjectTools";
import { useGatewayRuntimePreparation } from "./hooks/useGatewayRuntimePreparation";
import { useGatewaySession } from "./hooks/useGatewaySession";
import { useGatewaySettingsOverlay } from "./hooks/useGatewaySettingsOverlay";
import { useGatewaySettingsSync } from "./hooks/useGatewaySettingsSync";
import { useGatewaySharedHistory } from "./hooks/useGatewaySharedHistory";
import { useGatewayTransportStatus } from "./hooks/useGatewayTransportStatus";
import { useGatewayWorkspaceProjects } from "./hooks/useGatewayWorkspaceProjects";
import { usePendingUploads } from "./hooks/usePendingUploads";
import { useStableCallback } from "./hooks/useStableCallback";
import type { SendChatFn } from "./types";
import { shouldRestorePageComposerDraft } from "./workbench/pageComposerDraftRestore";
import { sessionWorkbench } from "./workbench/sessionWorkbench";
import { useGatewayWorkbench } from "./workbench/useGatewayWorkbench";

const SEARCH_JUMP_MAX_PAGES = 20;

function useGatewayAppController() {
  const historyShareToken = useMemo(
    () => (getDesktopRemoteHost() ? null : parseHistoryShareToken()),
    [],
  );
  const {
    token,
    accountUser,
    environments,
    environmentDirectoryUnavailable,
    reloadEnvironments,
    selection,
    authInitializing,
    authSubmitting,
    authError,
    twoFactorRequired,
    setAuthError,
    login: handleLoginSubmit,
    register: handleRegisterSubmit,
    verifyTwoFactor,
    switchExecutionTarget,
    finishDeviceDraft,
    returnToCloudDraft,
    deviceRouteStatus,
    retryDeviceConversationRoute,
    returnToCloudConversation,
    applyExecutionPresence,
    clearSession,
  } = useGatewaySession(historyShareToken);
  const terminalIdentityRef = useRef<{ conversationId?: string; runId?: string } | null>(null);
  const getTerminalIdentity = useCallback(() => terminalIdentityRef.current, []);
  const { api, terminalClient, sftpClient, gitClient } = useGatewayClients(
    token,
    getTerminalIdentity,
  );
  const selectedAgentId = selection?.agent_id?.trim() || selection?.device_id?.trim() || "";
  const [activeAgentId, setActiveAgentId] = useState(() => api?.getActiveAgent() ?? "");
  const activeAgentIdRef = useRef(activeAgentId);
  const taskLandingAgentRef = useRef("");
  const activeAgentScope = selectedAgentId || activeAgentId || api?.getActiveAgent() || "";
  useEffect(() => {
    if (!api || !accountUser || historyShareToken) return;
    const unsubscribe = api.subscribeAgents(applyExecutionPresence);
    void api.listAgents().catch(() => undefined);
    return unsubscribe;
  }, [accountUser, api, applyExecutionPresence, historyShareToken]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // True only after an authenticated gateway connection has been established
  // and then dropped; the initial connect never shows lost-connection UI.
  const [gatewayConnectionLost, setGatewayConnectionLost] = useState(false);
  // A cached Agent status is usable only after it has been observed on the
  // currently authenticated browser-socket epoch.
  const [sidebarAgentStatusFresh, setSidebarAgentStatusFresh] = useState(false);
  // The homepage is a real unsaved conversation. A stable local-draft id keeps
  // the initial Workbench root valid and lets the first sidebar/dock drop form
  // an actual split without changing the visible homepage experience.
  const [initialHomeConversation] = useState(createGatewayHomeConversationState);
  const [conversationId, setConversationId] = useState(initialHomeConversation.conversationId);
  // 本地未持久化的会话模型切换（按会话 id 键）；发消息随 selected_model
  // 落库后由 history-sync 回声在清理 effect 中收敛删除。
  const [conversationModelOverrides, setConversationModelOverrides] = useState<
    ReadonlyMap<string, SelectedModel>
  >(new Map());
  const [chatError, setChatError] = useState<string | null>(null);
  // 用量环手动压缩：以 operationId 关联桌面终态，避免 accepted 被误当作完成。
  // 按会话 id 键化（issue #359 缺陷 #3）：不同会话各自独立 pending，一个会话压缩
  // 期间绝不静默屏蔽另一个会话的压缩请求。state 与 ref 经唯一 setter/clearer 同步
  // 写以保证两者一致。
  const [manualCompactPendingByConversation, setManualCompactPendingState] = useState<
    ReadonlyMap<string, ManualCompactPendingRequest>
  >(() => new Map());
  const manualCompactPendingRef = useRef<ReadonlyMap<string, ManualCompactPendingRequest>>(
    manualCompactPendingByConversation,
  );
  const setManualCompactPendingRequest = useCallback((request: ManualCompactPendingRequest) => {
    const next = new Map(manualCompactPendingRef.current);
    next.set(request.conversationId, request);
    manualCompactPendingRef.current = next;
    setManualCompactPendingState(next);
  }, []);
  const clearManualCompactPendingRequest = useCallback(
    (conversationId: string, operationId: string) => {
      const current = manualCompactPendingRef.current;
      const pending = current.get(conversationId);
      if (!pending || pending.operationId !== operationId) return false;
      const next = new Map(current);
      next.delete(conversationId);
      manualCompactPendingRef.current = next;
      setManualCompactPendingState(next);
      return true;
    },
    [],
  );
  const addNotify = useCallback(
    (type: ToastTone, message: string) =>
      toast[type](message, { id: `app-notify:${type}:${message}` }),
    [],
  );
  // Sidebar errors raised outside the sidebar store (project removal flow).
  const [sidebarActionError, setSidebarActionError] = useState<string | null>(null);
  const [queuedChatTurns, setQueuedChatTurns] = useState<ChatQueueItemSummary[]>([]);
  const [queuePausedState, setQueuePausedState] = useState<{
    conversationId: string;
    paused: boolean;
  } | null>(null);
  const [queueControlConversationId, setQueueControlConversationId] = useState("");
  const queueControlInFlightRef = useRef(false);
  const [, setChatQueueRevision] = useState(0);
  const [selectedHistoryId, setSelectedHistoryId] = useState(
    initialHomeConversation.selectedHistoryId,
  );
  const [selectedHistory, setSelectedHistory] = useState<HistoryDetail | null>(null);
  // Two-phase conversation open (openController): "opening" gates the
  // composer/transcript loading affordances; showOverlay drives the switch
  // overlay (appears only after ~150ms of still-loading).
  const [conversationOpenState, setConversationOpenState] = useState<ConversationOpenState>({
    conversationId: "",
    phase: "idle",
    showOverlay: false,
    errorCode: null,
  });
  // Explicit "load full history" request from the transcript header.
  const [fullHistoryLoading, setFullHistoryLoading] = useState(false);
  // Bumped whenever the command pipeline's pending set changes so busy state
  // re-derives.
  const [pendingCommandRevision, setPendingCommandRevision] = useState(0);
  const {
    settings,
    setSettings,
    settingsSyncReady,
    settingsSyncTargetReady,
    settingsSyncError,
    settingsSaveState,
  } = useGatewaySettingsSync({ token, api, activeAgentId: activeAgentScope });
  const deviceDraft = selection?.device_draft_workspace;
  const deviceDraftLease = deviceDraft ? selection?.selection_lease : undefined;
  const [failedDeviceDraft, setFailedDeviceDraft] = useState<string>();
  const attemptedDeviceDraftRef = useRef<string | undefined>(undefined);
  const deviceDraftContext = useRef({ api, lease: deviceDraftLease, system: settings.system });
  deviceDraftContext.current = { api, lease: deviceDraftLease, system: settings.system };
  const accountUserIdRef = useRef(accountUser?.id);
  accountUserIdRef.current = accountUser?.id;
  const [relayUserRecord, setRelayUser] = useState<RelayUser | null>(accountUser);
  const relayUser = relayUserRecord?.id === accountUser?.id ? relayUserRecord : accountUser;
  const [relayStatsRecord, setRelayStatsRecord] = useState<{
    ownerId: number;
    value: RelayDashboardStats;
  } | null>(null);
  const relayStats =
    relayStatsRecord && relayStatsRecord.ownerId === accountUser?.id
      ? relayStatsRecord.value
      : null;
  const acceptRelayUser = useCallback((user: RelayUser) => {
    if (user.id === accountUserIdRef.current) setRelayUser(user);
  }, []);
  const setRelayStats = useCallback(
    (value: RelayDashboardStats) => {
      const ownerId = accountUser?.id;
      if (ownerId && ownerId === accountUserIdRef.current) setRelayStatsRecord({ ownerId, value });
    },
    [accountUser?.id],
  );
  useEffect(() => {
    setRelayUser(accountUser);
  }, [accountUser]);
  const refreshRelayAccount = useCallback(async () => {
    const expectedUser = accountUserIdRef.current;
    const [profile, stats] = await Promise.all([getRelayProfile(), getRelayDashboardStats()]);
    if (!expectedUser || expectedUser !== accountUserIdRef.current || profile.id !== expectedUser)
      return;
    acceptRelayUser(profile);
    setRelayStats(stats);
  }, [acceptRelayUser, setRelayStats]);
  useEffect(() => {
    if (!accountUser) return;
    void refreshRelayAccount().catch(() => undefined);
  }, [accountUser, refreshRelayAccount]);
  const workspaceProjectRootClient = useMemo(
    () => (api ? createGatewayWorkspaceProjectRootClient(api) : undefined),
    [api],
  );
  const [workspaceRootRevision, setWorkspaceRootRevision] = useState(0);
  const handleWorkspaceDirectoriesMounted = useCallback(() => {
    setWorkspaceRootRevision((revision) => revision + 1);
  }, []);
  const effectiveTheme = resolveEffectiveTheme(settings.theme);
  const isAgentMode = settings.system.executionMode !== "text";
  const sidebar = useSidebar();
  const sidebarOpen = sidebar.isMobile ? sidebar.openMobile : sidebar.open;
  const setSidebarOpen = sidebar.isMobile ? sidebar.setOpenMobile : sidebar.setOpen;
  const {
    settingsOpen,
    overlay,
    openSettings,
    closeSettings,
    registerSettingsLeaveGuard,
    handleSettingsTransitionEnd,
    resetSettingsOverlay,
    settingsSection,
    settingsProviderId,
    modelPreferencesOpen,
    setModelPreferencesOpen,
  } = useGatewaySettingsOverlay(setSidebarOpen);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const initialRoute = useMemo(() => readCloudChatRoute(new URL(window.location.href)), []);
  const [browserNavigationVersion, setBrowserNavigationVersion] = useState(0);
  useEffect(() => {
    if (getDesktopRemoteHost()) return;
    const navigate = () => setBrowserNavigationVersion((version) => version + 1);
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);
  const {
    activeView,
    setActiveView: setActiveViewState,
    projectSettingsProject,
    setProjectSettingsProject,
  } = useApplicationViewState<WorkspaceProject>(
    getDesktopRemoteHost()?.initialView ??
      (initialRoute.page === "tasks" && initialRoute.deviceView ? "cron-hub" : "chat"),
  );
  const displayedConversationId = resolveVisibleConversationId(selectedHistoryId, conversationId);
  const workspaceOwner = JSON.stringify([accountUser?.id ?? "", activeAgentScope]);
  const dock = useConversationRightDock(workspaceOwner, displayedConversationId);
  const { rightDockOpen, setRightDockOpen, openToolTab, moveConversation, closeToolForPane } = dock;
  const selectedTaskDevice = selection?.runtime_kind === "device_agent" ? selection.device_id : "";
  const returnFromDeviceTasksRef = useRef<(requestedId?: string) => void>(() => {});
  const setActiveView = useCallback<typeof setActiveViewState>(
    (view) => {
      if (typeof view === "string" && view !== "cron-hub") returnFromDeviceTasksRef.current();
      setActiveViewState(view);
    },
    [setActiveViewState],
  );
  useEffect(() => {
    if (!selectedTaskDevice || getDesktopRemoteHost()) return;
    const restoreDeviceView = () => {
      const route = readCloudChatRoute(new URL(window.location.href));
      if (route.page === "tasks" && route.deviceView && route.target === selectedTaskDevice) {
        setActiveViewState("cron-hub");
      } else if (route.page === "chat" && route.deviceId === selectedTaskDevice) {
        setActiveViewState("chat");
      }
    };
    restoreDeviceView();
    window.addEventListener("popstate", restoreDeviceView);
    return () => window.removeEventListener("popstate", restoreDeviceView);
  }, [selectedTaskDevice, setActiveViewState]);
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();
  // Both elements arrive via callback refs → state so the scroll-follow hook
  // re-binds on element identity change and can never keep listeners on a
  // dead node.
  const [transcriptScrollAreaRoot, setTranscriptScrollAreaRoot] = useState<HTMLDivElement | null>(
    null,
  );
  const [transcriptViewport, setTranscriptViewport] = useState<HTMLDivElement | null>(null);
  const transcriptStageRef = useRef<HTMLElement | null>(null);
  const { handle: transcriptFollow, following: transcriptFollowing } = useScrollFollow({
    viewport: transcriptViewport,
    listenerRoot: transcriptScrollAreaRoot,
    trackKeys: true,
    // 回贴区为 0：只有真正到达底部（8px 容差内）才恢复跟随。默认的 192px
    // 回贴区会在滚轮下行进入该区间的那一 tick 直接 pin 到底，读者看到的是
    // 正文突然上跳一段（复现页实测单 tick 231px），即"磁吸"。到达底部后向下
    // 滚轮、手势落底、指针在底部释放三种路径仍会重新贴底。
    config: { reattachZonePx: 0 },
  });
  // 楼层导航：当前楼层由转写区上报，跳转经 navRef 直达虚拟列表；粘底跟随
  // 激活时程序化滚动会被立即拽回底部——跳转前先按「跳入历史」语义解除跟随。
  const transcriptNavRef = useRef<GatewayTranscriptNavHandle | null>(null);
  const [activeFloorKey, setActiveFloorKey] = useState<string | null>(null);
  const handleFloorJump = useCallback(
    (rowKey: string) => {
      transcriptFollow.breakFollow();
      transcriptNavRef.current?.scrollToRowKey(rowKey);
    },
    [transcriptFollow],
  );
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const composerDraftCacheRef = useRef<Map<string, MentionComposerDraft>>(new Map());
  // 草稿 id → 真实会话 id。Pane 宿主草稿 effect 的 cleanup 闭包捕获的是旧
  // conversationId:draft→real 原位重绑时 cleanup 在 rename 之后才执行,
  // 若直接写 draft key 会落进永远读不到的孤儿条目,宿主新 effect 随即
  // clear() 掉用户正在输入的内容。读写统一经本映射改写到真实 id。
  const boundComposerDraftIdsRef = useRef<Map<string, string>>(new Map());
  const resolveComposerDraftKey = useCallback((conversationId: string) => {
    return boundComposerDraftIdsRef.current.get(conversationId) ?? conversationId;
  }, []);
  const composerDraftOwnerRef = useRef("");
  const [paneDraftRegistry] = useState(createGatewayDevicePaneDraftRegistry);
  const deviceDraftScopeRef = useRef<GatewayDeviceDraftScope | undefined>(undefined);
  const recoveredLocalDraftScopeRef = useRef("");
  const activeDeviceDraftOwnersRef = useRef(new Map<string, string>());
  const restoredDeviceDraftFocusRef = useRef("");
  const [savedDeviceDraft, setSavedDeviceDraft] = useState<{
    scopeKey: string;
    state: GatewaySavedDeviceDraftState;
    path?: string;
  }>();
  const [retrySavedDeviceDraftKey, setRetrySavedDeviceDraftKey] = useState("");
  const draftPersistenceRetiredOwnerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!accountUser?.id) draftPersistenceRetiredOwnerRef.current = undefined;
  }, [accountUser?.id]);
  const conversationIdRef = useRef(conversationId);
  const selectedHistoryIdRef = useRef(selectedHistoryId);
  const statusRef = useRef<AgentStatus | null>(status);
  const queuedChatTurnsRef = useRef<ChatQueueItemSummary[]>([]);
  const chatQueueConversationIdRef = useRef("");
  const chatQueueRevisionRef = useRef(0);
  const queuedChatEditSessionRef = useRef<QueuedEditSession | null>(null);
  const queuedChatEditPendingRef = useRef(false);
  const selectedHistoryRef = useRef(selectedHistory);
  // Per-conversation runtime workdir (drafts have no persisted summary yet).
  const conversationWorkdirsRef = useRef<Map<string, string>>(new Map());
  // Lazy history windows: per conversation, the persisted-message edge the
  // loaded transcript starts at (see lib/chat/historyWindow.ts). Entries are
  // (re)established by every applied history fetch and dropped with the
  // conversation's other per-id resources.
  const historyWindowStatesRef = useRef<Map<string, HistoryWindowState>>(new Map());
  const displayedConversationWorkdirRef = useRef("");
  const pendingUploadContextRef = useRef<{
    conversationId: string;
    workdir: string;
    executionMode: string;
  } | null>(null);
  const displayedConversationBusyRef = useRef(false);
  const historyLoadSequenceRef = useRef(0);
  const historyOpenAttemptRef = useRef<GatewayHistoryOpenAttempt | undefined>(undefined);
  const restoredConversationAgentRef = useRef("");
  const restoringConversationRef = useRef<{
    ownerId: number;
    agentId: string;
    conversationId: string;
  } | null>(null);
  const visibleConversationRevisionRef = useRef(0);
  const previousDisplayedConversationIdRef = useRef("");
  const pendingDisplayedConversationAutoBottomRef = useRef<string | null>(null);
  const protectedConversationRef = useRef(PROTECTED_DRAFT_CONVERSATION);
  const submitInFlightRef = useRef(false);
  // clientRequestId → draft conversation id, until the command binds.
  const draftClientRequestsRef = useRef<Map<string, string>>(new Map());
  const sendChatRef = useRef<SendChatFn | null>(null);
  const isImportingPastedTextRef = useRef(false);
  const resetProjectToolsRuntimeRef = useRef<() => void>(() => undefined);

  const resetToFreshHomeConversation = useCallback(() => {
    const next = createGatewayHomeConversationState();
    conversationIdRef.current = next.conversationId;
    selectedHistoryIdRef.current = next.selectedHistoryId;
    selectedHistoryRef.current = null;
    protectedConversationRef.current = PROTECTED_DRAFT_CONVERSATION;
    setConversationId(next.conversationId);
    setSelectedHistoryId(next.selectedHistoryId);
    setSelectedHistory(null);
    setChatError(null);
  }, []);

  // --- Chat streaming infrastructure (Phase 4) -----------------------------
  // Transcript stores (one per conversation), the global activity map, and
  // the command pipeline replace the old live-store registry, running-id
  // unions, and recovery machinery.
  // Ref indirection: the registry memo is stable across token changes while
  // the api client is not, and divergence resyncs must reach the live client.
  const apiRef = useRef(api);
  apiRef.current = api;
  // Failure text is resolved when the failure arrives, in the current locale.
  const localeRef = useRef(settings.locale);
  localeRef.current = settings.locale;
  const describeFailure = useCallback(
    (errorCode: string | null | undefined, message: string) =>
      describeChatRunFailure(errorCode, message, (key) => translate(key, localeRef.current)),
    [],
  );
  const transcriptStoreRegistry = useMemo(
    () =>
      createTranscriptStoreRegistry({
        onDivergence: (divergedConversationId) =>
          apiRef.current?.resyncConversation(divergedConversationId),
        describeRunFailure: describeFailure,
      }),
    [describeFailure],
  );
  const activityStore = useMemo(() => createActivityStore(), []);
  const pipelineOnBoundRef = useRef<
    (update: ChatCommandUpdate, pending: PendingChatCommand) => void
  >(() => undefined);
  const pipelineOnQueuedInGuiRef = useRef<
    (update: ChatCommandUpdate, pending: PendingChatCommand) => void
  >(() => undefined);
  const pipelineOnFailedRef = useRef<
    (pending: PendingChatCommand, errorCode: string | null, message: string) => void
  >(() => undefined);
  const chatCommandPipeline = useMemo(
    () =>
      new ChatCommandPipeline({
        getTranscriptStore: (targetConversationId) =>
          transcriptStoreRegistry.get(targetConversationId),
        onBound: (update, pending) => pipelineOnBoundRef.current(update, pending),
        onQueuedInGui: (update, pending) => pipelineOnQueuedInGuiRef.current(update, pending),
        onFailed: (pending, errorCode, message) =>
          pipelineOnFailedRef.current(pending, errorCode, message),
        onPendingChanged: () => setPendingCommandRevision((current) => current + 1),
        describeFailure,
      }),
    [describeFailure, transcriptStoreRegistry],
  );

  // --- Sidebar state layer --------------------------------------------------
  // One external store owns the whole sidebar domain (list, workdirs, running
  // set, per-row mutations); GatewayApp only creates it, feeds it the scope,
  // and makes imperative peek/upsertLocal/removeLocal calls. All rendering
  // subscriptions live in <GatewaySidebarContainer/>.
  const getSidebarProtectedConversationIds = useCallback(() => {
    // Authoritative reconciles keep only these ids when the server list omits
    // them: in-flight commands, the protected (displayed) conversation, and
    // running conversations. Never a blanket retain-all — that resurrects
    // deletions made by other clients while this one was offline.
    const ids = new Set<string>(chatCommandPipeline.pendingConversationIds());
    const protectedId = protectedConversationRef.current.trim();
    if (protectedId && protectedId !== PROTECTED_DRAFT_CONVERSATION) {
      ids.add(protectedId);
    }
    for (const id of activityStore.getSnapshot().activities.keys()) {
      ids.add(id);
    }
    return ids;
  }, [activityStore, chatCommandPipeline]);
  const getActivityKeepConversationIds = useCallback(
    () => chatCommandPipeline.pendingConversationIds(),
    [chatCommandPipeline],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Agent ID 是侧边栏 Store 的数据隔离边界。
  const sidebarStore = useMemo(
    () =>
      createSidebarStore(
        api
          ? createWebSidebarBackend({
              api,
              activityStore,
              getProtectedConversationIds: getSidebarProtectedConversationIds,
              getActivityKeepConversationIds,
            })
          : createIdleSidebarBackend(),
        { pageSize: HISTORY_LIST_PAGE_SIZE },
      ),
    [
      activeAgentScope,
      activityStore,
      api,
      getActivityKeepConversationIds,
      getSidebarProtectedConversationIds,
    ],
  );
  useEffect(() => {
    if (!api) {
      return;
    }
    sidebarStore.start();
    return () => {
      sidebarStore.stop();
    };
  }, [api, sidebarStore]);

  // 思考档位运行期补充（models.dev）：启动后台拉一次，TTL 内幂等；失败静默，
  // 档位解析维持在「快照 + 兜底」的现状。models.dev 带 ACAO:*，浏览器直连可达，
  // 无需经 gateway 代理。
  useEffect(() => {
    void loadThinkingLiveSupplement();
  }, []);

  // Narrow app-root subscriptions: workdirs (rare commits — project merge
  // inputs) and the byId index (list commits only; never running/idle ticks).
  const sidebarWorkdirs = useSidebarSelector(sidebarStore, (snapshot) => snapshot.workdirs);
  const sidebarConversationsById = useSidebarSelector(sidebarStore, (snapshot) => snapshot.byId);
  const mentionableConversations = useMemo(
    () =>
      [...sidebarConversationsById.values()]
        .filter((item) => !item.isPending)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ id, title, cwd, updatedAt, messageCount }) => ({
          id,
          title,
          cwd,
          updatedAt,
          messageCount,
        })),
    [sidebarConversationsById],
  );
  const {
    handleCloseShareModal,
    handleDisableSharedHistory,
    handleLoadSharedHistoryStatus,
    handleOpenShareModal,
    handleOpenSharedHistoryManager,
    handleRefreshSharedHistoryStatuses,
    handleSetShareRedactToolContent,
    handleSetSharedHistoryRedactToolContent,
    handleToggleHistoryShare,
    removeSharedHistoryItems,
    resetSharedHistory,
    setSharedManagerOpen,
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
  } = useGatewaySharedHistory({ api, gatewayConnectionLost, sidebarStore, status });

  const startNewConversationRef = useRef<
    (options?: { workdir?: string; preserveCurrentComposerDraft?: boolean }) => string
  >(() => "");
  const {
    activateWorkspaceProject,
    activateConversationWorkspace,
    activateSearchConversationWorkspace,
    clearSearchConversationWorkspace,
    searchConversationWorkdir,
    activeWorkspaceProject,
    activeWorkspaceProjectPath,
    archivedWorkspaceProjectPathKeys,
    handleBrowseWorkspaceProjectInFileTree,
    handleCancelWorkspaceCloneTask,
    handleCloneWorkspaceProject,
    handleCommitWorkspaceProjectRename,
    handleCreateWorkspaceGroup,
    handleDeleteWorkspaceGroup,
    handleDismissWorkspaceCloneTask,
    handleLoadWorkspaceRemoteBranches,
    handleMoveWorkspaceProjectToGroup,
    handleNewConversationForProject,
    handleOpenClonedWorkspace,
    handleOpenCreateWorkspaceProject,
    handleOpenWorkspaceFolder,
    handleOpenWorktree,
    handleRenameWorkspaceGroup,
    handleSelectWorkspaceProject,
    handleSetWorkspaceProjectPinned,
    handleSidebarProjectsCollapsedChange,
    handleSidebarRecentCollapsedChange,
    handleToggleWorkspaceGroupCollapsed,
    handleWorkdirPickerSelect,
    missingWorkspaceProjectPathKeys,
    projectPickerOpen,
    setActiveWorkspaceProjectId,
    setProjectPickerOpen,
    setWorkspaceCreateModalOpen,
    workspaceCloneTasks,
    workspaceCreateModalOpen,
    workspaceProjects,
  } = useGatewayWorkspaceProjects({
    api,
    displayedConversationWorkdirRef,
    setActiveView,
    setRightDockOpen,
    openDockToolTab: openToolTab,
    setSettings,
    setSidebarOpen,
    settings,
    sidebarStore,
    sidebarWorkdirs,
    startNewConversationRef,
  });

  // Conversation-open controller: the web end paints the conversation's whole
  // established history window in the single open phase — messages above the
  // window edge stay unfetched until the user pages up. Deps go through refs
  // (assigned per render) so the controller instance stays stable.
  const openInitialRef = useRef<
    (id: string, request?: ConversationOpenRequest) => Promise<"cache-hit" | "painted">
  >(() => Promise.resolve("painted"));
  const openController = useMemo(
    () =>
      createConversationOpenController({
        openInitial: (id, request) => openInitialRef.current(id, request),
        onStateChange: (state) => {
          if (state.phase === "idle" || state.phase === "ready")
            historyOpenAttemptRef.current = undefined;
          setConversationOpenState(state);
        },
      }),
    [],
  );

  const resolveActiveAgentID = useCallback(async () => {
    const currentApi = apiRef.current;
    if (!currentApi) {
      throw new Error("Gateway 尚未连接。");
    }
    let agentID = currentApi.getActiveAgent().trim();
    if (!agentID) {
      await currentApi.listAgents();
      agentID = currentApi.getActiveAgent().trim();
    }
    if (!agentID) {
      throw new Error("没有可用的 Agent。");
    }
    return agentID;
  }, []);

  const { workspaceFolderDropActive, workspaceFolderDropHandlers, mountDroppedDirectories } =
    useDirectoryDropActions({
      token,
      historyShareToken,
      locale: settings.locale,
      resolveAgentID: resolveActiveAgentID,
      addNotify,
      activeWorkspaceProject,
      workspaceProjectRootClient,
      onWorkspaceCreated: handleWorkdirPickerSelect,
      onWorkspaceDirectoriesMounted: handleWorkspaceDirectoriesMounted,
    });

  // 无会话兜底：等价于点一次“新对话”，返回新草稿会话 id 供上传立即挂靠。
  const ensureUploadConversation = useCallback(() => startNewConversationRef.current(), []);
  const workdirForConversation = useCallback(
    (targetConversationId: string) => {
      const targetId = targetConversationId.trim();
      const displayedId = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      );
      return resolveConversationUploadWorkdir({
        targetConversationId: targetId,
        displayedConversationId: displayedId,
        persistedWorkdir: sidebarStore.peek(targetId)?.cwd,
        runtimeWorkdir: conversationWorkdirsRef.current.get(targetId),
        isAgentMode,
        activeWorkspacePath: activeWorkspaceProjectPath,
        defaultWorkdir: settings.system.workdir,
      });
    },
    [activeWorkspaceProjectPath, isAgentMode, settings.system.workdir, sidebarStore],
  );

  const {
    pendingUploadedFiles,
    isUploadingFiles,
    uploadingConversationId,
    isFileDropActive,
    fileInputRef,
    folderInputRef,
    setUploadingFiles,
    getPendingUploadsForConversation,
    subscribePendingUploads,
    setPendingUploadsForConversation,
    updatePendingUploadsForConversation,
    moveConversationUploads,
    clearPendingUploads,
    handleImportReadableFiles,
    handleImportSelectedDirectoryFiles,
    handleFileDragEnter,
    handleFileDragOver: handlePendingFileDragOver,
    handleFileDragLeave,
    handleFileDrop: handlePendingFileDrop,
  } = usePendingUploads({
    token,
    workspaceOwner,
    resolveAgentID: resolveActiveAgentID,
    historyShareToken,
    settingsSyncReady,
    settingsOpen,
    activeView,
    locale: settings.locale,
    executionMode: settings.system.executionMode,
    conversationId,
    selectedHistoryId,
    displayedConversationWorkdirRef,
    composerRef,
    addNotify,
    onDropDirectories: mountDroppedDirectories,
    ensureUploadConversation,
    workdirForConversation,
  });

  const applyChatQueueSnapshot = useCallback((snapshot: ChatQueueSnapshot | null | undefined) => {
    if (!snapshot) return;
    const visibleConversationId = resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    );
    if (snapshot.conversationId !== visibleConversationId) {
      return;
    }
    const revision = Number(snapshot.revision ?? 0);
    const isSameQueueConversation = snapshot.conversationId === chatQueueConversationIdRef.current;
    if (isSameQueueConversation && revision < chatQueueRevisionRef.current) {
      return;
    }
    chatQueueConversationIdRef.current = snapshot.conversationId;
    chatQueueRevisionRef.current = revision;
    queuedChatTurnsRef.current = snapshot.items.slice();
    setChatQueueRevision(revision);
    setQueuedChatTurns(snapshot.items.slice());
    setQueuePausedState(
      typeof snapshot.paused === "boolean"
        ? { conversationId: snapshot.conversationId, paused: snapshot.paused }
        : null,
    );
  }, []);

  const handleQueuePausedChange = useCallback(
    async (paused: boolean) => {
      const target = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      );
      if (
        !api ||
        !target ||
        queueControlInFlightRef.current ||
        chatQueueConversationIdRef.current !== target
      )
        return;
      const revision = chatQueueRevisionRef.current;
      queueControlInFlightRef.current = true;
      setQueueControlConversationId(target);
      try {
        const response = await api.chatQueueSetPaused(target, paused, revision);
        applyChatQueueSnapshot(response.snapshot);
        if (!response.accepted)
          throw new Error(
            response.message || translate("chat.queue.controlFailed", settings.locale),
          );
      } catch (error) {
        if (
          resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current) ===
          target
        ) {
          setChatError(
            asErrorMessage(error, translate("chat.queue.controlFailed", settings.locale)),
          );
        }
        // A dropped acknowledgement does not imply that the mutation failed.
        void api
          .chatQueueGet(target)
          .then((response) => applyChatQueueSnapshot(response.snapshot))
          .catch(() => undefined);
      } finally {
        queueControlInFlightRef.current = false;
        setQueueControlConversationId("");
      }
    },
    [api, applyChatQueueSnapshot, settings.locale],
  );

  useEffect(() => {
    if (!api) return;
    return api.subscribeChatQueue((snapshot) => {
      applyChatQueueSnapshot(snapshot);
    });
  }, [api, applyChatQueueSnapshot]);

  // AskUserQuestion 卡片的应答出口：经网关 chat_queue.tool_answer 送达桌面端
  // 的工具挂起表；桌面端 resolve 后照常以 tool_result 事件流回本端。
  useEffect(() => {
    if (!api) {
      registerAskUserQuestionAnswerHandler(null);
      return;
    }
    registerAskUserQuestionAnswerHandler(async (toolCallId, answers) => {
      const conversationIdValue = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      ).trim();
      if (!conversationIdValue) {
        return { ok: false, message: "No active conversation." };
      }
      try {
        const response = await api.chatQueueToolAnswer(
          conversationIdValue,
          toolCallId,
          JSON.stringify(answers),
        );
        return { ok: response.accepted, message: response.message || undefined };
      } catch (error) {
        return { ok: false, message: asErrorMessage(error, "Failed to submit the answer.") };
      }
    });
    return () => registerAskUserQuestionAnswerHandler(null);
  }, [api]);

  // MCP elicitation forms: answers go through gateway chat_queue.mcp_elicitation. A refused
  // answer (400) comes back with per-field messages and the form stays open; the resolution
  // itself streams back as a tool_call update like every other card.
  useEffect(() => {
    if (!api) {
      registerMcpElicitationAnswerHandler(null);
      return;
    }
    registerMcpElicitationAnswerHandler(async (toolCallId, elicitationId, action, content) => {
      const conversationIdValue = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      ).trim();
      if (!conversationIdValue) {
        return { ok: false, message: "No active conversation." };
      }
      try {
        const response = await api.chatQueueMcpElicitation(
          conversationIdValue,
          toolCallId,
          buildMcpElicitationRequestJson(elicitationId, action, content),
        );
        if (response.accepted) return { ok: true };
        const fieldErrors = readMcpElicitationFieldErrors(response.itemJson);
        return {
          ok: false,
          message: response.message || undefined,
          ...(fieldErrors ? { fieldErrors } : {}),
        };
      } catch (error) {
        return { ok: false, message: asErrorMessage(error, "Failed to submit the answer.") };
      }
    });
    return () => registerMcpElicitationAnswerHandler(null);
  }, [api]);

  // 工具审批卡片的决定出口：经网关 chat_queue.tool_approval 送达桌面端审批挂起表;
  // 桌面端据此放行/拒绝该工具,结果照常以 tool_result 事件流回本端。
  useEffect(() => {
    if (!api) {
      registerToolApprovalDecisionHandler(null);
      return;
    }
    registerToolApprovalDecisionHandler(
      async (toolCallId, decision, targetConversationId, options) => {
        // 背景 Pane 显式携带自己的会话 id;主视图缺省仍按当前展示会话路由。
        const conversationIdValue = (
          targetConversationId?.trim() ||
          resolveVisibleConversationId(selectedHistoryIdRef.current, conversationIdRef.current)
        ).trim();
        if (!conversationIdValue) {
          return { ok: false, message: "No active conversation." };
        }
        try {
          const response = await api.chatQueueToolApproval(
            conversationIdValue,
            toolCallId,
            buildToolApprovalRequestJson(decision, options),
          );
          return { ok: response.accepted, message: response.message || undefined };
        } catch (error) {
          return { ok: false, message: asErrorMessage(error, "Failed to submit the decision.") };
        }
      },
    );
    return () => registerToolApprovalDecisionHandler(null);
  }, [api]);

  // 计划卡片的决定出口：经网关 chat_queue.plan_decision 送达桌面端计划挂起表;
  // 桌面端据此批准/退回计划,结果照常以 tool_result 事件流回本端。
  useEffect(() => {
    if (!api) {
      registerPlanDecisionHandler(null);
      return;
    }
    registerPlanDecisionHandler(async (toolCallId, answer) => {
      const conversationIdValue = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      ).trim();
      if (!conversationIdValue) {
        return { ok: false, message: "No active conversation." };
      }
      try {
        const response = await api.chatQueuePlanDecision(
          conversationIdValue,
          toolCallId,
          JSON.stringify(answer),
        );
        return {
          ok: response.accepted,
          message: response.message || undefined,
          errorCode: response.errorCode || undefined,
        };
      } catch (error) {
        return { ok: false, message: asErrorMessage(error, "Failed to submit the decision.") };
      }
    });
    return () => registerPlanDecisionHandler(null);
  }, [api]);

  const {
    applyLiveConversationTitle,
    cacheVisibleComposerDraft,
    clearCachedComposerDraft,
    getDisplayedConversationId,
    getVisibleComposerConversationId,
    isConversationBusy,
    isDisplayedConversation,
    loadComposerHistoryPrompts,
    prepareComposerForConversationChange,
    restoreCachedComposerDraft,
  } = useGatewayConversationState({
    activeWorkspaceProjectPath,
    activityStore,
    chatCommandPipeline,
    composerDraftCacheRef,
    composerDraftOwnerRef,
    composerRef,
    conversationId,
    conversationIdRef,
    conversationWorkdirsRef,
    getPendingUploadsForConversation,
    isAgentMode,
    isLocalDraftConversationId,
    selectedHistory,
    selectedHistoryId,
    selectedHistoryIdRef,
    selectedHistoryRef,
    sidebarStore,
    status,
    statusRef,
    transcriptStoreRegistry,
  });

  // Keep an empty draft conversation's workdir following the active project.
  useEffect(() => {
    const nextWorkdir = activeWorkspaceProjectPath.trim();
    if (!isAgentMode || !nextWorkdir) return;
    const conversationIdValue = resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    ).trim();
    if (!conversationIdValue || !isLocalDraftConversationId(conversationIdValue)) return;
    if (isConversationBusy(conversationIdValue)) return;
    if (
      (transcriptStoreRegistry.peek(conversationIdValue)?.getSnapshot().entryCount ?? 0) > 0 ||
      getPendingUploadsForConversation(conversationIdValue).length > 0
    ) {
      return;
    }
    conversationWorkdirsRef.current.set(conversationIdValue, nextWorkdir);
  }, [
    activeWorkspaceProjectPath,
    getPendingUploadsForConversation,
    isAgentMode,
    isConversationBusy,
    transcriptStoreRegistry,
  ]);

  const refreshDisplayedConversationHistorySnapshot = useMemo(
    () =>
      createRefreshDisplayedConversationHistorySnapshot({
        api,
        conversationIdRef,
        historyWindowStatesRef,
        isConversationBusy,
        isLocalDraftConversationId,
        selectedHistoryIdRef,
        selectedHistoryRef,
        setSelectedHistory,
        transcriptStoreRegistry,
      }),
    [api, isConversationBusy, transcriptStoreRegistry],
  );

  const markVisibleConversationRevision = useCallback(() => {
    visibleConversationRevisionRef.current += 1;
    return visibleConversationRevisionRef.current;
  }, []);

  const invalidateHistoryLoad = useCallback(() => {
    historyLoadSequenceRef.current += 1;
    return historyLoadSequenceRef.current;
  }, []);

  // Session Workbench：草稿转正时把承载草稿的 Pane 原位重绑到真实会话 id，
  // 与 setConversationId 同批提交——聚焦 Pane 不会闪现只读预览，DOM 不重挂载。
  // workbenchController 在下方创建后回填本 ref。
  const workbenchRenameConversationRef = useRef<(fromId: string, toId: string) => void>(() => {});
  const workbenchClearRef = useRef<() => void>(() => {});

  // A draft conversation got its real id (authoritative `command_update
  // bound`): re-key every draft-scoped resource onto the real conversation.
  const bindDraftConversation = useCallback(
    (previousConversationId: string, nextConversationId: string) => {
      const previousId = previousConversationId.trim();
      const nextId = nextConversationId.trim();
      if (!previousId || !nextId || previousId === nextId) {
        return;
      }
      const scope = deviceDraftScopeRef.current;
      if (scope) clearGatewayDeviceDraft(scope, { kind: "local", id: previousId });

      transcriptStoreRegistry.move(previousId, nextId);
      moveCommandRecovery(previousId, nextId);
      workbenchRenameConversationRef.current(previousId, nextId);

      const windowState = historyWindowStatesRef.current.get(previousId);
      if (windowState !== undefined) {
        historyWindowStatesRef.current.delete(previousId);
        historyWindowStatesRef.current.set(nextId, windowState);
      }

      const workdir = conversationWorkdirsRef.current.get(previousId);
      if (workdir !== undefined) {
        conversationWorkdirsRef.current.delete(previousId);
        conversationWorkdirsRef.current.set(nextId, workdir);
      }

      // 先登记改写映射再搬缓存:宿主草稿 effect 的 cleanup 会在 rename 提交
      // 后仍以旧 id 写回,经映射落到真实 id 上,不产生孤儿条目。
      for (const [draftId, boundId] of boundComposerDraftIdsRef.current) {
        if (boundId === previousId) boundComposerDraftIdsRef.current.set(draftId, nextId);
      }
      boundComposerDraftIdsRef.current.set(previousId, nextId);
      const cachedComposerDraft = composerDraftCacheRef.current.get(previousId);
      if (cachedComposerDraft) {
        composerDraftCacheRef.current.delete(previousId);
        composerDraftCacheRef.current.set(nextId, cachedComposerDraft);
      }
      if (composerDraftOwnerRef.current === previousId) {
        composerDraftOwnerRef.current = nextId;
      }
      moveConversationUploads(previousId, nextId);
      moveConversation(previousId, nextId);
      if (chatQueueConversationIdRef.current === previousId) {
        chatQueueConversationIdRef.current = nextId;
      }

      if (conversationIdRef.current === previousId) {
        conversationIdRef.current = nextId;
        setConversationId(nextId);
      }
      if (selectedHistoryIdRef.current === previousId) {
        selectedHistoryIdRef.current = nextId;
        setSelectedHistoryId(nextId);
      }
      if (protectedConversationRef.current.trim() === previousId) {
        protectedConversationRef.current = nextId;
      }

      // Re-key the sidebar row: drop the draft row, merge its fields under
      // the real id. The row stays pending until a server upsert confirms it.
      const draftRow = sidebarStore.peek(previousId);
      sidebarStore.removeLocal(previousId);
      if (draftRow) {
        const existingNext = sidebarStore.peek(nextId);
        sidebarStore.upsertLocal({
          id: nextId,
          title: existingNext?.title?.trim() || draftRow.title,
          providerId: existingNext?.providerId || draftRow.providerId,
          model: existingNext?.model || draftRow.model,
          sessionId: existingNext?.sessionId || draftRow.sessionId,
          cwd: existingNext?.cwd || draftRow.cwd,
          messageCount: existingNext?.messageCount ?? draftRow.messageCount,
          createdAt: existingNext?.createdAt ?? draftRow.createdAt,
          updatedAt: existingNext?.updatedAt ?? draftRow.updatedAt,
          isPinned: existingNext?.isPinned ?? draftRow.isPinned,
          pinnedAt: existingNext ? existingNext.pinnedAt : draftRow.pinnedAt,
          isShared: existingNext?.isShared ?? draftRow.isShared,
          selectedModelJson: existingNext?.selectedModelJson || draftRow.selectedModelJson,
          isPending: existingNext && existingNext.isPending !== true ? undefined : true,
        });
      }
      // Re-key the local model override so the pick made on the draft keeps
      // applying to the bound conversation.
      setConversationModelOverrides((prev) => {
        const override = prev.get(previousId);
        if (!override) return prev;
        const next = new Map(prev);
        next.delete(previousId);
        if (!next.has(nextId)) next.set(nextId, override);
        return next;
      });
    },
    [moveConversation, moveConversationUploads, sidebarStore, transcriptStoreRegistry],
  );

  const ensureTunnelToolTab = useCallback(
    (projectPathKey: string | undefined, conversationId: string) => {
      const targetProjectPathKey =
        workspaceProjectPathKey(projectPathKey) ||
        workspaceProjectPathKey(conversationWorkdirsRef.current.get(conversationId)) ||
        workspaceProjectPathKey(sidebarStore.peek(conversationId)?.cwd);
      if (!targetProjectPathKey) return;
      openToolTab(targetProjectPathKey, "tunnel", conversationId);
    },
    [openToolTab, sidebarStore],
  );

  // Tunnel list refreshes arrive through the tunnel.state push; the chat
  // event only opens the tunnel tool tab when the agent creates a tunnel.
  const handleTunnelManagerChatEvent = useCallback(
    (event: ChatEvent, conversationId: string) => {
      const change = readTunnelManagerToolChange(event);
      if (!change) return;
      if (change.action === "create") {
        ensureTunnelToolTab(change.projectPathKey, conversationId);
      }
    },
    [ensureTunnelToolTab],
  );

  useGatewayTransportStatus({
    activityStore,
    api,
    chatCommandPipeline,
    setGatewayConnectionLost,
    setSidebarAgentStatusFresh,
    setStatus,
    setStatusError,
    statusRef,
  });

  const refreshChatQueueSnapshot = useCallback(
    (targetConversationId: string, currentApi = api) => {
      const conversationIdValue = targetConversationId.trim();
      if (!currentApi || !conversationIdValue) {
        return;
      }
      void currentApi
        .chatQueueGet(conversationIdValue)
        .then((response) => applyChatQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyChatQueueSnapshot],
  );

  // Command pipeline hooks (assigned per render so they see fresh closures).
  pipelineOnBoundRef.current = (update, pending) => {
    const draftId = draftClientRequestsRef.current.get(pending.clientRequestId)?.trim() ?? "";
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    const realId = update.conversationId?.trim() ?? "";
    if (draftId && realId && draftId !== realId) {
      bindDraftConversation(draftId, realId);
    }
  };
  pipelineOnQueuedInGuiRef.current = (update, pending) => {
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    refreshChatQueueSnapshot(update.conversationId?.trim() || pending.conversationId);
    if (pending.isEditResend) {
      // The seeded `rebased` already truncated committed optimistically, but
      // the command was parked — server-side history is unchanged; a quiet
      // window refresh restores the truncated suffix (the edit anchor always
      // sits inside the loaded window, so the window covers the whole cut).
      void refreshDisplayedConversationHistorySnapshot(
        update.conversationId?.trim() || pending.conversationId,
        api,
      );
    }
  };
  pipelineOnFailedRef.current = (pending, _errorCode, message) => {
    draftClientRequestsRef.current.delete(pending.clientRequestId);
    const conversationIdValue = pending.conversationId.trim();
    if (pending.isEditResend) {
      void refreshDisplayedConversationHistorySnapshot(conversationIdValue, api);
    }
    if (isLocalDraftConversationId(conversationIdValue)) {
      // The draft never materialized: drop its optimistic sidebar row. The
      // transcript keeps the pipeline's error entry.
      sidebarStore.removeLocal(conversationIdValue);
    }
    if (!pending.waitForStart && isDisplayedConversation(conversationIdValue)) {
      setChatError(message);
    }
  };

  // THE transcript source: the displayed conversation's store snapshot plus a
  // persistent stream subscription (subscribed whenever the id is real —
  // regardless of running state, which is what makes GUI queue auto-sends
  // race-free: the next run's events simply flow in).
  const mobileNavigationStackRef = useRef<Array<{ projectId: string; conversationId: string }>>([]);
  const previousMobileNavigationRef = useRef<{ projectId: string; conversationId: string } | null>(
    null,
  );
  const restoringMobileNavigationRef = useRef<{ projectId: string; conversationId: string } | null>(
    null,
  );
  useEffect(() => {
    const next = {
      projectId: activeWorkspaceProject?.id ?? "",
      conversationId: displayedConversationId.trim(),
    };
    const previous = previousMobileNavigationRef.current;
    previousMobileNavigationRef.current = next;
    if (!isEmbeddedMobileRuntime()) return;
    const restoring = restoringMobileNavigationRef.current;
    if (restoring) {
      if (
        restoring.projectId === next.projectId &&
        restoring.conversationId === next.conversationId
      ) {
        restoringMobileNavigationRef.current = null;
      }
      return;
    }
    if (
      !previous ||
      (previous.projectId === next.projectId && previous.conversationId === next.conversationId)
    ) {
      return;
    }
    const stack = mobileNavigationStackRef.current;
    const last = stack.at(-1);
    if (last?.projectId !== previous.projectId || last.conversationId !== previous.conversationId) {
      stack.push(previous);
      if (stack.length > 50) stack.splice(0, stack.length - 50);
    }
  }, [activeWorkspaceProject?.id, displayedConversationId]);

  const terminalConversationId = displayedConversationId.trim();
  const terminalActivity = terminalConversationId
    ? activityStore.get(terminalConversationId)
    : null;
  const terminalActiveRun = terminalConversationId
    ? transcriptStoreRegistry.peek(terminalConversationId)?.getSnapshot().activeRun
    : null;
  const terminalRunId = terminalActivity?.runId?.trim() || terminalActiveRun?.runId?.trim() || "";
  const terminalIdentity = useMemo(() => {
    if (
      !terminalConversationId ||
      isLocalDraftConversationId(terminalConversationId) ||
      !terminalRunId
    ) {
      return null;
    }
    return { conversationId: terminalConversationId, runId: terminalRunId };
  }, [terminalConversationId, terminalRunId]);
  terminalIdentityRef.current = terminalIdentity;

  // 会话生效模型：本地 override > sidebar 行携带的持久化选择 > 全局默认。
  const selectionForConversation = useCallback(
    (targetConversationId: string) =>
      resolveActiveModelSelection({
        settings,
        override: conversationModelOverrides.get(targetConversationId),
        persistedSelectedModelJson: sidebarStore.peek(targetConversationId)?.selectedModelJson,
      }),
    [conversationModelOverrides, settings, sidebarStore],
  );
  const activeSelectedModel = useMemo(
    () =>
      resolveActiveModelSelection({
        settings,
        override: conversationModelOverrides.get(displayedConversationId),
        persistedSelectedModelJson:
          sidebarConversationsById.get(displayedConversationId)?.selectedModelJson,
      }),
    [conversationModelOverrides, displayedConversationId, settings, sidebarConversationsById],
  );
  // override 的持久化回声（本会话 selected_model 落库后随 history-sync 回流）
  // 到达即清理，会话从此走服务器权威值。
  useEffect(() => {
    if (conversationModelOverrides.size === 0) return;
    let changed = false;
    const next = new Map(conversationModelOverrides);
    for (const [id, override] of conversationModelOverrides) {
      const persisted = parseSelectedModelJson(sidebarConversationsById.get(id)?.selectedModelJson);
      if (
        persisted &&
        persisted.customProviderId === override.customProviderId &&
        persisted.model === override.model &&
        (override.thinkingEnabled === undefined ||
          persisted.thinkingEnabled === override.thinkingEnabled) &&
        (override.reasoning === undefined || persisted.reasoning === override.reasoning)
      ) {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) setConversationModelOverrides(next);
  }, [conversationModelOverrides, sidebarConversationsById]);

  const {
    displayedConversationBusy,
    displayedTranscript,
    handleConversationStreamEvent,
    handleConversationStreamSync,
    manualCompactPending,
    manualCompactTransientConversations,
  } = useGatewayConversationRuntime({
    activityStore,
    api,
    applyLiveConversationTitle,
    chatCommandPipeline,
    clearManualCompactPendingRequest,
    displayedConversationBusyRef,
    displayedConversationId,
    handleTunnelManagerChatEvent,
    isLocalDraftConversationId,
    locale: settings.locale,
    manualCompactPendingByConversation,
    manualCompactPendingRef,
    pendingCommandRevision,
    refreshChatQueueSnapshot,
    setChatError,
    transcriptStoreRegistry,
  });

  // Open in flight (history-window fetch, before the replace apply paints).
  const historyDetailLoading = conversationOpenState.phase === "opening";
  const deviceHistoryOpenFailed = Boolean(
    failedVisibleGatewayHistoryOpen(
      conversationOpenState,
      displayedConversationId,
      historyOpenAttemptRef.current,
    ),
  );
  const pendingHistoryRestore = restoringConversationRef.current;
  const historyRestoreFailed =
    conversationOpenState.phase === "failed" &&
    pendingHistoryRestore !== null &&
    pendingHistoryRestore.ownerId === accountUser?.id &&
    pendingHistoryRestore.agentId === activeAgentScope &&
    pendingHistoryRestore.conversationId === displayedConversationId &&
    pendingHistoryRestore.conversationId === conversationOpenState.conversationId;

  useGatewayHistoryReconciliation({
    api,
    conversationIdRef,
    displayedConversationBusy,
    displayedConversationId,
    historyWindowStatesRef,
    isConversationBusy,
    needsHistoryRefresh: displayedTranscript.needsHistoryRefresh,
    refreshDisplayedConversationHistorySnapshot,
    selectedHistoryIdRef,
    transcriptStoreRegistry,
  });

  // --- Conversation open (controller deps) ----------------------------------
  // Single-phase open: paint the conversation's established history window
  // (first opens fetch the initial tail, revisits everything the user has
  // paged up to). Sets the selection state synchronously (controller.open
  // calls this in the same tick), fetches the window, and replace-applies it
  // to the transcript store. The web end has no synchronous local-activation
  // path, so it always resolves "painted" (never "cache-hit") — revisits
  // still show the cached transcript instantly because the registry store
  // keeps rendering underneath. Messages above the window edge stay
  // unfetched until the user pages up ("load earlier history"): hydrating
  // the full record on open would put open cost back on the conversation's
  // lifetime size, which is exactly what the lazy window avoids.
  const openConversationInitial = useMemo(
    () =>
      createOpenConversationInitial({
        api,
        conversationIdRef,
        conversationWorkdirsRef,
        getDisplayedConversationId,
        historyLoadSequenceRef,
        historyWindowStatesRef,
        invalidateHistoryLoad,
        localeErrorMessage: translate("chat.history.openFailed", settings.locale),
        markVisibleConversationRevision,
        pendingDisplayedConversationAutoBottomRef,
        protectedConversationRef,
        selectedHistoryIdRef,
        setChatError,
        setConversationId,
        setSelectedHistory,
        setSelectedHistoryId,
        transcriptStoreRegistry,
        visibleConversationRevisionRef,
      }),
    [
      api,
      getDisplayedConversationId,
      invalidateHistoryLoad,
      markVisibleConversationRevision,
      settings.locale,
      transcriptStoreRegistry,
    ],
  );

  openInitialRef.current = (id, request) => {
    const { isCurrent: isCurrentRequest, ...options } = request ?? {};
    const currentApi = apiRef.current;
    const isCurrentAgent = currentApi?.captureActiveAgentScope();
    const isCurrent = () => apiRef.current === currentApi && isCurrentAgent?.() === true;
    historyOpenAttemptRef.current = { conversationId: id, options, isCurrent };
    return openConversationInitial(id, {
      ...options,
      isCurrent: () => isCurrent() && isCurrentRequest?.() !== false,
    });
  };

  const openSavedConversation = useCallback(
    (target: NonNullable<typeof restoringConversationRef.current>) => {
      restoringConversationRef.current = target;
      openController.open(target.conversationId, {
        afterCommit: () => {
          if (restoringConversationRef.current !== target) return;
          restoringConversationRef.current = null;
          setChatError(null);
          if (isAgentMode) {
            activateConversationWorkspace(
              conversationWorkdirsRef.current.get(target.conversationId),
            );
          }
        },
      });
    },
    [activateConversationWorkspace, isAgentMode, openController],
  );
  const publishDeviceDraftRow = (id: string, workdir: string) => {
    if (sidebarStore.getSnapshot().byId.has(id)) return;
    const now = Date.now();
    sidebarStore.upsertLocal({
      id,
      cwd: workdir || undefined,
      title: settings.locale === "zh-CN" ? "未发送草稿" : "Unsent draft",
      providerId: "",
      model: "",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      isPending: true,
    });
  };
  const recoverUnsentDeviceDraft = useEffectEvent(
    (ownerId: number, agentId: string, focus = false) => {
      const scope = deviceDraftScope();
      if (activeView !== "chat" || scope?.ownerId !== ownerId || scope.agentId !== agentId) return;
      const current = resolveVisibleConversationId(
        selectedHistoryIdRef.current,
        conversationIdRef.current,
      );
      if (!isLocalDraftConversationId(current)) return;
      const scopeKey = JSON.stringify([ownerId, agentId]);
      const saved = readGatewayDeviceDraft(scope);
      if (!saved) {
        setSavedDeviceDraft(undefined);
        return;
      }
      const workdir = workdirForConversation(current);
      const recovery = planGatewaySavedDeviceDraftRecovery(saved, settings.system, {
        workdir,
        workMode: isAgentMode,
        hasInput: Boolean(
          composerRef.current?.hasContent() ||
            composerDraftCacheRef.current.get(current)?.isEmpty === false ||
            getPendingUploadsForConversation(current).length ||
            uploadingConversationId === current,
        ),
      });
      if (recovery.state !== "ready") {
        if (recovery.state === "current-draft") publishDeviceDraftRow(current, workdir);
        setSavedDeviceDraft({ scopeKey, state: recovery.state, path: saved.workspace?.path });
        return;
      }
      // A fresh temporary id makes the normal pane hydration restore the editor.
      // Its attachment registry never observes a project change within that id.
      const next = createGatewayHomeConversationState();
      const { workspace } = recovery;
      const recovered = restoreGatewayDeviceDraft(saved);
      conversationWorkdirsRef.current.set(next.conversationId, workspace.path);
      composerDraftCacheRef.current.set(next.conversationId, recovered.composer);
      setPendingUploadsForConversation(next.conversationId, recovered.attachments);
      if (workspace.project) setActiveWorkspaceProjectId(workspace.project.id);
      if (focus) restoredDeviceDraftFocusRef.current = next.conversationId;
      conversationIdRef.current = next.conversationId;
      selectedHistoryIdRef.current = next.selectedHistoryId;
      setConversationId(next.conversationId);
      setSelectedHistoryId(next.selectedHistoryId);
      clearGatewayDeviceDraft(scope);
      activeDeviceDraftOwnersRef.current.delete(scopeKey);
      setSavedDeviceDraft(undefined);
      if (saved.unfinishedUpload || saved.exceedsLimit) {
        const zh = settings.locale === "zh-CN";
        const copy = [];
        if (saved.unfinishedUpload)
          copy.push(
            zh
              ? "未完成上传的文件需要重新添加。"
              : "Add any files whose upload was interrupted again.",
          );
        if (saved.exceedsLimit)
          copy.push(
            zh
              ? "草稿文字超过标签页的保存上限。"
              : "The draft text exceeded the browser tab’s recovery limit.",
          );
        addNotify("warning", copy.join(" "));
      }
    },
  );
  const deviceDraftScope = (): GatewayDeviceDraftScope | undefined => {
    const ownerId = accountUser?.id;
    const agentId = activeAgentScope.trim();
    if (
      !ownerId ||
      draftPersistenceRetiredOwnerRef.current === ownerId ||
      !agentId ||
      !settingsSyncTargetReady ||
      settingsSyncError ||
      !api ||
      api.getActiveAgent() !== agentId ||
      historyShareToken ||
      deviceDraftLease ||
      getDesktopRemoteHost()
    )
      return;
    return { ownerId, agentId };
  };
  deviceDraftScopeRef.current = deviceDraftScope();
  const localDraftRecoveryScope = deviceDraftScopeRef.current;
  const localDraftRecoveryScopeKey = localDraftRecoveryScope
    ? JSON.stringify([localDraftRecoveryScope.ownerId, localDraftRecoveryScope.agentId])
    : "";
  const savedDeviceDraftNotice =
    localDraftRecoveryScopeKey === savedDeviceDraft?.scopeKey &&
    isLocalDraftConversationId(displayedConversationId)
      ? savedDeviceDraft
      : undefined;
  useEffect(() => {
    const scope = deviceDraftScopeRef.current;
    if (
      !scope ||
      activeView !== "chat" ||
      !isLocalDraftConversationId(displayedConversationId) ||
      savedDeviceDraft?.scopeKey === localDraftRecoveryScopeKey ||
      activeDeviceDraftOwnersRef.current.has(localDraftRecoveryScopeKey)
    )
      return;
    const saved = readGatewayDeviceDraft(scope);
    if (saved) {
      setSavedDeviceDraft({
        scopeKey: localDraftRecoveryScopeKey,
        state: "saved",
        path: saved.workspace?.path,
      });
    }
  }, [activeView, displayedConversationId, localDraftRecoveryScopeKey, savedDeviceDraft?.scopeKey]);
  useEffect(() => {
    if (!retrySavedDeviceDraftKey) return;
    setRetrySavedDeviceDraftKey("");
    const scope = deviceDraftScopeRef.current;
    if (scope && retrySavedDeviceDraftKey === localDraftRecoveryScopeKey)
      recoverUnsentDeviceDraft(scope.ownerId, scope.agentId, true);
  }, [localDraftRecoveryScopeKey, retrySavedDeviceDraftKey]);
  const verifiedDeviceReplyIdentity = (
    conversationId: string,
    verified?: GatewayDeviceReplyIdentity,
    forCapture = false,
  ): GatewayDeviceReplyIdentity | undefined => {
    if (!deviceDraftScope() || !conversationId || isLocalDraftConversationId(conversationId))
      return;
    if (verified?.sessionId) return verified;
    const detail = selectedHistoryRef.current;
    const summary =
      detail?.conversation_id === conversationId && detail.conversation?.id === conversationId
        ? detail.conversation
        : undefined;
    if (summary)
      return {
        sessionId: summary.session_id?.trim() || conversationId,
        workdir: summary.cwd?.trim() ?? "",
      };
    const row = forCapture ? sidebarStore.peek(conversationId) : undefined;
    if (row && !row.isPending)
      return { sessionId: row.sessionId?.trim() || conversationId, workdir: row.cwd?.trim() ?? "" };
  };
  const takeDeviceReplyDraft = (conversationId: string, identity: GatewayDeviceReplyIdentity) => {
    const scope = deviceDraftScope();
    if (
      !scope ||
      composerDraftCacheRef.current.has(conversationId) ||
      getPendingUploadsForConversation(conversationId).length
    )
      return;
    const entry = readGatewayDeviceReplyDraft(scope, identity);
    if (!entry || (entry.saved.attachments.length && !isAgentMode)) return;
    if (
      entry.saved.workspace?.id &&
      !findDeviceDraftProject(settings.system, entry.saved.workspace)
    )
      return;
    const key = workspaceProjectPathKey(identity.workdir);
    if (
      key &&
      (archivedWorkspaceProjectPathKeys.has(key) || missingWorkspaceProjectPathKeys.has(key))
    )
      return;
    const restored = restoreGatewayDeviceDraft(entry.saved);
    clearGatewayDeviceDraft(scope, entry.target);
    setPendingUploadsForConversation(conversationId, restored.attachments);
    composerDraftCacheRef.current.set(conversationId, restored.composer);
    if (entry.saved.unfinishedUpload || entry.saved.exceedsLimit) {
      addNotify(
        "warning",
        settings.locale === "zh-CN"
          ? "部分草稿内容未恢复。请重新添加未完成上传的文件，或补回超出浏览器保存上限的文字。"
          : "Some draft content could not be restored. Add interrupted uploads again or re-enter text that exceeded the browser limit.",
      );
    }
    return restored.composer;
  };
  const rememberDeviceDrafts = useStableCallback(() => {
    const scope = deviceDraftScope();
    if (!scope) return;
    const scopeKey = JSON.stringify([scope.ownerId, scope.agentId]);
    const current = resolveVisibleConversationId(
      selectedHistoryIdRef.current,
      conversationIdRef.current,
    );
    const capture = (
      id: string,
      draft: MentionComposerDraft | undefined,
      submitting: boolean,
      verified?: GatewayDeviceReplyIdentity,
    ) => {
      const isLocal = isLocalDraftConversationId(id);
      const identity = isLocal ? undefined : verifiedDeviceReplyIdentity(id, verified, true);
      if (!isLocal && !identity) return;
      const target: GatewayDeviceDraftTarget | undefined = identity
        ? { kind: "session", id: identity.sessionId }
        : gatewayLocalDraftCaptureTarget(
            scope,
            id,
            current,
            activeDeviceDraftOwnersRef.current.get(scopeKey),
          );
      const attachments = getPendingUploadsForConversation(id);
      const unfinishedUpload = uploadingConversationId === id;
      if (submitting || ((!draft || draft.isEmpty) && !attachments.length && !unfinishedUpload)) {
        if (target) clearGatewayDeviceDraft(scope, target);
        return;
      }
      const path = identity?.workdir ?? workdirForConversation(id);
      const key = workspaceProjectPathKey(path);
      const project = settings.system.workspaceProjects.find(
        (candidate) => workspaceProjectPathKey(candidate.path) === key,
      );
      // Browser Back can leave a saved reply's attachments in the registry
      // after its composer unmounts. That capture has no text to replace.
      const segments =
        draft?.segments ??
        (target?.kind === "session"
          ? readGatewayDeviceDraft(scope, target)?.segments
          : undefined) ??
        [];
      saveGatewayDeviceDraft(
        scope,
        {
          workspace: key ? { id: project?.id ?? "", path } : null,
          segments,
          attachments,
          unfinishedUpload,
        },
        target,
      );
      if (isLocal && !target) {
        activeDeviceDraftOwnersRef.current.set(scopeKey, id);
        clearGatewayDeviceDraft(scope, { kind: "local", id });
      }
    };
    const mounted = paneDraftRegistry.entries(resolveComposerDraftKey);
    for (const [resolved, { id, snapshot }] of mounted) {
      capture(
        resolved,
        snapshot.draft,
        snapshot.submitting || (resolved === current && submitInFlightRef.current),
        resolved === id ? snapshot.identity : undefined,
      );
    }
    const captured = new Set(mounted.keys());
    if (
      !captured.has(current) &&
      current &&
      activeView === "chat" &&
      composerDraftOwnerRef.current === current
    ) {
      captured.add(current);
      capture(current, composerRef.current?.getDraft(), submitInFlightRef.current);
    }
    for (const [id, draft] of composerDraftCacheRef.current) {
      if (!captured.has(id) && !id.startsWith("scheduled-task-result:")) {
        captured.add(id);
        capture(id, draft.isEmpty ? undefined : draft, false);
      }
    }
    for (const id of sidebarStore.getSnapshot().byId.keys()) {
      if (
        !captured.has(id) &&
        isLocalDraftConversationId(id) &&
        (getPendingUploadsForConversation(id).length || uploadingConversationId === id)
      ) {
        captured.add(id);
        capture(id, undefined, id === current && submitInFlightRef.current);
      }
    }
    if (
      current &&
      !captured.has(current) &&
      (getPendingUploadsForConversation(current).length || uploadingConversationId === current)
    )
      capture(current, undefined, submitInFlightRef.current);
  });
  useEffect(() => {
    const remember = (event: PageTransitionEvent) => {
      if (!event.persisted) rememberDeviceDrafts();
    };
    const rememberBeforeLeavingDevice = () => {
      const route = readCloudChatRoute(new URL(window.location.href));
      if (
        selectedTaskDevice &&
        (deviceWorkbenchRouteTarget(route) !== selectedTaskDevice ||
          (route.page === "chat" && route.id !== displayedConversationId))
      ) {
        rememberDeviceDrafts();
      }
    };
    window.addEventListener("pagehide", remember);
    window.addEventListener("popstate", rememberBeforeLeavingDevice, true);
    return () => {
      window.removeEventListener("pagehide", remember);
      window.removeEventListener("popstate", rememberBeforeLeavingDevice, true);
    };
  }, [displayedConversationId, rememberDeviceDrafts, selectedTaskDevice]);
  const recoverLocalPaneDrafts = useEffectEvent(() => {
    const scope = deviceDraftScope();
    if (!scope) return;
    const key = JSON.stringify([scope.ownerId, scope.agentId]);
    if (recoveredLocalDraftScopeRef.current === key) return;
    recoveredLocalDraftScopeRef.current = key;
    for (const id of listGatewayLocalDeviceDrafts(scope)) {
      if (!/^__local_draft__:[a-z0-9-]{1,64}$/i.test(id) || composerDraftCacheRef.current.has(id))
        continue;
      const target = { kind: "local", id } as const;
      const draft = readGatewayDeviceDraft(scope, target);
      const workspace = draft && resolveGatewayDraftWorkspace(settings.system, draft.workspace);
      if (!draft || !workspace || (draft.attachments.length && (!workspace.path || !isAgentMode)))
        continue;
      const restored = restoreGatewayDeviceDraft(draft);
      conversationWorkdirsRef.current.set(id, workspace.path);
      composerDraftCacheRef.current.set(id, restored.composer);
      setPendingUploadsForConversation(id, restored.attachments);
      publishDeviceDraftRow(id, workspace.path);
      clearGatewayDeviceDraft(scope, target);
      if (draft.unfinishedUpload || draft.exceedsLimit)
        addNotify(
          "warning",
          settings.locale === "zh-CN"
            ? "部分分屏草稿内容需要重新添加。"
            : "Some pane draft content needs to be added again.",
        );
    }
  });
  useEffect(() => {
    if (localDraftRecoveryScopeKey) recoverLocalPaneDrafts();
  }, [localDraftRecoveryScopeKey]);

  useEffect(() => {
    if (getDesktopRemoteHost()) return;
    const retireHistory = () => {
      restoringConversationRef.current = null;
      invalidateHistoryLoad();
      openController.cancel();
    };
    window.addEventListener("popstate", retireHistory);
    return () => window.removeEventListener("popstate", retireHistory);
  }, [invalidateHistoryLoad, openController]);

  // Restore only after the authenticated client has settled the device's settings.
  // The history controller owns the request and its stale-response guard.
  useEffect(() => {
    const agentId = activeAgentScope.trim();
    const ownerId = accountUser?.id;
    const route = readCloudChatRoute(new URL(window.location.href));
    const explicitDevice =
      !getDesktopRemoteHost() && route.page === "chat" && route.deviceId !== undefined
        ? route
        : null;
    const scope = `${ownerId}/${agentId}/${explicitDevice ? browserNavigationVersion : "legacy"}`;
    if (
      !api ||
      !ownerId ||
      !agentId ||
      !settingsSyncTargetReady ||
      historyShareToken ||
      restoredConversationAgentRef.current === scope
    ) {
      return;
    }
    const landing = resolveGatewayConversationLanding({
      route: explicitDevice ?? { page: "chat", id: "" },
      activeDeviceId: selectedTaskDevice,
      savedConversationId: explicitDevice ? "" : loadGatewayConversationSelection(agentId, ownerId),
    });
    if (!landing) return;
    restoredConversationAgentRef.current = scope;
    if (deviceDraftLease) return;
    if (landing.conversationId && !isLocalDraftConversationId(landing.conversationId)) {
      openSavedConversation({ ownerId, agentId, conversationId: landing.conversationId });
    } else if (landing.explicit && !isLocalDraftConversationId(getDisplayedConversationId())) {
      rememberDeviceDrafts();
      startNewConversationRef.current({ preserveCurrentComposerDraft: true });
      if (api.getActiveAgent() === agentId) recoverUnsentDeviceDraft(ownerId, agentId);
    } else if (api.getActiveAgent() === agentId) {
      recoverUnsentDeviceDraft(ownerId, agentId);
    }
  }, [
    accountUser?.id,
    activeAgentScope,
    api,
    browserNavigationVersion,
    deviceDraftLease,
    getDisplayedConversationId,
    historyShareToken,
    openSavedConversation,
    rememberDeviceDrafts,
    selectedTaskDevice,
    settingsSyncTargetReady,
  ]);
  const retryDeviceHistoryOpen = useCallback(() => {
    const attempt = failedVisibleGatewayHistoryOpen(
      openController.getState(),
      getDisplayedConversationId(),
      historyOpenAttemptRef.current,
    );
    if (!attempt?.isCurrent()) return;
    setChatError(null);
    openController.open(attempt.conversationId, attempt.options);
  }, [getDisplayedConversationId, openController]);

  returnFromDeviceTasksRef.current = (requestedId) => {
    const ownerId = accountUser?.id;
    const agentId = activeAgentScope.trim();
    if (!ownerId || !agentId || !selectedTaskDevice || getDesktopRemoteHost()) return;
    const url = new URL(window.location.href);
    const explicitScope = `${ownerId}/${agentId}/${browserNavigationVersion}`;
    const restoredHere =
      restoredConversationAgentRef.current === explicitScope ||
      restoredConversationAgentRef.current === `${ownerId}/${agentId}/legacy`;
    const visibleId = getDisplayedConversationId();
    const visibleConversation =
      restoredHere && visibleId && !isLocalDraftConversationId(visibleId)
        ? {
            conversationId: visibleId,
            historyConversationId: selectedHistory?.conversation_id,
            historySessionId: selectedHistory?.conversation?.session_id,
            sidebarSessionId: sidebarConversationsById.get(visibleId)?.sessionId,
          }
        : undefined;
    const href = gatewayDeviceTaskChatReturnHref({
      url,
      deviceId: selectedTaskDevice,
      requestedId,
      visibleConversation,
      restoredHere,
      recentConversationId: restoredHere ? "" : loadGatewayConversationSelection(agentId, ownerId),
    });
    if (!href) return;
    pushWorkbenchLocation(window.history.state, href);
    if (restoredHere || requestedId) restoredConversationAgentRef.current = explicitScope;
    else setBrowserNavigationVersion((version) => version + 1);
  };

  // Persist only real conversations. Starting a new conversation explicitly
  // clears this key, so the new-conversation button remains a new-conversation
  // intent rather than becoming an implicit reload shortcut.
  useEffect(() => {
    const agentId = activeAgentScope.trim();
    const conversationIdValue = displayedConversationId.trim();
    if (
      !accountUser?.id ||
      !agentId ||
      !conversationIdValue ||
      isLocalDraftConversationId(conversationIdValue) ||
      !settingsSyncTargetReady ||
      getDisplayedConversationId() !== displayedConversationId ||
      deviceDraftLease ||
      historyShareToken
    ) {
      return;
    }
    const detailConversationId = selectedHistory?.conversation_id.trim();
    const sessionId = resolveGatewayConversationRestoreTarget({
      conversationId: conversationIdValue,
      historyConversationId: selectedHistory?.conversation_id,
      historySessionId:
        detailConversationId === conversationIdValue
          ? selectedHistory?.conversation?.session_id
          : undefined,
      sidebarSessionId: sidebarConversationsById.get(conversationIdValue)?.sessionId,
    });
    // Active first turns may precede history summaries; the relay persists their alias mapping.
    if (!sessionId) return;
    saveGatewayConversationSelection(agentId, sessionId, accountUser.id);
  }, [
    accountUser?.id,
    activeAgentScope,
    deviceDraftLease,
    displayedConversationId,
    getDisplayedConversationId,
    historyShareToken,
    selectedHistory,
    settingsSyncTargetReady,
    sidebarConversationsById,
  ]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const route = readCloudChatRoute(url);
    if (
      route.page !== "chat" ||
      (route.deviceId !== undefined && route.deviceId !== selectedTaskDevice)
    )
      return;
    if (
      getDesktopRemoteHost() ||
      historyShareToken ||
      !selectedTaskDevice ||
      !accountUser?.id ||
      !settingsSyncTargetReady ||
      deviceDraftLease ||
      activeView !== "chat" ||
      deviceRouteStatus ||
      historyRestoreFailed ||
      restoredConversationAgentRef.current !==
        `${accountUser.id}/${activeAgentScope}/${route.deviceId !== undefined ? browserNavigationVersion : "legacy"}` ||
      getDisplayedConversationId() !== displayedConversationId ||
      conversationOpenState.phase === "opening" ||
      openController.getState().phase === "opening"
    )
      return;
    const isDraft = isLocalDraftConversationId(displayedConversationId);
    const routeId = isDraft
      ? ""
      : resolveGatewayConversationRestoreTarget({
          conversationId: displayedConversationId,
          historyConversationId: selectedHistory?.conversation_id,
          historySessionId: selectedHistory?.conversation?.session_id,
          sidebarSessionId: sidebarConversationsById.get(displayedConversationId)?.sessionId,
        });
    if (!isDraft && !/^[a-z0-9_-]{1,128}$/i.test(routeId)) return;
    if (route.deviceId === selectedTaskDevice && route.id === displayedConversationId) return;
    const href = cloudChatRouteHref(
      { page: "chat", id: routeId, deviceId: selectedTaskDevice },
      url,
    );
    if (href === url.pathname + url.search + url.hash) return;
    const firstSend =
      !route.id &&
      !!routeId &&
      openController.getState().conversationId !== displayedConversationId;
    const mode = route.deviceId === undefined || firstSend ? "replaceState" : "pushState";
    window.history[mode](window.history.state, "", href);
    restoredConversationAgentRef.current = `${accountUser.id}/${activeAgentScope}/${browserNavigationVersion}`;
  }, [
    accountUser?.id,
    activeAgentScope,
    activeView,
    browserNavigationVersion,
    conversationOpenState.phase,
    deviceDraftLease,
    deviceRouteStatus,
    displayedConversationId,
    getDisplayedConversationId,
    historyRestoreFailed,
    historyShareToken,
    openController,
    selectedHistory,
    selectedTaskDevice,
    settingsSyncTargetReady,
    sidebarConversationsById,
  ]);

  const prepareChatRuntime = useGatewayRuntimePreparation({
    api,
    historyShareToken,
    locale: settings.locale,
    setStatus,
    setStatusError,
    statusOnline: status?.online,
    statusRef,
  });

  const branchInFlightRef = useRef(false);
  const [branchPendingMessageId, setBranchPendingMessageId] = useState<string | null>(null);
  const {
    handleBranchConversation: handleBranchConversationImpl,
    handleLoadUploadedImagePreview: handleLoadUploadedImagePreviewImpl,
    handleResendFromEdit: handleResendFromEditImpl,
    handleSidebarConversationsRemoved,
    handleSidebarLocalDraftDeleted,
    handleSidebarNewConversation,
    handleSidebarOpenResourceHub,
    handleSidebarSelectConversation,
    startNewConversation,
  } = createGatewayConversationActions({
    activateConversationWorkspace,
    activateSearchConversationWorkspace,
    clearSearchConversationWorkspace,
    activeView,
    activeWorkspaceProjectPath,
    api,
    branchFailureMessage: translate("chat.branchFailed", settings.locale),
    branchInFlightRef,
    cacheVisibleComposerDraft,
    clearCachedComposerDraft,
    clearPersistedConversationSelection: () => {
      restoringConversationRef.current = null;
      if (accountUser?.id) clearGatewayConversationSelection(activeAgentScope, accountUser.id);
    },
    composerDraftCacheRef,
    composerDraftOwnerRef,
    composerRef,
    conversationIdRef,
    conversationWorkdirsRef,
    createLocalDraftConversationId,
    getDisplayedConversationId,
    getVisibleComposerConversationId,
    historyWindowStatesRef,
    invalidateHistoryLoad,
    isAgentMode,
    isConversationBusy,
    isLocalDraftConversationId,
    markVisibleConversationRevision,
    openController,
    pendingDisplayedConversationAutoBottomRef,
    prepareComposerForConversationChange,
    protectedConversationRef,
    removeSharedHistoryItems,
    restoreCachedComposerDraft,
    selectedHistoryIdRef,
    sendChatRef,
    setActiveView,
    setBranchPendingMessageId,
    setChatError,
    setConversationId,
    setPendingUploadsForConversation,
    setSelectedHistory,
    setSelectedHistoryId,
    setSidebarOpen,
    sidebarStore,
    submitInFlightRef,
    transcriptStoreRegistry,
  });
  startNewConversationRef.current = startNewConversation;
  const openDeviceTaskConversation = (conversationId: string) => {
    const id = conversationId.trim();
    if (!id) return;
    returnFromDeviceTasksRef.current(id);
    handleSidebarSelectConversation(id);
  };

  const openPreparedDeviceDraft = useEffectEvent(async () => {
    if (!deviceDraft || !deviceDraftLease || !api) return;
    const lease = deviceDraftLease;
    const stillCurrent = () =>
      deviceDraftContext.current.api === api && deviceDraftContext.current.lease === lease;
    try {
      const project = findDeviceDraftProject(settings.system, deviceDraft);
      if (settingsSyncError || !project) throw new Error("Device workspace unavailable");
      await api.listDirs(project.path, 1);
      if (!stillCurrent()) return;
      const currentProject = findDeviceDraftProject(deviceDraftContext.current.system, deviceDraft);
      if (!currentProject || !activateWorkspaceProject(currentProject, { startConversation: true }))
        throw new Error("Device workspace unavailable");
      finishDeviceDraft(lease);
    } catch {
      if (stillCurrent()) setFailedDeviceDraft(lease);
    }
  });
  useEffect(() => {
    if (
      !deviceDraftLease ||
      !settingsSyncTargetReady ||
      attemptedDeviceDraftRef.current === deviceDraftLease
    )
      return;
    attemptedDeviceDraftRef.current = deviceDraftLease;
    void openPreparedDeviceDraft();
  }, [deviceDraftLease, settingsSyncTargetReady]);

  const restorePreviousMobileNavigation = useCallback(() => {
    const stack = mobileNavigationStackRef.current;
    const currentProjectId = activeWorkspaceProject?.id ?? "";
    const currentConversationId = displayedConversationId.trim();
    while (stack.length > 0) {
      const entry = stack.pop();
      if (!entry) return false;
      if (entry.projectId === currentProjectId && entry.conversationId === currentConversationId) {
        continue;
      }
      restoringMobileNavigationRef.current = entry;
      const project = workspaceProjects.find((item) => item.id === entry.projectId);
      if (project && project.id !== currentProjectId) {
        activateWorkspaceProject(project);
      }
      if (entry.conversationId && entry.conversationId !== currentConversationId) {
        handleSidebarSelectConversation(entry.conversationId);
      } else if (!entry.conversationId && currentConversationId) {
        startNewConversation({
          workdir: project?.path || undefined,
          preserveCurrentComposerDraft: true,
        });
      }
      return true;
    }
    return false;
  }, [
    activateWorkspaceProject,
    activeWorkspaceProject?.id,
    displayedConversationId,
    handleSidebarSelectConversation,
    startNewConversation,
    workspaceProjects,
  ]);

  useEffect(() => {
    if (!isEmbeddedMobileRuntime()) return;
    const handleMobileBack = (rawEvent: Event) => {
      if (rawEvent.defaultPrevented || selection?.runtime_kind === "web_chat") return;
      let handled = true;
      if (shareConversation) {
        handleCloseShareModal();
      } else if (sharedManagerOpen) {
        setSharedManagerOpen(false);
      } else if (projectPickerOpen) {
        setProjectPickerOpen(false);
      } else if (workspaceCreateModalOpen) {
        setWorkspaceCreateModalOpen(false);
      } else if (userMenuOpen) {
        setUserMenuOpen(false);
      } else if (settingsOpen) {
        closeSettings();
      } else if (activeView === "chat" && rightDockOpen) {
        setRightDockOpen(false);
      } else if (sidebarOpen) {
        setSidebarOpen(false);
      } else if (activeView !== "chat") {
        setActiveView("chat");
      } else {
        handled = restorePreviousMobileNavigation();
      }
      if (!handled) return;
      rawEvent.preventDefault();
      mobileHaptic(8);
    };
    window.addEventListener(MOBILE_BACK_EVENT, handleMobileBack);
    return () => window.removeEventListener(MOBILE_BACK_EVENT, handleMobileBack);
  }, [
    activeView,
    closeSettings,
    handleCloseShareModal,
    projectPickerOpen,
    restorePreviousMobileNavigation,
    rightDockOpen,
    selection?.runtime_kind,
    setActiveView,
    setProjectPickerOpen,
    setRightDockOpen,
    setSharedManagerOpen,
    setSidebarOpen,
    setWorkspaceCreateModalOpen,
    settingsOpen,
    shareConversation,
    sharedManagerOpen,
    sidebarOpen,
    userMenuOpen,
    workspaceCreateModalOpen,
  ]);

  // The factory above rebuilds every closure per render so handlers always see
  // fresh state, but these three flow into the memo'd transcript region
  // (GatewayTranscriptListRegion / row components / ChatComposerBar). Pin their
  // identities — same pattern as sendChatRef in the pre-split monolith — so
  // unrelated GatewayApp renders (composer keystrokes, queue ticks, status
  // polls) cannot defeat that memo boundary.
  const handleBranchConversation = useStableCallback(handleBranchConversationImpl);
  const handleResendFromEdit = useStableCallback(handleResendFromEditImpl);
  const handleLoadUploadedImagePreview = useStableCallback(handleLoadUploadedImagePreviewImpl);
  const importDeviceConversationFiles = useStableCallback(
    async (workdir: string, files: File[], signal: AbortSignal) => {
      if (!api) throw new Error("The device is unavailable.");
      const isCurrent = api.captureActiveAgentScope();
      const agentId = await resolveActiveAgentID();
      signal.throwIfAborted();
      if (!isCurrent() || !agentId) throw new Error("The device is unavailable.");
      const result = await importReadableFiles(token, agentId, workdir, files, signal);
      signal.throwIfAborted();
      if (!isCurrent()) throw new Error("The device changed.");
      return result.files;
    },
  );

  const translateWorkspaceProject = useCallback(
    (key: string) => translate(key, settings.locale),
    [settings.locale],
  );
  const beforeRemoveWorkspaceProject = useCallback(
    async (project: WorkspaceProject) => {
      if (!workspaceProjectRootClient) {
        throw new Error(translateWorkspaceProject("chat.workspaceRootGrantsRevokeFailed"));
      }
      await workspaceProjectRootClient.revoke(project);
    },
    [translateWorkspaceProject, workspaceProjectRootClient],
  );

  const {
    removeWorkspaceProject,
    handleArchiveWorkspaceProject,
    handleUnarchiveWorkspaceProject,
    handleWorktreeRemoved,
  } = useWorkspaceProjectSettingsActions({
    setSettings,
    workspaceProjects,
    archivedWorkspaceProjectPathKeys,
    activeWorkspaceProject,
    activateWorkspaceProject,
    setActiveWorkspaceProjectId,
    t: translateWorkspaceProject,
    setErrorMessage: setSidebarActionError,
    beforeRemoveWorkspaceProject,
  });

  const isWorkspaceProjectRunning = useCallback(
    (pathKey: string) => {
      if (sidebarStore.getSnapshot().runningWorkdirPathKeys.has(pathKey)) {
        return true;
      }
      for (const [conversationId, activity] of activityStore.getSnapshot().activities) {
        const runtimeWorkdir =
          activity.workdir?.trim() ||
          conversationWorkdirsRef.current.get(conversationId)?.trim() ||
          "";
        const persistedWorkdir = sidebarStore.peek(conversationId)?.cwd?.trim() || "";
        if (workspaceProjectPathKey(runtimeWorkdir || persistedWorkdir) === pathKey) {
          return true;
        }
      }
      return false;
    },
    [activityStore, sidebarStore],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: workbench setter and version ref are stable hook outputs declared later in the composition
  const pruneWorkspaceProjectTerminalSessions = useCallback((pathKey: string) => {
    terminalSessionsVersionRef.current += 1;
    setTerminalSessions((current) =>
      current.filter((session) => !terminalSessionBelongsToProject(session, pathKey)),
    );
  }, []);
  const closeWorkspaceProjectRightDock = useCallback(
    (pathKey: string) => {
      if (workspaceProjectPathKey(activeWorkspaceProjectPath) === pathKey) {
        setRightDockOpen(false);
      }
    },
    [activeWorkspaceProjectPath, setRightDockOpen],
  );
  const getDisplayedConversationWorkdir = useCallback(
    () => displayedConversationWorkdirRef.current,
    [],
  );
  const refreshWorkspaceProjectWorkdirs = useCallback(() => {
    void sidebarStore.refreshWorkdirs("delete");
  }, [sidebarStore]);
  const handleRemoveWorkspaceProject = useWorkspaceProjectDeletion({
    settings,
    t: translateWorkspaceProject,
    requestConfirmDialog,
    setErrorMessage: setSidebarActionError,
    removeWorkspaceProject,
    gitClient,
    terminalClient,
    shouldInspectTerminalSessions:
      settings.remote.enableWebTerminal || settings.remote.enableWebSshTerminal,
    isWorkspaceProjectRunning,
    onPruneTerminalSessions: pruneWorkspaceProjectTerminalSessions,
    onCloseRightDockProject: closeWorkspaceProjectRightDock,
    getDisplayedConversationWorkdir,
    startNewConversation,
    onWorktreeRemoved: refreshWorkspaceProjectWorkdirs,
  });

  const handleComposerBusyChange = useCallback((_isBusy: boolean) => {}, []);

  const handleLogout = useCallback(
    async (revokeRemotely = true) => {
      const ownerId = accountUser?.id;
      draftPersistenceRetiredOwnerRef.current = ownerId;
      try {
        await clearSession(revokeRemotely);
      } catch {
        draftPersistenceRetiredOwnerRef.current = undefined;
        addNotify("error", "退出登录失败，请重试。");
        return;
      }
      if (ownerId) clearGatewayDeviceDraftsForAccount(ownerId);
      invalidateHistoryLoad();
      markVisibleConversationRevision();
      // Dropping the api swaps in a fresh (empty) sidebar store; the start/stop
      // effect stops the old one.
      openController.cancel();
      chatCommandPipeline.reset();
      clearCommandRecoveries();
      transcriptStoreRegistry.clear();
      activityStore.clear();
      draftClientRequestsRef.current.clear();
      historyWindowStatesRef.current.clear();
      conversationWorkdirsRef.current.clear();
      composerDraftCacheRef.current.clear();
      paneDraftRegistry.clear();
      recoveredLocalDraftScopeRef.current = "";
      activeDeviceDraftOwnersRef.current.clear();
      restoredDeviceDraftFocusRef.current = "";
      setSavedDeviceDraft(undefined);
      setRetrySavedDeviceDraftKey("");
      boundComposerDraftIdsRef.current.clear();
      composerDraftOwnerRef.current = "";
      composerRef.current?.clear();
      resetSharedHistory();
      clearPendingUploads();
      submitInFlightRef.current = false;
      setUserMenuOpen(false);
      setProjectSettingsProject(null);
      resetSettingsOverlay();
      setStatus(null);
      setStatusError(null);
      setChatError(null);
      setSidebarActionError(null);
      setFullHistoryLoading(false);
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = "";
      chatQueueRevisionRef.current = 0;
      queuedChatEditSessionRef.current = null;
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
      resetProjectToolsRuntimeRef.current();
      workbenchClearRef.current();
      restoredConversationAgentRef.current = "";
      resetToFreshHomeConversation();
    },
    [
      accountUser?.id,
      activityStore,
      addNotify,
      chatCommandPipeline,
      clearPendingUploads,
      clearSession,
      invalidateHistoryLoad,
      markVisibleConversationRevision,
      openController,
      paneDraftRegistry,
      resetSharedHistory,
      resetToFreshHomeConversation,
      transcriptStoreRegistry,
      resetSettingsOverlay,
      setProjectSettingsProject,
    ],
  );

  useEffect(() => {
    // Expiry can belong to a stale request; never revoke whichever account now owns the cookie.
    const expired = () => handleLogout(false);
    const changed = () => {
      if (accountUser?.id) clearGatewayDeviceDraftsForAccount(accountUser.id);
      handleLogout(false);
      window.location.reload();
    };
    const cookieChanged = (event: StorageEvent) => {
      if (event.key === ACCOUNT_SESSION_STORAGE_KEY && event.newValue) changed();
    };
    window.addEventListener(RELAY_SESSION_EXPIRED_EVENT, expired);
    window.addEventListener(ACCOUNT_CHANGED_EVENT, changed);
    window.addEventListener("storage", cookieChanged);
    return () => {
      window.removeEventListener(RELAY_SESSION_EXPIRED_EVENT, expired);
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, changed);
      window.removeEventListener("storage", cookieChanged);
    };
  }, [accountUser?.id, handleLogout]);

  const currentUserLabel = translate("common.currentUser", settings.locale);
  const userMenuLabel =
    (relayUser?.username || relayUser?.email || currentUserLabel).trim() || currentUserLabel;
  const userAvatarLabel = userMenuLabel.slice(0, 1).toUpperCase();
  const handleActiveAgentChange = useCallback(
    (agentId: string) => {
      const nextAgentId = agentId.trim();
      const taskLanding = !!nextAgentId && taskLandingAgentRef.current === nextAgentId;
      taskLandingAgentRef.current = "";
      const previousAgentId = activeAgentIdRef.current.trim();
      activeAgentIdRef.current = nextAgentId;
      setActiveAgentId(nextAgentId);
      setStatusError(null);
      setChatError(null);
      setSidebarActionError(null);
      if (!previousAgentId || previousAgentId === nextAgentId) {
        return;
      }

      invalidateHistoryLoad();
      markVisibleConversationRevision();
      openController.cancel();
      chatCommandPipeline.reset();
      clearCommandRecoveries();
      transcriptStoreRegistry.clear();
      activityStore.clear();
      draftClientRequestsRef.current.clear();
      conversationWorkdirsRef.current.clear();
      composerDraftCacheRef.current.clear();
      paneDraftRegistry.clear();
      recoveredLocalDraftScopeRef.current = "";
      boundComposerDraftIdsRef.current.clear();
      composerDraftOwnerRef.current = "";
      composerRef.current?.clear();
      clearPendingUploads();
      pendingUploadContextRef.current = null;
      submitInFlightRef.current = false;
      previousDisplayedConversationIdRef.current = "";
      pendingDisplayedConversationAutoBottomRef.current = null;
      displayedConversationWorkdirRef.current = "";
      resetSharedHistory();
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = "";
      chatQueueRevisionRef.current = 0;
      queuedChatEditSessionRef.current = null;
      statusRef.current = null;
      setStatus(null);
      setSidebarAgentStatusFresh(false);
      setGatewayConnectionLost(false);
      setConversationModelOverrides(new Map());
      setFullHistoryLoading(false);
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
      setProjectPickerOpen(false);
      setProjectSettingsProject(null);
      resetSettingsOverlay();
      setActiveViewState(taskLanding ? "cron-hub" : "chat");
      toast.dismiss();
      resetProjectToolsRuntimeRef.current();
      workbenchClearRef.current();
      restoringConversationRef.current = null;
      restoredConversationAgentRef.current = "";
      resetToFreshHomeConversation();
    },
    [
      activityStore,
      chatCommandPipeline,
      clearPendingUploads,
      invalidateHistoryLoad,
      markVisibleConversationRevision,
      openController,
      paneDraftRegistry,
      resetSharedHistory,
      resetToFreshHomeConversation,
      transcriptStoreRegistry,
      setActiveViewState,
      resetSettingsOverlay,
      setProjectSettingsProject,
      setProjectPickerOpen,
    ],
  );

  useLayoutEffect(() => {
    if (!api || !selectedAgentId) return;
    api.setActiveAgent(selectedAgentId);
    if (activeAgentIdRef.current !== selectedAgentId) handleActiveAgentChange(selectedAgentId);
  }, [api, handleActiveAgentChange, selectedAgentId]);

  const localeContextValue = useLocaleContextValue(settings.locale);

  const resourceWorkdir =
    sidebarConversationsById.get(displayedConversationId)?.cwd?.trim() ||
    conversationWorkdirsRef.current.get(displayedConversationId)?.trim() ||
    (searchConversationWorkdir === ""
      ? ""
      : isAgentMode
        ? activeWorkspaceProjectPath || settings.system.workdir.trim()
        : "");
  const {
    activeProviders,
    availableSkills,
    chatRuntimeControlsForCurrentProvider,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    codeReviewSkill,
    currentChatProvider,
    currentModelContextWindow,
    currentModelLabel,
    enabledComposerSkills,
    handleChatRuntimeControlsChange,
    handleSelectModel,
    isAgentDevExecutionMode,
    modelOptions,
    selectedValue,
    skillsRootDir,
    workspaceResources,
  } = useGatewayChatConfiguration({
    activeSelectedModel,
    displayedConversationId,
    isAgentMode,
    resourceWorkdir,
    setConversationModelOverrides,
    setSettings,
    settings,
  });
  // @ 弹层的应用候选：门控与 GUI 完全同源（agent 模式 + 工作区挂
  // cua-driver），列表经 Gateway 直通中继自桌面宿主本机。
  const mentionApps = useMentionApps(workspaceResources.mcpServers, isAgentMode);
  const {
    cancelChat,
    cancelQueuedChatEdit,
    commitQueuedChatEdit,
    editQueuedTurn,
    materializeComposerDraftForSend,
    moveQueuedTurnUp,
    removeQueuedTurn,
    runQueuedTurnNow,
    sendChat,
    submitCurrentComposerToGuiQueue,
  } = createGatewayChatCommandActions({
    activeProviders,
    activeWorkspaceProjectPath,
    activityStore,
    api,
    apiRef,
    applyChatQueueSnapshot,
    chatCommandPipeline,
    chatQueueRevisionRef,
    chatRuntimeControlsForCurrentProvider,
    clearCachedComposerDraft,
    composerRef,
    conversationIdRef,
    conversationWorkdirsRef,
    displayedConversationWorkdirRef,
    draftClientRequestsRef,
    getDisplayedConversationId,
    getPendingUploadsForConversation,
    isAgentMode,
    isDisplayedConversation,
    isImportingPastedTextRef,
    isLocalDraftConversationId,
    pendingUploadedFiles,
    prepareChatRuntime,
    protectedConversationRef,
    queuedChatEditSessionRef,
    queuedChatEditPendingRef,
    visibleConversationRevisionRef,
    refreshChatQueueSnapshot,
    resolveActiveAgentID,
    selectedHistoryIdRef,
    selectionForConversation,
    sendChatRef,
    setChatError,
    setConversationId,
    setPendingUploadsForConversation,
    setSelectedHistoryId,
    setUploadingFiles,
    settings,
    sidebarStore,
    token,
    transcriptFollow,
    transcriptStoreRegistry,
  });

  const cancelQueuedChatEditRef = useRef(cancelQueuedChatEdit);
  cancelQueuedChatEditRef.current = cancelQueuedChatEdit;
  useEffect(() => {
    const session = queuedChatEditSessionRef.current;
    if (session && session.conversationId !== displayedConversationId) {
      void cancelQueuedChatEditRef.current();
    }
  }, [displayedConversationId]);

  const canShareHistory = Boolean(
    api &&
      settings.remote.enabled &&
      settings.remote.gatewayUrl.trim() &&
      settings.remote.token.trim(),
  );
  // Sidebar rows, running dots, and project activity all render inside
  // <GatewaySidebarContainer/> from the sidebar store — no app-root memos.
  const currentConversationPersistedCwd =
    sidebarConversationsById.get(displayedConversationId)?.cwd?.trim() || "";
  const currentConversationRuntimeWorkdir =
    conversationWorkdirsRef.current.get(displayedConversationId)?.trim() || "";
  const displayedConversationWorkdir =
    currentConversationPersistedCwd ||
    currentConversationRuntimeWorkdir ||
    (searchConversationWorkdir === ""
      ? ""
      : isAgentMode
        ? activeWorkspaceProjectPath || settings.system.workdir.trim()
        : "");
  const searchMentionableConversations = useCallback(
    (query: string) =>
      searchMentionConversations({
        query,
        currentConversationId: displayedConversationId,
        currentWorkdir: displayedConversationWorkdir,
      }),
    [displayedConversationId, displayedConversationWorkdir],
  );
  displayedConversationWorkdirRef.current = displayedConversationWorkdir;
  // Switching conversations keeps every conversation's uploads, but a workdir
  // change within the same conversation (a draft switching projects)
  // invalidates them (staged uploads stay readable, workspace picks do not),
  // and a mode flip away from tools invalidates all of them — mirroring the
  // GUI-side rule in usePendingUploads.
  useEffect(() => {
    const executionMode = settings.system.executionMode;
    const previous = pendingUploadContextRef.current;
    pendingUploadContextRef.current = {
      conversationId: displayedConversationId,
      workdir: displayedConversationWorkdir,
      executionMode,
    };
    if (!previous) return;
    if (previous.executionMode !== executionMode) {
      clearPendingUploads();
      return;
    }
    if (previous.conversationId !== displayedConversationId) return;
    if (previous.workdir === displayedConversationWorkdir) return;
    setPendingUploadsForConversation(displayedConversationId, []);
  }, [
    clearPendingUploads,
    displayedConversationId,
    displayedConversationWorkdir,
    settings.system.executionMode,
    setPendingUploadsForConversation,
  ]);
  useEffect(() => {
    if (!api || !displayedConversationId) {
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = "";
      chatQueueRevisionRef.current = 0;
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
      return;
    }
    if (chatQueueConversationIdRef.current !== displayedConversationId) {
      queuedChatTurnsRef.current = [];
      chatQueueConversationIdRef.current = displayedConversationId;
      chatQueueRevisionRef.current = 0;
      setQueuedChatTurns([]);
      setChatQueueRevision(0);
    }
    let cancelled = false;
    void api
      .chatQueueGet(displayedConversationId)
      .then((response) => {
        if (!cancelled) applyChatQueueSnapshot(response.snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, applyChatQueueSnapshot, displayedConversationId]);
  const queuedChatTurnsForDisplayedConversation = useMemo<ChatQueueTurnPreview[]>(
    () =>
      queuedChatTurns.map((item) => ({
        id: item.id,
        previewText: item.previewText,
        fileCount: item.fileCount,
      })),
    [queuedChatTurns],
  );
  const {
    associatedSshHostIds,
    changedFilesActions,
    gitDisabledMessage,
    gitReviewFocusRequest,
    handleGitReviewFocusRequestHandled,
    handleEmptyStateSuggestion,
    handleChatTranscriptWidthChange,
    handleInsertCodeMention,
    handleOpenChatFileLink,
    handleOpenSftpFile,
    handleOpenSshTerminal,
    handleOpenWorkspaceDiff,
    handleOpenWorkspaceFile,
    handleProjectTerminalSessionsChange,
    updateProjectTerminalSessions,
    handleRightDockClose,
    handleRightDockFileTreeStateChange,
    handleRightDockInsertCodeReviewSkill,
    handleRightDockInsertCommitMention,
    handleRightDockInsertFileMention,
    handleRightDockInsertGitFileMention,
    handleRightDockProjectStateChange,
    handleRightDockWidthChange,
    handleSshProjectHostIdsChange,
    handleWorkspaceEditorClosed,
    handleWorkspaceEditorHide,
    handleWorkspaceFilePreviewClosed,
    hideWorkspaceSshTerminalOverlay,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    projectTerminalSessions,
    projectToolsDisabledMessage,
    requestWorkspaceFilePreviewClose,
    rightDockFileTreeState,
    rightDockProjectState,
    terminalDisabledMessage,
    tabbedWorkspace,
    terminalProjectPath,
    terminalProjectPathKey,
    terminalSessions,
    terminalSessionsLoaded,
    terminalSessionsVersionRef,
    setTerminalSessions,
    tunnelDisabledMessage,
    tunnelEnabled,
    workspaceActivityClient,
    workspaceTabs,
    workspaceViewScope,
    workspaceEditors,
    workspaceFilePreviewMounted,
    workspaceFilePreviewOpen,
    workspaceFilePreviewOpenRequest,
    workspaceSshTerminalMounted,
    workspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest,
  } = useGatewayProjectTools({
    workspaceOwner,
    activeWorkspaceProjectPath,
    addNotify,
    api,
    codeReviewSkill,
    composerRef,
    displayedConversationId,
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
  });

  const verifyTerminalSessionAlive = useCallback(
    async (_sessionId: string) => {
      if (!terminalClient) return;
      try {
        const sessions = await terminalClient.list();
        terminalSessionsVersionRef.current += 1;
        setTerminalSessions(sortTerminalSessions(sessions));
      } catch {
        // 瞬时网关错误不应把仍存活的终端误判为幽灵会话。
      }
    },
    [setTerminalSessions, terminalClient, terminalSessionsVersionRef],
  );

  // --- Session Workbench（多看板分屏）----------------------------------------
  // 布局与聚焦语义复用共享 reducer；聚焦 Pane 的会话 === 页面当前会话
  // （与桌面端相同不变式）。每个会话 Pane 渲染同一套完整宿主，焦点切换
  // 只换绑定不拆 DOM；侧栏选中走 syncCurrentConversation（已有 Pane 则
  // 聚焦，否则重绑聚焦 Pane）。拖拽体系与桌面端共用。
  const workbenchController = useGatewayWorkbench({
    enabled: sessionWorkbench.enabled,
    displayedConversationId,
    sidebarStore,
    workspaceProjects,
    archivedProjectPathKeys: archivedWorkspaceProjectPathKeys,
    missingProjectPathKeys: missingWorkspaceProjectPathKeys,
    activateWorkspaceProject,
    terminalClient,
    terminalSessions,
    terminalProjectPath,
    newTerminalTitle: translate("projectTools.newTerminal", settings.locale),
    projectToolTitle: (tool) => translate(projectToolSurfaceTitleKey(tool), settings.locale),
    selectConversation: handleSidebarSelectConversation,
    startConversationForProject: handleNewConversationForProject,
    conversationWorkdirFor: (conversationId) =>
      conversationWorkdirsRef.current.get(conversationId)?.trim() ||
      sidebarStore.peek(conversationId)?.cwd?.trim() ||
      null,
    onNoSpaceForSplit: () =>
      addNotify("error", translate("workbench.noSpaceForSplit", settings.locale)),
    onDropStateChanged: () =>
      addNotify("error", translate("workbench.dropStateChanged", settings.locale)),
    onWorkspaceDropFailed: (error) =>
      addNotify(
        "error",
        asErrorMessage(error, translate("workbench.workspaceDropFailed", settings.locale)),
      ),
    onConversationAlreadyOpen: () =>
      addNotify("success", translate("workbench.conversationAlreadyOpen", settings.locale)),
    onProjectToolPaneClosed: (tool, projectPathKey) => {
      closeToolForPane(tool, projectPathKey);
      setSettings((prev) => releaseProjectToolFromDock(prev, tool, projectPathKey));
    },
    onTerminalCloseFailed: (message) => addNotify("error", message),
  });
  workbenchRenameConversationRef.current = workbenchController.workbench.renameConversation;
  workbenchClearRef.current = workbenchController.clearWorkbench;

  // 会话从权威索引消失（批量删除等）：先收起对应 Pane，再走既有移除通路；
  // displayed 被删时的选中迁移完成后，syncCurrentConversation 会把聚焦 Pane
  // 重新绑定到新的当前会话。草稿 id 必须跳过——草稿转正会经 removeLocal 把
  // 草稿 id 移出权威索引，此时 Pane 已由 rename 通路原位重绑，收 Pane 会误关
  // 聚焦面板；与底层处理器跳过草稿的口径一致。用户手动删草稿走
  // onLocalDraftDeleted 通路。
  const handleSidebarConversationsRemovedWithWorkbench = (ids: readonly string[]) => {
    const scope = deviceDraftScope();
    if (scope) {
      for (const id of ids) {
        const identity = verifiedDeviceReplyIdentity(id, undefined, true);
        if (identity) clearGatewayDeviceDraft(scope, { kind: "session", id: identity.sessionId });
      }
    }
    workbenchController.closePanesForRemovedConversations(
      ids.filter((id) => !isLocalDraftConversationId(id)),
    );
    handleSidebarConversationsRemoved(ids);
  };
  const handleSidebarLocalDraftDeletedWithWorkbench = (id: string) => {
    const scope = deviceDraftScope();
    if (scope) clearGatewayDeviceDraft(scope, { kind: "local", id });
    workbenchController.closePanesForRemovedConversations([id]);
    handleSidebarLocalDraftDeleted(id);
  };
  const recoverPageReplyDraft = useEffectEvent((id: string) => {
    const identity = verifiedDeviceReplyIdentity(id);
    if (identity && !historyDetailLoading) return takeDeviceReplyDraft(id, identity);
  });
  useEffect(() => {
    if (activeView !== "chat") {
      return;
    }

    const targetConversationId = displayedConversationId.trim();
    if (!targetConversationId) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      // Workbench 开启后草稿始终由稳定 Pane 宿主管理，包括布局从多 Pane
      // 收敛回单 Pane 的一帧；页面级 restore 只能服务关闭 Workbench 的
      // legacy composer，否则会用旧缓存覆盖宿主里尚未写回的输入。
      if (sessionWorkbench.enabled) {
        composerDraftOwnerRef.current = targetConversationId;
        return;
      }
      const composer = composerRef.current;
      if (!composer) return;
      if (
        !shouldRestorePageComposerDraft({
          workbenchEnabled: false,
          targetConversationId,
          ownerConversationId: composerDraftOwnerRef.current,
          composerHasContent: composer.hasContent(),
        })
      )
        return;
      restoreCachedComposerDraft(targetConversationId);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeView, displayedConversationId, restoreCachedComposerDraft]);
  useEffect(() => {
    if (
      activeView !== "chat" ||
      !displayedConversationId ||
      restoredDeviceDraftFocusRef.current !== displayedConversationId
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      restoredDeviceDraftFocusRef.current = "";
      composerRef.current?.focus({ restoreSelection: false });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, displayedConversationId]);
  useEffect(() => {
    if (
      sessionWorkbench.enabled ||
      activeView !== "chat" ||
      historyDetailLoading ||
      selectedHistory?.conversation_id !== displayedConversationId ||
      !selectedHistory.conversation
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      const composer = composerRef.current;
      if (
        !composer ||
        composerDraftOwnerRef.current !== displayedConversationId ||
        composer.hasContent()
      )
        return;
      const recovered = recoverPageReplyDraft(displayedConversationId);
      if (recovered) composer.setDraft(recovered);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeView,
    displayedConversationId,
    historyDetailLoading,
    selectedHistory?.conversation_id,
    selectedHistory?.conversation,
  ]);

  const {
    approvalBar,
    approvalConversationIds,
    canDropUpload,
    canEditOfflineDraft,
    chatProtocolIncompatibleMessage,
    composerCompactionBlocked,
    composerDraftOnly,
    composerInputDisabled,
    composerIsSending,
    composerPlaceholder,
    contextUsageTokensSource,
    displayedTranscriptRowCount,
    fileDropDescription,
    fileDropLimitHint,
    fileDropTitle,
    handleFileDragOver,
    handleFileDrop,
    handleLoadEarlierHistory,
    handleManualCompact,
    historyDetailLoadingTitle,
    loadingOlderHistory,
    selectedHistoryHasMore,
    sidebarSectionsDisabled,
    taskProgressSnapshot,
    transcriptBusy,
    transcriptError,
    transcriptFloors,
    transcriptHistoryLoading,
    transcriptLiveStartIndex,
    transcriptRows,
    transcriptToolStatus,
    transcriptToolStatusIsCompaction,
  } = useGatewayChatPresentation({
    activeView,
    activeWorkspaceProject,
    api,
    chatCommandHasPending: (conversationId) => chatCommandPipeline.hasPending(conversationId),
    chatError,
    clearManualCompactPendingRequest,
    displayedConversationBusy,
    displayedConversationId,
    displayedConversationWorkdir,
    displayedTranscript,
    enabledComposerSkills,
    fullHistoryLoading,
    gatewayConnectionLost,
    handlePendingFileDragOver,
    handlePendingFileDrop,
    historyDetailLoading,
    historyOpenFailed: deviceHistoryOpenFailed,
    historyShareToken,
    isAgentMode,
    isDisplayedConversation,
    isLocalDraftConversationId,
    isUploadingFiles,
    manualCompactPendingRef,
    refreshDisplayedConversationHistorySnapshot,
    selectedHistory,
    selectedHistoryId,
    setChatError,
    setFullHistoryLoading,
    setManualCompactPendingRequest,
    settings,
    sidebarAgentStatusFresh,
    sidebarConversationsById,
    status,
    token,
    transcriptStoreRegistry,
  });

  // 会话搜索跳转：与桌面端 ChatTranscript 相同，目标在已加载窗口内就滚过去，
  // 否则逐页加载更早历史，直到命中或没有更多历史（最多 SEARCH_JUMP_MAX_PAGES 页）。
  const searchJumpPagesRef = useRef(0);
  const pendingSearchJump = useSyncExternalStore(
    subscribeSearchJumpTarget,
    getSearchJumpTargetSnapshot,
  );
  useEffect(() => {
    if (historyDetailLoading || loadingOlderHistory || !transcriptViewport) return;
    const target =
      pendingSearchJump?.conversationId === displayedConversationId ? pendingSearchJump : null;
    if (!target) {
      searchJumpPagesRef.current = 0;
      return;
    }
    const rowKey = resolveSearchJumpRowKey(transcriptRowsToJumpCandidates(transcriptRows), target);
    if (rowKey) {
      const frame = requestAnimationFrame(() => {
        if (getSearchJumpTargetSnapshot() !== target) return;
        // A history open may still have a pending initial scroll to the latest turn.
        // Consume it before clearing the explicit target so the next layout cannot pin again.
        if (pendingDisplayedConversationAutoBottomRef.current === target.conversationId) {
          pendingDisplayedConversationAutoBottomRef.current = null;
        }
        clearSearchJumpTarget(target);
        searchJumpPagesRef.current = 0;
        handleFloorJump(rowKey);
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!selectedHistoryHasMore || searchJumpPagesRef.current >= SEARCH_JUMP_MAX_PAGES) {
      clearSearchJumpTarget(target);
      searchJumpPagesRef.current = 0;
      return;
    }
    searchJumpPagesRef.current += 1;
    handleLoadEarlierHistory();
  }, [
    displayedConversationId,
    handleFloorJump,
    historyDetailLoading,
    pendingSearchJump,
    handleLoadEarlierHistory,
    loadingOlderHistory,
    selectedHistoryHasMore,
    transcriptRows,
    transcriptViewport,
  ]);

  useEffect(() => {
    const nextDisplayedConversationId = displayedConversationId.trim();
    const previousDisplayedConversationId = previousDisplayedConversationIdRef.current.trim();
    previousDisplayedConversationIdRef.current = nextDisplayedConversationId;
    if (
      !nextDisplayedConversationId ||
      !previousDisplayedConversationId ||
      previousDisplayedConversationId === nextDisplayedConversationId
    ) {
      return;
    }
    // Switching away folds the settled turns so revisits start clean.
    transcriptStoreRegistry.peek(previousDisplayedConversationId)?.foldSettledTurns();
    if (getSearchJumpTargetSnapshot()?.conversationId !== nextDisplayedConversationId) {
      pendingDisplayedConversationAutoBottomRef.current = nextDisplayedConversationId;
    }
  }, [displayedConversationId, transcriptStoreRegistry]);

  useLayoutEffect(() => {
    const targetConversationId = pendingDisplayedConversationAutoBottomRef.current?.trim() ?? "";
    if (
      !targetConversationId ||
      historyDetailLoading ||
      displayedConversationId.trim() !== targetConversationId ||
      displayedTranscriptRowCount === 0
    ) {
      return;
    }

    pendingDisplayedConversationAutoBottomRef.current = null;
    if (getSearchJumpTargetSnapshot()?.conversationId !== targetConversationId) {
      transcriptFollow.stickToBottom();
    }
  }, [
    displayedConversationId,
    displayedTranscriptRowCount,
    historyDetailLoading,
    transcriptFollow,
  ]);

  if (historyShareToken) {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <SharedHistoryPage token={historyShareToken} />
      </LocaleContext.Provider>
    );
  }

  if (authInitializing) {
    return (
      <main
        className="app-auth-restoring flex min-h-dvh w-full min-w-0 flex-1 items-center justify-center bg-background"
        role="status"
        aria-label="正在恢复登录状态"
      >
        <img
          src="/zeroagent-logo.png"
          alt=""
          width={48}
          height={48}
          className="h-12 w-12 shrink-0 animate-pulse"
          draggable={false}
        />
      </main>
    );
  }

  if (!accountUser) {
    return (
      <AccountLoginPage
        error={authError}
        isSubmitting={authSubmitting}
        twoFactorRequired={twoFactorRequired}
        onSubmit={(email, password) => void handleLoginSubmit(email, password)}
        onRegister={(input) => void handleRegisterSubmit(input)}
        onSubmitTwoFactor={(code) => void verifyTwoFactor(code)}
        onClearError={() => setAuthError(null)}
        onSetError={setAuthError}
      />
    );
  }

  if (deviceRouteStatus) {
    const loading = deviceRouteStatus === "loading";
    const invalidLink = deviceRouteStatus === "invalid-link";
    const route = readCloudChatRoute(new URL(window.location.href));
    const tasks = route.page === "tasks" && route.deviceView;
    const zh = settings.locale === "zh-CN";
    let message = zh ? "暂时无法访问此设备。" : "This device is unavailable.";
    if (deviceRouteStatus === "unauthorized")
      message = zh ? "设备控制权限已失效。" : "Device control access has ended.";
    else if (invalidLink)
      message = tasks
        ? zh
          ? "设备定时任务链接无效。"
          : "This device task link is invalid."
        : zh
          ? "设备对话链接无效。"
          : "This device conversation link is invalid.";
    else if (loading)
      message = tasks
        ? zh
          ? "正在打开设备定时任务…"
          : "Opening scheduled tasks on the device…"
        : zh
          ? "正在打开设备对话…"
          : "Opening device conversation…";
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <div className={GATEWAY_SHELL_CLASS}>
          <div className="max-820:hidden">
            <ApplicationRail
              activeId={tasks ? "cron-hub" : "chat"}
              brand={<BrandMark />}
              items={[
                createWorkbenchNavigationItem("chat", zh ? "对话" : "Chat", () =>
                  returnToCloudConversation(),
                ),
                createWorkbenchNavigationItem("library", zh ? "资料空间" : "Library", () =>
                  returnToCloudConversation({ page: "library", location: CLOUD_SPACE_HOME }),
                ),
                createWorkbenchNavigationItem("customize", zh ? "自定义" : "Customize", () =>
                  returnToCloudConversation({
                    page: "extensions",
                    location: DEFAULT_EXTENSION_LOCATION,
                  }),
                ),
                createWorkbenchNavigationItem("cron-hub", zh ? "定时任务" : "Scheduled tasks", () =>
                  returnToCloudConversation({ page: "tasks" }),
                ),
              ]}
              footer={
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full"
                  aria-label={zh ? "账户设置" : "Account settings"}
                  onClick={() =>
                    returnToCloudConversation({ page: "settings", section: "account" })
                  }
                >
                  {userAvatarLabel}
                </Button>
              }
            />
          </div>
          <main className={cn(GATEWAY_MAIN_SHELL_CLASS, "items-center justify-center")}>
            <StatusNotice
              className="mx-4 max-w-md"
              tone={loading ? "info" : "error"}
              busy={loading}
              message={message}
              description={
                loading
                  ? undefined
                  : invalidLink
                    ? zh
                      ? "请从原设备重新打开，或请分享者提供完整链接。"
                      : "Open it again from the original device or ask the sender for a complete link."
                    : zh
                      ? "检查设备连接和当前账户的访问权限，然后重试。"
                      : "Check the device connection and your account access, then try again."
              }
              actions={
                <>
                  {!loading && !invalidLink && (
                    <Button
                      variant="outline"
                      className="max-820:min-h-11"
                      onClick={retryDeviceConversationRoute}
                    >
                      {zh ? "重试" : "Try again"}
                    </Button>
                  )}
                  <Button
                    variant={invalidLink ? "outline" : "ghost"}
                    className="max-820:min-h-11"
                    onClick={() => returnToCloudConversation()}
                  >
                    {zh ? "返回云端" : "Back to Cloud"}
                  </Button>
                </>
              }
            />
          </main>
        </div>
      </LocaleContext.Provider>
    );
  }

  if (selection?.runtime_kind === "web_chat") {
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <GatewayCloudWorkspace key={(relayUser ?? accountUser)?.id} locale={settings.locale}>
          {(workspaceAvailability) => (
            <CloudChatPage
              workspaceAvailability={workspaceAvailability}
              user={relayUser ?? accountUser}
              onUserChange={acceptRelayUser}
              environments={environments}
              retryEnvironmentDirectory={
                environmentDirectoryUnavailable ? () => reloadEnvironments(true) : undefined
              }
              selection={selection}
              settings={settings}
              setSettings={setSettings}
              settingsSaveState={settingsSaveState}
              onSwitch={switchExecutionTarget}
              onLogout={handleLogout}
            />
          )}
        </GatewayCloudWorkspace>
      </LocaleContext.Provider>
    );
  }

  if (!token) return null;

  if (!api) {
    return null;
  }

  if (!settingsSyncReady || deviceDraftLease) {
    const deviceDraftFailed = failedDeviceDraft === deviceDraftLease;
    const zh = settings.locale === "zh-CN";
    return (
      <LocaleContext.Provider value={localeContextValue}>
        <GatewayLoadingScreen embedded={Boolean(getDesktopRemoteHost())}>
          {deviceDraftLease ? (
            <StatusNotice
              className="mx-4 max-w-md"
              tone={deviceDraftFailed ? "error" : "info"}
              busy={!deviceDraftFailed}
              message={
                deviceDraftFailed
                  ? zh
                    ? "所选设备工作区暂不可用。"
                    : "The selected device workspace is unavailable."
                  : zh
                    ? "正在打开设备工作区…"
                    : "Opening device workspace…"
              }
              description={zh ? "云端草稿已保留。" : "Your cloud draft is saved."}
              actions={
                <Button variant="ghost" onClick={() => returnToCloudDraft(deviceDraftLease)}>
                  {zh ? "返回云端" : "Return to Cloud"}
                </Button>
              }
            />
          ) : (
            <GatewayLoadingCard
              label={translate("chat.runtime.settingsSyncTitle", settings.locale)}
            />
          )}
        </GatewayLoadingScreen>
      </LocaleContext.Provider>
    );
  }
  // --- 多看板背景 Pane 的按会话绑定能力(复刻桌面端 buildBackgroundPaneBinding
  // 的数据面):工作区、草稿缓存、附件导入全部按显式 conversationId 路由。---
  const getCachedComposerDraft = (targetConversationId: string) =>
    composerDraftCacheRef.current.get(resolveComposerDraftKey(targetConversationId));
  const setCachedComposerDraft = (
    targetConversationId: string,
    draft: MentionComposerDraft | null,
  ) => {
    const key = resolveComposerDraftKey(targetConversationId);
    if (draft) composerDraftCacheRef.current.set(key, draft);
    else composerDraftCacheRef.current.delete(key);
  };
  const importFilesForConversation = (
    targetConversationId: string,
    workdir: string,
    files: File[],
  ) => handleImportReadableFiles(files, { conversationId: targetConversationId, workdir });

  const viewModel = {
    environments,
    switchExecutionTarget,
    rememberDeviceDrafts,
    selection,
    relayUser,
    relayStats,
    refreshRelayAccount,

    imageStudioToken: token,
    setChatError,
    registerSettingsLeaveGuard,
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
    cancelQueuedChatEdit,
    changedFilesActions,
    chatError,
    chatProtocolIncompatibleMessage,
    chatRuntimeControlsForCurrentProvider,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    closeSettings,
    codeReviewSkill,
    commitQueuedChatEdit,
    composerCompactionBlocked,
    composerDraftOnly,
    composerInputDisabled,
    composerIsSending,
    composerPlaceholder,
    composerRef,
    confirmDialog,
    contextUsageTokensSource,
    conversationId,
    conversationOpenState,
    deviceHistoryOpenFailed,
    openDeviceTaskConversation,
    retryDeviceHistoryOpen,
    savedDeviceDraftNotice,
    retrySavedDeviceDraft: () => setRetrySavedDeviceDraftKey(localDraftRecoveryScopeKey),
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
    fileDropDescription,
    fileDropLimitHint,
    fileDropTitle,
    fileInputRef,
    folderInputRef,
    gatewayConnectionLost,
    getCachedComposerDraft,
    getDisplayedConversationId,
    getPendingUploadsForConversation,
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
    importDeviceConversationFiles,
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
    handleOpenWorkspaceDiff,
    handleOpenWorkspaceFile,
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
    handleSidebarConversationsRemoved: handleSidebarConversationsRemovedWithWorkbench,
    handleSidebarLocalDraftDeleted: handleSidebarLocalDraftDeletedWithWorkbench,
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
    isAgentDevExecutionMode,
    isAgentMode,
    isConversationBusy,
    handleConversationStreamEvent,
    handleConversationStreamSync,
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
    queuePaused:
      queuePausedState?.conversationId === displayedConversationId
        ? queuePausedState.paused
        : undefined,
    queueControlPending: queueControlConversationId === displayedConversationId,
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
    verifiedDeviceReplyIdentity,
    takeDeviceReplyDraft,
    registerDevicePaneDraft: paneDraftRegistry.register,
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
    settings,
    settingsOpen,
    modelPreferencesOpen,
    setModelPreferencesOpen,
    settingsProviderId,
    settingsSaveState,
    settingsSection,
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
    taskProgressSnapshot,
    terminalClient,
    terminalDisabledMessage,
    tabbedWorkspace,
    terminalProjectPath,
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
    workspaceOwner,
    workspaceTabs,
    workspaceViewScope,
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
  };
  return viewModel;
}

export type GatewayAppViewModel = Extract<
  ReturnType<typeof useGatewayAppController>,
  { activeFloorKey: string | null }
>;

type GatewayAppProps = { imageStudioIdentity?: TrustedGatewayImageIdentity };

export default function GatewayApp(props: GatewayAppProps) {
  return (
    <SidebarProvider>
      <GatewayAppContent {...props} />
    </SidebarProvider>
  );
}
function GatewayAppContent({ imageStudioIdentity }: GatewayAppProps) {
  const result = useGatewayAppController();
  if (!result || !("activeFloorKey" in result)) {
    return result;
  }
  return (
    <UploadedImagePreviewScope.Provider value={result.workspaceOwner}>
      <GatewayAppView viewModel={result} imageStudioIdentity={imageStudioIdentity} />
    </UploadedImagePreviewScope.Provider>
  );
}
