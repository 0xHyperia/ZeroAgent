import { ApplicationRail } from "@liveagent/ui/application/ApplicationRail";
import { ApplicationView } from "@liveagent/ui/application/ApplicationView";
import { AppWorkbenchChrome } from "@liveagent/ui/application/AppWorkbenchChrome";
import { useUnsavedChangesPrompt } from "@liveagent/ui/application/useUnsavedChangesPrompt";
import { AppErrorBoundary } from "@liveagent/ui/components/AppErrorBoundary";
import {
  ChatHistorySidebar,
  type ChatHistorySidebarMutationKind,
} from "@liveagent/ui/components/chat/ChatHistorySidebar";
import type {
  MentionComposerDraft,
  MentionComposerHandle,
} from "@liveagent/ui/components/chat/MentionComposer";
import {
  BookOpen,
  Globe,
  NavigationChat,
  NavigationChatFilled,
  NavigationDevices,
  NavigationLibrary,
  NavigationLibraryFilled,
  PanelLeft,
  SquarePen,
  X,
} from "@liveagent/ui/components/IconSet";
import { ScrollArea } from "@liveagent/ui/components/ui/scroll-area";
import { useSidebar } from "@liveagent/ui/components/ui/sidebar";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import {
  deleteSidebarConversations,
  type SidebarBatchDeleteOptions,
} from "@liveagent/ui/lib/sidebar/batchDelete";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import type { SttSettingsService } from "@liveagent/ui/lib/stt/types";
import { ChatComposerBar } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { SettingsPage } from "@liveagent/ui/pages/settings/SettingsPage";
import {
  type ChangeEvent,
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildTextFromComposerDraft } from "@/app/chatDraft";
import { UserMenu } from "@/app/UserMenu";
import { CloudChatFilePanel } from "@/components/CloudChatFilePanel";
import { CloudChatArtifactsPanel } from "@/components/cloudchat/CloudChatArtifactsPanel";
import {
  CloudChatComposerMenu,
  CloudChatModeSwitch,
  type CloudChatPresentation,
} from "@/components/cloudchat/CloudChatComposerMenu";
import {
  CloudChatContextPicker,
  CloudChatWorkToolbar,
  type CloudComposerMenu,
  type CloudComposerPicker,
} from "@/components/cloudchat/CloudChatContextPicker";
import { CloudChatEmptyState, CloudChatStarters } from "@/components/cloudchat/CloudChatEmptyState";
import { CloudChatFeedback } from "@/components/cloudchat/CloudChatFeedback";
import { CloudChatHeaderActions } from "@/components/cloudchat/CloudChatHeaderActions";
import { CloudChatMemoryPanel } from "@/components/cloudchat/CloudChatMemoryPanel";
import { CloudChatMessageReader } from "@/components/cloudchat/CloudChatMessageReader";
import { CloudChatModelLimitsPanel } from "@/components/cloudchat/CloudChatModelLimitsPanel";
import { CloudChatProjectNavigation } from "@/components/cloudchat/CloudChatProjectNavigation";
import { CloudChatProjectsPanel } from "@/components/cloudchat/CloudChatProjectsPanel";
import { CloudChatResearchConfirmation } from "@/components/cloudchat/CloudChatResearchConfirmation";
import {
  CloudChatResourcePanel,
  CloudChatResourcePresentation,
} from "@/components/cloudchat/CloudChatResourcePanel";
import { CloudChatSourcesPanel } from "@/components/cloudchat/CloudChatSourcesPanel";
import { CloudContextSidebar } from "@/components/cloudchat/CloudContextSidebar";
import { CloudConversationTitle } from "@/components/cloudchat/CloudConversationTitle";
import { CloudSpacePage } from "@/components/cloudchat/CloudSpacePage";
import { useCloudSidebarPreview } from "@/components/cloudchat/useCloudSidebarPreview";
import { ExecutionEnvironmentSwitcher } from "@/components/ExecutionEnvironmentSwitcher";
import { GatewayBrand } from "@/components/GatewayBrand";
import { GatewayTranscript } from "@/components/GatewayTranscript";
import { FirstRunOnboarding } from "@/components/onboarding/FirstRunOnboarding";
import {
  ACCOUNT_CHANGED_EVENT,
  accountFetch,
  captureAccountRequestGuard,
} from "@/lib/accountRequest";
import { buildModelOptions } from "@/lib/chat/chatPageHelpers";
import {
  CLOUD_SPACE_HOME,
  CloudSpaceError,
  type CloudSpaceItem,
  type CloudSpaceLocation,
  createCloudSpaceClient,
} from "@/lib/cloudSpace";
import "../cloud-space.css";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import type { TranscriptRow } from "@/lib/chat/transcript/types";
import {
  CloudChatArtifactError,
  type CloudChatArtifactVersion,
  cloudArtifactReferences,
  cloudArtifactVersionFromLink,
  createCloudChatArtifactsClient,
  linkCloudArtifactCitations,
} from "@/lib/cloudChatArtifacts";
import {
  type CloudBranchRequest,
  CloudBranchRequestError,
  CloudBranchUnconfirmedError,
  createCloudChatBranchesClient,
} from "@/lib/cloudChatBranches";
import {
  type CloudChatFile,
  CloudChatFileError,
  cloudFileCanReference,
  cloudFileReferences,
  cloudFileStatus,
  createCloudChatFilesClient,
  linkCloudFileCitations,
} from "@/lib/cloudChatFiles";
import {
  CloudChatHistoryError,
  type CloudChatMessage,
  createCloudChatHistoryClient,
  mergeCloudChatHistory,
} from "@/lib/cloudChatHistory";
import {
  CLOUD_MESSAGE_CLIPBOARD_BYTES,
  CLOUD_MESSAGE_INLINE_EDIT_BYTES,
  cloudMessageFitsTextBudget,
  cloudMessageTranscriptPreview,
  copyCloudMessageText,
} from "@/lib/cloudChatMessagePreview";
import {
  type CloudChatConversation,
  CloudChatMetadataError,
  type CloudChatRunHead,
  createCloudChatMetadataClient,
  mergeCloudChatConversations,
} from "@/lib/cloudChatMetadata";
import { createCloudChatModelLimitsClient } from "@/lib/cloudChatModelLimits";
import {
  buildCloudChatModelParameters,
  CLOUD_CHAT_REASONING_OPTIONS,
  type CloudChatModelParameters,
  type CloudChatReasoningEffort,
  cloudChatClientPreferences,
  cloudChatReasoningEffort,
  cloudChatReasoningLevel,
} from "@/lib/cloudChatModelParameters";
import { type CloudProject, createCloudChatProjectsClient } from "@/lib/cloudChatProjects";
import {
  type CloudChatPublicResearch,
  initialCloudResearchTopic,
  parseCloudChatPublicResearch,
} from "@/lib/cloudChatResearch";
import {
  CloudChatAccountQueueFullError,
  type CloudChatRun,
  type CloudChatRunRequest,
  CloudChatRunRequestError,
  CloudChatSubmissionUnknownError,
  cloudChatRunStatusText,
  cloudChatRunToolStatus,
  createCloudChatRunsClient,
  isCloudChatRunTerminal,
} from "@/lib/cloudChatRuns";
import { patchCloudChatRuntimeControls } from "@/lib/cloudChatRuntimeControls";
import { cloudChatScrollFollowing } from "@/lib/cloudChatScrollFollow";
import {
  CloudChatSourceError,
  createCloudChatSourcesClient,
  linkCloudSourceCitations,
} from "@/lib/cloudChatSources";
import type {
  ExecutionEnvironment,
  ExecutionSelection,
  ExecutionWorkspace,
} from "@/lib/executionTargets";
import { toModelValue } from "@/lib/providers/llm";
import {
  getRelayDashboardStats,
  getRelayProfile,
  listRelayApiKeys,
  listRelayGroups,
  notifyRelaySessionExpired,
  RELAY_SESSION_CHANGED_EVENT,
  RELAY_SESSION_EXPIRED_EVENT,
  type RelayDashboardStats,
  type RelayUser,
} from "@/lib/relay/client";
import {
  bindRelayKeysToSettings,
  mergeRefreshedRelaySettings,
  relayProviderId,
  relayProviderKeyId,
} from "@/lib/relay/providers";
import {
  type AppSettings,
  type ChatRuntimeControls,
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  getNextTheme,
  type ReasoningLevel,
} from "@/lib/settings";
import type { WebSettingsSaveState } from "@/lib/webSettings";
import {
  GATEWAY_CHAT_FRAME_CLASS,
  GATEWAY_MAIN_BACKDROP_CLASS,
  GATEWAY_MAIN_SHELL_CLASS,
  GATEWAY_SHELL_CLASS,
  GATEWAY_TRANSCRIPT_SCROLL_CLASS,
} from "@/lib/webStyleClasses";
import type { SectionId } from "@/pages/settings/types";

type Conversation = CloudChatConversation;
type Message = CloudChatMessage;
type FilePanel = { fileId?: string; fromLine?: number; toLine?: number };
type SourcePanel = { sourceId?: string; fromLine?: number; toLine?: number };
type WebSettings = {
  model: string;
  reasoning_effort: CloudChatReasoningEffort;
  provider_key_id?: number;
};
type ConversationView = { userId: number; conversationId: string };
type PendingRunSubmission = {
  request: CloudChatRunRequest;
  optimisticUserId: string;
  optimisticAssistantId: string;
  optimisticContent: unknown;
  preserveDraft?: boolean;
};
type PendingBranchSubmission = {
  view: ConversationView;
  request: CloudBranchRequest;
  draftText: string;
  draftFiles: CloudChatFile[];
  draftArtifacts: CloudChatArtifactVersion[];
  execution: {
    model: string;
    reasoning: CloudChatReasoningEffort;
    providerKeyId: number;
    parameters: CloudChatModelParameters;
    publicResearch?: CloudChatPublicResearch;
  };
};
type PendingResearchConfirmation = {
  id: string;
  view: ConversationView;
  topic: string;
  guard: () => void;
  submit: (research: CloudChatPublicResearch) => void;
};
type Props = {
  user: RelayUser;
  onUserChange: (user: RelayUser) => void;
  environments: ExecutionEnvironment[];
  selection: ExecutionSelection | null;
  settings: AppSettings;
  setSettings: (updater: (previous: AppSettings) => AppSettings) => void;
  settingsSaveState: WebSettingsSaveState;
  onSwitch: (environment: ExecutionEnvironment, workspace: ExecutionWorkspace) => Promise<unknown>;
  onLogout: () => void;
};

const EMPTY_MUTATIONS = new Map<string, ChatHistorySidebarMutationKind>();
const EMPTY_PATHS = new Set<string>();
const CLOUD_SETTINGS_SECTIONS = new Set<SectionId>(["account", "system", "providers", "devices"]);

async function webChatRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const guard = captureAccountRequestGuard();
  const response = await accountFetch(path, {
    ...init,
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...init?.headers },
  });
  if (response.status === 401) notifyRelaySessionExpired();
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  guard();
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `请求失败 (HTTP ${response.status})`);
  }
  return payload;
}

function messageText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text?: string } =>
      Boolean(part && typeof part === "object"),
    )
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");
}

function requestMessageContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part?.type === "file_reference") return { type: "file_reference", file_id: part.file_id };
    if (part?.type === "artifact_reference")
      return { type: "artifact_reference", version_id: part.version_id };
    return part;
  });
}

