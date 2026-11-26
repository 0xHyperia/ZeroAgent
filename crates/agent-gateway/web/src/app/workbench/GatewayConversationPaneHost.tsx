import {
  type ChangedFilesActions,
  ChangedFilesActionsProvider,
} from "@liveagent/ui/components/chat/ChangedFilesCard";
import type {
  ClarifyContext,
  RunClarifyTurn,
} from "@liveagent/ui/components/chat/clarify/clarifyTypes";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import {
  ScheduledPromptPreview,
  ScheduledReplyPreview,
} from "@liveagent/ui/components/chat/ScheduledReplyPreview";
import { TaskProgressBar } from "@liveagent/ui/components/chat/TaskProgressBar";
import { ToolApprovalBar } from "@liveagent/ui/components/chat/ToolApprovalBar";
import { TranscriptLatestButton } from "@liveagent/ui/components/chat/TranscriptLatestButton";
import { Loader2 } from "@liveagent/ui/components/IconSet";
// 会话 Pane 的统一宿主——复刻桌面端 RestorableConversationPaneHost:
// 每个 Pane 始终挂同一组件,焦点切换只换 primary/background 绑定,不拆宿主。
// 发送/停止/排队/上传/审批按本 Pane 的 conversationId 路由;选模型、编辑队列
// 项、由正文重发等页面级操作在背景 Pane 上先走 focusGuard。Primary 把自己的
// 输入框挂到页面 composerRef,卸载时把未发送草稿写回缓存。
import { DeviceConversationImageSurface } from "@liveagent/ui/components/resource-preview/DeviceConversationImageSurface";
import { DeviceUiTranscript } from "@liveagent/ui/components/sandboxed-ui/DeviceUiTranscript";
import { TrajectoryView } from "@liveagent/ui/components/trajectory/TrajectoryView";
import { Button } from "@liveagent/ui/components/ui/button";
import { ScrollArea } from "@liveagent/ui/components/ui/scroll-area";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ScheduledConversationRun } from "@liveagent/ui/lib/automation/types";
import {
  type CheckpointRewindClient,
  CheckpointRewindProvider,
  type CheckpointRewoundInfo,
} from "@liveagent/ui/lib/chat/checkpointRewind";
import type { ComposerCommandHost } from "@liveagent/ui/lib/chat/composerCommands";
import { deriveContextUsageTokens } from "@liveagent/ui/lib/chat/contextUsage";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import { selectLatestTaskProgress } from "@liveagent/ui/lib/chat/taskProgress";
import {
  pendingToolApprovalFromToolCall,
  type RemoteToolApprovalItem,
} from "@liveagent/ui/lib/chat/toolApprovalArgs";
import {
  mergePendingUploadedFiles,
  type PendingUploadedFile,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import { useScrollFollow } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import { useThinkingLiveVersion } from "@liveagent/ui/lib/models/useThinkingLive";
import type { DevicePluginsClient } from "@liveagent/ui/lib/plugins/devicePlugins";
import type { DeviceUiSurfaceClient } from "@liveagent/ui/lib/plugins/deviceUiSurface";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { toTrajectoryMessages } from "@liveagent/ui/lib/trajectory/transcriptMessages";
import {
  type TranscriptMessageJump,
  useTranscriptMessageJump,
} from "@liveagent/ui/lib/transcript-virtual/useTranscriptMessageJump";
import type { TranscriptNavigationHandle } from "@liveagent/ui/lib/transcript-virtual/useTranscriptNavigation";
import {
  ChatComposerBar,
  type ChatComposerBarProps,
  type ChatQueueTurnPreview,
  type ContextUsageTokensSource,
} from "@liveagent/ui/pages/chat/ChatComposerBar";
import { CHAT_TRANSCRIPT_WIDTH_CSS_VAR } from "@liveagent/ui/pages/chat/transcript/TranscriptWidthControls";
import {
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { createGatewayTrajectoryHost } from "@/agent-ui-adapters/trajectory";
import {
  type ImportDeviceConversationFiles,
  useGatewayDeviceImages,
} from "@/components/GatewayDeviceImages";
import { GatewayTranscript } from "@/components/GatewayTranscript";
import { executeClarifyPromptTurn } from "@/lib/chat/clarifyPromptTurn";
import { trimLeadingHeadlessEntries } from "@/lib/chat/historyWindow";
import type {
  ConversationStreamEvent,
  ConversationSubscribeResult,
} from "@/lib/chat/stream/streamTypes";
import type { TranscriptStoreRegistry } from "@/lib/chat/stream/useConversationChat";
import { submitToolApprovalDecision } from "@/lib/chat/toolApprovalBridge";
import type { GatewayWebSocketClient } from "@/lib/gatewaySocket";
import { parseHistoryMessagesJsonAsync } from "@/lib/historyParser";
import { toModelValue } from "@/lib/providers/llm";
import {
  type AppSettings,
  applyConversationThinking,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  isThinkingAlwaysOnForModel,
  normalizeChatRuntimeControlsForProvider,
  type SelectedModel,
} from "@/lib/settings";
import {
  liveTrajectoryAuthoritativeRevision,
  liveTrajectoryEvents,
  subscribeLiveTrajectory,
} from "@/lib/trajectory/liveTrajectory";
import {
  GATEWAY_CHAT_FRAME_CLASS,
  GATEWAY_TRANSCRIPT_LATEST_BOTTOM,
  GATEWAY_TRANSCRIPT_SCROLL_CLASS,
} from "@/lib/webStyleClasses";
import type { SectionId } from "@/pages/settings/types";
import { ConversationStatsBarHost } from "../ConversationStatsBarHost";
import {
  HISTORY_DETAIL_INITIAL_MAX_MESSAGES,
  HISTORY_DETAIL_LOAD_EARLIER_PAGE_MESSAGES,
} from "../constants";
import type {
  GatewayDevicePaneDraft,
  GatewayDeviceReplyIdentity,
} from "../gatewayDeviceDraftRecovery";
import { isLocalDraftConversationId } from "../gatewayLocalDraft";
import { sendComposerCommandTurn } from "../sendComposerCommandTurn";
import type { SendChatFn } from "../types";
import { WebGoalBarHost } from "../WebGoalBarHost";
import { createWebComposerCommandHost } from "../webComposerCommandHost";
import { resolveWorkbenchComposerInputDisabled } from "./composerInputState";

type ChatQueueSnapshotLike = Parameters<
  Parameters<GatewayWebSocketClient["subscribeChatQueue"]>[0]
>[0];

/**
 * 页面级共享上下文:所有背景会话 Pane 共用一份,在 GatewayAppView 渲染体内
 * 逐帧重建(未 memo 化——宿主经 contextRef 读取最新值,不依赖引用稳定;
 * 真正的稳定化需要先把上游 handler 链整体 useCallback 化,留待性能收敛)。
 * 函数字段一律按 conversationId 显式路由,不依赖"当前展示会话"。
 */
export type GatewayConversationPaneHostContext = {
  deviceUiSurface?: DeviceUiSurfaceClient;
  devicePlugins?: DevicePluginsClient;
  mobileControls: boolean;
  api: GatewayWebSocketClient;
  registry: TranscriptStoreRegistry;
  settings: AppSettings;
  hasModels: boolean;
  showUsage: boolean;
  /** 页面级输入禁用(历史加载/压缩中)——只作用于 primary Pane。 */
  isInputDisabled: boolean;
  /** 传输层禁用(离线/协议不兼容)——背景 Pane 也要挡住发送。 */
  transportInputDisabled: boolean;
  canEditOfflineDraft: boolean;
  inputPlaceholder: string;
  modelOptions: ChatComposerBarProps["modelOptions"];
  enabledSkills: ChatComposerBarProps["enabledSkills"];
  mentionableConversations: ChatComposerBarProps["mentionableConversations"];
  searchMentionableConversations: ChatComposerBarProps["searchMentionableConversations"];
  mentionApps: ChatComposerBarProps["mentionApps"];
  contextDisplayMode: ChatComposerBarProps["contextDisplayMode"];
  commandSafetyMode: ChatComposerBarProps["commandSafetyMode"];
  onCommandSafetyModeChange: ChatComposerBarProps["onCommandSafetyModeChange"];
  sttProvider: ChatComposerBarProps["sttProvider"];
  sttProviderConfigured: boolean | undefined;
  sttTransport: ChatComposerBarProps["sttTransport"];
  onSttError: (message: string) => void;
  gitClient: ChatComposerBarProps["gitClient"];
  gitWriteEnabled: boolean;
  gitDisabledMessage: string | undefined;
  workspaceActivityClient: ChatComposerBarProps["workspaceActivityClient"];
  onOpenWorktree: ChatComposerBarProps["onOpenWorktree"];
  onWorktreeRemoved: ChatComposerBarProps["onWorktreeRemoved"];
  openSettings: (section?: SectionId, providerId?: string) => void;
  onOpenFileLink: Parameters<typeof GatewayTranscript>[0]["onOpenFileLink"];
  onLoadUploadedImagePreview: ChatComposerBarProps["onLoadUploadedImagePreview"];
  replacePendingUpload?: (
    ...args: [
      ...Parameters<NonNullable<ChatComposerBarProps["onReplacePendingUpload"]>>,
      { conversationId: string; workdir: string },
    ]
  ) => ReturnType<NonNullable<ChatComposerBarProps["onReplacePendingUpload"]>>;
  imageAnnotationAuthority?: string;
  transcriptContentWidth: number;
  selectionForConversation: (conversationId: string) => SelectedModel | undefined;
  workdirForConversation: (conversationId: string) => string;
  isConversationBusy: (conversationId: string) => boolean;
  handleConversationStreamEvent: (conversationId: string, event: ConversationStreamEvent) => void;
  handleConversationStreamSync: (
    conversationId: string,
    result: ConversationSubscribeResult,
  ) => void;
  sendChat: SendChatFn;
  importDeviceConversationFiles: ImportDeviceConversationFiles;
  fileReaderOpen?: boolean;
  closeFileReader?: () => void;
  cancelChat: (conversationId: string) => Promise<void> | void;
  materializeComposerDraftForSend: (
    draft: MentionComposerDraft,
    files: PendingUploadedFile[],
    workdir: string,
    targetConversationId?: string,
    isCurrentAgent?: () => boolean,
  ) => Promise<{
    text: string;
    uploadedFiles: PendingUploadedFile[];
    referencedConversations: ConversationMentionReference[];
  }>;
  /** 在途导入归属的会话 id:上传禁用/动画只作用在目标会话的 Pane 上。 */
  uploadingConversationId: string | null;
  getPendingUploads: (conversationId: string) => PendingUploadedFile[];
  subscribePendingUploads: (listener: () => void) => () => void;
  updatePendingUploads: (
    conversationId: string,
    updater: (current: PendingUploadedFile[]) => PendingUploadedFile[],
  ) => PendingUploadedFile[];
  importFilesForConversation: (
    conversationId: string,
    workdir: string,
    files: File[],
  ) => Promise<void>;
  getCachedComposerDraft: (conversationId: string) => MentionComposerDraft | undefined;
  setCachedComposerDraft: (conversationId: string, draft: MentionComposerDraft | null) => void;
  verifiedDeviceReplyIdentity: (
    conversationId: string,
    verified?: GatewayDeviceReplyIdentity,
  ) => GatewayDeviceReplyIdentity | undefined;
  takeDeviceReplyDraft: (
    conversationId: string,
    identity: GatewayDeviceReplyIdentity,
  ) => MentionComposerDraft | undefined;
  registerDevicePaneDraft: (
    conversationId: string,
    read: () => GatewayDevicePaneDraft | undefined,
  ) => () => void;
  notifyError: (message: string) => void;
  trajectoryHost: ReturnType<typeof createGatewayTrajectoryHost>;
};

export type GatewayConversationPrimarySurface = {
  isSending: boolean;
  isUploadingFiles: boolean;
  isInputDisabled: boolean;
  draftOnly?: boolean;
  leadingControls?: ChatComposerBarProps["leadingControls"];
  onSend: () => void;
  onStop: () => void;
  onSelectModel: ChatComposerBarProps["onSelectModel"];
  onSelectExecutionMode: ChatComposerBarProps["onSelectExecutionMode"];
  onChatRuntimeControlsChange: ChatComposerBarProps["onChatRuntimeControlsChange"];
  onPrepareChatRuntime: ChatComposerBarProps["onPrepareChatRuntime"];
  onComposerBusyChange: ChatComposerBarProps["onComposerBusyChange"];
  onPickReadableFiles: ChatComposerBarProps["onPickReadableFiles"];
  onPickWorkspaceFolder: ChatComposerBarProps["onPickWorkspaceFolder"];
  onPasteFiles: ChatComposerBarProps["onPasteFiles"];
  loadHistoryPrompts: ChatComposerBarProps["loadHistoryPrompts"];
  pendingUploadedFiles: PendingUploadedFile[];
  onRemovePendingUpload: ChatComposerBarProps["onRemovePendingUpload"];
  queuedTurns: ChatQueueTurnPreview[];
  queuePaused?: boolean;
  onRunQueuedTurnNow: ChatComposerBarProps["onRunQueuedTurnNow"];
  onMoveQueuedTurnUp: ChatComposerBarProps["onMoveQueuedTurnUp"];
  onEditQueuedTurn: ChatComposerBarProps["onEditQueuedTurn"];
  onRemoveQueuedTurn: ChatComposerBarProps["onRemoveQueuedTurn"];
  onManualCompactConfirm: ChatComposerBarProps["onManualCompactConfirm"];
  manualCompactBlocked: boolean;
  /** 主 Pane 的“/”指令宿主；背景 Pane 只提供 /stop 等按本会话路由的指令。 */
  commandHost?: ComposerCommandHost;
  approvalBar: ReactNode;
  taskProgressBar: ReactNode;
  statsBar: ReactNode;
  fileDropOverlay: ReactNode;
  transcriptExtras: ReactNode;
  stageRef?: MutableRefObject<HTMLElement | null>;
  setTranscriptScrollAreaRoot?: (node: HTMLDivElement | null) => void;
  setTranscriptViewport?: (node: HTMLDivElement | null) => void;
  transcriptViewport?: HTMLDivElement | null;
  isViewportFollowing?: () => boolean;
  viewportFollowing?: boolean;
  onJumpToBottom?: () => void;
  navRef?: Parameters<typeof GatewayTranscript>[0]["navRef"];
  onAnchorUserRowChange?: Parameters<typeof GatewayTranscript>[0]["onAnchorUserRowChange"];
  onResendFromEdit: Parameters<typeof GatewayTranscript>[0]["onResendFromEdit"];
  onBranchConversation: Parameters<typeof GatewayTranscript>[0]["onBranchConversation"];
  branchPendingMessageId: string | null;
  onSuggestionSelect: Parameters<typeof GatewayTranscript>[0]["onSuggestionSelect"];
  hasMoreHistory: boolean;
  isLoadingMoreHistory: boolean;
  onLoadEarlierHistory?: () => void;
  isLoading: boolean;
  loadingTitle?: string;
  transcriptError?: string | null;
  changedFilesActions: ChangedFilesActions;
  checkpoint: {
    client: CheckpointRewindClient;
    disabled: boolean;
    resolveAuthorizedRoots: () => string[] | Promise<string[]>;
    onRewound: (info: CheckpointRewoundInfo) => void;
  };
};

export type GatewayConversationPaneHostProps = {
  paneId: string;
  conversationId: string;
  context: GatewayConversationPaneHostContext;
  /** 本 Pane 是否承载页面当前会话(primary 绑定)。焦点切换不拆宿主。 */
  isPrimary: boolean;
  /** focusGuard 出口:页面级操作先聚焦本 Pane。 */
  onFocusPane: (conversationId: string) => void;
  /** 页面 composerRef:primary Pane 把自己的输入框挂上去。 */
  pageComposerRef?: MutableRefObject<MentionComposerHandle | null>;
  primary?: GatewayConversationPrimarySurface;
  blockedMessage?: string | null;
  /** 本 Pane 独立的会话/轨迹视图（每个会话一份，后台 Pane 也能保持）。 */
  trajectoryActive?: boolean;
  composerScopeId?: string;
  historyVersion?: string;
  messageJump?: TranscriptMessageJump;
  scheduledRun?: ScheduledConversationRun;
  isStreamAlreadySubscribed?: (conversationId: string) => boolean;
};

export function GatewayConversationPaneHost(props: GatewayConversationPaneHostProps) {
  const chatFrameRef = useRef<HTMLDivElement | null>(null);
  const {
    paneId,
    conversationId: requestedConversationId,
    context,
    isPrimary,
    onFocusPane: focusPane,
    pageComposerRef,
    primary,
    blockedMessage,
    trajectoryActive = false,
    composerScopeId,
    historyVersion,
    messageJump,
    scheduledRun,
    isStreamAlreadySubscribed,
  } = props;
  const [taskConversation, setTaskConversation] = useState<{
    requestedId: string;
    id: string;
  }>();
  const resolvedTaskConversation =
    taskConversation?.requestedId === requestedConversationId ? taskConversation : undefined;
  const conversationId = resolvedTaskConversation?.id ?? requestedConversationId;
  const identityReady = !composerScopeId || Boolean(resolvedTaskConversation);
  const onFocusPane = useCallback(() => focusPane(conversationId), [conversationId, focusPane]);
  const streamAlreadySubscribed = isStreamAlreadySubscribed?.(conversationId) === true;
  const composerKey = composerScopeId ?? conversationId;
  const taskFileInputRef = useRef<HTMLInputElement | null>(null);
  const { api, registry, replacePendingUpload } = context;
  // context 里的部分函数(sendChat 等)每次渲染都是新引用;凡按 conversationId
  // 维度运行的 effect 一律经 ref 读取,避免身份抖动触发误重置。
  const contextRef = useRef(context);
  contextRef.current = context;
  const { t } = useLocale();
  const isDraft = isLocalDraftConversationId(conversationId);
  const store = registry.get(conversationId);

  // ---- 数据层:独立流订阅 + 一次性尾窗水合 --------------------------------
  // Primary 的流由页面级 useConversationChat 占用同一 store;背景 Pane 自己订
  // 阅。isPrimary 翻转时 effect 重跑,保证「后订阅替换先订阅」后背景能把流接回。
  useEffect(() => {
    if (isDraft || isPrimary || !identityReady || streamAlreadySubscribed) return;
    return api.subscribeConversationStream(conversationId, {
      onSync: (result) => {
        store.applySync(result);
        contextRef.current.handleConversationStreamSync(conversationId, result);
      },
      onEvent: (event) => {
        store.applyEvent(event);
        contextRef.current.handleConversationStreamEvent(conversationId, event);
      },
    });
  }, [api, conversationId, identityReady, isDraft, isPrimary, store, streamAlreadySubscribed]);

  const [hydrated, setHydrated] = useState(isDraft);
  const [verifiedDraftHistory, setVerifiedDraftHistory] = useState<{
    conversationId: string;
    identity: GatewayDeviceReplyIdentity;
  }>();
  const [historyFailed, setHistoryFailed] = useState(false);
  const [historyReadVersion, setHistoryReadVersion] = useState<string>();
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const lastCompletedRunRef = useRef<string | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const loadedMaxMessagesRef = useRef(HISTORY_DETAIL_INITIAL_MAX_MESSAGES);
  const historyConversationIdRef = useRef(conversationId);
  historyConversationIdRef.current = conversationId;
  const preview = scheduledRun?.preview;
  const scheduledRunActive = Boolean(scheduledRun?.active);
  const streamingScheduledReply = scheduledRunActive && !preview?.done;
  const deferScheduledHistoryRefresh = useEffectEvent(() => streamingScheduledReply);
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation identity is the reset trigger; the effect intentionally does not read it.
  useEffect(() => {
    loadedMaxMessagesRef.current = HISTORY_DETAIL_INITIAL_MAX_MESSAGES;
    setHasMoreHistory(false);
  }, [conversationId]);
  useEffect(() => {
    if (!composerScopeId || !identityReady) return;
    const isResultConversation = (id: string) =>
      id === conversationId || id === requestedConversationId;
    const refresh = () => {
      // The scheduled preview owns the live reply until the completion refresh.
      if (!deferScheduledHistoryRefresh()) setHistoryAttempt((attempt) => attempt + 1);
    };
    const unsubscribeActivity = api.subscribeChatActivity((event) => {
      if (
        event.running ||
        !event.runId ||
        event.runId === lastCompletedRunRef.current ||
        !isResultConversation(event.conversationId)
      )
        return;
      lastCompletedRunRef.current = event.runId;
      refresh();
    });
    const unsubscribeHistory = api.subscribeHistory((event) => {
      // Desktop-origin turns can persist before the task pane receives any
      // activity event. Use the same history notification as the chat page.
      if (event.kind === "upsert" && isResultConversation(event.conversation_id)) refresh();
    });
    return () => {
      unsubscribeActivity();
      unsubscribeHistory();
    };
  }, [api, composerScopeId, conversationId, identityReady, requestedConversationId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: historyAttempt and historyVersion explicitly revalidate the read.
  useEffect(() => {
    setHistoryFailed(false);
    if (isDraft || isPrimary) {
      setHydrated(true);
      return;
    }
    const hasCachedRows = store.getSnapshot().rows.length > 0;
    if (hasCachedRows) setHydrated(true);
    if (hasCachedRows && !composerScopeId) return;
    let cancelled = false;
    if (!hasCachedRows) setHydrated(false);
    void (async () => {
      try {
        const detail = await api.getHistory(conversationId, {
          maxMessages: loadedMaxMessagesRef.current,
        });
        if (cancelled) return;
        const parsed = await parseHistoryMessagesJsonAsync(detail.messages_json);
        if (cancelled) return;
        const entries = detail.has_more === true ? trimLeadingHeadlessEntries(parsed) : parsed;
        // Scheduler records carry engine session IDs. Remote chat and its
        // events use the desktop conversation ID from the history summary.
        const id = composerScopeId
          ? detail.conversation?.id?.trim() || conversationId
          : conversationId;
        if (
          !composerScopeId &&
          detail.conversation_id === conversationId &&
          detail.conversation?.id === conversationId
        ) {
          setVerifiedDraftHistory({
            conversationId,
            identity: {
              sessionId: detail.conversation.session_id?.trim() || conversationId,
              workdir: detail.conversation.cwd?.trim() ?? "",
            },
          });
        }
        const targetStore = id === conversationId ? store : registry.get(id);
        const mode = targetStore.getSnapshot().rows.length > 0 ? "enrich" : "replace";
        targetStore.applyHistorySnapshot(entries, { mode });
        if (composerScopeId) {
          setTaskConversation((current) =>
            current?.requestedId === requestedConversationId && current.id === id
              ? current
              : { requestedId: requestedConversationId, id },
          );
        }
        setHasMoreHistory(detail.has_more === true);
        setHistoryReadVersion(historyVersion);
      } catch {
        // 历史读取失败时退化为纯实时视图;聚焦后主视图会重新拉取。
        if (!cancelled) setHistoryFailed(true);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    api,
    composerScopeId,
    conversationId,
    historyAttempt,
    historyVersion,
    isDraft,
    isPrimary,
    registry,
    requestedConversationId,
    store,
  ]);
  useEffect(() => {
    if (!preview?.text || streamingScheduledReply || !historyFailed) return;
    const timer = window.setTimeout(() => setHistoryAttempt((attempt) => attempt + 1), 4000);
    return () => window.clearTimeout(timer);
  }, [historyFailed, preview?.text, streamingScheduledReply]);

  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadingEarlierRef = useRef<Promise<void> | null>(null);
  const handleLoadEarlierHistory = useCallback(() => {
    if (isDraft) return Promise.resolve();
    if (loadingEarlierRef.current) return loadingEarlierRef.current;
    const requestedConversationId = conversationId;
    setLoadingEarlier(true);
    const nextMax = loadedMaxMessagesRef.current + HISTORY_DETAIL_LOAD_EARLIER_PAGE_MESSAGES;
    const request = (async () => {
      try {
        const detail = await api.getHistory(requestedConversationId, { maxMessages: nextMax });
        if (historyConversationIdRef.current !== requestedConversationId) return;
        const parsed = await parseHistoryMessagesJsonAsync(detail.messages_json);
        if (historyConversationIdRef.current !== requestedConversationId) return;
        const entries = detail.has_more === true ? trimLeadingHeadlessEntries(parsed) : parsed;
        store.applyHistorySnapshot(entries, { mode: "enrich" });
        loadedMaxMessagesRef.current = nextMax;
        setHasMoreHistory(detail.has_more === true);
      } catch {
        // 拉取失败保持现状,按钮可重试。
      }
    })().finally(() => {
      if (loadingEarlierRef.current === request) {
        loadingEarlierRef.current = null;
        setLoadingEarlier(false);
      }
    });
    loadingEarlierRef.current = request;
    return request;
  }, [api, conversationId, isDraft, store]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversation identity cancels the previous pane's loading indicator; the effect intentionally does not read it.
  useEffect(() => {
    loadingEarlierRef.current = null;
    setLoadingEarlier(false);
  }, [conversationId]);

  const subscribeTranscript = useCallback(
    (listener: () => void) => store.subscribe(listener),
    [store],
  );
  const getTranscript = useCallback(() => store.getSnapshot(), [store]);
  const transcript = useSyncExternalStore(subscribeTranscript, getTranscript, getTranscript);
  const paneTrajectoryMessages = useMemo(
    () => toTrajectoryMessages(transcript.rows),
    [transcript.rows],
  );
  const liveTrajectory = useSyncExternalStore(subscribeLiveTrajectory, () =>
    isDraft ? null : liveTrajectoryEvents(conversationId),
  );
  const trajectoryAuthoritativeRevision = useSyncExternalStore(subscribeLiveTrajectory, () =>
    liveTrajectoryAuthoritativeRevision(conversationId),
  );

  // ---- 每会话队列:订阅网关中继的队列快照,revision 单调递增去旧 ----------
  const [queuedTurns, setQueuedTurns] = useState<ChatQueueTurnPreview[]>([]);
  const [queuePaused, setQueuePaused] = useState<boolean | undefined>();
  const [queueControlPending, setQueueControlPending] = useState(false);
  const queueControlPendingRef = useRef(false);
  const queuedTurnsRef = useRef<ChatQueueTurnPreview[]>([]);
  const queueRevisionRef = useRef(0);
  const queueConversationRef = useRef(conversationId);
  queueConversationRef.current = conversationId;
  const applyQueueSnapshot = useCallback(
    (snapshot: ChatQueueSnapshotLike | null | undefined) => {
      if (
        !snapshot ||
        snapshot.conversationId !== conversationId ||
        queueConversationRef.current !== conversationId
      )
        return;
      const revision = Number(snapshot.revision ?? 0);
      if (revision < queueRevisionRef.current) return;
      queueRevisionRef.current = revision;
      const items = snapshot.items.map((item) => ({
        id: item.id,
        previewText: item.previewText,
        fileCount: item.fileCount,
      }));
      queuedTurnsRef.current = items;
      setQueuedTurns(items);
      setQueuePaused(typeof snapshot.paused === "boolean" ? snapshot.paused : undefined);
    },
    [conversationId],
  );
  useEffect(() => {
    if (isDraft) return;
    queueRevisionRef.current = 0;
    queuedTurnsRef.current = [];
    setQueuedTurns([]);
    setQueuePaused(undefined);
    let cancelled = false;
    const unsubscribe = api.subscribeChatQueue(applyQueueSnapshot);
    void api
      .chatQueueGet(conversationId)
      .then((response) => {
        if (!cancelled) applyQueueSnapshot(response.snapshot);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, applyQueueSnapshot, conversationId, isDraft]);

  const handleQueuePausedChange = useCallback(
    async (paused: boolean) => {
      if (queueControlPendingRef.current) return;
      queueControlPendingRef.current = true;
      setQueueControlPending(true);
      try {
        const response = await api.chatQueueSetPaused(
          conversationId,
          paused,
          queueRevisionRef.current,
        );
        applyQueueSnapshot(response.snapshot);
        if (!response.accepted) throw new Error(response.message || t("chat.queue.controlFailed"));
      } catch (error) {
        context.notifyError(error instanceof Error ? error.message : t("chat.queue.controlFailed"));
        void api
          .chatQueueGet(conversationId)
          .then((response) => applyQueueSnapshot(response.snapshot))
          .catch(() => undefined);
      } finally {
        queueControlPendingRef.current = false;
        setQueueControlPending(false);
      }
    },
    [api, applyQueueSnapshot, context, conversationId, t],
  );

  // 队列操作直接以本会话 id 走网关 RPC(等价桌面端按会话路由);编辑队列项
  // 需要页面级编辑会话,与桌面端一致先聚焦本 Pane。
  const handleRunQueuedTurnNow = useCallback(
    (id: string) => {
      void api
        .chatQueueRunNow(conversationId, id)
        .then((response) => applyQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyQueueSnapshot, conversationId],
  );
  const handleMoveQueuedTurnUp = useCallback(
    (id: string) => {
      void api
        .chatQueueMove(conversationId, id, "up")
        .then((response) => applyQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyQueueSnapshot, conversationId],
  );
  const handleRemoveQueuedTurn = useCallback(
    (id: string) => {
      void api
        .chatQueueRemove(conversationId, id)
        .then((response) => applyQueueSnapshot(response.snapshot))
        .catch(() => undefined);
    },
    [api, applyQueueSnapshot, conversationId],
  );

  // ---- 每会话待发附件:直接订阅页面级 per-conversation 存储 ----------------
  // 文档级 paste/drop 可以写入背景会话；订阅保证 chip 与发送读取同一份
  // 权威快照，不再依赖 Pane 自己动作后的手动镜像刷新。
  const pendingUploads = useSyncExternalStore(
    context.subscribePendingUploads,
    () => context.getPendingUploads(composerKey),
    () => context.getPendingUploads(composerKey),
  );

  // ---- 发送/停止:严格按本 Pane 的 conversationId 路由(桌面端口径) --------
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const sendInFlightRef = useRef(false);
  const workdir = context.workdirForConversation(conversationId);
  const workdirRef = useRef(workdir);
  workdirRef.current = workdir;
  const selection = context.selectionForConversation(conversationId);
  const selectedProvider = selection
    ? context.settings.customProviders.find((item) => item.id === selection.customProviderId)
    : undefined;
  // 运行期思考档位补充到达会改变档位列表/恒开判定/当前档钳制，版本号计入依赖使
  // memo 跟进。
  const thinkingLiveVersion = useThinkingLiveVersion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: thinkingLiveVersion 是刻意的失效信号，运行期档位补充到达后重钳当前档；selection 按字段比较，避免每次解析出新对象触发重算。
  const paneRuntimeControls = useMemo(
    () =>
      normalizeChatRuntimeControlsForProvider(
        applyConversationThinking(context.settings.chatRuntimeControls, selection),
        {
          providerId: selectedProvider?.type,
          nativeWebSearchSupported: selectedProvider?.nativeWebSearchSupported,
          webSearchFallbackAvailable: context.settings.kbrainWebSearch?.available,
          requestFormat: selectedProvider?.requestFormat,
          modelId: selection?.model,
        },
      ),
    [
      context.settings.chatRuntimeControls,
      context.settings.kbrainWebSearch?.available,
      selectedProvider?.nativeWebSearchSupported,
      selectedProvider?.requestFormat,
      selectedProvider?.type,
      selection?.model,
      selection?.thinkingEnabled,
      selection?.reasoning,
      thinkingLiveVersion,
    ],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: thinkingLiveVersion 是刻意的失效信号，运行期档位补充到达后重算。
  const paneReasoningOptions = useMemo(
    () =>
      getChatRuntimeReasoningLevelsForProvider({
        providerId: selectedProvider?.type,
        requestFormat: selectedProvider?.requestFormat,
        modelId: selection?.model,
      }),
    [
      selectedProvider?.requestFormat,
      selectedProvider?.type,
      selection?.model,
      thinkingLiveVersion,
    ],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: thinkingLiveVersion 是刻意的失效信号，运行期档位补充到达后重算。
  const paneThinkingAlwaysOn = useMemo(
    () => isThinkingAlwaysOnForModel(selectedProvider?.type ?? "claude_code", selection?.model),
    [selectedProvider?.type, selection?.model, thinkingLiveVersion],
  );

  // 提示词澄清执行器（桌面端背景 Pane 口径）：模型覆盖/回退/错误拍平在
  // executeClarifyPromptTurn（两宿主共用），fallback 按本 Pane 会话解析。
  // runTurn 在 useClarifySession 内走 latest-ref，依赖变化只换身份不打断会话。
  const runClarifyTurn = useCallback<RunClarifyTurn>(
    (messages, _signal, onTextDelta) =>
      executeClarifyPromptTurn(
        context.api,
        context.settings,
        {
          provider: selectedProvider,
          model: selection?.model,
          runtimeControls: paneRuntimeControls,
        },
        messages,
        onTextDelta,
      ),
    [context, selection, selectedProvider, paneRuntimeControls],
  );
  // 与桌面端口径一致：会话无 workdir 时不传空串，避免系统提示词带噪音。
  const clarifyContext = useMemo<ClarifyContext | undefined>(
    () => (workdir ? { workdir } : undefined),
    [workdir],
  );

  const isRunning =
    scheduledRunActive ||
    transcript.activeRun !== null ||
    context.isConversationBusy(conversationId);
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  const images = useGatewayDeviceImages({
    api,
    conversationId,
    workdir,
    enabled: !isDraft && !scheduledRun && !trajectoryActive,
    offline: context.transportInputDisabled,
    zh: context.settings.locale === "zh-CN",
    store,
    importFiles: context.importDeviceConversationFiles,
    send: context.sendChat,
    isRunning: () => isRunningRef.current,
    fileReaderOpen: isPrimary && context.fileReaderOpen,
    closeFileReader: isPrimary ? context.closeFileReader : undefined,
  });

  const handleSend = useCallback(() => {
    if (sendInFlightRef.current || context.transportInputDisabled) return;
    // 本会话的附件导入尚未落账时不得发送:此刻 getPendingUploads 读到的
    // 是空列表,消息会丢附件(与主 Pane 的上传中禁用同一边界)。
    if (context.uploadingConversationId === composerKey) return;
    const composer = composerRef.current;
    const draft = composer?.getDraft() ?? null;
    const isCurrentAgent = context.api.captureActiveAgentScope();
    sendInFlightRef.current = true;
    void (async () => {
      try {
        const files = context.getPendingUploads(composerKey).slice();
        let text: string;
        let uploadedFiles: PendingUploadedFile[];
        let referencedConversations = draft?.conversationMentions ?? [];
        try {
          const materialized = draft
            ? await context.materializeComposerDraftForSend(
                draft,
                files,
                workdirRef.current,
                composerKey,
                isCurrentAgent,
              )
            : { text: "", uploadedFiles: files, referencedConversations: [] };
          text = materialized.text;
          uploadedFiles = materialized.uploadedFiles;
          referencedConversations = materialized.referencedConversations;
        } catch (error) {
          if (isCurrentAgent())
            context.notifyError(error instanceof Error ? error.message : "大段粘贴内容导入失败");
          return;
        }
        if (!isCurrentAgent() || (!text && uploadedFiles.length === 0)) return;
        composerRef.current?.clear();
        if (composerScopeId) context.setCachedComposerDraft(composerKey, null);
        context.updatePendingUploads(composerKey, () => []);
        // 忙时入队(与桌面端背景 Pane enqueue 一致):队列面板持有提示词,
        // 不做转录乐观回显;闲时直发。
        const busy = isRunningRef.current || queuedTurnsRef.current.length > 0;
        const restore = () => {
          if (!isCurrentAgent()) return;
          context.updatePendingUploads(composerKey, (current) =>
            mergePendingUploadedFiles(current, uploadedFiles),
          );
          const currentComposer = composerRef.current;
          if (draft && currentComposer && !currentComposer.hasContent()) {
            currentComposer.setDraft(draft);
          } else if (
            composerScopeId &&
            draft &&
            !currentComposer &&
            !context.getCachedComposerDraft(composerKey)
          ) {
            context.setCachedComposerDraft(composerKey, draft);
          }
        };
        try {
          const outcome = await context.sendChat(text, {
            isCurrentAgent,
            conversationId,
            uploadedFiles,
            referencedConversations,
            runtimeControls: paneRuntimeControls,
            preserveComposerOnStart: Boolean(composerScopeId),
            queuePolicy: busy ? "append" : "auto",
            optimisticEcho: !busy,
          });
          if (outcome?.kind === "failed" || (composerScopeId && !outcome)) restore();
        } catch {
          restore();
        }
      } finally {
        sendInFlightRef.current = false;
      }
    })();
  }, [composerKey, composerScopeId, context, conversationId, paneRuntimeControls]);

  const handleStop = useCallback(() => {
    if (scheduledRun?.active) {
      scheduledRun.cancel?.();
      return;
    }
    // 与桌面端/聚焦舞台一致:有排队回合先"停当前、跑下一条",否则纯停止。
    const nextQueuedTurn = queuedTurnsRef.current[0];
    if (nextQueuedTurn && !queuePaused) {
      handleRunQueuedTurnNow(nextQueuedTurn.id);
      return;
    }
    void context.cancelChat(conversationId);
  }, [context, conversationId, handleRunQueuedTurnNow, queuePaused, scheduledRun]);
  // 背景 Pane 的“/”指令：目录、发送、目标清除与定时任务都按本会话路由；
  // /plan、/model 与 /rewind 依赖主 Pane 的开关、模型与回退上下文，这里不提供。
  // context 每次渲染都是新对象：读数经 ref 取最新值，宿主引用只随 api 与会话变化，
  // 否则输入框会在每次渲染时重新拉指令目录。
  const commandLatestRef = useRef({ context, paneRuntimeControls });
  commandLatestRef.current = { context, paneRuntimeControls };
  const commandApi = context.api;
  const commandDevicePlugins = context.devicePlugins;
  const backgroundCommandHost = useMemo<ComposerCommandHost>(
    () =>
      createWebComposerCommandHost({
        t,
        client: commandApi,
        devicePlugins: commandDevicePlugins,
        getConversationId: () => conversationId,
        getWorkdir: () => workdirRef.current || undefined,
        getRuntimeControls: () => commandLatestRef.current.paneRuntimeControls,
        sendTurn: (text, command, runtimeControls) =>
          sendComposerCommandTurn(commandLatestRef.current.context.sendChat, t, text, command, {
            conversationId,
            runtimeControls,
            isBusy: () => commandLatestRef.current.context.isConversationBusy(conversationId),
          }),
      }),
    [commandApi, commandDevicePlugins, conversationId, t],
  );

  // ---- 草稿:挂载恢复缓存,卸载(聚焦切换/关 Pane)写回缓存(桌面端口径) --
  // hydrated 必须参与触发:背景 Pane 冷启动时先渲染加载占位,composer 尚未
  // 挂载,恢复会被无声跳过;水合完成后重跑一次才能把缓存草稿真正写进输入框。
  const composerMounted =
    hydrated && identityReady && (!composerScopeId || !historyFailed || transcript.rows.length > 0);
  const touchedDraftKeys = useRef(new Set<string>());
  const previousDraftReceipts = useRef({ key: composerKey, files: pendingUploads });
  const draftRestoreAttemptRef = useRef("");
  const durableReplyIdentity =
    composerScopeId || historyFailed
      ? undefined
      : context.verifiedDeviceReplyIdentity(
          conversationId,
          verifiedDraftHistory?.conversationId === conversationId
            ? verifiedDraftHistory.identity
            : undefined,
        );
  const durableReplyIdentityRef = useRef(durableReplyIdentity);
  durableReplyIdentityRef.current = durableReplyIdentity;
  useLayoutEffect(() => {
    if (!composerMounted) return;
    const composer = composerRef.current;
    const {
      getCachedComposerDraft,
      setCachedComposerDraft,
      registerDevicePaneDraft,
      getPendingUploads,
    } = contextRef.current;
    const cached = getCachedComposerDraft(composerKey);
    if (cached) {
      composer?.setDraft(cached);
    } else {
      composer?.clear();
    }
    const unregister =
      !composerScopeId && composer
        ? registerDevicePaneDraft(composerKey, () => ({
            draft: composer.getDraft(),
            identity: durableReplyIdentityRef.current,
            submitting: sendInFlightRef.current,
          }))
        : undefined;
    return () => {
      unregister?.();
      const nextDraft = composer?.getDraft();
      if (!nextDraft) return;
      if (nextDraft.isEmpty && !getPendingUploads(composerKey).length) {
        if (composerScopeId || touchedDraftKeys.current.has(composerKey))
          setCachedComposerDraft(composerKey, null);
        return;
      }
      setCachedComposerDraft(composerKey, nextDraft);
    };
  }, [composerKey, composerMounted, composerScopeId]);

  const replySessionId = durableReplyIdentity?.sessionId;
  const replyWorkdir = durableReplyIdentity?.workdir;
  useLayoutEffect(() => {
    const previous = previousDraftReceipts.current;
    if (
      (previous.key === composerKey && previous.files !== pendingUploads) ||
      context.uploadingConversationId === composerKey
    )
      touchedDraftKeys.current.add(composerKey);
    previousDraftReceipts.current = { key: composerKey, files: pendingUploads };
  }, [composerKey, context.uploadingConversationId, pendingUploads]);
  useLayoutEffect(() => {
    if (!composerMounted || !replySessionId || replyWorkdir === undefined) return;
    const attemptKey = JSON.stringify([composerKey, replySessionId, replyWorkdir]);
    if (draftRestoreAttemptRef.current === attemptKey) return;
    const composer = composerRef.current;
    if (!composer) return;
    draftRestoreAttemptRef.current = attemptKey;
    if (touchedDraftKeys.current.has(composerKey) || composer.hasContent()) return;
    const recovered = contextRef.current.takeDeviceReplyDraft(composerKey, {
      sessionId: replySessionId,
      workdir: replyWorkdir,
    });
    if (recovered) composer.setDraft(recovered);
  }, [composerKey, composerMounted, replySessionId, replyWorkdir]);

  useLayoutEffect(() => {
    if (!isPrimary || !pageComposerRef) return;
    // Assign on attach only. Nulling on detach is order-dependent: the
    // outgoing primary's cleanup can run after the incoming assign (or
    // assign null while this pane's composer is still mounting) and leave
    // Enter reading an empty page composer.
    if (composerRef.current) pageComposerRef.current = composerRef.current;
  });

  // ---- 转录滚动跟随 -----------------------------------------------------
  // 背景 Pane 与主 Pane 共用同一套滚动跟随引擎：主 Pane 的视口由 GatewayApp
  // 持有的引擎接管（经 primary.setTranscriptViewport 接线），本地这套只在
  // 非主态生效。回贴区为 0：只有真正到达底部才恢复跟随。此前这里手写了一套
  // "距底不足 48px 即视为跟随、行数一变就写 scrollTop" 的逻辑，读者停在底部
  // 附近时会被每次流式增量吸回底部，而且与桌面端各 Pane 的引擎语义不一致。
  const usePrimary = Boolean(isPrimary && primary);
  const [paneScrollAreaRoot, setPaneScrollAreaRoot] = useState<HTMLDivElement | null>(null);
  const [paneViewport, setPaneViewport] = useState<HTMLDivElement | null>(null);
  const { handle: paneFollow, following: paneFollowing } = useScrollFollow({
    viewport: paneViewport,
    listenerRoot: paneScrollAreaRoot,
    enabled: !usePrimary,
    config: { reattachZonePx: 0 },
  });
  // 会话切换后落在最新消息上，与桌面端 ChatTranscript 一致。
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId 是有意的重置信号，动作由 handle 执行。
  useLayoutEffect(() => {
    if (!usePrimary) paneFollow.stickToBottom();
  }, [conversationId, paneFollow, usePrimary]);
  const rowCount = transcript.rows.length;
  const taskResultNavigation = useRef<TranscriptNavigationHandle | null>(null);
  useTranscriptMessageJump({
    target: messageJump,
    rowKey: messageJump
      ? transcript.rows.find(
          (row) => row.kind === "user" && row.messageRef?.messageId === messageJump.messageId,
        )?.key
      : undefined,
    historyBoundary: transcript.rows[0]?.key ?? "",
    hasMoreHistory,
    loadEarlier: handleLoadEarlierHistory,
    ready: Boolean(paneViewport) && hydrated && historyReadVersion === historyVersion,
    jumpToRow: (key) => {
      paneFollow.breakFollow();
      taskResultNavigation.current?.scrollToRowKey(key);
    },
  });

  // ---- 每会话模型/用量/进度/审批 -------------------------------------------
  const selectedValue = selection
    ? toModelValue(selection.customProviderId, selection.model)
    : undefined;
  const modelLabel = useMemo(() => {
    if (!selection) return t("chat.selectModel");
    return selectedProvider ? `${selectedProvider.name} / ${selection.model}` : selection.model;
  }, [selectedProvider, selection, t]);
  const contextWindow = useMemo(() => {
    if (!selection) return undefined;
    const provider = context.settings.customProviders.find(
      (item) => item.id === selection.customProviderId,
    );
    return provider ? findProviderModelConfig(provider, selection.model).contextWindow : undefined;
  }, [context.settings.customProviders, selection]);
  const contextUsageTokensSource = useMemo<ContextUsageTokensSource>(() => {
    let cache: { revision: number; value: number | undefined } | null = null;
    return {
      subscribe: store.subscribe,
      getContextUsageTokens: () => {
        const snapshot = store.getSnapshot();
        if (cache && cache.revision === snapshot.revision) return cache.value;
        const value = deriveContextUsageTokens(snapshot.rows);
        cache = { revision: snapshot.revision, value };
        return value;
      },
    };
  }, [store]);
  const taskProgressSnapshot = useMemo(
    () => selectLatestTaskProgress(transcript.rows),
    [transcript.rows],
  );
  const pendingToolApprovals = useMemo(() => {
    const result: RemoteToolApprovalItem[] = [];
    for (const row of transcript.rows) {
      if (row.kind !== "assistant") continue;
      for (const round of row.rounds) {
        for (const block of round.blocks) {
          if (block.kind !== "tool") continue;
          const { toolCall, toolResult } = block.item;
          const pending = toolResult ? null : pendingToolApprovalFromToolCall(toolCall);
          if (pending) result.push(pending);
        }
      }
    }
    return result;
  }, [transcript.rows]);
  // 审批决定显式携带本 Pane 的会话 id,绝不落到聚焦会话上。
  const approvalBar =
    pendingToolApprovals.length > 0 ? (
      <ToolApprovalBar
        key={conversationId}
        pending={pendingToolApprovals}
        workdir={workdir}
        onDecide={(toolCallId, decision, options) =>
          submitToolApprovalDecision(toolCallId, decision, conversationId, options)
        }
      />
    ) : null;

  const promptId = preview?.prompt?.messageId;
  const scheduledPromptIndex = promptId
    ? transcript.rows.findIndex(
        (row) => row.kind === "user" && row.messageRef?.messageId === promptId,
      )
    : -1;
  const followingPrompt =
    scheduledPromptIndex < 0
      ? undefined
      : transcript.rows
          .slice(scheduledPromptIndex + 1)
          .find((row) => row.kind === "assistant" || row.kind === "user");
  const scheduledHistoryReplyKey =
    !streamingScheduledReply && followingPrompt?.kind === "assistant"
      ? followingPrompt.key
      : undefined;
  const showScheduledReply =
    !scheduledHistoryReplyKey &&
    scheduledRun &&
    preview &&
    (streamingScheduledReply ||
      ((preview.text || preview.prompt) &&
        (historyFailed || historyReadVersion !== historyVersion)));
  const scheduledTurn =
    scheduledRun && preview && (showScheduledReply || promptId)
      ? {
          key: `scheduled-preview:${scheduledRun.run.id}`,
          promptHistoryKey: transcript.rows[scheduledPromptIndex]?.key,
          replyHistoryKey: scheduledHistoryReplyKey,
          prompt:
            showScheduledReply && preview.prompt && scheduledPromptIndex < 0 ? (
              <ScheduledPromptPreview prompt={preview.prompt} />
            ) : undefined,
          reply: showScheduledReply ? (
            <ScheduledReplyPreview
              preview={preview}
              startedAt={scheduledRun.run.startedAt}
              streaming={streamingScheduledReply}
              showPrompt={false}
            />
          ) : undefined,
        }
      : undefined;

  if (
    !showScheduledReply &&
    ((!identityReady && !historyFailed) || (!hydrated && !isPrimary && rowCount === 0))
  ) {
    return (
      <div
        data-workbench-pane-id={paneId}
        data-workbench-surface="conversation"
        data-workbench-surface-id={`conversation:${conversationId}`}
        className="flex size-full min-h-0 items-center justify-center"
      >
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (
    !showScheduledReply &&
    composerScopeId &&
    historyFailed &&
    (!identityReady || rowCount === 0)
  ) {
    const zh = context.settings.locale === "zh-CN";
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-muted-foreground" role="status">
          {zh ? "暂时无法读取结果对话。" : "The result conversation could not be loaded."}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setHistoryAttempt((attempt) => attempt + 1)}
          >
            {zh ? "重试" : "Retry"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onFocusPane}>
            {zh ? "打开结果对话" : "Open result conversation"}
          </Button>
        </div>
      </div>
    );
  }

  const transcriptFollowing = usePrimary
    ? (primary?.viewportFollowing ?? paneFollowing)
    : paneFollowing;
  const transcriptIsViewportFollowing =
    usePrimary && primary?.isViewportFollowing
      ? primary.isViewportFollowing
      : paneFollow.isFollowing;
  const handleJumpToBottom =
    usePrimary && primary?.onJumpToBottom ? primary.onJumpToBottom : paneFollow.jumpToBottom;
  const transcriptTree = (
    <GatewayTranscript
      expandProcessByDefault={context.settings.customSettings.chatTranscript.expandProcessByDefault}
      detailedProgress={context.settings.customSettings.chatTranscript.showDetailedProgress}
      conversationId={conversationId}
      rows={transcript.rows}
      liveStartIndex={transcript.liveStartIndex}
      activeTurnKey={transcript.activeTurnKey}
      contentWidth={context.transcriptContentWidth}
      isViewportFollowing={transcriptIsViewportFollowing}
      viewportFollowing={transcriptFollowing}
      toolStatus={transcript.toolStatus}
      toolStatusIsCompaction={transcript.toolStatusIsCompaction}
      retryAttempts={transcript.retryAttempts}
      isStreaming={transcript.activeRun !== null}
      isLoading={usePrimary ? primary?.isLoading : false}
      loadingTitle={usePrimary ? primary?.loadingTitle : undefined}
      error={usePrimary ? (primary?.transcriptError ?? undefined) : undefined}
      hasModels={context.hasModels}
      onOpenSettings={context.openSettings}
      hasMoreHistory={usePrimary ? (primary?.hasMoreHistory ?? false) : hasMoreHistory}
      isLoadingMoreHistory={usePrimary ? (primary?.isLoadingMoreHistory ?? false) : loadingEarlier}
      onLoadEarlierHistory={
        usePrimary
          ? primary?.onLoadEarlierHistory
          : hasMoreHistory
            ? handleLoadEarlierHistory
            : undefined
      }
      showUsage={context.showUsage}
      usageContextWindow={contextWindow}
      workspaceRoot={workdir}
      onOpenFileLink={context.onOpenFileLink}
      gitClient={context.gitClient}
      onLoadUploadedImagePreview={context.onLoadUploadedImagePreview}
      navRef={usePrimary ? primary?.navRef : messageJump ? taskResultNavigation : undefined}
      onAnchorUserRowChange={usePrimary ? primary?.onAnchorUserRowChange : undefined}
      onResendFromEdit={usePrimary ? primary?.onResendFromEdit : () => onFocusPane()}
      onBranchConversation={usePrimary ? primary?.onBranchConversation : undefined}
      branchPendingMessageId={
        usePrimary ? (primary?.branchPendingMessageId ?? undefined) : undefined
      }
      onSuggestionSelect={usePrimary ? primary?.onSuggestionSelect : () => onFocusPane()}
      onQuoteSelection={(text) => {
        composerRef.current?.insertQuote(text);
      }}
      onCommentSelection={(comment) => composerRef.current?.upsertComment?.(comment) != null}
      scheduledTurn={scheduledTurn}
    />
  );

  // Each pane explicitly owns its composer-height variable, so concurrent
  // panes never discover or update one another through a DOM ancestor query.
  const surface = (
    <div
      data-workbench-pane-id={paneId}
      data-workbench-surface="conversation"
      data-workbench-surface-id={`conversation:${conversationId}`}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onInputCapture={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest(".mention-composer"))
          touchedDraftKeys.current.add(composerKey);
      }}
    >
      {composerScopeId && (
        <input
          ref={taskFileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length) void context.importFilesForConversation(composerKey, workdir, files);
          }}
        />
      )}
      {blockedMessage ? (
        <div
          data-workbench-pane-blocked=""
          className={cn(
            "flex shrink-0 items-center gap-2",
            "border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400",
          )}
        >
          {blockedMessage}
        </div>
      ) : null}
      <div
        ref={chatFrameRef}
        className={cn(
          GATEWAY_CHAT_FRAME_CLASS,
          "relative flex size-full h-full min-h-0 min-w-0 flex-1",
          "flex-col overflow-hidden max-820:h-full",
        )}
      >
        <section
          ref={usePrimary ? primary?.stageRef : undefined}
          className="gateway-transcript-stage relative min-h-0 flex-1 overflow-hidden @container"
          style={
            {
              [CHAT_TRANSCRIPT_WIDTH_CSS_VAR]: `${context.transcriptContentWidth}px`,
            } as CSSProperties
          }
        >
          {trajectoryActive ? (
            <TrajectoryView
              conversationId={conversationId}
              host={context.trajectoryHost}
              messages={paneTrajectoryMessages}
              workdir={workdir}
              hasMoreMessages={usePrimary ? (primary?.hasMoreHistory ?? false) : hasMoreHistory}
              loadEarlierMessages={
                usePrimary
                  ? primary?.onLoadEarlierHistory
                  : hasMoreHistory
                    ? handleLoadEarlierHistory
                    : undefined
              }
              liveEvents={liveTrajectory ?? undefined}
              authoritativeRevision={trajectoryAuthoritativeRevision}
            />
          ) : (
            <div className="relative h-full min-h-0">
              <ScrollArea
                ref={usePrimary ? primary?.setTranscriptScrollAreaRoot : setPaneScrollAreaRoot}
                viewportProps={{
                  className: "chat-transcript-viewport",
                  "aria-label": t("chat.transcript.messages"),
                }}
                viewportRef={
                  usePrimary && primary?.setTranscriptViewport
                    ? primary.setTranscriptViewport
                    : setPaneViewport
                }
                className={GATEWAY_TRANSCRIPT_SCROLL_CLASS}
              >
                {usePrimary && primary ? (
                  <ChangedFilesActionsProvider value={primary.changedFilesActions}>
                    <CheckpointRewindProvider
                      client={primary.checkpoint.client}
                      conversationId={conversationId}
                      disabled={primary.checkpoint.disabled}
                      resolveAuthorizedRoots={() =>
                        Promise.resolve(primary.checkpoint.resolveAuthorizedRoots())
                      }
                      onRewound={primary.checkpoint.onRewound}
                    >
                      {transcriptTree}
                    </CheckpointRewindProvider>
                  </ChangedFilesActionsProvider>
                ) : (
                  transcriptTree
                )}
              </ScrollArea>
              {usePrimary ? primary?.transcriptExtras : null}
              {!transcriptFollowing && rowCount > 0 && !(usePrimary && primary?.isLoading) ? (
                <TranscriptLatestButton
                  bottom={GATEWAY_TRANSCRIPT_LATEST_BOTTOM}
                  viewport={usePrimary ? (primary?.transcriptViewport ?? null) : paneViewport}
                  onJump={handleJumpToBottom}
                />
              ) : null}
            </div>
          )}
          <ChatComposerBar
            focusImagePlacement
            surface="web"
            mobileControls={context.mobileControls}
            overlayHeightOwnerRef={chatFrameRef}
            runClarifyTurn={
              context.settings.customSettings.promptClarifyEnabled ? runClarifyTurn : undefined
            }
            clarifyContext={clarifyContext}
            conversationId={conversationId}
            hidden={trajectoryActive}
            composerRef={composerRef}
            isSending={usePrimary ? (primary?.isSending ?? isRunning) : isRunning}
            isUploadingFiles={
              usePrimary
                ? (primary?.isUploadingFiles ?? false)
                : context.uploadingConversationId === composerKey
            }
            isInputDisabled={resolveWorkbenchComposerInputDisabled({
              isPrimary: usePrimary,
              primaryInputDisabled: primary?.isInputDisabled ?? context.isInputDisabled,
              transportInputDisabled: context.transportInputDisabled,
              conversationIsCompacting: transcript.toolStatusIsCompaction === true,
            })}
            draftOnly={
              usePrimary
                ? primary?.draftOnly
                : context.canEditOfflineDraft &&
                  !historyFailed &&
                  !transcript.toolStatusIsCompaction
            }
            sttSessionKey={conversationId}
            sttProvider={context.sttProvider}
            sttProviderConfigured={context.sttProviderConfigured}
            sttTransport={context.sttTransport}
            onSttError={context.onSttError}
            inputPlaceholder={context.inputPlaceholder}
            workdir={workdir}
            enabledSkills={context.enabledSkills}
            mentionableConversations={context.mentionableConversations}
            searchMentionableConversations={context.searchMentionableConversations}
            mentionApps={context.mentionApps}
            commandHost={
              usePrimary && primary
                ? primary.commandHost
                : composerScopeId
                  ? undefined
                  : backgroundCommandHost
            }
            goalBar={
              <WebGoalBarHost
                key={`goal-${conversationId}`}
                conversationId={isDraft ? undefined : conversationId}
                client={context.api}
                commandHost={
                  usePrimary && primary
                    ? primary.commandHost
                    : composerScopeId
                      ? undefined
                      : backgroundCommandHost
                }
                running={usePrimary ? (primary?.isSending ?? isRunning) : isRunning}
              />
            }
            executionMode={context.settings.system.executionMode}
            hasModels={context.hasModels}
            currentModelLabel={modelLabel}
            modelOptions={context.modelOptions}
            selectedValue={selectedValue}
            chatRuntimeControls={paneRuntimeControls}
            webSearchFallback={context.settings.kbrainWebSearch}
            commandSafetyMode={context.commandSafetyMode}
            onCommandSafetyModeChange={context.onCommandSafetyModeChange}
            reasoningOptions={paneReasoningOptions}
            thinkingAlwaysOn={paneThinkingAlwaysOn}
            contextUsageTokensSource={contextUsageTokensSource}
            contextWindow={contextWindow}
            contextDisplayMode={context.contextDisplayMode}
            onManualCompactConfirm={
              usePrimary && primary ? primary.onManualCompactConfirm : () => onFocusPane()
            }
            manualCompactBlocked={
              usePrimary
                ? (primary?.manualCompactBlocked ?? false)
                : transcript.toolStatusIsCompaction === true
            }
            gitClient={context.gitClient}
            gitWriteEnabled={context.gitWriteEnabled}
            gitDisabledMessage={context.gitDisabledMessage}
            workspaceActivityClient={context.workspaceActivityClient}
            onOpenWorktree={context.onOpenWorktree}
            onWorktreeRemoved={context.onWorktreeRemoved}
            onSend={usePrimary && primary ? primary.onSend : handleSend}
            onStop={usePrimary && primary ? primary.onStop : handleStop}
            stopDisabled={
              context.transportInputDisabled ||
              Boolean(scheduledRun?.active && !scheduledRun.cancel)
            }
            onComposerBusyChange={
              usePrimary && primary ? primary.onComposerBusyChange : () => undefined
            }
            onSelectModel={usePrimary && primary ? primary.onSelectModel : () => onFocusPane()}
            onSelectExecutionMode={
              usePrimary && primary ? primary.onSelectExecutionMode : () => onFocusPane()
            }
            onOpenSettings={context.openSettings}
            onChatRuntimeControlsChange={
              usePrimary && primary ? primary.onChatRuntimeControlsChange : () => onFocusPane()
            }
            onPrepareChatRuntime={usePrimary && primary ? primary.onPrepareChatRuntime : undefined}
            onPickReadableFiles={
              usePrimary && primary
                ? primary.onPickReadableFiles
                : composerScopeId
                  ? () => taskFileInputRef.current?.click()
                  : onFocusPane
            }
            onPickWorkspaceFolder={
              usePrimary && primary ? primary.onPickWorkspaceFolder : () => onFocusPane()
            }
            leadingControls={usePrimary ? primary?.leadingControls : undefined}
            onPasteFiles={
              usePrimary && primary
                ? primary.onPasteFiles
                : (files) => {
                    void context.importFilesForConversation(composerKey, workdirRef.current, files);
                  }
            }
            onLoadUploadedImagePreview={context.onLoadUploadedImagePreview}
            loadHistoryPrompts={usePrimary && primary ? primary.loadHistoryPrompts : undefined}
            pendingUploadedFiles={
              usePrimary && primary ? primary.pendingUploadedFiles : pendingUploads
            }
            onReplacePendingUpload={
              replacePendingUpload && workdir
                ? (relativePath, replacement) =>
                    replacePendingUpload(relativePath, replacement, {
                      conversationId: composerKey,
                      workdir,
                    })
                : undefined
            }
            imageAnnotationAuthority={context.imageAnnotationAuthority}
            onRemovePendingUpload={
              usePrimary && primary
                ? primary.onRemovePendingUpload
                : (relativePath) => {
                    context.updatePendingUploads(composerKey, (current) =>
                      current.filter((file) => file.relativePath !== relativePath),
                    );
                  }
            }
            queuedTurns={usePrimary && primary ? primary.queuedTurns : queuedTurns}
            queuePaused={usePrimary ? primary?.queuePaused : queuePaused}
            queueControlPending={queueControlPending}
            queueRunDisabled={context.transportInputDisabled || scheduledRunActive}
            onQueuePausedChange={handleQueuePausedChange}
            onRunQueuedTurnNow={
              usePrimary && primary ? primary.onRunQueuedTurnNow : handleRunQueuedTurnNow
            }
            onMoveQueuedTurnUp={
              usePrimary && primary ? primary.onMoveQueuedTurnUp : handleMoveQueuedTurnUp
            }
            onEditQueuedTurn={
              usePrimary && primary ? primary.onEditQueuedTurn : () => onFocusPane()
            }
            onRemoveQueuedTurn={
              usePrimary && primary ? primary.onRemoveQueuedTurn : handleRemoveQueuedTurn
            }
            taskProgressBar={
              usePrimary ? (
                primary?.taskProgressBar
              ) : (
                <TaskProgressBar
                  key={conversationId}
                  snapshot={taskProgressSnapshot}
                  isConversationRunning={isRunning}
                />
              )
            }
            approvalBar={usePrimary ? primary?.approvalBar : approvalBar}
            statsBar={
              usePrimary ? (
                primary?.statsBar
              ) : (
                <ConversationStatsBarHost
                  key={`stats-${conversationId}`}
                  conversationId={conversationId}
                  host={context.trajectoryHost}
                  enabled={!trajectoryActive}
                  contextUsageTokensSource={contextUsageTokensSource}
                  contextWindow={contextWindow}
                  onManualCompactConfirm={() => onFocusPane()}
                  manualCompactBlocked={transcript.toolStatusIsCompaction === true}
                />
              )
            }
            fileDropOverlay={usePrimary ? primary?.fileDropOverlay : null}
          />
        </section>
      </div>
    </div>
  );
  return (
    <DeviceConversationImageSurface host={images} includeAttachments={Boolean(workdir)}>
      <DeviceUiTranscript
        client={workdir ? context.deviceUiSurface : undefined}
        conversationId={conversationId}
        workdir={workdir}
        running={isRunning}
        htmlPreviews={context.settings.customSettings.chatTranscript.htmlPreviews}
      >
        {surface}
      </DeviceUiTranscript>
    </DeviceConversationImageSurface>
  );
}