function toEpoch(value: string | undefined) {
  const timestamp = value ? new Date(value).getTime() : Date.now();
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function attachmentKind(attachment: { mime: string }): PendingUploadedFile["kind"] {
  if (attachment.mime.startsWith("image/")) return "image";
  if (attachment.mime === "application/pdf") return "pdf";
  if (attachment.mime.includes("word")) return "word";
  if (attachment.mime.includes("spreadsheet") || attachment.mime.includes("excel"))
    return "spreadsheet";
  return "text";
}

export function CloudChatPage({
  user,
  onUserChange,
  environments,
  selection,
  settings,
  setSettings,
  settingsSaveState,
  onSwitch,
  onLogout,
}: Props) {
  const disabledSttSettingsService = useMemo<SttSettingsService>(
    () => ({
      runtimeLabel: "Cloud Chat",
      get: async () => settings.stt,
      update: async () => settings.stt,
      test: async () => ({
        result: "network_failed",
        message: "Cloud Chat 暂不提供语音输入配置",
      }),
    }),
    [settings.stt],
  );
  const requestedSettingsSection = new URLSearchParams(window.location.search).get(
    "settings",
  ) as SectionId | null;
  const initialSettingsSection =
    requestedSettingsSection && CLOUD_SETTINGS_SECTIONS.has(requestedSettingsSection)
      ? requestedSettingsSection
      : "account";
  const [accountStats, setAccountStats] = useState<RelayDashboardStats | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationsLoadingMore, setConversationsLoadingMore] = useState(false);
  const [conversationsHasMore, setConversationsHasMore] = useState(false);
  const [conversationsError, setConversationsError] = useState("");
  const [conversationId, setConversationId] = useState(
    () => new URLSearchParams(window.location.search).get("conversation")?.trim() ?? "",
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [model, setModel] = useState("gpt-5.1");
  const [providerKeyId, setProviderKeyId] = useState(0);
  const [reasoning, setReasoning] = useState<ReasoningLevel>("medium");
  const [runtimeControls, setRuntimeControls] = useState<ChatRuntimeControls>(() => ({
    ...DEFAULT_CHAT_RUNTIME_CONTROLS,
    reasoning: "medium",
    thinkingEnabled: true,
    nativeWebSearchEnabled: false,
  }));
  const [researchConfirmation, setResearchConfirmation] =
    useState<PendingResearchConfirmation | null>(null);
  const [attachments, setAttachments] = useState<CloudChatFile[]>([]);
  const [artifactAttachments, setArtifactAttachments] = useState<CloudChatArtifactVersion[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [filePanel, setFilePanel] = useState<FilePanel | null>(null);
  const [sourcePanel, setSourcePanel] = useState<SourcePanel | null>(null);
  const [artifactPanel, setArtifactPanel] = useState<{ versionId?: string } | null>(null);
  const [workPanel, setWorkPanel] = useState<"projects" | "memory" | null>(null);
  const [workspaceView, setWorkspaceView] = useState<"chat" | "library" | "projects">("chat");
  const [spaceLocation, setSpaceLocation] = useState<CloudSpaceLocation>(CLOUD_SPACE_HOME);
  const [spaceRevision, setSpaceRevision] = useState(0);
  const [spaceVisited, setSpaceVisited] = useState(false);
  const [spaceStorageOpen, setSpaceStorageOpen] = useState(false);
  const [presentation, setPresentation] = useState<CloudChatPresentation>("work");
  const [composerMenu, setComposerMenu] = useState<CloudComposerMenu>(null);
  const [composerMenuAnchor, setComposerMenuAnchor] = useState<HTMLElement | null>(null);
  const [projectContextBusy, setProjectContextBusy] = useState(false);
  const projectContextMutation = useRef(false);
  const [composerProject, setComposerProject] = useState<{
    scope: string;
    project: CloudProject | null;
  }>({ scope: "", project: null });
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [initialProjectId, setInitialProjectId] = useState<string | undefined>();
  const [contextNotice, setContextNotice] = useState("");
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchUnconfirmed, setBranchUnconfirmed] = useState(false);
  const [branchPendingMessageId, setBranchPendingMessageId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [activeRun, setActiveRun] = useState<CloudChatRun | null>(null);
  const [restoredTerminalRun, setRestoredTerminalRun] = useState<CloudChatRunHead | null>(null);
  const [terminalEditRequest, setTerminalEditRequest] = useState<{
    token: string;
    messageId: string;
  } | null>(null);
  const [modelLimitsOpen, setModelLimitsOpen] = useState(false);
  const [preparingExecution, setPreparingExecution] = useState(false);
  const [runConnection, setRunConnection] = useState<
    "connecting" | "connected" | "reconnecting" | null
  >(null);
  const [submissionUnconfirmed, setSubmissionUnconfirmed] = useState(false);
  const [submissionQueueFull, setSubmissionQueueFull] = useState(false);
  const [streamNotice, setStreamNotice] = useState("");
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyBefore, setHistoryBefore] = useState("");
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyPageLoading, setHistoryPageLoading] = useState(false);
  const [followingTranscript, setFollowingTranscript] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [messageReader, setMessageReader] = useState<{
    id: string;
    message?: Message;
    error?: string;
  } | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [webSettingsLoaded, setWebSettingsLoaded] = useState(false);
  const [error, setError] = useState("");
  const projectNavigation = useUnsavedChangesPrompt(user.id);
  const sidebar = useSidebar();
  const sidebarOpen = sidebar.isMobile ? sidebar.openMobile : sidebar.open;
  const setSidebarOpen = sidebar.isMobile ? sidebar.setOpenMobile : sidebar.setOpen;
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: moving the trigger or changing its account closes the old menu.
  useEffect(() => setUserMenuOpen(false), [sidebar.isMobile, user.id]);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(() =>
    Boolean(requestedSettingsSection && CLOUD_SETTINGS_SECTIONS.has(requestedSettingsSection)),
  );
  const [settingsSection, setSettingsSection] = useState<SectionId>(initialSettingsSection);
  const settingsHistoryOpen = useRef(accountSettingsOpen);
  const sidebarDestination = workspaceView === "library" ? "library" : "chat";
  const sidebarPreview = useCloudSidebarPreview(
    !sidebar.isMobile && !accountSettingsOpen,
    user.id,
    { pinnedOpen: sidebar.open, destination: sidebarDestination },
  );
  const shownSidebarDestination = sidebarPreview.open
    ? sidebarPreview.destination
    : sidebarDestination;
  useEffect(() => {
    if (accountSettingsOpen) sidebar.setOpenMobile(false);
  }, [accountSettingsOpen, sidebar.setOpenMobile]);
  useEffect(() => {
    const onPopState = () => {
      const requested = new URL(window.location.href).searchParams.get(
        "settings",
      ) as SectionId | null;
      const open = Boolean(requested && CLOUD_SETTINGS_SECTIONS.has(requested));
      settingsHistoryOpen.current = open;
      if (open) setSettingsSection(requested as SectionId);
      setAccountSettingsOpen(open);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pinnedConversationIds, setPinnedConversationIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [transcriptViewport, setTranscriptViewport] = useState<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const submissionAbortRef = useRef<AbortController | null>(null);
  const pendingSubmissionRef = useRef<PendingRunSubmission | null>(null);
  const cancelSubmissionRef = useRef(false);
  const mountedRef = useRef(true);
  const accountInvalidatedRef = useRef(false);
  const ownerRef = useRef(user.id);
  const viewRef = useRef<ConversationView>({ userId: user.id, conversationId });
  const attachedRunIdRef = useRef<string | null>(null);
  const latestRunRef = useRef<CloudChatRun | null>(null);
  const conversationsCursorRef = useRef("");
  const conversationsInitializedRef = useRef(false);
  const conversationsEpochRef = useRef(0);
  const conversationsAbortRef = useRef<AbortController | null>(null);
  const metadataClient = useMemo(
    () => createCloudChatMetadataClient(accountFetch, captureAccountRequestGuard),
    [],
  );
  const modelLimitsClient = useMemo(
    () => createCloudChatModelLimitsClient(accountFetch, captureAccountRequestGuard),
    [],
  );
  const modelPreparationAbortRef = useRef<AbortController | null>(null);
  const runsClient = useMemo(() => createCloudChatRunsClient(accountFetch), []);
  const filesClient = useMemo(
    () => createCloudChatFilesClient(accountFetch, captureAccountRequestGuard),
    [],
  );
  const spaceClient = useMemo(
    () => createCloudSpaceClient(accountFetch, captureAccountRequestGuard),
    [],
  );
  const branchesClient = useMemo(
    () => createCloudChatBranchesClient(accountFetch, captureAccountRequestGuard),
    [],
  );
  const projectsClient = useMemo(
    () => createCloudChatProjectsClient(accountFetch, captureAccountRequestGuard),
    [],
  );
  const sourcesClient = useMemo(
    () => createCloudChatSourcesClient(accountFetch, captureAccountRequestGuard),
    [],
  );
  const artifactsClient = useMemo(
    () => createCloudChatArtifactsClient(accountFetch, captureAccountRequestGuard),
    [],
  );
  const branchAbortRef = useRef<AbortController | null>(null);
  const pendingBranchRef = useRef<PendingBranchSubmission | null>(null);
  const researchConfirmationRef = useRef<PendingResearchConfirmation | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const draftRestoreRef = useRef<{
    view: ConversationView;
    text?: string;
    draft?: MentionComposerDraft;
  } | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const historyPageAbortRef = useRef<AbortController | null>(null);
  const messageReadAbortRef = useRef<AbortController | null>(null);
  const followTranscriptTailRef = useRef(true);
  const conversationCreationRef = useRef<Promise<string> | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const settingsRef = useRef(settings);
  const setSettingsRef = useRef(setSettings);
  const setSidebarOpenRef = useRef(setSidebarOpen);
  ownerRef.current = user.id;
  settingsRef.current = settings;
  setSettingsRef.current = setSettings;
  setSidebarOpenRef.current = setSidebarOpen;

  const isCurrentView = useCallback((view: ConversationView) => {
    return (
      mountedRef.current &&
      !accountInvalidatedRef.current &&
      ownerRef.current === view.userId &&
      viewRef.current === view
    );
  }, []);
  const captureWorkGuard = useCallback(() => {
    const guard = captureAccountRequestGuard();
    const view = viewRef.current;
    return () => {
      guard();
      if (!isCurrentView(view)) throw new Error("Account changed while the request was pending");
    };
  }, [isCurrentView]);
  const historyClient = useMemo(
    () => createCloudChatHistoryClient(accountFetch, captureWorkGuard),
    [captureWorkGuard],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision invalidates the server-owned project association after a panel mutation.
  useEffect(() => {
    const scope = `${user.id}:${conversationId}`;
    let current = true;
    setComposerProject({ scope, project: null });
    if (!conversationId) return;
    const guard = captureWorkGuard();
    void projectsClient
      .getAssociation(conversationId)
      .then(async (binding) => {
        guard();
        const project = binding.project_id
          ? await projectsClient.getProject(binding.project_id)
          : null;
        guard();
        if (current) setComposerProject({ scope, project });
      })
      .catch(() => {
        /* Picker can refresh/reconcile; never display a retired association. */
      });
    return () => {
      current = false;
    };
  }, [user.id, conversationId, projectsClient, captureWorkGuard, navigationRevision]);

  const detachRun = useCallback(() => {
    setTerminalEditRequest(null);
    modelPreparationAbortRef.current?.abort();
    modelPreparationAbortRef.current = null;
    setPreparingExecution(false);
    setModelLimitsOpen(false);
    abortRef.current?.abort();
    abortRef.current = null;
    submissionAbortRef.current?.abort();
    submissionAbortRef.current = null;
    attachedRunIdRef.current = null;
    latestRunRef.current = null;
    pendingSubmissionRef.current = null;
    cancelSubmissionRef.current = false;
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    branchAbortRef.current?.abort();
    branchAbortRef.current = null;
    pendingBranchRef.current = null;
    researchConfirmationRef.current = null;
    setResearchConfirmation(null);
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    draftRestoreRef.current = null;
    historyPageAbortRef.current?.abort();
    historyPageAbortRef.current = null;
    messageReadAbortRef.current?.abort();
    messageReadAbortRef.current = null;
    followTranscriptTailRef.current = true;
    setFollowingTranscript(true);
  }, []);

  function selectConversationView(id: string) {
    setComposerMenu(null);
    setWorkspaceView("chat");
    detachRun();
    viewRef.current = { userId: user.id, conversationId: id };
    setConversationId(id);
    setMessages([]);
    setHistoryLoading(Boolean(id));
    setHistoryBefore("");
    setHistoryHasMore(false);
    setHistoryPageLoading(false);
    setHistoryError("");
    setMessageReader(null);
    setActiveRun(null);
    setRestoredTerminalRun(null);
    setStreaming(false);
    setRunConnection(null);
    setSubmissionUnconfirmed(false);
    setSubmissionQueueFull(false);
    setStreamNotice("");
    setAttachments([]);
    setArtifactAttachments([]);
    setUploadingFiles(false);
    setFilePanel(null);
    setSourcePanel(null);
    setArtifactPanel(null);
    setWorkPanel(null);
    setContextNotice("");
    setBranchBusy(false);
    setBranchUnconfirmed(false);
    setBranchPendingMessageId(null);
    setExporting(false);
    setError("");
    return viewRef.current;
  }

  useEffect(() => {
    mountedRef.current = true;
    accountInvalidatedRef.current = false;
    conversationsAbortRef.current?.abort();
    conversationsAbortRef.current = null;
    conversationsEpochRef.current++;
    conversationsInitializedRef.current = false;
    conversationsCursorRef.current = "";
    setConversationsHasMore(false);
    setConversationsLoadingMore(false);
    setConversationsError("");
    if (viewRef.current.userId !== user.id) {
      setWorkspaceView("chat");
      setInitialProjectId(undefined);
      setRuntimeControls((current) => ({ ...current, nativeWebSearchEnabled: false }));
      viewRef.current = { userId: user.id, conversationId: "" };
      setConversationId("");
      setMessages([]);
      setHistoryBefore("");
      setHistoryHasMore(false);
      setHistoryPageLoading(false);
      setHistoryError("");
      setMessageReader(null);
      setConversations([]);
      setAttachments([]);
      setArtifactAttachments([]);
      setFilePanel(null);
      setSourcePanel(null);
      setArtifactPanel(null);
      setWorkPanel(null);
      setContextNotice("");
      setBranchBusy(false);
      setBranchUnconfirmed(false);
      setBranchPendingMessageId(null);
      setExporting(false);
      setUploadingFiles(false);
      setAccountStats(null);
      setActiveRun(null);
      setRestoredTerminalRun(null);
      setStreaming(false);
      setRunConnection(null);
      setSubmissionUnconfirmed(false);
      setSubmissionQueueFull(false);
      setStreamNotice("");
      setError("");
    }
    const owner = user.id;
    const invalidate = () => {
      if (ownerRef.current !== owner) return;
      accountInvalidatedRef.current = true;
      detachRun();
      conversationsAbortRef.current?.abort();
      conversationsAbortRef.current = null;
      conversationsEpochRef.current++;
      conversationsInitializedRef.current = false;
      conversationsCursorRef.current = "";
      setConversationsHasMore(false);
      setConversationsLoadingMore(false);
      setConversationsError("");
      viewRef.current = { userId: 0, conversationId: "" };
      setStreaming(false);
      setActiveRun(null);
      setRestoredTerminalRun(null);
      setRunConnection(null);
      setSubmissionUnconfirmed(false);
      setSubmissionQueueFull(false);
      setStreamNotice("");
      setMessages([]);
      setHistoryBefore("");
      setHistoryHasMore(false);
      setHistoryPageLoading(false);
      setHistoryError("");
      setMessageReader(null);
      setConversations([]);
      setAttachments([]);
      setArtifactAttachments([]);
      setUploadingFiles(false);
      setFilePanel(null);
      setSourcePanel(null);
      setArtifactPanel(null);
      setWorkPanel(null);
      setContextNotice("");
      setBranchBusy(false);
      setBranchUnconfirmed(false);
      setBranchPendingMessageId(null);
      setExporting(false);
      setAccountStats(null);
      setError("登录状态已更新，请刷新页面后继续。");
    };
    for (const event of [
      ACCOUNT_CHANGED_EVENT,
      RELAY_SESSION_CHANGED_EVENT,
      RELAY_SESSION_EXPIRED_EVENT,
    ]) {
      window.addEventListener(event, invalidate);
    }
    return () => {
      mountedRef.current = false;
      detachRun();
      conversationsAbortRef.current?.abort();
      conversationsAbortRef.current = null;
      for (const event of [
        ACCOUNT_CHANGED_EVENT,
        RELAY_SESSION_CHANGED_EVENT,
        RELAY_SESSION_EXPIRED_EVENT,
      ]) {
        window.removeEventListener(event, invalidate);
      }
    };
  }, [detachRun, user.id]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (conversationId) url.searchParams.set("conversation", conversationId);
    else url.searchParams.delete("conversation");
    if (accountSettingsOpen) url.searchParams.set("settings", settingsSection);
    else url.searchParams.delete("settings");
    const method =
      accountSettingsOpen && !settingsHistoryOpen.current ? "pushState" : "replaceState";
    settingsHistoryOpen.current = accountSettingsOpen;
    window.history[method](window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [accountSettingsOpen, conversationId, settingsSection]);
  useEffect(() => {
    const restore = draftRestoreRef.current;
    if (restore && restore.view.conversationId === conversationId && isCurrentView(restore.view)) {
      if (restore.draft) composerRef.current?.setDraft(restore.draft);
      else composerRef.current?.setText(restore.text ?? "");
      draftRestoreRef.current = null;
    }
  }, [conversationId, isCurrentView]);

  const refreshConversations = useCallback(async () => {
    const owner = ownerRef.current;
    conversationsAbortRef.current?.abort();
    const controller = new AbortController();
    conversationsAbortRef.current = controller;
    const epoch = ++conversationsEpochRef.current;
    const current = () =>
      mountedRef.current &&
      !accountInvalidatedRef.current &&
      ownerRef.current === owner &&
      conversationsEpochRef.current === epoch;
    setConversationsLoading(true);
    setConversationsLoadingMore(false);
    try {
      const page = await metadataClient.listConversations({ signal: controller.signal });
      if (current()) {
        const wasInitialized = conversationsInitializedRef.current;
        setConversations((previous) =>
          wasInitialized
            ? mergeCloudChatConversations(previous, page.conversations)
            : page.conversations,
        );
        if (!conversationsInitializedRef.current) {
          conversationsCursorRef.current = page.nextCursor;
          setConversationsHasMore(page.hasMore);
        }
        conversationsInitializedRef.current = true;
        setConversationsError("");
      }
      return page.conversations;
    } catch (cause) {
      if (current() && !controller.signal.aborted)
        setConversationsError(cause instanceof Error ? cause.message : "会话列表读取失败");
      throw cause;
    } finally {
      if (current()) {
        conversationsAbortRef.current = null;
        setConversationsLoading(false);
      }
    }
  }, [metadataClient]);

  async function loadMoreConversations() {
    if (!conversationsHasMore || !conversationsCursorRef.current || conversationsAbortRef.current)
      return;
    const owner = ownerRef.current,
      epoch = conversationsEpochRef.current;
    const controller = new AbortController();
    conversationsAbortRef.current = controller;
    setConversationsLoadingMore(true);
    const current = () =>
      mountedRef.current &&
      !accountInvalidatedRef.current &&
      ownerRef.current === owner &&
      conversationsEpochRef.current === epoch;
    try {
      const page = await metadataClient.listConversations({
        cursor: conversationsCursorRef.current,
        signal: controller.signal,
      });
      if (!current()) return;
      setConversations((previous) => mergeCloudChatConversations(previous, page.conversations));
      conversationsCursorRef.current = page.nextCursor;
      setConversationsHasMore(page.hasMore);
      setConversationsError("");
    } catch (cause) {
      if (current() && !controller.signal.aborted)
        setConversationsError(cause instanceof Error ? cause.message : "更早会话读取失败");
    } finally {
      if (current()) {
        conversationsAbortRef.current = null;
        setConversationsLoadingMore(false);
      }
    }
  }

  const refreshModels = useCallback(async () => {
    const owner = ownerRef.current;
    const current = () =>
      mountedRef.current && !accountInvalidatedRef.current && ownerRef.current === owner;
    setModelsLoading(true);
    try {
      const [keys, groups] = await Promise.all([listRelayApiKeys(), listRelayGroups()]);
      const next = await bindRelayKeysToSettings(settingsRef.current, keys, groups, true);
      if (current())
        setSettingsRef.current((previous) => mergeRefreshedRelaySettings(previous, next));
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current()) setModelsLoading(false);
    }
  }, []);

  const saveWebSettings = useCallback(
    async (nextModel: string, nextReasoning: ReasoningLevel, nextProviderKeyId = providerKeyId) => {
      const normalizedModel = nextModel.trim();
      if (!normalizedModel) return;
      await webChatRequest<{ settings: WebSettings }>("/api/web-settings", {
        method: "PATCH",
        body: JSON.stringify({
          model: normalizedModel,
          reasoning_effort: cloudChatReasoningEffort(nextReasoning),
          provider_key_id: nextProviderKeyId,
        }),
      });
    },
    [providerKeyId],
  );

  useEffect(() => {
    let cancelled = false;
    const current = () =>
      !cancelled &&
      mountedRef.current &&
      !accountInvalidatedRef.current &&
      ownerRef.current === user.id;
    void Promise.all([
      refreshConversations(),
      getRelayDashboardStats().then((stats) => {
        if (current()) setAccountStats(stats);
      }),
      webChatRequest<{ settings: WebSettings }>("/api/web-settings").then((response) => {
        if (!current()) return;
        setModel(response.settings.model);
        setProviderKeyId(response.settings.provider_key_id ?? 0);
        setReasoning(cloudChatReasoningLevel(response.settings.reasoning_effort));
        setRuntimeControls((current) => ({
          ...current,
          reasoning: cloudChatReasoningLevel(response.settings.reasoning_effort),
          thinkingEnabled: response.settings.reasoning_effort !== "none",
        }));
        setWebSettingsLoaded(true);
      }),
    ]).catch((cause) => {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [refreshConversations, user.id]);

  useEffect(() => {
    let cancelled = false;
    const current = () =>
      !cancelled &&
      mountedRef.current &&
      !accountInvalidatedRef.current &&
      ownerRef.current === user.id;
    void Promise.all([listRelayApiKeys(), listRelayGroups()])
      .then(async ([keys, groups]) => {
        const next = await bindRelayKeysToSettings(settingsRef.current, keys, groups, true);
        if (current()) setSettingsRef.current(() => next);
      })
      .catch((cause) => {
        if (current()) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (current()) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const refreshRelayAccount = useCallback(async () => {
    const [profile, stats] = await Promise.all([getRelayProfile(), getRelayDashboardStats()]);
    onUserChange(profile);
    setAccountStats(stats);
  }, [onUserChange]);

  useEffect(() => {
    if (!transcriptViewport) return;
    let previousTop = transcriptViewport.scrollTop;
    const follow = () => {
      const top = transcriptViewport.scrollTop;
      const distance = transcriptViewport.scrollHeight - transcriptViewport.clientHeight - top;
      followTranscriptTailRef.current = cloudChatScrollFollowing(
        followTranscriptTailRef.current,
        previousTop,
        top,
        distance,
      );
      previousTop = top;
      setFollowingTranscript(followTranscriptTailRef.current);
    };
    transcriptViewport.addEventListener("scroll", follow, { passive: true });
    return () => transcriptViewport.removeEventListener("scroll", follow);
  }, [transcriptViewport]);

  useEffect(() => {
    if (!transcriptViewport) return;
    if (messages.length === 0) {
      transcriptViewport.scrollTop = 0;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (followTranscriptTailRef.current)
        transcriptViewport.scrollTop = transcriptViewport.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, transcriptViewport]);

  const displayRun = useCallback(
    (run: CloudChatRun, view: ConversationView) => {
      if (!isCurrentView(view) || attachedRunIdRef.current !== run.id) return;
      const previous = latestRunRef.current;
      if (
        previous?.id === run.id &&
        (BigInt(run.last_seq) < BigInt(previous.last_seq) ||
          (isCloudChatRunTerminal(previous) && !isCloudChatRunTerminal(run)))
      )
        return;
      latestRunRef.current = run;
      setRestoredTerminalRun(null);
      setActiveRun(run);
      setStreaming(!isCloudChatRunTerminal(run));
      if (isCloudChatRunTerminal(run)) setStreamNotice("");
      setMessages((current) => {
        const message: Message = {
          id: run.assistant_message_id,
          role: "assistant",
          content: run.output,
        };
        return current.some((item) => item.id === message.id)
          ? current.map((item) => (item.id === message.id ? message : item))
          : [...current, message];
      });
    },
    [isCurrentView],
  );

  const attachRun = useCallback(
    (run: CloudChatRun, view: ConversationView) => {
      if (!isCurrentView(view)) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      attachedRunIdRef.current = run.id;
      displayRun(run, view);
      void runsClient
        .watchRun(run, {
          signal: controller.signal,
          onRun: (next) => displayRun(next, view),
          onConnection: (state) => {
            if (isCurrentView(view) && attachedRunIdRef.current === run.id) {
              setRunConnection(state);
              if (state === "connected") setStreamNotice("");
            }
          },
          onRecoverableError: (cause) => {
            if (
              isCurrentView(view) &&
              attachedRunIdRef.current === run.id &&
              cause.reason === "cloud_stream_limit"
            )
              setStreamNotice(cause.message);
          },
        })
        .then(async () => {
          if (!isCurrentView(view) || attachedRunIdRef.current !== run.id) return;
          // The terminal event is committed with the final message; replace optimistic rows by its IDs.
          const response = await historyClient.list(view.conversationId, {
            signal: controller.signal,
          });
          if (isCurrentView(view) && attachedRunIdRef.current === run.id)
            setMessages((current) => mergeCloudChatHistory(current, response.messages));
          await refreshConversations();
        })
        .catch((cause) => {
          if (
            controller.signal.aborted ||
            !isCurrentView(view) ||
            attachedRunIdRef.current !== run.id
          )
            return;
          if (
            (cause instanceof CloudChatRunRequestError || cause instanceof CloudChatHistoryError) &&
            cause.status === 401
          )
            notifyRelaySessionExpired();
          setError(cause instanceof Error ? cause.message : "任务状态同步失败，请重新打开会话");
          // Losing a viewer is not evidence that the server stopped its run.
        })
        .finally(() => {
          if (!isCurrentView(view) || abortRef.current !== controller) return;
          abortRef.current = null;
          setRunConnection(null);
        });
    },
    [displayRun, isCurrentView, refreshConversations, runsClient, historyClient],
  );

  useEffect(() => {
    if (viewRef.current.userId !== user.id || viewRef.current.conversationId !== conversationId) {
      viewRef.current = { userId: user.id, conversationId };
    }
    const view = viewRef.current;
    const controller = new AbortController();
    const attachedAtStart = attachedRunIdRef.current;
    setHistoryLoading(Boolean(conversationId));
    if (conversationId) {
      void Promise.all([
        historyClient.list(conversationId, { signal: controller.signal }),
        runsClient.listRuns(conversationId, true, controller.signal),
      ])
        .then(async ([response, runs]) => {
          if (
            !isCurrentView(view) ||
            pendingSubmissionRef.current ||
            attachedRunIdRef.current !== attachedAtStart
          )
            return;
          const run = runs.find((item) => !isCloudChatRunTerminal(item));
          let page = response;
          let history = page.messages;
          if (run && !history.some((message) => message.id === run.user_message_id)) {
            // A run may have been accepted between the concurrent history and status reads.
            page = await historyClient.list(conversationId, { signal: controller.signal });
            history = page.messages;
          }
          if (
            !isCurrentView(view) ||
            pendingSubmissionRef.current ||
            attachedRunIdRef.current !== attachedAtStart
          )
            return;
          setMessages(history);
          setHistoryBefore(page.nextBeforeId);
          setHistoryHasMore(page.hasMore);
          setHistoryError("");
          if (run) attachRun(run, view);
          else {
            const lastUser = [...history].reverse().find((message) => message.role === "user");
            const tail = history.at(-1);
            if (lastUser) {
              const head = await metadataClient.findTurnRun(
                conversationId,
                lastUser.id,
                controller.signal,
              );
              if (
                !isCurrentView(view) ||
                pendingSubmissionRef.current ||
                attachedRunIdRef.current !== attachedAtStart
              )
                return;
              if (
                head &&
                isCloudChatRunTerminal(head) &&
                (tail?.role === "user" || tail?.id === head.assistant_message_id)
              )
                setRestoredTerminalRun(head);
            }
          }
          if (window.matchMedia("(max-width: 820px)").matches) setSidebarOpenRef.current(false);
        })
        .catch((cause) => {
          if (controller.signal.aborted || !isCurrentView(view)) return;
          if (
            (cause instanceof CloudChatRunRequestError ||
              cause instanceof CloudChatHistoryError ||
              cause instanceof CloudChatMetadataError) &&
            cause.status === 401
          )
            notifyRelaySessionExpired();
          setError(cause instanceof Error ? cause.message : "会话恢复失败");
        })
        .finally(() => {
          if (isCurrentView(view)) setHistoryLoading(false);
        });
    }
    return () => {
      controller.abort();
      if (viewRef.current === view) {
        abortRef.current?.abort();
        abortRef.current = null;
      }
    };
  }, [
    attachRun,
    conversationId,
    isCurrentView,
    runsClient,
    user.id,
    historyClient,
    metadataClient,
  ]);

  async function loadEarlierHistory() {
    const view = viewRef.current;
    if (!isCurrentView(view) || !historyHasMore || !historyBefore || historyPageAbortRef.current)
      return;
    const controller = new AbortController();
    historyPageAbortRef.current = controller;
    setHistoryPageLoading(true);
    followTranscriptTailRef.current = false;
    setFollowingTranscript(false);
    setHistoryError("");
    try {
      const page = await historyClient.list(view.conversationId, {
        beforeId: historyBefore,
        signal: controller.signal,
      });
      if (!isCurrentView(view) || controller.signal.aborted) return;
      setMessages((current) => mergeCloudChatHistory(current, page.messages, true));
      setHistoryBefore(page.nextBeforeId);
      setHistoryHasMore(page.hasMore);
    } catch (cause) {
      if (isCurrentView(view) && !controller.signal.aborted) {
        if (cause instanceof CloudChatHistoryError && cause.status === 401)
          notifyRelaySessionExpired();
        setHistoryError(cause instanceof Error ? cause.message : "加载更早消息失败，请重试。");
      }
    } finally {
      if (historyPageAbortRef.current === controller) {
        historyPageAbortRef.current = null;
        if (isCurrentView(view)) setHistoryPageLoading(false);
      }
    }
  }
  async function readMessageBody(id: string) {
    const view = viewRef.current;
    if (!isCurrentView(view)) return;
    messageReadAbortRef.current?.abort();
    messageReadAbortRef.current = null;
    const cached = messages.find((message) => message.id === id && !message.content_omitted);
    if (cached) {
      setMessageReader({ id, message: cached });
      return;
    }
    const controller = new AbortController();
    messageReadAbortRef.current = controller;
    setMessageReader({ id });
    try {
      const full = await historyClient.get(view.conversationId, id, controller.signal);
      if (!isCurrentView(view) || messageReadAbortRef.current !== controller) return;
      const prior = messages.find((message) => message.id === id);
      if (prior?.content_sha256 && full.content_sha256 !== prior.content_sha256)
        throw new Error("消息正文校验发生变化，请刷新会话后重试。");
      setMessages((current) => current.map((message) => (message.id === id ? full : message)));
      setMessageReader({ id, message: full });
    } catch (cause) {
      if (
        isCurrentView(view) &&
        messageReadAbortRef.current === controller &&
        !controller.signal.aborted
      ) {
        if (cause instanceof CloudChatHistoryError && cause.status === 401)
          notifyRelaySessionExpired();
        setMessageReader({
          id,
          error: cause instanceof Error ? cause.message : "消息读取失败，请重试。",
        });
      }
    } finally {
      if (messageReadAbortRef.current === controller) messageReadAbortRef.current = null;
    }
  }

  function closeMessageReader() {
    messageReadAbortRef.current?.abort();
    messageReadAbortRef.current = null;
    setMessageReader(null);
  }

  async function createConversation(preserveDraft = false) {
    if (conversationCreationRef.current) return conversationCreationRef.current;
    const operation = createConversationOnce(preserveDraft);
    conversationCreationRef.current = operation;
    try {
      return await operation;
    } finally {
      if (conversationCreationRef.current === operation) conversationCreationRef.current = null;
    }
  }

  async function createConversationOnce(preserveDraft = false) {
    const previousView = viewRef.current;
    const savedDraft = preserveDraft ? composerRef.current?.getDraft() : undefined;
    const savedFiles = preserveDraft ? attachments : [];
    const savedArtifacts = preserveDraft ? artifactAttachments : [];
    const response = await webChatRequest<{ conversation: Conversation }>(
      "/api/web-chat/conversations",
      { method: "POST", body: JSON.stringify({ model }) },
    );
    if (!isCurrentView(previousView)) return "";
    setConversations((current) => [response.conversation, ...current]);
    selectConversationView(response.conversation.id);
    if (savedDraft) {
      draftRestoreRef.current = { view: viewRef.current, draft: savedDraft };
      composerRef.current?.setDraft(savedDraft);
      setAttachments(savedFiles);
      setArtifactAttachments(savedArtifacts);
    }
    setSidebarOpen(window.matchMedia("(min-width: 821px)").matches);
    return response.conversation.id;
  }

  async function openConversation(id: string) {
    if (id === viewRef.current.conversationId) return;
    selectConversationView(id);
  }

  async function removeConversation(id: string) {
    if (streaming && id === conversationId) {
      setError("请先停止当前任务，再删除会话");
      return;
    }
    await webChatRequest<void>(`/api/web-chat/conversations/${id}`, { method: "DELETE" });
    setConversations((current) => current.filter((item) => item.id !== id));
    if (conversationId === id) {
      selectConversationView("");
    }
  }

  async function removeConversations(ids: readonly string[], options?: SidebarBatchDeleteOptions) {
    return deleteSidebarConversations(
      ids,
      async (id) => {
        if (streaming && id === conversationId) return false;
        await removeConversation(id);
        return true;
      },
      options,
    );
  }

  async function saveConversationTitle(id: string, title: string) {
    const response = await webChatRequest<{ conversation: Conversation }>(
      `/api/web-chat/conversations/${id}`,
      { method: "PATCH", body: JSON.stringify({ title }) },
    );
    setConversations((current) =>
      current.map((item) => (item.id === id ? response.conversation : item)),
    );
  }
  async function renameConversation() {
    const id = renamingId;
    const title = renameDraft.trim();
    setRenamingId(null);
    setRenameDraft("");
    if (!id || !title) return;
    try {
      await saveConversationTitle(id, title);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function applyBranch(pending: PendingBranchSubmission, reconcile = false) {
    if (branchAbortRef.current || !isCurrentView(pending.view)) return;
    const controller = new AbortController();
    branchAbortRef.current = controller;
    pendingBranchRef.current = pending;
    const guard = captureAccountRequestGuard();
    let accepted = false;
    setBranchBusy(true);
    setError("");
    try {
      let branch = reconcile
        ? await branchesClient.find(pending.request.client_request_id, controller.signal)
        : null;
      if (!branch)
        branch = await branchesClient.create(
          pending.view.conversationId,
          pending.request,
          controller.signal,
        );
      guard();
      if (!isCurrentView(pending.view) || pendingBranchRef.current !== pending) return;
      accepted = true;
      if (
        branch.source_conversation_id !== pending.view.conversationId ||
        branch.source_message_id !== pending.request.message_id ||
        branch.action !== pending.request.action ||
        branch.conversation.id === pending.view.conversationId
      )
        throw new Error("分支身份不一致，请核对后重试。");
      const history = await historyClient.list(branch.conversation.id, {
        signal: controller.signal,
      });
      guard();
      if (!isCurrentView(pending.view) || pendingBranchRef.current !== pending) return;
      if (
        branch.action !== "fork" &&
        typeof branch.draft_content !== "string" &&
        !Array.isArray(branch.draft_content)
      )
        throw new Error("分支草稿不可用，请核对后重试。");
      const newView = selectConversationView(branch.conversation.id);
      setConversations((current) => [
        branch.conversation,
        ...current.filter((item) => item.id !== branch.conversation.id),
      ]);
      setMessages(history.messages);
      setHistoryBefore(history.nextBeforeId);
      setHistoryHasMore(history.hasMore);
      setHistoryLoading(false);
      setAttachments(pending.draftFiles);
      setArtifactAttachments(pending.draftArtifacts);
      draftRestoreRef.current = { view: newView, text: pending.draftText };
      composerRef.current?.setText(pending.draftText);
      if (branch.action === "fork") return;
      const userMessage: Message = {
        id: createUuid(),
        role: "user",
        content: branch.draft_content,
      };
      const assistantId = createUuid();
      setMessages((current) => [
        ...current,
        userMessage,
        { id: assistantId, role: "assistant", content: "" },
      ]);
      await submitRun(
        {
          request: {
            conversation_id: branch.conversation.id,
            client_request_id: createUuid(),
            model: pending.execution.model,
            reasoning_effort: pending.execution.reasoning,
            model_parameters: pending.execution.parameters,
            ...(pending.execution.publicResearch
              ? { public_research: pending.execution.publicResearch }
              : {}),
            provider_key_id: pending.execution.providerKeyId,
            content: requestMessageContent(branch.draft_content),
          },
          optimisticUserId: userMessage.id,
          optimisticAssistantId: assistantId,
          optimisticContent: userMessage.content,
          preserveDraft: true,
        },
        newView,
      );
    } catch (cause) {
      if (controller.signal.aborted || !isCurrentView(pending.view)) return;
      if (
        (cause instanceof CloudBranchRequestError || cause instanceof CloudChatHistoryError) &&
        cause.status === 401
      ) {
        notifyRelaySessionExpired();
        return;
      }
      const definitive =
        cause instanceof CloudBranchRequestError &&
        cause.status >= 400 &&
        cause.status < 500 &&
        cause.status !== 408 &&
        cause.status !== 429;
      if (cause instanceof CloudBranchUnconfirmedError || accepted || (reconcile && !definitive)) {
        setBranchUnconfirmed(true);
        setError("分支结果尚未确认，请核对原请求后继续。");
      } else {
        pendingBranchRef.current = null;
        setBranchPendingMessageId(null);
        setBranchUnconfirmed(false);
        setError(cause instanceof Error ? cause.message : "分支操作失败");
      }
    } finally {
      if (branchAbortRef.current === controller) {
        branchAbortRef.current = null;
        if (isCurrentView(pending.view)) setBranchBusy(false);
      }
    }
  }

  async function branchConversation(
    messageRef: HistoryMessageRef,
    edited?: { text: string; files: PendingUploadedFile[] },
  ) {
    const view = viewRef.current;
    if (
      !isCurrentView(view) ||
      streaming ||
      historyLoading ||
      uploadingFiles ||
      branchAbortRef.current ||
      pendingBranchRef.current ||
      researchConfirmationRef.current ||
      pendingSubmissionRef.current ||
      modelPreparationAbortRef.current
    )
      return;
    const index = messages.findIndex(
      (message) => message.id === messageRef.messageId && message.role === "user",
    );
    if (index < 0 || messageRef.segmentId !== view.conversationId) return;
    const original = messages[index];
    if (edited && original.content_omitted) {
      void readMessageBody(original.id);
      return;
    }
    let anchor = original.id;
    let action: CloudBranchRequest["action"] = "fork";
    let content: unknown;
    if (edited) {
      const ids = edited.files.map((file) => file.relativePath);
      if (
        ids.length > 8 ||
        ids.some(
          (id) =>
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) &&
            !cloudArtifactVersionFromLink(id),
        )
      ) {
        setError("附件标识无效，请从文件库重新选择。");
        return;
      }
      const originalIDs = [
        ...cloudFileReferences(original.content).map((file) => file.file_id),
        ...cloudArtifactReferences(original.content).map(
          (version) => `cloud-artifacts/${version.version_id}`,
        ),
      ];
      const unchanged =
        edited.text === messageText(original.content) &&
        ids.length === originalIDs.length &&
        ids.every((id, i) => id === originalIDs[i]);
      action = unchanged ? "regenerate" : "edit";
      content = ids.length
        ? [
            ...(edited.text.trim() ? [{ type: "text", text: edited.text }] : []),
            ...ids.map((id) => {
              const versionId = cloudArtifactVersionFromLink(id);
              return versionId
                ? { type: "artifact_reference", version_id: versionId }
                : { type: "file_reference", file_id: id };
            }),
          ]
        : edited.text;
      if (!edited.text.trim() && !ids.length) {
        setError("编辑后的消息不能为空。");
        return;
      }
    } else {
      for (let next = index + 1; next < messages.length && messages[next].role !== "user"; next++)
        if (messages[next].role === "assistant") anchor = messages[next].id;
    }
    const provider = selectedModelOption ? relayProviderKeyId(selectedModelOption.providerId) : 0;
    if (action !== "fork" && provider <= 0) {
      setError("请选择可用的模型分组后重试。");
      return;
    }
    const draft = composerRef.current?.getDraft();
    let parameters: CloudChatModelParameters;
    try {
      parameters =
        action === "fork"
          ? {}
          : await prepareModelParameters(
              view,
              selectedModelOption?.providerId ?? "",
              provider,
              model,
            );
      if (!isCurrentView(view)) return;
    } catch (cause) {
      if (!isCurrentView(view)) return;
      if (action !== "fork") {
        setError(cause instanceof Error ? cause.message : "请检查模型参数。");
        return;
      }
      parameters = {};
    }
    const pending: PendingBranchSubmission = {
      view,
      request: {
        client_request_id: createUuid(),
        message_id: anchor,
        action,
        ...(action === "edit" ? { content } : {}),
      },
      draftText: draft ? buildTextFromComposerDraft(draft) : "",
      draftFiles: [...attachments],
      draftArtifacts: [...artifactAttachments],
      execution: {
        model,
        reasoning: cloudChatReasoningEffort(reasoning),
        providerKeyId: provider,
        parameters,
      },
    };
    const proceed = (research?: CloudChatPublicResearch) => {
      if (!isCurrentView(pending.view)) return;
      pending.execution.publicResearch = research;
      setBranchPendingMessageId(original.id);
      void applyBranch(pending);
    };
    if (action !== "fork" && runtimeControls.nativeWebSearchEnabled) {
      requestResearchConfirmation(
        messageText(action === "edit" ? content : original.content),
        view,
        proceed,
      );
    } else proceed();
  }

  async function prepareModelParameters(
    view: ConversationView,
    providerId: string,
    keyId: number,
    modelId: string,
  ) {
    const localSettings = structuredClone({ customProviders: settingsRef.current.customProviders });
    const preferences = cloudChatClientPreferences();
    const controller = new AbortController();
    modelPreparationAbortRef.current = controller;
    setPreparingExecution(true);
    try {
      const limits = await modelLimitsClient.get(keyId, modelId, controller.signal);
      if (!isCurrentView(view) || controller.signal.aborted) throw new Error("当前会话已切换。");
      return buildCloudChatModelParameters(localSettings, providerId, modelId, preferences, limits);
    } finally {
      if (modelPreparationAbortRef.current === controller) {
        modelPreparationAbortRef.current = null;
        if (isCurrentView(view)) setPreparingExecution(false);
      }
    }
  }

  function requestResearchConfirmation(
    topic: string,
    view: ConversationView,
    submit: PendingResearchConfirmation["submit"],
  ) {
    if (!isCurrentView(view) || researchConfirmationRef.current) return;
    const pending = {
      id: createUuid(),
      view,
      topic: initialCloudResearchTopic(topic),
      guard: captureAccountRequestGuard(),
      submit,
    };
    researchConfirmationRef.current = pending;
    setResearchConfirmation(pending);
  }

  function settleResearchConfirmation(
    pending: PendingResearchConfirmation,
    research?: CloudChatPublicResearch,
  ) {
    if (researchConfirmationRef.current !== pending) return;
    researchConfirmationRef.current = null;
    setResearchConfirmation(null);
    if (!research) return;
    try {
      pending.guard();
      if (isCurrentView(pending.view)) pending.submit(parseCloudChatPublicResearch(research));
    } catch (cause) {
      if (isCurrentView(pending.view))
        setError(cause instanceof Error ? cause.message : "公开检索授权已失效，请重试。");
    }
  }

  async function exportConversation(format: "markdown" | "json") {
    const view = viewRef.current;
    if (!view.conversationId || !isCurrentView(view) || exportAbortRef.current) return;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExporting(true);
    setError("");
    const guard = captureAccountRequestGuard();
    try {
      const result = await branchesClient.exportConversation(
        view.conversationId,
        format,
        controller.signal,
      );
      guard();
      result.guard();
      if (!isCurrentView(view)) return;
      const url = URL.createObjectURL(result.blob);
      try {
        guard();
        result.guard();
        if (!isCurrentView(view)) return;
        const link = document.createElement("a");
        link.href = url;
        link.download = result.filename;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (cause) {
      if (!controller.signal.aborted && isCurrentView(view)) {
        if (cause instanceof CloudBranchRequestError && cause.status === 401)
          notifyRelaySessionExpired();
        setError(cause instanceof Error ? cause.message : "导出失败，请重试。");
      }
    } finally {
      if (exportAbortRef.current === controller) {
        exportAbortRef.current = null;
        if (isCurrentView(view)) setExporting(false);
      }
    }
  }

  async function attachFileList(files: File[]) {
    if (
      !files.length ||
      uploadAbortRef.current ||
      modelPreparationAbortRef.current ||
      streaming ||
      submissionUnconfirmed ||
      submissionQueueFull ||
      accountInvalidatedRef.current
    )
      return;
    if (!isCurrentView(viewRef.current)) return;
    const resourceCount = attachments.length + artifactAttachments.length;
    if (resourceCount >= 8) {
      setError("每条消息最多引用 8 个文件或成果，请先移除附件。");
      return;
    }
    const guard = captureAccountRequestGuard();
    let view = viewRef.current;
    setUploadingFiles(true);
    try {
      if (!view.conversationId) {
        const id = await createConversation();
        guard();
        if (!id) return;
        view = viewRef.current;
      }
      if (!isCurrentView(view) || uploadAbortRef.current) return;
      const controller = new AbortController();
      uploadAbortRef.current = controller;
      setUploadingFiles(true);
      setError("");
      try {
        for (const file of files.slice(0, 8 - resourceCount)) {
          if (!isCurrentView(view) || controller.signal.aborted) return;
          const uploaded = await filesClient.upload(file, view.conversationId, controller.signal);
          guard();
          if (!isCurrentView(view) || controller.signal.aborted) return;
          setAttachments((current) =>
            current.some((item) => item.id === uploaded.id) ? current : [...current, uploaded],
          );
        }
        if (files.length > 8 - resourceCount)
          setError("每条消息最多引用 8 个文件或成果，其余文件尚未上传。");
      } finally {
        if (uploadAbortRef.current === controller) {
          uploadAbortRef.current = null;
          if (isCurrentView(view)) setUploadingFiles(false);
        }
      }
    } catch (cause) {
      if (!isCurrentView(view)) return;
      if (cause instanceof CloudChatFileError && cause.status === 401) notifyRelaySessionExpired();
      setError(cause instanceof Error ? cause.message : "附件上传失败，请在文件库中核对。");
    } finally {
      if (isCurrentView(view) && !uploadAbortRef.current) setUploadingFiles(false);
    }
  }

  async function attachFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    await attachFileList(files);
  }

  async function submitRun(pending: PendingRunSubmission, view: ConversationView) {
    if (!isCurrentView(view) || submissionAbortRef.current) return;
    const controller = new AbortController();
    submissionAbortRef.current = controller;
    pendingSubmissionRef.current = pending;
    attachedRunIdRef.current = `pending:${pending.request.client_request_id}`;
    setRestoredTerminalRun(null);
    setSubmissionQueueFull(false);
    setMessages((current) =>
      current.some((message) => message.id === pending.optimisticUserId)
        ? current
        : [
            ...current,
            { id: pending.optimisticUserId, role: "user", content: pending.optimisticContent },
            { id: pending.optimisticAssistantId, role: "assistant", content: "" },
          ],
    );
    setStreaming(true);
    setError("");
    setRunConnection("connecting");
    try {
      const run = await runsClient.createRun(pending.request, controller.signal);
      if (!isCurrentView(view)) return;
      pendingSubmissionRef.current = null;
      setSubmissionUnconfirmed(false);
      if (!pending.preserveDraft) {
        composerRef.current?.clear();
        setAttachments([]);
        setArtifactAttachments([]);
      }
      setMessages((current) => {
        const rebound = current.map((message) => {
          if (message.id === pending.optimisticUserId)
            return { ...message, id: run.user_message_id };
          if (message.id === pending.optimisticAssistantId) {
            return { ...message, id: run.assistant_message_id, content: run.output };
          }
          return message;
        });
        return rebound.filter(
          (message, index) => rebound.findIndex((item) => item.id === message.id) === index,
        );
      });
      attachRun(run, view);
      if (cancelSubmissionRef.current && !isCloudChatRunTerminal(run)) {
        try {
          const cancelled = await runsClient.cancelRun(run.id, controller.signal);
          displayRun(cancelled, view);
        } catch (cause) {
          if (isCurrentView(view))
            setError(cause instanceof Error ? cause.message : "停止结果尚未确认，请重试");
        }
      }
      void refreshConversations().catch(() => undefined);
    } catch (cause) {
      if (controller.signal.aborted || !isCurrentView(view)) return;
      if (cause instanceof CloudChatRunRequestError && cause.status === 401)
        notifyRelaySessionExpired();
      if (cause instanceof CloudChatAccountQueueFullError) {
        setSubmissionQueueFull(true);
        setSubmissionUnconfirmed(false);
        cancelSubmissionRef.current = false;
        setMessages((current) =>
          current.filter(
            (message) =>
              message.id !== pending.optimisticUserId &&
              message.id !== pending.optimisticAssistantId,
          ),
        );
      } else if (cause instanceof CloudChatSubmissionUnknownError) {
        // Keep the original body/ID until a retry can reconcile its acceptance.
        setSubmissionUnconfirmed(true);
      } else {
        pendingSubmissionRef.current = null;
        setSubmissionUnconfirmed(false);
        setMessages((current) =>
          current.filter(
            (message) =>
              message.id !== pending.optimisticUserId &&
              message.id !== pending.optimisticAssistantId,
          ),
        );
      }
      setStreaming(false);
      setRunConnection(null);
      setError(
        cause instanceof CloudChatAccountQueueFullError
          ? ""
          : cause instanceof Error
            ? cause.message
            : "任务提交失败",
      );
    } finally {
      if (submissionAbortRef.current === controller) submissionAbortRef.current = null;
    }
  }

  async function stopRun() {
    const view = viewRef.current;
    const run = activeRun;
    if (pendingSubmissionRef.current && submissionAbortRef.current) {
      cancelSubmissionRef.current = true;
      setError("正在确认任务后停止，请稍候");
      return;
    }
    if (!run || isCloudChatRunTerminal(run)) return;
    try {
      const next = await runsClient.cancelRun(run.id);
      if (!isCurrentView(view) || attachedRunIdRef.current !== run.id) return;
      displayRun(next, view);
      // Do not abort the subscriber: it still needs the server's cancellation result.
    } catch (cause) {
      if (!isCurrentView(view)) return;
      if (cause instanceof CloudChatRunRequestError && cause.status === 401)
        notifyRelaySessionExpired();
      setError(cause instanceof Error ? cause.message : "停止结果尚未确认，请重试");
    }
  }

  async function send() {
    if (projectContextMutation.current) return;
    if (modelPreparationAbortRef.current) return;
    if (!isCurrentView(viewRef.current)) return;
    if (researchConfirmationRef.current) return;
    if (branchBusy || branchUnconfirmed || branchAbortRef.current || pendingBranchRef.current)
      return;
    if (pendingSubmissionRef.current) {
      await submitRun(pendingSubmissionRef.current, viewRef.current);
      return;
    }
    const draft = composerRef.current?.getDraft();
    const text = draft ? buildTextFromComposerDraft(draft).trim() : "";
    if (
      streaming ||
      uploadingFiles ||
      uploadAbortRef.current ||
      modelsLoading ||
      !webSettingsLoaded ||
      modelOptions.length === 0 ||
      !selectedModelOption ||
      (!text && attachments.length === 0 && artifactAttachments.length === 0)
    )
      return;
    if (attachments.some((file) => !cloudFileCanReference(file))) {
      setError("有附件尚未完成解析或需要拆分，请在文件库中查看状态，或从本条消息移除后发送。");
      return;
    }
    if (artifactAttachments.some((version) => version.state !== "ready")) {
      setError("有成果尚未正式保存，请刷新成果状态，或从本条消息移除后发送。");
      return;
    }
    const executionProviderKeyId = relayProviderKeyId(selectedModelOption.providerId);
    if (executionProviderKeyId <= 0) {
      setError("请选择可用的模型分组后重试。");
      return;
    }
    let parameters: CloudChatModelParameters;
    const preparedView = viewRef.current;
    try {
      parameters = await prepareModelParameters(
        preparedView,
        selectedModelOption.providerId,
        executionProviderKeyId,
        model,
      );
      if (!isCurrentView(preparedView)) return;
      if (
        parameters.input_modalities?.length === 1 &&
        attachments.some((file) => file.state === "vision_ready")
      )
        throw new Error("所选模型设置为仅文本输入，请开启图片输入或从消息中移除图片。");
    } catch (cause) {
      if (isCurrentView(preparedView))
        setError(cause instanceof Error ? cause.message : "请检查模型参数。");
      return;
    }
    const proceed = async (publicResearch?: CloudChatPublicResearch) => {
      if (!isCurrentView(preparedView)) return;
      if (latestRunRef.current && !isCloudChatRunTerminal(latestRunRef.current)) {
        setError("请等待当前任务完成，或停止后再发送。");
        return;
      }
      setError("");
      setContextNotice("");
      const id = conversationId || (await createConversation());
      if (!id) return;
      const hasResources = attachments.length + artifactAttachments.length > 0;
      const content: unknown = hasResources
        ? [
            ...(text ? [{ type: "text", text }] : []),
            ...attachments.map((attachment) => ({
              type: "file_reference",
              file_id: attachment.id,
            })),
            ...artifactAttachments.map((version) => ({
              type: "artifact_reference",
              version_id: version.id,
            })),
          ]
        : text;
      const view = viewRef.current;
      const optimisticContent = hasResources
        ? [
            ...(text ? [{ type: "text", text }] : []),
            ...attachments.map((file) => ({
              type: "file_reference",
              file_id: file.id,
              name: file.name,
              mime: file.mime,
              size: file.size,
            })),
            ...artifactAttachments.map((version) => ({
              type: "artifact_reference",
              version_id: version.id,
              name: version.name,
              mime: version.mime,
              size: version.size,
              family_id: version.family_id,
              number: version.number,
              sha256: version.sha256,
            })),
          ]
        : content;
      const optimisticUser: Message = {
        id: createUuid(),
        role: "user",
        content: optimisticContent,
      };
      const assistantId = createUuid();
      setMessages((current) => [
        ...current,
        optimisticUser,
        { id: assistantId, role: "assistant", content: "" },
      ]);
      cancelSubmissionRef.current = false;
      await submitRun(
        {
          request: {
            conversation_id: id,
            client_request_id: createUuid(),
            model,
            reasoning_effort: cloudChatReasoningEffort(reasoning),
            model_parameters: parameters,
            ...(publicResearch ? { public_research: publicResearch } : {}),
            provider_key_id: executionProviderKeyId,
            content,
          },
          optimisticUserId: optimisticUser.id,
          optimisticAssistantId: assistantId,
          optimisticContent: optimisticContent,
        },
        view,
      );
    };
    if (runtimeControls.nativeWebSearchEnabled) {
      requestResearchConfirmation(text, preparedView, (research) => {
        void proceed(research).catch((cause) => {
          if (isCurrentView(preparedView))
            setError(cause instanceof Error ? cause.message : "发送失败，请重试。");
        });
      });
    } else await proceed();
  }

  const copyMessageText = useCallback(
    async (text: string, view: ConversationView) => {
      const guard = captureAccountRequestGuard();
      try {
        await copyCloudMessageText(text, () => {
          guard();
          if (!isCurrentView(view)) throw new Error("会话已切换");
        });
        return true;
      } catch {
        if (isCurrentView(view)) setError("无法复制完整正文，请在原文窗口下载完整文本。");
        return false;
      }
    },
    [isCurrentView],
  );

  const transcriptRows = useMemo<TranscriptRow[]>(
    () =>
      messages.map((message, messageIndex) => {
        const fullText = messageText(message.content);
        const preview = cloudMessageTranscriptPreview(fullText);
        const messageView = viewRef.current;
        const canCopy = cloudMessageFitsTextBudget(fullText, CLOUD_MESSAGE_CLIPBOARD_BYTES);
        const copyContent =
          preview.truncated && canCopy ? () => copyMessageText(fullText, messageView) : undefined;
        const copyDisabledReason = message.content_omitted
          ? "请先读取完整消息后复制正文"
          : !canCopy
            ? "消息较长，请下载完整正文"
            : undefined;
        const text = message.content_omitted ? "这条消息正文按需加载。" : preview.text;
        if (message.role === "user") {
          return {
            key: message.id,
            origin: "history",
            kind: "user",
            text: preview.truncated ? `${text}\n\n${preview.notice}` : text,
            contentOmitted: message.content_omitted,
            contentPreview: preview.truncated,
            retryText: preview.truncated ? fullText : undefined,
            inlineEditText:
              preview.truncated &&
              cloudMessageFitsTextBudget(fullText, CLOUD_MESSAGE_INLINE_EDIT_BYTES)
                ? fullText
                : undefined,
            copyContent,
            copyDisabledReason,
            attachments: [
              ...cloudFileReferences(message.content).map((file) => ({
                relativePath: file.file_id,
                fileName: file.name || "附件",
                kind: attachmentKind({ mime: file.mime || "text/plain" }),
                sizeBytes: file.size ?? 0,
              })),
              ...cloudArtifactReferences(message.content).map((version) => ({
                relativePath: `cloud-artifacts/${version.version_id}`,
                fileName: `${version.name || "成果"}${version.number ? ` · v${version.number}` : ""}`,
                kind: "text" as const,
                sizeBytes: version.size ?? 0,
              })),
            ],
            referencedConversations: [],
            messageRef: !streaming
              ? {
                  segmentIndex: 0,
                  messageIndex,
                  segmentId: conversationId,
                  messageId: message.id,
                  role: "user",
                  contentHash: "",
                }
              : undefined,
          };
        }
        return {
          key: message.id,
          origin: streaming && message.id === messages.at(-1)?.id ? "stream" : "history",
          kind: "assistant",
          turnKey: message.id,
          contentOmitted: message.content_omitted,
          contentPreview: preview.truncated,
          copyContent,
          copyDisabledReason,
          shareText:
            preview.truncated &&
            cloudMessageFitsTextBudget(fullText, CLOUD_MESSAGE_INLINE_EDIT_BYTES)
              ? fullText
              : undefined,
          rounds: [
            {
              key: `${message.id}:round:1`,
              round: 1,
              runningToolCallIds: [],
              blocks: text
                ? [
                    {
                      kind: "text",
                      id: `${message.id}:text`,
                      text: message.content_omitted
                        ? `正文按需加载。[查看消息正文](cloud-messages/${message.id})`
                        : preview.truncated
                          ? `${linkCloudArtifactCitations(linkCloudSourceCitations(linkCloudFileCitations(text)))}\n\n${preview.notice} [分段查看完整正文](cloud-messages/${message.id})`
                          : linkCloudArtifactCitations(
                              linkCloudSourceCitations(linkCloudFileCitations(text)),
                            ),
                    },
                  ]
                : [],
            },
          ],
        };
      }),
    [messages, streaming, conversationId, copyMessageText],
  );

  const sidebarItems = useMemo<SidebarConversation[]>(() => {
    const cloud: SidebarConversation[] = conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      providerId: "web-chat",
      model: conversation.model,
      createdAt: toEpoch(conversation.created_at),
      updatedAt: toEpoch(conversation.updated_at),
      isPinned: pinnedConversationIds.has(conversation.id),
    }));
    return cloud.sort(
      (left, right) =>
        Number(right.isPinned === true) - Number(left.isPinned === true) ||
        right.updatedAt - left.updatedAt,
    );
  }, [conversations, pinnedConversationIds]);

  const runningConversationIds = useMemo(
    () => (streaming && conversationId ? new Set([conversationId]) : new Set<string>()),
    [conversationId, streaming],
  );
  const pendingUploadedFiles = useMemo<PendingUploadedFile[]>(
    () => [
      ...attachments.map((attachment) => ({
        relativePath: attachment.id,
        fileName: `${attachment.name} · ${cloudFileStatus(attachment)}`,
        kind: attachmentKind(attachment),
        sizeBytes: attachment.size,
      })),
      ...artifactAttachments.map((version) => ({
        relativePath: `cloud-artifacts/${version.id}`,
        fileName: `${version.name} · v${version.number}`,
        kind: "text" as const,
        sizeBytes: version.size,
      })),
    ],
    [attachments, artifactAttachments],
  );
  const conversationFiles = useMemo(() => {
    const refs = messages.flatMap((message) =>
      message.role === "user" ? cloudFileReferences(message.content) : [],
    );
    return refs.filter(
      (file, index) => refs.findIndex((item) => item.file_id === file.file_id) === index,
    );
  }, [messages]);
  const conversationArtifacts = useMemo(() => {
    const refs = messages.flatMap((message) =>
      message.role === "user" ? cloudArtifactReferences(message.content) : [],
    );
    return refs.filter(
      (version, index) =>
        refs.findIndex((item) => item.version_id === version.version_id) === index,
    );
  }, [messages]);
  const modelOptions = useMemo(
    () =>
      buildModelOptions(settings, { floatSelectedFirst: false }).map((option) => ({
        ...option,
        nativeWebSearchSupported: true,
      })),
    [settings],
  );
  const selectedModelValue = providerKeyId
    ? toModelValue(relayProviderId(providerKeyId), model)
    : modelOptions.find((option) => option.model === model)?.value;
  const selectedModelOption = modelOptions.find((option) => option.value === selectedModelValue);

  useEffect(() => {
    if (
      modelsLoading ||
      !webSettingsLoaded ||
      (selectedModelOption && providerKeyId > 0) ||
      modelOptions.length === 0
    ) {
      return;
    }
    const preferred = settings.selectedModel
      ? modelOptions.find(
          (option) =>
            option.providerId === settings.selectedModel?.customProviderId &&
            option.model === settings.selectedModel.model,
        )
      : undefined;
    const next = selectedModelOption ?? preferred ?? modelOptions[0];
    const nextProviderKeyId = relayProviderKeyId(next.providerId);
    setModel(next.model);
    setProviderKeyId(nextProviderKeyId);
    void saveWebSettings(next.model, reasoning, nextProviderKeyId).catch((cause) =>
      setError(String(cause)),
    );
  }, [
    modelOptions,
    modelsLoading,
    reasoning,
    selectedModelOption,
    providerKeyId,
    settings.selectedModel,
    webSettingsLoaded,
    saveWebSettings,
  ]);
  const userMenuLabel = user.username || user.email;
  const userAvatarLabel = userMenuLabel.slice(0, 1).toUpperCase();
  const terminalNotice = !streaming
    ? activeRun && isCloudChatRunTerminal(activeRun)
      ? activeRun
      : restoredTerminalRun
    : null;
  const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
  const canReviewTerminalRequest =
    terminalNotice &&
    (terminalNotice.state === "failed" || terminalNotice.state === "cancelled") &&
    terminalNotice.conversation_id === conversationId &&
    terminalNotice.user_message_id === lastUserMessage?.id;
  const terminalRequestNeedsReader =
    lastUserMessage &&
    (lastUserMessage.content_omitted ||
      !cloudMessageFitsTextBudget(
        messageText(lastUserMessage.content),
        CLOUD_MESSAGE_INLINE_EDIT_BYTES,
      ));
  function reviewTerminalRequest() {
    const view = viewRef.current;
    if (
      !isCurrentView(view) ||
      !canReviewTerminalRequest ||
      !lastUserMessage ||
      terminalNotice?.conversation_id !== view.conversationId ||
      streaming ||
      historyLoading ||
      pendingSubmissionRef.current ||
      pendingBranchRef.current ||
      modelPreparationAbortRef.current ||
      researchConfirmationRef.current ||
      (latestRunRef.current && !isCloudChatRunTerminal(latestRunRef.current))
    )
      return;
    if (terminalRequestNeedsReader) {
      void readMessageBody(lastUserMessage.id);
      return;
    }
    setTerminalEditRequest({ token: createUuid(), messageId: lastUserMessage.id });
  }

  const landing = !historyLoading && transcriptRows.length === 0 && !streaming;
  const canSwitchPresentation = landing && !preparingExecution;
  const composerLocked =
    projectContextBusy ||
    preparingExecution ||
    historyLoading ||
    uploadingFiles ||
    submissionUnconfirmed ||
    submissionQueueFull ||
    branchBusy ||
    branchUnconfirmed;
  function clearResources() {
    setAccountSettingsOpen(false);
    sidebarPreview.dismiss();
    setComposerMenu(null);
    setFilePanel(null);
    setArtifactPanel(null);
    setSourcePanel(null);
    setWorkPanel(null);
    setWorkspaceView("chat");
  }
  function closeResources() {
    projectNavigation.request(() => {
      clearResources();
      if (sidebar.isMobile) setSidebarOpen(false);
    });
  }
  function navigateConversation(id?: string) {
    projectNavigation.request(() => {
      clearResources();
      if (id !== undefined) void openConversation(id);
      else {
        selectConversationView("");
        composerRef.current?.clear();
        composerRef.current?.focus();
      }
      if (sidebar.isMobile) setSidebarOpen(false);
    });
  }
  function openResource(
    resource: "files" | "artifacts" | "sources" | "projects" | "memory",
    page = false,
    projectId?: string,
    fileId?: string,
    pinSidebar = false,
  ) {
    projectNavigation.request(() => {
      setAccountSettingsOpen(false);
      sidebarPreview.dismiss();
      if (pinSidebar) sidebar.setOpen(true);
      setFilePanel(resource === "files" ? { fileId } : null);
      setArtifactPanel(resource === "artifacts" ? {} : null);
      setSourcePanel(resource === "sources" ? {} : null);
      setWorkPanel(resource === "projects" || resource === "memory" ? resource : null);
      setInitialProjectId(projectId);
      setWorkspaceView(page ? (resource === "projects" ? "projects" : "library") : "chat");
      if (page && (resource === "files" || resource === "artifacts")) {
        setSpaceVisited(true);
        setSpaceLocation({
          ...CLOUD_SPACE_HOME,
          category: resource === "artifacts" ? "outputs" : "all",
        });
      }
      if (page && sidebar.isMobile) setSidebarOpen(false);
    });
  }
  function openProject(id = "") {
    openResource("projects", true, id);
  }
  function navigateSpace(location: CloudSpaceLocation) {
    projectNavigation.request(() => {
      setSpaceVisited(true);
      clearResources();
      setSpaceLocation(location);
      setWorkspaceView("library");
      if (sidebar.isMobile) setSidebarOpen(false);
    });
  }
  function openSpaceItem(item: CloudSpaceItem) {
    if (item.kind === "folder") {
      navigateSpace({ ...CLOUD_SPACE_HOME, folder: item.id });
      return;
    }
    projectNavigation.request(() => {
      setSpaceVisited(true);
      setFilePanel(item.kind === "file" ? { fileId: item.target_id } : null);
      setArtifactPanel(item.kind === "artifact" ? { versionId: item.target_id } : null);
      setSourcePanel(null);
      setWorkPanel(null);
      setWorkspaceView("library");
      sidebarPreview.dismiss();
      if (sidebar.isMobile) setSidebarOpen(false);
    });
  }
  async function referenceSpaceItems(items: CloudSpaceItem[]) {
    if (composerLocked || streaming || modelPreparationAbortRef.current)
      throw new Error("请等待当前操作完成后再引用资料。");
    const view = viewRef.current,
      guard = captureWorkGuard();
    const files: CloudChatFile[] = [],
      versions: CloudChatArtifactVersion[] = [];
    for (const item of items) {
      guard();
      if (item.kind === "file") {
        const file = await filesClient.get(item.target_id);
        guard();
        if (!cloudFileCanReference(file))
          throw new Error(`${item.name}暂不能引用，请打开预览查看处理状态。`);
        files.push(file);
      } else if (item.kind === "artifact") {
        const version = await artifactsClient.get(item.target_id);
        guard();
        if (version.state !== "ready") throw new Error(`${item.name}尚未保存完成。`);
        versions.push(version);
      }
    }
    guard();
    if (!isCurrentView(view)) return;
    const newFiles = files.filter((file) => !attachments.some((old) => old.id === file.id)),
      newVersions = versions.filter(
        (version) => !artifactAttachments.some((old) => old.id === version.id),
      );
    if (attachments.length + artifactAttachments.length + newFiles.length + newVersions.length > 8)
      throw new Error("每条消息最多引用 8 个文件或成果。");
    setAttachments((old) => [...old, ...newFiles]);
    setArtifactAttachments((old) => [...old, ...newVersions]);
    clearResources();
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  function pinSidebarPreview() {
    if (shownSidebarDestination === "library") {
      openResource("files", true, undefined, undefined, true);
      return;
    }
    projectNavigation.request(() => {
      if (shownSidebarDestination === "devices") {
        setSettingsSection("devices");
        setAccountSettingsOpen(true);
      } else if (workspaceView !== "chat") clearResources();
      sidebarPreview.dismiss();
      sidebar.setOpen(true);
    });
  }
  function showResourceDetail(action: () => void) {
    projectNavigation.request(() => {
      clearResources();
      action();
    });
  }
  function fillStarter(text: string) {
    if (
      !isCurrentView(viewRef.current) ||
      streaming ||
      pendingSubmissionRef.current ||
      composerLocked
    )
      return;
    const draft = composerRef.current?.getDraft();
    if (draft && !draft.isEmpty) {
      const suffix = `\n\n${text}`;
      composerRef.current?.setDraft({
        ...draft,
        segments: [...draft.segments, { type: "text", text: suffix }],
        text: draft.text + suffix,
        textWithoutLargePastes: draft.textWithoutLargePastes + suffix,
        isEmpty: false,
      });
      setContextNotice("已添加到现有草稿，发送前可继续编辑。");
    } else composerRef.current?.setText(text);
    composerRef.current?.focus();
  }
  function openComposerPicker(kind: CloudComposerPicker, anchor: HTMLElement | null) {
    if (composerLocked || streaming) return;
    setComposerMenuAnchor(anchor);
    setComposerMenu((old) => (old === kind ? null : kind));
  }
  function attachLibraryFile(file: CloudChatFile) {
    if (
      !isCurrentView(viewRef.current) ||
      composerLocked ||
      streaming ||
      !cloudFileCanReference(file)
    )
      return;
    if (attachments.some((item) => item.id === file.id)) return;
    if (attachments.length + artifactAttachments.length >= 8)
      throw new Error("每条消息最多引用 8 个文件或成果。");
    setAttachments((old) => (old.some((item) => item.id === file.id) ? old : [...old, file]));
  }
  async function selectComposerProject(project: CloudProject | null) {
    if (
      composerLocked ||
      streaming ||
      projectContextMutation.current ||
      !isCurrentView(viewRef.current)
    )
      return;
    projectContextMutation.current = true;
    setProjectContextBusy(true);
    let actionView = viewRef.current;
    try {
      const id = conversationId || (await createConversation(true));
      if (!id || viewRef.current.conversationId !== id || !isCurrentView(viewRef.current)) return;
      actionView = viewRef.current;
      setContextNotice("正在更新项目上下文…");
      const guard = captureWorkGuard();
      const binding = await projectsClient.getAssociation(id);
      guard();
      if (binding.project_id !== (project?.id ?? "")) {
        await projectsClient.setAssociation(id, project?.id ?? "", binding.version);
        guard();
      }
      setComposerProject({ scope: `${user.id}:${id}`, project });
      setNavigationRevision((old) => old + 1);
      setContextNotice(project ? `已选择项目：${project.name}` : "已移出项目。");
    } catch (cause) {
      if (isCurrentView(actionView)) {
        setContextNotice("");
        setError(cause instanceof Error ? cause.message : "项目更新失败，请刷新后重试。");
      }
      throw cause;
    } finally {
      projectContextMutation.current = false;
      setProjectContextBusy(false);
    }
  }

  const terminalFeedback =
    terminalNotice && cloudChatRunStatusText(terminalNotice) ? (
      <CloudChatFeedback
        role="status"
        tone={
          terminalNotice.state === "failed"
            ? "error"
            : terminalNotice.state === "interrupted"
              ? "warning"
              : "info"
        }
        message={cloudChatRunStatusText(terminalNotice) ?? ""}
        data-restored-run-state={!activeRun ? terminalNotice.state : undefined}
        data-terminal-run-state={terminalNotice.state}
        description={
          canReviewTerminalRequest
            ? terminalRequestNeedsReader
              ? "先查看完整原文；较长消息仍需分段查看或下载。"
              : "先编辑并确认，再在新分支发起请求。"
            : undefined
        }
        actions={
          canReviewTerminalRequest ? (
            <button
              type="button"
              className="cloud-feedback-action"
              disabled={
                historyLoading ||
                branchBusy ||
                branchUnconfirmed ||
                preparingExecution ||
                Boolean(researchConfirmation) ||
                submissionUnconfirmed ||
                submissionQueueFull
              }
              onClick={reviewTerminalRequest}
            >
              {terminalRequestNeedsReader ? "查看原请求正文" : "编辑并重试"}
            </button>
          ) : undefined
        }
      />
    ) : null;
  const preparationNotice = [
    preparingExecution && "正在读取账户模型参数…",
    branchBusy && "正在保存分支…",
    exporting && "正在导出…",
    uploadingFiles && "正在保存并校验附件…",
  ]
    .filter(Boolean)
    .join(" · ");
  const composerFeedback =
    error ||
    historyError ||
    streamNotice ||
    preparationNotice ||
    contextNotice ||
    submissionUnconfirmed ||
    submissionQueueFull ||
    branchUnconfirmed ? (
      <div className="cloud-feedback-stack" data-cloud-composer-feedback="">
        {error ? <CloudChatFeedback tone="error" message={error} /> : null}
        {historyError && historyError !== error ? (
          <CloudChatFeedback
            tone="error"
            message={historyError}
            actions={
              <button
                type="button"
                className="cloud-feedback-action"
                disabled={historyPageLoading}
                onClick={() => void loadEarlierHistory()}
              >
                重试加载历史
              </button>
            }
          />
        ) : null}
        {submissionUnconfirmed ? (
          <CloudChatFeedback
            tone="warning"
            message="提交结果尚未确认，请核对原任务后继续。"
            actions={
              <button
                type="button"
                className="cloud-feedback-action"
                disabled={streaming}
                onClick={() => void send()}
              >
                核对提交状态
              </button>
            }
          />
        ) : null}
        {submissionQueueFull ? (
          <CloudChatFeedback
            tone="warning"
            message="账户队列已满，这次提交尚未受理。"
            description="草稿和附件已保留，请等待或取消已有任务后重试。"
            actions={
              <>
                <button
                  type="button"
                  className="cloud-feedback-action"
                  disabled={streaming}
                  onClick={() => void send()}
                >
                  重试提交
                </button>
                <button
                  type="button"
                  className="cloud-feedback-action"
                  disabled={streaming}
                  onClick={() => {
                    pendingSubmissionRef.current = null;
                    cancelSubmissionRef.current = false;
                    attachedRunIdRef.current = null;
                    setSubmissionQueueFull(false);
                    setError("");
                    composerRef.current?.focus();
                  }}
                >
                  {pendingSubmissionRef.current?.preserveDraft ? "取消本次生成" : "返回编辑"}
                </button>
              </>
            }
          />
        ) : null}
        {branchUnconfirmed ? (
          <CloudChatFeedback
            tone="warning"
            message="分支结果尚未确认，请核对原请求后继续。"
            actions={
              <button
                type="button"
                className="cloud-feedback-action"
                disabled={branchBusy}
                onClick={() => {
                  const pending = pendingBranchRef.current;
                  if (pending) void applyBranch(pending, true);
                }}
              >
                核对分支状态
              </button>
            }
          />
        ) : null}
        {streamNotice ? <CloudChatFeedback compact message={streamNotice} /> : null}
        {preparationNotice ? <CloudChatFeedback compact busy message={preparationNotice} /> : null}
        {contextNotice ? (
          <CloudChatFeedback
            compact
            message={contextNotice}
            onDismiss={() => setContextNotice("")}
          />
        ) : null}
      </div>
    ) : null;

  const accountMenu = (
    <UserMenu
      variant="rail"
      open={userMenuOpen}
      onOpenChange={setUserMenuOpen}
      userMenuLabel={userMenuLabel}
      userAvatarLabel={userAvatarLabel}
      email={user.email}
      balance={user.balance}
      todayTokens={accountStats?.today_tokens}
      avatarUrl={user.avatar_url}
      online
      onRefreshAccount={refreshRelayAccount}
      onDismissNavigation={() => {
        if (sidebar.isMobile) setSidebarOpen(false);
      }}
      onOpenAccount={() => {
        setSettingsSection("account");
        setAccountSettingsOpen(true);
      }}
      onOpenSettings={() => {
        setSettingsSection("system");
        setAccountSettingsOpen(true);
      }}
      onLogout={onLogout}
    />
  );

  const renderApplicationRail = (mobile = false) => (
    <ApplicationRail
      previewId={sidebarPreview.open ? sidebarPreview.destination : undefined}
      brand={
        mobile ? (
          <Button
            variant="ghost"
            size="icon"
            title="关闭边栏"
            aria-label="关闭边栏"
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeft className="size-5" />
          </Button>
        ) : (
          <img
            src="/zeroagent-logo.png"
            alt="ZeroAgent"
            draggable={false}
            className="size-8 object-contain"
          />
        )
      }
      activeId={
        accountSettingsOpen ? "settings" : workspaceView === "projects" ? "chat" : workspaceView
      }
      items={[
        {
          id: "chat",
          label: "对话",
          icon: <NavigationChat className="size-5" aria-hidden="true" />,
          activeIcon: <NavigationChatFilled className="size-5" aria-hidden="true" />,
          onSelect: closeResources,
        },
        {
          id: "library",
          label: "资料空间",
          icon: <NavigationLibrary className="size-5" aria-hidden="true" />,
          activeIcon: <NavigationLibraryFilled className="size-5" aria-hidden="true" />,
          onSelect: () => openResource("files", true),
        },
        {
          id: "devices",
          label: "设备",
          icon: <NavigationDevices className="size-5" aria-hidden="true" />,
          onSelect: () => {
            if (mobile) setSidebarOpen(false);
            setSettingsSection("devices");
            setAccountSettingsOpen(true);
          },
        },
      ]}
      footer={accountMenu}
    />
  );

  return (
    <AppErrorBoundary>
      <div
        className={`${GATEWAY_SHELL_CLASS} cloud-chat-shell`}
        data-workspace-view={workspaceView}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.htm,.css,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.sql,.log,.pdf,.docx,.xlsx,.pptx,.doc,.xls,.ppt,.png,.jpg,.jpeg,.gif,.webp,.zip,application/zip"
          className="gateway-hidden-file-input hidden"
          aria-label="选择附件"
          onChange={(event) => void attachFiles(event)}
        />
        <div
          ref={sidebarPreview.rootRef}
          className="gateway-editor-host relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          {!sidebar.isMobile ? renderApplicationRail() : null}
          <div
            data-cloud-conversation-workspace
            aria-hidden={accountSettingsOpen}
            inert={accountSettingsOpen}
            className={accountSettingsOpen ? "hidden" : "relative flex min-h-0 min-w-0 flex-1"}
          >
            {!sidebar.isMobile && !sidebar.open ? (
              <div data-cloud-sidebar-hover-edge aria-hidden="true" />
            ) : null}
            <button
              type="button"
              className="gateway-sidebar-backdrop"
              data-state={sidebarOpen ? "open" : "closed"}
              aria-label="关闭侧栏"
              aria-hidden={!sidebarOpen}
              tabIndex={sidebarOpen ? 0 : -1}
              onClick={() => setSidebarOpen(false)}
            />
            <div
              data-sidebar-preview-region
              data-transient={sidebarPreview.open ? "true" : undefined}
              data-sidebar-context={shownSidebarDestination}
              className="relative shrink-0"
            >
              {!sidebar.isMobile || shownSidebarDestination === "chat" ? (
                <div
                  className={shownSidebarDestination === "chat" ? "contents" : "hidden"}
                  aria-hidden={shownSidebarDestination !== "chat"}
                  inert={shownSidebarDestination !== "chat"}
                >
                  <ChatHistorySidebar
                    mobileRail={sidebar.isMobile ? renderApplicationRail(true) : undefined}
                    newConversationIcon={<SquarePen className="size-4 shrink-0" />}
                    onPinPreview={pinSidebarPreview}
                    previewOpen={sidebarPreview.open && shownSidebarDestination === "chat"}
                    brand={
                      <div className="cloud-sidebar-brand">
                        <GatewayBrand />
                      </div>
                    }
                    navigationContent={
                      <>
                        <div className="cloud-sidebar-utilities">
                          <button
                            type="button"
                            className="cloud-sidebar-destination"
                            aria-current={workspaceView === "library" ? "page" : undefined}
                            onClick={() => openResource("files", true)}
                          >
                            <BookOpen className="size-4" />
                            资料空间
                          </button>
                        </div>
                        <CloudChatProjectNavigation
                          key={user.id}
                          client={projectsClient}
                          captureGuard={captureAccountRequestGuard}
                          revision={navigationRevision}
                          onOpen={openProject}
                        />
                      </>
                    }
                    onOpenResourceHub={() => setFilePanel({})}
                    items={sidebarItems}
                    currentConversationId={workspaceView === "chat" ? conversationId : ""}
                    busyConversationIds={EMPTY_MUTATIONS}
                    runningConversationIds={runningConversationIds}
                    listStatus={conversationsLoading ? "loading" : "ready"}
                    scopeKey="web-chat"
                    totalItems={sidebarItems.length}
                    hasMore={conversationsHasMore}
                    isLoadingMore={conversationsLoadingMore}
                    errorMessage={conversationsError || null}
                    actionErrorMessage={error || null}
                    renamingId={renamingId}
                    renameDraft={renameDraft}
                    isOpen={
                      shownSidebarDestination === "chat" && (sidebarOpen || sidebarPreview.open)
                    }
                    fontScale={settings.customSettings.fontScale.sidebar}
                    activeView="chat"
                    showProjects={false}
                    showAgentHubs={false}
                    missingProjectPathKeys={EMPTY_PATHS}
                    runningProjectPathKeys={EMPTY_PATHS}
                    onNewConversation={() => navigateConversation()}
                    onSelectConversation={(id) => navigateConversation(id)}
                    onStartRenaming={(item) => {
                      setRenamingId(item.id);
                      setRenameDraft(item.title);
                    }}
                    onRenameDraftChange={setRenameDraft}
                    onCommitRename={() => void renameConversation()}
                    onCancelRename={() => {
                      setRenamingId(null);
                      setRenameDraft("");
                    }}
                    onSetPinned={(id, pinned) =>
                      setPinnedConversationIds((current) => {
                        const next = new Set(current);
                        if (pinned) next.add(id);
                        else next.delete(id);
                        return next;
                      })
                    }
                    onMoveToWorkspace={() => undefined}
                    onMoveConversationsToWorkspace={async (ids) => ids}
                    canShareConversations={false}
                    sharedConversationCount={0}
                    onShareConversation={() => undefined}
                    onOpenSharedConversations={() => undefined}
                    onDeleteConversation={(id) => void removeConversation(id)}
                    onDeleteConversations={removeConversations}
                    onLoadMore={() => void loadMoreConversations()}
                    footerTrailing={
                      conversationsError ? (
                        <button
                          type="button"
                          className="text-xs text-destructive"
                          onClick={() =>
                            void (conversationsHasMore
                              ? loadMoreConversations()
                              : refreshConversations().catch(() => undefined))
                          }
                        >
                          重试会话列表
                        </button>
                      ) : undefined
                    }
                    onOpenSettings={() => {
                      setSettingsSection("system");
                      setAccountSettingsOpen(true);
                    }}
                    accountMenu={false}
                  />
                </div>
              ) : null}
              {shownSidebarDestination !== "chat" ? (
                <CloudContextSidebar
                  mobileRail={sidebar.isMobile ? renderApplicationRail(true) : undefined}
                  key={`${user.id}:${shownSidebarDestination}`}
                  destination={shownSidebarDestination}
                  preview={sidebarPreview.open}
                  activeResource={
                    workspaceView === "library"
                      ? artifactPanel
                        ? "artifacts"
                        : sourcePanel
                          ? "sources"
                          : "files"
                      : undefined
                  }
                  files={filesClient}
                  spaceClient={spaceClient}
                  spaceLocation={spaceLocation}
                  spaceRevision={spaceRevision}
                  onSpaceNavigate={navigateSpace}
                  onSpaceOpen={openSpaceItem}
                  onSpaceStorage={() =>
                    projectNavigation.request(() => {
                      clearResources();
                      setSpaceVisited(true);
                      setWorkspaceView("library");
                      setSpaceStorageOpen(true);
                      if (sidebar.isMobile) setSidebarOpen(false);
                    })
                  }
                  environments={environments}
                  onOpenResource={(resource) => openResource(resource, true)}
                  onOpenFile={(id) => openResource("files", true, undefined, id)}
                  onOpenDevices={() => {
                    sidebarPreview.dismiss();
                    setSettingsSection("devices");
                    setAccountSettingsOpen(true);
                  }}
                  onPin={pinSidebarPreview}
                />
              ) : null}
            </div>
            <main
              className={`${GATEWAY_MAIN_SHELL_CLASS} gateway-cloud-main`}
              data-resource-panel-open={
                workspaceView === "chat" &&
                Boolean(filePanel || artifactPanel || sourcePanel || workPanel)
              }
            >
              <div className={GATEWAY_MAIN_BACKDROP_CLASS} />
              <AppWorkbenchChrome
                className={landing ? "cloud-header-landing" : "cloud-header-thread"}
                navigationMode={
                  !sidebar.isMobile && workspaceView === "chat" && !canSwitchPresentation
                    ? "new-chat"
                    : "sidebar"
                }
                navigationActions={
                  !sidebar.isMobile && workspaceView === "chat" && !canSwitchPresentation ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="新对话"
                      aria-label="新对话"
                      onClick={() => navigateConversation()}
                      className="cloud-header-new-chat rounded-lg"
                    >
                      <SquarePen className="size-4.5" />
                    </Button>
                  ) : undefined
                }
                leadingActions={
                  <>
                    {sidebar.isMobile && workspaceView === "chat" && !canSwitchPresentation ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="新对话"
                        aria-label="新对话"
                        onClick={() => navigateConversation()}
                        className="cloud-header-new-chat shrink-0 rounded-lg"
                      >
                        <SquarePen className="size-4.5" />
                      </Button>
                    ) : null}
                    {workspaceView === "chat" && conversationId && !canSwitchPresentation ? (
                      <CloudConversationTitle
                        key={`${user.id}:${conversationId}`}
                        title={
                          conversations.find((item) => item.id === conversationId)?.title ||
                          "新对话"
                        }
                        onRename={(title) => saveConversationTitle(conversationId, title)}
                      />
                    ) : (
                      <span
                        className={`min-w-0 truncate text-sm font-medium ${landing && workspaceView === "chat" ? "cloud-header-title-landing" : ""}`}
                      >
                        {workspaceView === "library"
                          ? "资料空间"
                          : workspaceView === "projects"
                            ? "项目"
                            : conversations.find((item) => item.id === conversationId)?.title ||
                              "新对话"}
                      </span>
                    )}
                    {workspaceView === "chat" && canSwitchPresentation ? (
                      <CloudChatModeSwitch
                        value={presentation}
                        onChange={(mode) => {
                          setComposerMenu(null);
                          setPresentation(mode);
                        }}
                      />
                    ) : null}
                  </>
                }
                trailingActions={
                  workspaceView === "chat" ? (
                    <CloudChatHeaderActions
                      modelLimitsDisabled={!selectedModelOption || preparingExecution || streaming}
                      exportDisabled={
                        !conversationId || historyLoading || streaming || branchBusy || exporting
                      }
                      onOpenModelLimits={() => setModelLimitsOpen(true)}
                      onExport={(format) => void exportConversation(format)}
                      onOpenResource={(resource) => openResource(resource)}
                    />
                  ) : (
                    <Button variant="ghost" size="sm" onClick={closeResources}>
                      返回对话
                    </Button>
                  )
                }
                settings={settings}
                sidebarOpen={sidebarOpen}
                onOpenSettings={(section) => {
                  if (section) setSettingsSection(section);
                  setAccountSettingsOpen(true);
                }}
                onToggleTheme={() =>
                  setSettings((current) => ({ ...current, theme: getNextTheme(current.theme) }))
                }
                onOpenSidebar={() => setSidebarOpen(true)}
                preThemeActions={
                  workspaceView === "chat" ? (
                    <ExecutionEnvironmentSwitcher
                      environments={environments}
                      selection={selection}
                      disabled={streaming}
                      onSwitch={onSwitch}
                    />
                  ) : null
                }
              />
              <ApplicationView
                activeView="chat"
                settings={settings}
                setSettings={setSettings}
                isAgentMode={false}
                className={workspaceView === "chat" ? "contents" : "hidden"}
                chat={{
                  containerProps: {
                    className: `${GATEWAY_CHAT_FRAME_CLASS} zone-font-scale`,
                    style: {
                      "--zone-font-scale": settings.customSettings.fontScale.chat,
                    } as CSSProperties,
                  },
                  content: (
                    <>
                      <div className="cloud-conversation-resources">
                        {conversationFiles.length ? (
                          <details className="min-w-0">
                            <summary className="cursor-pointer text-muted-foreground">
                              本会话附件 ({conversationFiles.length})
                            </summary>
                            <div className="flex flex-wrap gap-8px py-8px">
                              {conversationFiles.map((file) => (
                                <button
                                  key={file.file_id}
                                  type="button"
                                  className="max-w-240px truncate rounded-lg border border-border px-8px py-4px"
                                  onClick={() => setFilePanel({ fileId: file.file_id })}
                                >
                                  {file.name || "附件"}
                                </button>
                              ))}
                            </div>
                          </details>
                        ) : null}
                        {conversationArtifacts.length ? (
                          <details className="min-w-0">
                            <summary className="cursor-pointer text-muted-foreground">
                              本会话成果 ({conversationArtifacts.length})
                            </summary>
                            <div className="flex flex-wrap gap-8px py-8px">
                              {conversationArtifacts.map((version) => (
                                <button
                                  key={version.version_id}
                                  type="button"
                                  className="max-w-240px truncate rounded-lg border border-border px-8px py-4px"
                                  onClick={() =>
                                    setArtifactPanel({ versionId: version.version_id })
                                  }
                                >
                                  {version.name || "成果"}
                                  {version.number ? ` · v${version.number}` : ""}
                                </button>
                              ))}
                            </div>
                          </details>
                        ) : null}
                      </div>
                      <section
                        className="gateway-transcript-stage cloud-conversation-layout relative min-h-0 flex-1 overflow-hidden @container"
                        data-layout={landing ? "landing" : "thread"}
                        data-presentation={presentation}
                      >
                        {landing ? <CloudChatEmptyState mode={presentation} /> : null}
                        <div className="gateway-transcript-scroll-shell relative h-full min-h-0">
                          <ScrollArea
                            viewportRef={setTranscriptViewport}
                            className={GATEWAY_TRANSCRIPT_SCROLL_CLASS}
                          >
                            <GatewayTranscript
                              emptyState={null}
                              hasMoreHistory={historyHasMore}
                              isLoadingMoreHistory={historyPageLoading}
                              onLoadEarlierHistory={() => void loadEarlierHistory()}
                              isViewportFollowing={() => followTranscriptTailRef.current}
                              viewportFollowing={followingTranscript}
                              resendCreatesBranch
                              conversationId={conversationId}
                              rows={transcriptRows}
                              editRequest={terminalEditRequest}
                              onEditRequestHandled={(token) =>
                                setTerminalEditRequest((current) =>
                                  current?.token === token ? null : current,
                                )
                              }
                              liveStartIndex={
                                streaming ? Math.max(0, transcriptRows.length - 1) : -1
                              }
                              activeTurnKey={streaming ? messages.at(-1)?.id : null}
                              footer={terminalFeedback}
                              toolStatus={
                                streaming
                                  ? runConnection === "reconnecting"
                                    ? "正在重新连接，任务仍在服务端保留"
                                    : activeRun
                                      ? cloudChatRunToolStatus(activeRun) ||
                                        cloudChatRunStatusText(activeRun)
                                      : "正在保存任务"
                                  : null
                              }
                              isStreaming={streaming}
                              assistantLiveMode="streaming"
                              isLoading={historyLoading}
                              hasModels={modelOptions.length > 0}
                              onOpenSettings={() => {
                                setSettingsSection("providers");
                                setAccountSettingsOpen(true);
                              }}
                              onSuggestionSelect={(text) => {
                                composerRef.current?.setText(text);
                                composerRef.current?.focus();
                              }}
                              onOpenFileLink={(link) => {
                                const messageMatch =
                                  /^cloud-messages\/([A-Za-z0-9_-]{1,128})$/.exec(link.path);
                                if (messageMatch) {
                                  void readMessageBody(messageMatch[1]);
                                  return;
                                }
                                const artifactId = cloudArtifactVersionFromLink(link.path);
                                if (artifactId) {
                                  showResourceDetail(() =>
                                    setArtifactPanel({ versionId: artifactId }),
                                  );
                                  return;
                                }
                                const sourceMatch =
                                  /^cloud-sources\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
                                    link.path,
                                  );
                                if (sourceMatch) {
                                  showResourceDetail(() =>
                                    setSourcePanel({
                                      sourceId: sourceMatch[1],
                                      fromLine: link.line,
                                      toLine: link.endLine,
                                    }),
                                  );
                                  return;
                                }
                                const match =
                                  /^cloud-files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
                                    link.path,
                                  );
                                if (!match) {
                                  setError("云端对话仅支持打开当前账户的文件引用。");
                                  return;
                                }
                                showResourceDetail(() =>
                                  setFilePanel({
                                    fileId: match[1],
                                    fromLine: link.line,
                                    toLine: link.endLine,
                                  }),
                                );
                              }}
                              onResendFromEdit={
                                branchBusy || branchUnconfirmed || streaming
                                  ? undefined
                                  : (ref, text, files) => branchConversation(ref, { text, files })
                              }
                              onBranchConversation={
                                branchBusy || branchUnconfirmed || streaming
                                  ? undefined
                                  : (ref) => branchConversation(ref)
                              }
                              branchPendingMessageId={branchPendingMessageId}
                            />
                          </ScrollArea>
                        </div>
                        <ChatComposerBar
                          feedback={composerFeedback}
                          layout="inline"
                          expandedInput={presentation === "work"}
                          contextBarPosition={sidebar.isMobile ? "above" : "below"}
                          allowQueueWhileSending={false}
                          onPickWorkspaceFolder={() => undefined}
                          onRefreshModels={() => void refreshModels()}
                          modelsRefreshing={modelsLoading}
                          surface="web"
                          conversationId={conversationId}
                          composerRef={composerRef}
                          isSending={streaming}
                          isUploadingFiles={uploadingFiles}
                          isInputDisabled={
                            projectContextBusy ||
                            preparingExecution ||
                            historyLoading ||
                            modelsLoading ||
                            modelOptions.length === 0 ||
                            submissionUnconfirmed ||
                            submissionQueueFull ||
                            branchBusy ||
                            branchUnconfirmed ||
                            Boolean(researchConfirmation)
                          }
                          allowUploadsWithoutWorkspace
                          inputPlaceholder={
                            presentation === "work" ? "使用 ZeroAgent 工作" : "询问 ZeroAgent"
                          }
                          capabilityMenu={
                            <CloudChatComposerMenu
                              disabled={composerLocked || streaming}
                              open={composerMenu === "add"}
                              onOpenChange={(open) =>
                                setComposerMenu((old) =>
                                  open ? "add" : old === "add" ? null : old,
                                )
                              }
                              researchEnabled={runtimeControls.nativeWebSearchEnabled}
                              onUpload={() => fileRef.current?.click()}
                              onOpenFiles={(anchor) => openComposerPicker("files", anchor)}
                              onOpenProjects={(anchor) => openComposerPicker("projects", anchor)}
                              onToggleResearch={() =>
                                setRuntimeControls((current) => ({
                                  ...current,
                                  nativeWebSearchEnabled: !current.nativeWebSearchEnabled,
                                }))
                              }
                            />
                          }
                          leadingControls={
                            runtimeControls.nativeWebSearchEnabled ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="cloud-active-tool"
                                title="移除公开联网研究"
                                aria-label="移除公开联网研究"
                                disabled={composerLocked}
                                onClick={() =>
                                  setRuntimeControls((current) => ({
                                    ...current,
                                    nativeWebSearchEnabled: false,
                                  }))
                                }
                              >
                                <Globe className="size-3.5" />
                                <span>联网研究</span>
                                <X className="size-3" />
                              </Button>
                            ) : undefined
                          }
                          contextBar={
                            <div
                              className="cloud-context-motion"
                              data-open={presentation === "work"}
                              inert={presentation !== "work"}
                              aria-hidden={presentation !== "work"}
                            >
                              <div className="cloud-context-motion-inner">
                                <CloudChatWorkToolbar
                                  open={composerMenu}
                                  busy={projectContextBusy}
                                  disabled={composerLocked || streaming}
                                  projectName={
                                    composerProject.scope === `${user.id}:${conversationId}`
                                      ? composerProject.project?.name
                                      : undefined
                                  }
                                  onOpen={openComposerPicker}
                                />
                              </div>
                            </div>
                          }
                          workdir=""
                          showGitControls={false}
                          enabledSkills={[]}
                          executionMode="text"
                          hasModels={modelOptions.length > 0}
                          currentModelLabel={model}
                          modelOptions={modelOptions}
                          selectedValue={selectedModelValue}
                          chatRuntimeControls={runtimeControls}
                          reasoningOptions={CLOUD_CHAT_REASONING_OPTIONS}
                          thinkingAlwaysOn={false}
                          onSend={() => void send()}
                          onStop={() => void stopRun()}
                          onComposerBusyChange={() => undefined}
                          onSelectModel={(next) => {
                            const nextProviderKeyId = relayProviderKeyId(next.customProviderId);
                            setModel(next.model);
                            setProviderKeyId(nextProviderKeyId);
                            setSettings((current) => ({ ...current, selectedModel: next }));
                            void saveWebSettings(next.model, reasoning, nextProviderKeyId).catch(
                              (cause) => setError(String(cause)),
                            );
                          }}
                          onSelectExecutionMode={() => undefined}
                          onOpenSettings={(section) => {
                            if (section) setSettingsSection(section);
                            setAccountSettingsOpen(true);
                          }}
                          onChatRuntimeControlsChange={(patch) => {
                            const next = patchCloudChatRuntimeControls(runtimeControls, patch);
                            setRuntimeControls(next);
                            if (
                              patch.nativeWebSearchEnabled === false &&
                              researchConfirmationRef.current
                            )
                              settleResearchConfirmation(researchConfirmationRef.current);
                            if (next.reasoning !== reasoning) {
                              setReasoning(next.reasoning);
                              void saveWebSettings(model, next.reasoning).catch((cause) =>
                                setError(String(cause)),
                              );
                            }
                          }}
                          onPickReadableFiles={() => fileRef.current?.click()}
                          onPasteFiles={(files) => void attachFileList(files)}
                          loadHistoryPrompts={() =>
                            messages
                              .filter((message) => message.role === "user")
                              .map((message) => messageText(message.content))
                              .filter(Boolean)
                          }
                          pendingUploadedFiles={pendingUploadedFiles}
                          onOpenPendingUpload={(path) => {
                            const versionId = cloudArtifactVersionFromLink(path);
                            showResourceDetail(() => {
                              if (versionId) setArtifactPanel({ versionId });
                              else setFilePanel({ fileId: path });
                            });
                          }}
                          onRemovePendingUpload={(id) => {
                            const versionId = cloudArtifactVersionFromLink(id);
                            if (versionId)
                              setArtifactAttachments((current) =>
                                current.filter((item) => item.id !== versionId),
                              );
                            else
                              setAttachments((current) => current.filter((item) => item.id !== id));
                          }}
                          queuedTurns={[]}
                          onRunQueuedTurnNow={() => undefined}
                          onMoveQueuedTurnUp={() => undefined}
                          onEditQueuedTurn={() => undefined}
                          onRemoveQueuedTurn={() => undefined}
                        />
                        {landing ? (
                          <CloudChatStarters mode={presentation} onSelect={fillStarter} />
                        ) : null}
                      </section>
                    </>
                  ),
                }}
              />
              <CloudChatContextPicker
                key={user.id}
                kind={composerMenu && composerMenu !== "add" ? composerMenu : null}
                anchor={composerMenuAnchor}
                mobile={sidebar.isMobile}
                scope={`${user.id}:${conversationId}`}
                revision={navigationRevision}
                projectsClient={projectsClient}
                filesClient={filesClient}
                captureGuard={captureWorkGuard}
                attachedIds={attachments.map((file) => file.id)}
                selectedProjectId={
                  composerProject.scope === `${user.id}:${conversationId}`
                    ? composerProject.project?.id
                    : undefined
                }
                disabled={composerLocked || streaming}
                researchEnabled={runtimeControls.nativeWebSearchEnabled}
                onClose={() => setComposerMenu(null)}
                onSelectProject={selectComposerProject}
                onAttach={attachLibraryFile}
                onBrowse={(kind) => openResource(kind, true)}
                onToggleResearch={() =>
                  setRuntimeControls((current) => ({
                    ...current,
                    nativeWebSearchEnabled: !current.nativeWebSearchEnabled,
                  }))
                }
                onFillDraft={fillStarter}
                onFocusComposer={() => {
                  if (isCurrentView(viewRef.current)) composerRef.current?.focus();
                }}
              />
              <CloudChatResourcePresentation.Provider
                value={
                  workspaceView === "chat" || (workspaceView === "library" && !sourcePanel)
                    ? "panel"
                    : "page"
                }
              >
                <div className={workspaceView === "chat" ? "contents" : "cloud-workspace-content"}>
                  {spaceVisited &&
                  !accountInvalidatedRef.current &&
                  viewRef.current.userId === user.id ? (
                    <div
                      className={
                        workspaceView === "library" && !sourcePanel ? "contents" : "hidden"
                      }
                      inert={workspaceView !== "library" || Boolean(sourcePanel)}
                    >
                      <CloudSpacePage
                        key={user.id}
                        client={spaceClient}
                        files={filesClient}
                        artifacts={artifactsClient}
                        revision={spaceRevision}
                        active={workspaceView === "library" && !sourcePanel}
                        storageOpen={spaceStorageOpen}
                        onStorageOpenChange={setSpaceStorageOpen}
                        location={spaceLocation}
                        onNavigate={navigateSpace}
                        onOpen={openSpaceItem}
                        onReference={referenceSpaceItems}
                        onCreateWork={(text) => {
                          if (composerLocked || streaming) return;
                          clearResources();
                          if (landing) setPresentation("work");
                          fillStarter(text);
                        }}
                        canReference={!composerLocked && !streaming}
                        captureGuard={captureAccountRequestGuard}
                        onChanged={() => setSpaceRevision((old) => old + 1)}
                        onError={(cause) => {
                          if (cause instanceof CloudSpaceError && cause.status === 401)
                            notifyRelaySessionExpired();
                        }}
                      />
                    </div>
                  ) : null}
                  {filePanel &&
                  (workspaceView !== "library" || filePanel.fileId) &&
                  viewRef.current.userId === user.id &&
                  !accountInvalidatedRef.current
                    ? (() => {
                        const view = viewRef.current;
                        return (
                          <CloudChatFilePanel
                            key={`${user.id}:${conversationId}:${filePanel.fileId ?? "library"}`}
                            client={filesClient}
                            onBrowseLibrary={
                              workspaceView === "library" ? () => setFilePanel(null) : undefined
                            }
                            onUpload={
                              workspaceView === "library"
                                ? undefined
                                : () => {
                                    closeResources();
                                    fileRef.current?.click();
                                  }
                            }
                            initialFileId={filePanel.fileId}
                            fromLine={filePanel.fromLine}
                            toLine={filePanel.toLine}
                            canAttach={
                              !preparingExecution &&
                              !streaming &&
                              !uploadingFiles &&
                              !submissionUnconfirmed &&
                              !submissionQueueFull
                            }
                            isCurrent={() => isCurrentView(view)}
                            onClose={
                              workspaceView === "library"
                                ? () => {
                                    setFilePanel(null);
                                    setSpaceRevision((old) => old + 1);
                                  }
                                : closeResources
                            }
                            onAttach={(file) => {
                              if (!isCurrentView(view) || modelPreparationAbortRef.current) return;
                              if (attachments.length + artifactAttachments.length >= 8) {
                                setError("每条消息最多引用 8 个文件或成果。");
                                return;
                              }
                              setAttachments((current) =>
                                current.some((item) => item.id === file.id)
                                  ? current
                                  : [...current, file],
                              );
                              if (workspaceView !== "chat") closeResources();
                            }}
                            onDeleted={(id) => {
                              if (isCurrentView(view))
                                setAttachments((current) =>
                                  current.filter((file) => file.id !== id),
                                );
                            }}
                            onError={(cause) => {
                              if (cause instanceof CloudChatFileError && cause.status === 401)
                                notifyRelaySessionExpired();
                            }}
                          />
                        );
                      })()
                    : null}
                  {artifactPanel &&
                  (workspaceView !== "library" || artifactPanel.versionId) &&
                  viewRef.current.userId === user.id &&
                  !accountInvalidatedRef.current
                    ? (() => {
                        const view = viewRef.current;
                        const canContinue =
                          !preparingExecution &&
                          !streaming &&
                          !uploadingFiles &&
                          !submissionUnconfirmed &&
                          !submissionQueueFull &&
                          !branchBusy &&
                          !branchUnconfirmed;
                        return (
                          <CloudChatArtifactsPanel
                            key={`${user.id}:${conversationId}:${artifactPanel.versionId ?? "library"}`}
                            client={artifactsClient}
                            conversationId={conversationId || undefined}
                            initialVersionId={artifactPanel.versionId}
                            isCurrent={() => isCurrentView(view)}
                            onClose={
                              workspaceView === "library"
                                ? () => {
                                    setArtifactPanel(null);
                                    setSpaceRevision((old) => old + 1);
                                  }
                                : closeResources
                            }
                            onContinue={
                              canContinue
                                ? (version) => {
                                    if (!isCurrentView(view) || version.state !== "ready") return;
                                    if (
                                      artifactAttachments.some((item) => item.id === version.id)
                                    ) {
                                      setArtifactPanel(null);
                                      composerRef.current?.focus();
                                      return;
                                    }
                                    if (attachments.length + artifactAttachments.length >= 8) {
                                      setError("每条消息最多引用 8 个文件或成果。");
                                      return;
                                    }
                                    setArtifactAttachments((current) =>
                                      current.some((item) => item.id === version.id)
                                        ? current
                                        : [...current, version],
                                    );
                                    closeResources();
                                    composerRef.current?.focus();
                                  }
                                : undefined
                            }
                            onDeleted={(familyId) => {
                              if (!isCurrentView(view)) return;
                              setArtifactAttachments((current) =>
                                current.filter((version) => version.family_id !== familyId),
                              );
                              setContextNotice("成果已停止访问，已有版本引用将不可用。");
                            }}
                            onOpenSourceRun={(_runId, sourceConversationId) => {
                              if (!isCurrentView(view)) return;
                              if (!conversations.some((item) => item.id === sourceConversationId)) {
                                setError("来源对话已删除或暂不可用，仍可使用已保存的成果版本。");
                                return;
                              }
                              selectConversationView(sourceConversationId);
                            }}
                            onError={(cause) => {
                              if (cause instanceof CloudChatArtifactError && cause.status === 401)
                                notifyRelaySessionExpired();
                            }}
                          />
                        );
                      })()
                    : null}
                  {sourcePanel &&
                  viewRef.current.userId === user.id &&
                  !accountInvalidatedRef.current
                    ? (() => {
                        const view = viewRef.current;
                        return (
                          <CloudChatSourcesPanel
                            key={`${user.id}:${conversationId}:${sourcePanel.sourceId ?? "library"}`}
                            client={sourcesClient}
                            initialSourceId={sourcePanel.sourceId}
                            fromLine={sourcePanel.fromLine}
                            toLine={sourcePanel.toLine}
                            isCurrent={() => isCurrentView(view)}
                            onClose={closeResources}
                            onDeleted={() => {
                              if (isCurrentView(view))
                                setContextNotice("来源资料已删除，原引用将不可用。");
                            }}
                            onError={(cause) => {
                              if (cause instanceof CloudChatSourceError && cause.status === 401)
                                notifyRelaySessionExpired();
                            }}
                          />
                        );
                      })()
                    : null}
                  {workPanel &&
                  viewRef.current.userId === user.id &&
                  !accountInvalidatedRef.current ? (
                    <CloudChatResourcePanel
                      title={workPanel === "projects" ? "项目" : "记忆"}
                      description="管理后续对话使用的资料和偏好。"
                      onClose={closeResources}
                    >
                      <div className="min-h-0 flex-1 overflow-auto">
                        {workPanel === "projects" ? (
                          <CloudChatProjectsPanel
                            key={`${user.id}:${conversationId}:${initialProjectId ?? "associated"}`}
                            initialProjectId={initialProjectId}
                            onDirtyChange={projectNavigation.setDirty}
                            onRequestNavigation={projectNavigation.request}
                            client={projectsClient}
                            filesClient={filesClient}
                            conversationId={conversationId || null}
                            captureGuard={captureWorkGuard}
                            onProjectChange={() => setContextNotice("已更新当前对话的项目。")}
                            onOpenConversation={(id) => navigateConversation(id)}
                            onContextChanged={() => {
                              setNavigationRevision((old) => old + 1);
                              setContextNotice("已保存，将用于后续消息。");
                            }}
                          />
                        ) : (
                          <CloudChatMemoryPanel
                            key={user.id}
                            client={projectsClient}
                            captureGuard={captureWorkGuard}
                            onContextChanged={() => {
                              setNavigationRevision((old) => old + 1);
                              setContextNotice("已保存，将用于后续消息。");
                            }}
                          />
                        )}
                      </div>
                    </CloudChatResourcePanel>
                  ) : null}
                </div>
              </CloudChatResourcePresentation.Provider>
            </main>
          </div>

          {accountSettingsOpen ? (
            <div className="cloud-settings-page flex min-h-0 min-w-0 flex-1">
              <SettingsPage
                presentation="page"
                settings={settings}
                setSettings={setSettings}
                saveState={settingsSaveState}
                onBack={() => {
                  setAccountSettingsOpen(false);
                  requestAnimationFrame(() =>
                    sidebarPreview.rootRef.current
                      ?.querySelector<HTMLButtonElement>(
                        sidebar.isMobile
                          ? "[data-app-header-navigation] button"
                          : ".application-rail [aria-haspopup=menu]",
                      )
                      ?.focus(),
                  );
                }}
                initialSection={settingsSection}
                onSectionChange={setSettingsSection}
                hiddenSections={[
                  "systemTools",
                  "stt",
                  "agents",
                  "ssh",
                  "memory",
                  "hooks",
                  "cron",
                  "remote",
                ]}
                relayUser={user}
                relayStats={accountStats}
                onRelayUserChange={onUserChange}
                onRelayStatsChange={setAccountStats}
                runtimeKind="web_chat"
                sttSettingsService={disabledSttSettingsService}
              />
            </div>
          ) : null}
        </div>
        {modelLimitsOpen &&
        selectedModelOption &&
        viewRef.current.userId === user.id &&
        !accountInvalidatedRef.current ? (
          <CloudChatModelLimitsPanel
            key={`${user.id}:${selectedModelOption.providerId}:${model}`}
            client={modelLimitsClient}
            providerKeyId={relayProviderKeyId(selectedModelOption.providerId)}
            model={model}
            localContext={
              settings.customProviders
                ?.find((provider) => provider.id === selectedModelOption.providerId)
                ?.models.find((item) => item.id === model)?.contextWindow
            }
            localOutput={
              settings.customProviders
                ?.find((provider) => provider.id === selectedModelOption.providerId)
                ?.models.find((item) => item.id === model)?.maxOutputToken
            }
            captureGuard={captureWorkGuard}
            onClose={() => setModelLimitsOpen(false)}
          />
        ) : null}
        {researchConfirmation && isCurrentView(researchConfirmation.view) ? (
          <CloudChatResearchConfirmation
            key={researchConfirmation.id}
            initialTopic={researchConfirmation.topic}
            onCancel={() => settleResearchConfirmation(researchConfirmation)}
            onConfirm={(research) => settleResearchConfirmation(researchConfirmation, research)}
          />
        ) : null}
        {messageReader && viewRef.current.userId === user.id && !accountInvalidatedRef.current ? (
          <CloudChatMessageReader
            key={`${messageReader.id}:${messageReader.message?.content_sha256 ?? "loading"}`}
            message={messageReader.message}
            error={messageReader.error}
            onRetry={() => void readMessageBody(messageReader.id)}
            onClose={closeMessageReader}
            captureGuard={() => {
              const view = viewRef.current;
              const guard = captureAccountRequestGuard();
              return () => {
                guard();
                if (!isCurrentView(view)) throw new Error("消息窗口已切换");
              };
            }}
            onOpenFile={(fileId) => {
              closeMessageReader();
              setFilePanel({ fileId });
            }}
            onOpenArtifact={(versionId) => {
              closeMessageReader();
              setArtifactPanel({ versionId });
            }}
          />
        ) : null}
        {projectNavigation.dialog}
        <FirstRunOnboarding
          userId={user.id}
          onSyncKeys={async (keys, groups) => {
            const next = await bindRelayKeysToSettings(settings, keys, groups, true);
            setSettings(() => next);
          }}
        />
      </div>
    </AppErrorBoundary>
  );
}
