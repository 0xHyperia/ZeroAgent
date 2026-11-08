import { ApplicationRail } from "@liveagent/ui/application/ApplicationRail";
import { ApplicationView } from "@liveagent/ui/application/ApplicationView";
import { AppWorkbenchChrome } from "@liveagent/ui/application/AppWorkbenchChrome";
import { BrandMark } from "@liveagent/ui/application/BrandMark";
import { SettingsWorkspace } from "@liveagent/ui/application/SettingsWorkspace";
import { useUnsavedChangesPrompt } from "@liveagent/ui/application/useUnsavedChangesPrompt";
import { WorkbenchCanvas, WorkbenchShell } from "@liveagent/ui/application/WorkbenchShell";
import { createWorkbenchNavigationItem } from "@liveagent/ui/application/workbenchNavigation";
import { AppErrorBoundary } from "@liveagent/ui/components/AppErrorBoundary";
import {
  ChatHistorySidebar,
  type ChatHistorySidebarMutationKind,
} from "@liveagent/ui/components/chat/ChatHistorySidebar";
import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import { FileDropBoundary } from "@liveagent/ui/components/files/FileDropBoundary";
import {
  ArrowLeft,
  Blend,
  BookOpen,
  ChevronDown,
  Globe,
  PanelLeft,
  SquarePen,
  X,
} from "@liveagent/ui/components/IconSet";
import {
  type DocumentRevisionComment,
  documentRevisionText,
} from "@liveagent/ui/components/resource-preview/ResourceDocumentComments";
import { ResourceThumbnail } from "@liveagent/ui/components/resource-preview/ResourcePreview";
import { ScrollArea } from "@liveagent/ui/components/ui/scroll-area";
import { useSidebar } from "@liveagent/ui/components/ui/sidebar";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { CLOUD_COMPOSER_CAPABILITIES } from "@liveagent/ui/contracts/composerPresentation";
import type {
  ExtensionCatalog,
  ExtensionPackage,
  ExtensionSkill,
  ExtensionWorkspaceLocation,
} from "@liveagent/ui/features/extensions/extensionTypes";
import type { AssistantDeliverable } from "@liveagent/ui/lib/chat/assistantResources";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { buildFloorEntries } from "@liveagent/ui/lib/chat-floor-nav/floorModel";
import { useScrollFollow } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import { parseExtensionReference } from "@liveagent/ui/lib/extensions/presentation";
import { modelTypesFor } from "@liveagent/ui/lib/models/modelTypes";
import { useCatalogLiveVersion } from "@liveagent/ui/lib/models/useThinkingLive";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import {
  deleteSidebarConversations,
  type SidebarBatchDeleteOptions,
} from "@liveagent/ui/lib/sidebar/batchDelete";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import type { SttSettingsService } from "@liveagent/ui/lib/stt/types";
import {
  type TranscriptMessageJump,
  useTranscriptMessageJump,
} from "@liveagent/ui/lib/transcript-virtual/useTranscriptMessageJump";
import { ChatComposerBar } from "@liveagent/ui/pages/chat/ChatComposerBar";
import { FloorNavRail } from "@liveagent/ui/pages/chat/transcript/FloorNavRail";
import { ProviderSettingsDialog } from "@liveagent/ui/pages/settings/ProvidersSection";
import { SettingsPage } from "@liveagent/ui/pages/settings/SettingsPage";
import {
  type ChangeEvent,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
import { CloudChatProjectNavigation } from "@/components/cloudchat/CloudChatProjectNavigation";
import { CloudChatResourcePresentation } from "@/components/cloudchat/CloudChatReaderContext";
import { CloudChatResearchConfirmation } from "@/components/cloudchat/CloudChatResearchConfirmation";
import { CloudChatResourcePanel } from "@/components/cloudchat/CloudChatResourcePanel";
import { CloudChatResourceWorkbench } from "@/components/cloudchat/CloudChatResourceWorkbench";
import { CloudChatSourcesPanel } from "@/components/cloudchat/CloudChatSourcesPanel";
import { CloudChatVisualProvider } from "@/components/cloudchat/CloudChatVisualProvider";
import { CloudContextSidebar } from "@/components/cloudchat/CloudContextSidebar";
import { CloudConversationBranches } from "@/components/cloudchat/CloudConversationBranches";
import { CloudConversationMoveMenu } from "@/components/cloudchat/CloudConversationMoveMenu";
import { CloudConversationTitle } from "@/components/cloudchat/CloudConversationTitle";
import { CloudDraftConflictDialog } from "@/components/cloudchat/CloudDraftConflictDialog";
import { CloudProjectCreateDialog } from "@/components/cloudchat/CloudProjectCreateDialog";
import { CloudProjectSettingsDialog } from "@/components/cloudchat/CloudProjectSettingsDialog";
import { CloudScheduleWorkspace } from "@/components/cloudchat/CloudScheduleWorkspace";
import { CloudSpacePage } from "@/components/cloudchat/CloudSpacePage";
import { useCloudChatQueueController } from "@/components/cloudchat/useCloudChatQueueController";
import { useCloudSavedDraft } from "@/components/cloudchat/useCloudSavedDraft";
import { useCloudSidebarPreview } from "@/components/cloudchat/useCloudSidebarPreview";
import {
  WorkspaceHandoffDialog,
  type WorkspaceHandoffSource,
} from "@/components/cloudchat/WorkspaceHandoffDialog";
import { ExecutionEnvironmentSwitcher } from "@/components/ExecutionEnvironmentSwitcher";
import { GatewayBrand } from "@/components/GatewayBrand";
import { GatewayTranscript, type GatewayTranscriptNavHandle } from "@/components/GatewayTranscript";
import { MobileSidebarUpdate } from "@/components/mobile/MobileAppExperience";
import { FirstRunOnboarding } from "@/components/onboarding/FirstRunOnboarding";
import {
  ACCOUNT_CHANGED_EVENT,
  accountFetch,
  captureAccountRequestGuard,
} from "@/lib/accountRequest";
import { buildModelOptions } from "@/lib/chat/chatPageHelpers";
import type { CloudChatPresentationResource } from "@/lib/cloudChatPresentation";
import {
  type CloudChatRoute,
  type CloudReaderRoute,
  type CloudSettingsSection,
  cloudSettingsSection,
  DEFAULT_EXTENSION_LOCATION,
} from "@/lib/cloudChatRoute";
import { waitForCloudChatRetry } from "@/lib/cloudChatRuns";
import {
  buildCloudComposerText,
  cloudComposerExtensions,
  cloudComposerSkills,
  cloudComposerSlashSkills,
  cloudExtensionMention,
  cloudPackageSkill,
  createCloudExtensionsAdapter,
  extensionDraftFromLink,
  linkExtensionDraftCitations,
} from "@/lib/cloudExtensions";
import { cloudGenerationSettings } from "@/lib/cloudGenerationSettings";
import type { CloudTaskConversationSelection } from "@/lib/cloudSchedules";
import { siteRevisionText } from "@/lib/cloudSiteRevision";
import {
  CLOUD_SPACE_HOME,
  CloudSpaceError,
  type CloudSpaceItem,
  type CloudSpaceLocation,
  createCloudSpaceClient,
} from "@/lib/cloudSpace";
import type { DesktopCloudHost, DesktopTaskConversation } from "@/lib/desktopRemoteHost";
import { readCloudChatLocation, useCloudChatHistory } from "@/lib/useCloudChatHistory";
import { sendBrowserWorkspaceHandoff } from "@/lib/workspaceHandoff";
import { CloudModelPreferencesSection } from "./settings/CloudModelPreferencesSection";
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
  createCloudChatConversationsClient,
  createCloudConversationSearchAdapter,
} from "@/lib/cloudChatConversations";
import {
  type CloudChatDraft,
  CloudChatDraftStore,
  cloneCloudChatDraft,
  cloudChatCanonicalJSON,
  cloudChatDraftContentMatches,
  emptyCloudChatDraft,
} from "@/lib/cloudChatDrafts";
import {
  CLOUD_FILE_ACCEPT,
  type CloudChatFile,
  CloudChatFileError,
  CloudFileUploadUnconfirmedError,
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
import { type CloudChatPendingInput, createCloudChatQueueClient } from "@/lib/cloudChatQueue";
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
import {
  type CloudChatSavedDraft,
  createCloudChatSavedDraftsClient,
} from "@/lib/cloudChatSavedDrafts";
import {
  CloudChatSourceError,
  createCloudChatSourcesClient,
  linkCloudSourceCitations,
} from "@/lib/cloudChatSources";
import {
  cloudChatAssistantDeliverables,
  cloudChatAssistantRounds,
  cloudChatMessageTimestamp,
} from "@/lib/cloudChatTranscript";
import { prepareCloudFileBatch } from "@/lib/cloudFileDrop";
import { CLOUD_RESOURCE_DRAG_MIME, readCloudResourceDragPayload } from "@/lib/cloudResourceDrag";
import type {
  ExecutionEnvironment,
  ExecutionSelection,
  ExecutionWorkspace,
} from "@/lib/executionTargets";
import { isEmbeddedMobileRuntime, MOBILE_BACK_EVENT } from "@/lib/mobileRuntime";
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
  submittedSavedDraft?: CloudChatSavedDraft;
  submittedDraftScope?: string;
  request: CloudChatRunRequest;
  optimisticUserId: string;
  optimisticAssistantId: string;
  optimisticContent: unknown;
  preserveDraft?: boolean;
  submittedDraft?: CloudChatDraft;
};
type RetainedRunSubmission = {
  pending: PendingRunSubmission;
  status: "unknown" | "queue-full";
  cancelRequested: boolean;
};
type PendingBranchSubmission = {
  view: ConversationView;
  request: CloudBranchRequest;
  draft: CloudChatDraft;
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
  onOpenDeviceTasks?: (
    environment: ExecutionEnvironment,
    workspace: ExecutionWorkspace,
    taskRoute?: Extract<CloudChatRoute, { page: "tasks" }>,
  ) => Promise<unknown>;
  onLogout: () => void;
  desktopCloudHost?: DesktopCloudHost;
  desktopAccountLayout?: import("@/lib/desktopRemoteHost").DesktopAccountLayout;
  workbenchActive?: boolean;
  embeddedTaskConversation?: DesktopTaskConversation;
};

const ExtensionsWorkspace = lazy(() =>
  import("@liveagent/ui/features/extensions/ExtensionsWorkspace").then((module) => ({
    default: module.ExtensionsWorkspace,
  })),
);
const EMPTY_PATHS = new Set<string>();
function CloudConversationMain({
  mount,
  ...props
}: ComponentPropsWithoutRef<"main"> & { mount?: HTMLDivElement | null }) {
  const surface = <main {...props} />;
  return mount ? createPortal(surface, mount) : surface;
}

type TaskConversationMount = {
  element: HTMLDivElement;
  onChromeTarget: (element: HTMLDivElement | null) => void;
};

function TaskResultMount({
  id,
  loading,
  onMount,
  onChromeTarget,
}: {
  id: string;
  loading: boolean;
  onMount: (mount: TaskConversationMount | null) => void;
  onChromeTarget: TaskConversationMount["onChromeTarget"];
}) {
  const attach = useCallback(
    (element: HTMLDivElement | null) => onMount(element ? { element, onChromeTarget } : null),
    [onMount, onChromeTarget],
  );
  return (
    <div
      ref={attach}
      data-conversation-id={id}
      className="flex min-h-0 min-w-0 flex-1"
      aria-busy={loading}
    />
  );
}

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
  onOpenDeviceTasks,
  onLogout,
  desktopCloudHost,
  workbenchActive = true,
  embeddedTaskConversation,
  desktopAccountLayout,
}: Props) {
  const embeddedTaskId = embeddedTaskConversation?.id;
  const embeddedTaskRun = embeddedTaskConversation?.runId;
  const embeddedTaskJump = embeddedTaskConversation?.jump;
  const embeddedTaskFollowLatest = embeddedTaskConversation?.followLatest;
  const embeddedTaskResource = embeddedTaskConversation?.resource;
  const embeddedTask = Boolean(embeddedTaskId);
  const embeddedAccount = Boolean(desktopAccountLayout);
  const embeddedWorkbench = embeddedTask || embeddedAccount;
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
  const [initialLocation] = useState(() =>
    embeddedTaskId
      ? {
          route: { page: "chat", id: embeddedTaskId } satisfies CloudChatRoute,
          conversation: embeddedTaskId,
        }
      : readCloudChatLocation(user.id),
  );
  const [workspaceHandoff, setWorkspaceHandoff] = useState<{
    owner: number;
    source: WorkspaceHandoffSource;
  }>();
  const initialRoute: CloudChatRoute = initialLocation.route;
  const [scheduleRoute, setScheduleRoute] = useState<
    Extract<CloudChatRoute, { page: "tasks" }> | undefined
  >(initialRoute.page === "tasks" ? initialRoute : undefined);
  const [taskConversationMount, setTaskConversationMount] = useState<TaskConversationMount | null>(null);
  const taskReturnConversation = useRef<string | undefined>(undefined);
  const taskRunSelection = useRef<CloudTaskConversationSelection | null>(null);
  const initialReader =
    initialRoute.page === "chat" || initialRoute.page === "library"
      ? initialRoute.reader
      : undefined;
  const [accountStats, setAccountStats] = useState<RelayDashboardStats | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [conversationsLoadingMore, setConversationsLoadingMore] = useState(false);
  const [conversationsHasMore, setConversationsHasMore] = useState(false);
  const [conversationsError, setConversationsError] = useState("");
  const [conversationSearchRequest, setConversationSearchRequest] = useState(0);
  const [headerRenameRequest, setHeaderRenameRequest] = useState(0);
  const [recentSection, setRecentSection] = useState({ owner: user.id, collapsed: false });
  const navigateConversationRef = useRef(navigateConversation);
  navigateConversationRef.current = navigateConversation;
  const [conversationMutations, setConversationMutations] = useState<
    ReadonlyMap<string, ChatHistorySidebarMutationKind>
  >(() => new Map());
  const [conversationId, setConversationId] = useState(initialLocation.conversation);
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
  const [uploadingAttachments, setUploadingAttachments] = useState<{
    view: ConversationView;
    files: { id: string; file: File }[];
  } | null>(null);
  const uploadPreviewSequence = useRef(0);
  const [resolvingResources, setResolvingResources] = useState(false);
  const [uploadUnconfirmed, setUploadUnconfirmed] = useState(false);
  const [checkingUploads, setCheckingUploads] = useState(false);
  const uploadUnconfirmedRef = useRef(false);
  const uploadBatchRef = useRef<symbol | null>(null);
  const resourceDropRef = useRef<symbol | null>(null);
  const draftResourcesRef = useRef({ files: attachments, artifacts: artifactAttachments });
  draftResourcesRef.current = { files: attachments, artifacts: artifactAttachments };
  const [filePanel, setFilePanel] = useState<FilePanel | null>(
    initialReader?.kind === "file" ? { fileId: initialReader.id } : null,
  );
  const [sourcePanel, setSourcePanel] = useState<SourcePanel | null>(null);
  const [artifactPanel, setArtifactPanel] = useState<{
    versionId?: string;
    site?: boolean;
    item?: CloudSpaceItem;
    siteAction?: "share" | "settings";
  } | null>(
    initialReader && initialReader.kind !== "file"
      ? { versionId: initialReader.id, site: initialReader.kind === "site" }
      : null,
  );
  const [workPanel, setWorkPanel] = useState<"memory" | null>(null);
  const [customize, setCustomize] = useState({
    owner: user.id,
    open: initialRoute.page === "extensions",
    visited: initialRoute.page === "extensions",
  });
  const customizeOpen = customize.owner === user.id && customize.open;
  const [extensionLocation, setExtensionLocation] = useState<ExtensionWorkspaceLocation>(
    initialRoute.page === "extensions" ? initialRoute.location : DEFAULT_EXTENSION_LOCATION,
  );
  const extensionsAdapter = useMemo(
    () => createCloudExtensionsAdapter(`cloud:${user.id}`),
    [user.id],
  );
  const [extensions, setExtensions] = useState<{
    owner: number;
    catalog: ExtensionCatalog | null;
    loading: boolean;
    error: string;
  }>({ owner: user.id, catalog: null, loading: true, error: "" });
  const [extensionRefresh, setExtensionRefresh] = useState(0);
  const extensionCatalog = extensions.owner === user.id ? extensions.catalog : null;
  const enabledCloudSkills = useMemo(
    () => cloudComposerSkills(extensionCatalog, settings.locale),
    [extensionCatalog, settings.locale],
  );
  const mentionCloudExtensions = useMemo(
    () => cloudComposerExtensions(extensionCatalog, settings.locale),
    [extensionCatalog, settings.locale],
  );
  const slashCloudSkills = useMemo(
    () => cloudComposerSlashSkills(extensionCatalog, settings.locale),
    [extensionCatalog, settings.locale],
  );
  const resolveExtensionMention = useCallback(
    (reference: string) => cloudExtensionMention(extensionCatalog, reference, settings.locale),
    [extensionCatalog, settings.locale],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: extensionRefresh is an explicit catalog reconciliation request.
  useEffect(() => {
    const controller = new AbortController();
    setExtensions((old) => ({
      owner: user.id,
      catalog: old.owner === user.id ? old.catalog : null,
      loading: true,
      error: "",
    }));
    void extensionsAdapter
      .list(controller.signal)
      .then((catalog) => {
        if (!controller.signal.aborted)
          setExtensions({ owner: user.id, catalog, loading: false, error: "" });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setExtensions((old) => ({
            ...old,
            loading: false,
            error: cause instanceof Error ? cause.message : "技能目录加载失败",
          }));
      });
    const retire = () => {
      controller.abort();
      setExtensions({ owner: 0, catalog: null, loading: false, error: "" });
      setCustomize({ owner: 0, open: false, visited: false });
    };
    window.addEventListener(ACCOUNT_CHANGED_EVENT, retire);
    return () => {
      controller.abort();
      window.removeEventListener(ACCOUNT_CHANGED_EVENT, retire);
    };
  }, [user.id, extensionsAdapter, extensionRefresh]);
  const [workspaceView, setWorkspaceView] = useState<"chat" | "library">(
    initialRoute.page === "library" ? "library" : "chat",
  );
  const [spaceWork, setSpaceWork] = useState(false);
  const [spaceFolderRequest, setSpaceFolderRequest] = useState(0);
  const [spaceLocation, setSpaceLocation] = useState<CloudSpaceLocation>(
    initialRoute.page === "library" ? initialRoute.location : CLOUD_SPACE_HOME,
  );
  const [spaceRevision, setSpaceRevision] = useState(0);
  const [spaceVisited, setSpaceVisited] = useState(initialRoute.page === "library");
  const [spaceStorageOpen, setSpaceStorageOpen] = useState(false);
  const [presentation, setPresentation] = useState<CloudChatPresentation>("work");
  const draftPresentationRef = useRef({
    presentation,
    researchEnabled: runtimeControls.nativeWebSearchEnabled,
  });
  draftPresentationRef.current = {
    presentation,
    researchEnabled: runtimeControls.nativeWebSearchEnabled,
  };
  const [composerMenu, setComposerMenu] = useState<CloudComposerMenu>(null);
  const [composerMenuAnchor, setComposerMenuAnchor] = useState<HTMLElement | null>(null);
  const [projectContextBusy, setProjectContextBusy] = useState(false);
  const projectContextMutation = useRef(false);
  const draftProjectIdRef = useRef<string | undefined>(undefined);
  const [composerProject, setComposerProject] = useState<{
    scope: string;
    project: CloudProject | null;
  }>({ scope: "", project: null });
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [projectCreate, setProjectCreate] = useState<{
    owner: number;
    open: boolean;
    conversationId?: string;
  }>({ owner: user.id, open: false });
  const [projectRows, setProjectRows] = useState<{
    owner: number;
    groups: Record<string, { items: readonly SidebarConversation[]; position: number }>;
  }>({ owner: user.id, groups: {} });
  const sidebarMoves = useRef(new Map<string, symbol>());
  const [floorAnchor, setFloorAnchor] = useState<{ scope: string; rowKey: string | null }>({
    scope: "",
    rowKey: null,
  });
  const [projectSettings, setProjectSettings] = useState<{
    owner: number;
    id?: string;
    open: boolean;
  }>({
    owner: user.id,
    id: initialRoute.page === "projects" ? initialRoute.id : undefined,
    open: initialRoute.page === "projects",
  });
  const [contextNotice, setContextNotice] = useState("");
  const [draftConflictOpen, setDraftConflictOpen] = useState(false);
  const [draftConflictLocal, setDraftConflictLocal] = useState<CloudChatSavedDraft | null>(null);
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchUnconfirmed, setBranchUnconfirmed] = useState(false);
  const [branchPendingMessageId, setBranchPendingMessageId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [activeRun, setActiveRun] = useState<CloudChatRun | null>(null);
  const [restoredTerminalRun, setRestoredTerminalRun] = useState<CloudChatRunHead | null>(null);
  const [terminalEditRequest, setTerminalEditRequest] = useState<{
    token: string;
    messageId: string;
  } | null>(null);
  const [preparingExecution, setPreparingExecution] = useState(false);
  const [runConnection, setRunConnection] = useState<
    "connecting" | "connected" | "reconnecting" | null
  >(null);
  const [submissionUnconfirmed, setSubmissionUnconfirmed] = useState(false);
  const [submissionQueueFull, setSubmissionQueueFull] = useState(false);
  const [streamNotice, setStreamNotice] = useState("");
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyBefore, setHistoryBefore] = useState("");
  const [historyAfter, setHistoryAfter] = useState("");
  const [historyHasAfter, setHistoryHasAfter] = useState(false);
  const [historySelection, setHistorySelection] = useState<{
    conversationId: string;
    messageId: string;
    token: string;
  } | null>(null);
  const [taskMessageJump, setTaskMessageJump] = useState<{
    conversationId: string;
    jump: TranscriptMessageJump;
  }>();
  const historyJumpedToken = useRef("");
  const transcriptNavigation = useRef<GatewayTranscriptNavHandle | null>(null);
  const cloudChatFrameRef = useRef<HTMLDivElement | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyPageLoading, setHistoryPageLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyReloadRevision, setHistoryReloadRevision] = useState(0);
  const [historyRetryKind, setHistoryRetryKind] = useState<"restore" | "earlier" | "later">(
    "restore",
  );
  const historyRestoreFailed = historyRetryKind === "restore" && Boolean(historyError);
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
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(initialRoute.page === "settings");
  const [settingsSection, setActiveSettingsSection] = useState<CloudSettingsSection>(
    initialRoute.page === "settings" ? (initialRoute.section ?? "system") : "account",
  );
  const [settingsDetail, setSettingsDetail] = useState(
    initialRoute.page !== "settings" || !!initialRoute.section,
  );
  const setSettingsSection = useCallback((section: CloudSettingsSection) => {
    setActiveSettingsSection(section);
    setSettingsDetail(true);
  }, []);
  const [modelPreferencesOwner, setModelPreferencesOwner] = useState<number | null>(null);
  const openModelPreferences = useCallback(() => setModelPreferencesOwner(user.id), [user.id]);
  const openComposerSettings = useCallback(
    (section?: SectionId) => {
      if (section === "model-preferences" || section === "image-studio") {
        openModelPreferences();
        return;
      }
      const target = cloudSettingsSection(section);
      if (target) setSettingsSection(target);
      if (target === "system" && sidebar.isMobile) setSettingsDetail(false);
      setCustomize((value) => ({ ...value, open: false }));
      setAccountSettingsOpen(true);
    },
    [openModelPreferences, setSettingsSection, sidebar.isMobile],
  );
  const sidebarDestination = scheduleRoute
    ? "cron-hub"
    : customizeOpen
      ? "customize"
      : workspaceView === "library"
        ? "library"
        : "chat";
  const sidebarPreview = useCloudSidebarPreview(
    !embeddedWorkbench && !sidebar.isMobile && !accountSettingsOpen,
    user.id,
    { pinnedOpen: sidebar.open, destination: sidebarDestination },
  );
  const shownSidebarDestination = sidebarPreview.open
    ? sidebarPreview.destination
    : sidebarDestination;
  const previewTasks = sidebarPreview.open && shownSidebarDestination === "cron-hub";
  const previewCustomize = sidebarPreview.open && shownSidebarDestination === "customize";
  const contextDestination =
    shownSidebarDestination === "cron-hub" || shownSidebarDestination === "customize"
      ? undefined
      : shownSidebarDestination;
  const [taskPreviewRoute, setTaskPreviewRoute] = useState<
    Extract<CloudChatRoute, { page: "tasks" }>
  >({ page: "tasks" });
  useEffect(() => {
    if (accountSettingsOpen) sidebar.setOpenMobile(false);
  }, [accountSettingsOpen, sidebar.setOpenMobile]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [transcriptViewport, setTranscriptViewport] = useState<HTMLDivElement | null>(null);
  const { handle: transcriptFollow, following: followingTranscript } = useScrollFollow({
    viewport: transcriptViewport,
    listenerRoot: transcriptViewport?.parentElement,
    trackKeys: true,
  });
  const titleRefreshAbort = useRef<AbortController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes must stop the previous title refresh.
  useEffect(() => () => titleRefreshAbort.current?.abort(), [conversationId, user.id]);
  const abortRef = useRef<AbortController | null>(null);
  const submissionAbortRef = useRef<AbortController | null>(null);
  const pendingSubmissionRef = useRef<PendingRunSubmission | null>(null);
  const retainedSubmissionsRef = useRef(new Map<string, RetainedRunSubmission>());
  const queueDraftsRef = useRef(
    new Map<
      string,
      {
        view: ConversationView;
        draft: CloudChatDraft;
        input: CloudChatPendingInput;
        saved?: CloudChatSavedDraft;
        scope?: string;
      }
    >(),
  );
  const queueEditPreferences = useRef(
    new Map<
      string,
      {
        model: string;
        providerKeyId: number;
        reasoning: ReasoningLevel;
        runtimeControls: ChatRuntimeControls;
      }
    >(),
  );
  const queueEditingItemId = useRef<string | null>(null);
  const draftsRef = useRef(new CloudChatDraftStore(user.id));
  const savedDraftSyncRef = useRef<ReturnType<typeof useCloudSavedDraft> | null>(null);
  const savedModelsRef = useRef(
    new Map<string, NonNullable<CloudChatSavedDraft["modelSelection"]>>(),
  );
  const savedModelRestoreRef = useRef<{
    scope: string;
    model: NonNullable<CloudChatSavedDraft["modelSelection"]>;
  } | null>(null);
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
  const conversationClient = useMemo(
    () => createCloudChatConversationsClient(accountFetch, captureAccountRequestGuard),
    [],
  );
  const conversationSearchAdapter = useMemo(
    () =>
      createCloudConversationSearchAdapter(conversationClient, (item) =>
        navigateConversationRef.current(item.id, item.messageId),
      ),
    [conversationClient],
  );
  const modelLimitsClient = useMemo(
    () => createCloudChatModelLimitsClient(accountFetch, captureAccountRequestGuard),
    [],
  );
  const modelPreparationAbortRef = useRef<AbortController | null>(null);
  const runsClient = useMemo(() => createCloudChatRunsClient(accountFetch), []);
  const queueClient = useMemo(
    () => createCloudChatQueueClient(accountFetch, captureAccountRequestGuard),
    [],
  );
  const savedDraftClient = useMemo(
    () => createCloudChatSavedDraftsClient(accountFetch, captureAccountRequestGuard),
    [],
  );
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
  const draftRestoreRef = useRef<{
    view: ConversationView;
    draft: CloudChatDraft;
  } | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const historyPageAbortRef = useRef<AbortController | null>(null);
  const messageReadAbortRef = useRef<AbortController | null>(null);
  const conversationCreationRef = useRef<Promise<string> | null>(null);
  const dispatchPreparationRef = useRef(false);
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
    const guard = captureWorkGuard();
    void (
      conversationId
        ? projectsClient.getAssociation(conversationId)
        : Promise.resolve({ project_id: draftProjectIdRef.current ?? "" })
    )
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
    draftRestoreRef.current = null;
    historyPageAbortRef.current?.abort();
    historyPageAbortRef.current = null;
    messageReadAbortRef.current?.abort();
    messageReadAbortRef.current = null;
    transcriptFollow.stickToBottom();
  }, [transcriptFollow]);

  function captureComposerDraft(): CloudChatDraft {
    return cloneCloudChatDraft({
      composer: composerRef.current?.getDraft() ?? draftRestoreRef.current?.draft.composer ?? null,
      ...draftResourcesRef.current,
      ...draftPresentationRef.current,
      ...(draftProjectIdRef.current ? { projectId: draftProjectIdRef.current } : {}),
    });
  }

  function restoreComposerDraft(draft: CloudChatDraft, view: ConversationView) {
    const snapshot = cloneCloudChatDraft(draft);
    if (draftProjectIdRef.current !== snapshot.projectId) {
      draftProjectIdRef.current = snapshot.projectId;
      setNavigationRevision((current) => current + 1);
    }
    draftsRef.current.write(view, snapshot);
    draftResourcesRef.current = { files: snapshot.files, artifacts: snapshot.artifacts };
    draftPresentationRef.current = {
      presentation: snapshot.presentation,
      researchEnabled: snapshot.researchEnabled,
    };
    setAttachments(snapshot.files);
    setArtifactAttachments(snapshot.artifacts);
    setPresentation(snapshot.presentation);
    setRuntimeControls((current) => ({
      ...current,
      nativeWebSearchEnabled: snapshot.researchEnabled,
    }));
    if (composerRef.current) {
      if (snapshot.composer) composerRef.current.setDraft(snapshot.composer);
      else composerRef.current.clear();
      draftRestoreRef.current = null;
    } else draftRestoreRef.current = { view, draft: snapshot };
  }

  function selectConversationView(
    id: string,
    preserveAttachmentBatch = false,
    nextDraft?: CloudChatDraft,
    resetBlank = false,
  ) {
    if (!isCurrentView(viewRef.current)) return viewRef.current;
    const discardBlank = resetBlank && !viewRef.current.conversationId;
    if (!discardBlank && !queueEditPreferences.current.has(viewRef.current.conversationId)) {
      const captured = captureSavedSnapshot(viewRef.current.conversationId || "blank");
      if (captured) savedDraftSyncRef.current?.markDirty(captured);
      void savedDraftSyncRef.current?.flush();
    }
    if (!discardBlank) draftsRef.current.write(viewRef.current, captureComposerDraft());
    else draftsRef.current.remove(viewRef.current);
    if (!preserveAttachmentBatch) uploadBatchRef.current = null;
    resourceDropRef.current = null;
    setResolvingResources(false);
    setCheckingUploads(false);
    setComposerMenu(null);
    setWorkspaceView("chat");
    detachRun();
    viewRef.current = { userId: user.id, conversationId: id };
    restoreComposerDraft(
      nextDraft ?? draftsRef.current.read(viewRef.current) ?? emptyCloudChatDraft(),
      viewRef.current,
    );
    const retained = retainedSubmissionsRef.current.get(id);
    pendingSubmissionRef.current = retained?.pending ?? null;
    cancelSubmissionRef.current = retained?.cancelRequested ?? false;
    setConversationId(id);
    setMessages([]);
    setHistoryLoading(Boolean(id));
    setHistoryBefore("");
    setHistoryHasMore(false);
    setHistoryAfter("");
    setHistoryHasAfter(false);
    setHistorySelection(null);
    setTaskMessageJump(undefined);
    setHistoryPageLoading(false);
    setHistoryError("");
    setMessageReader(null);
    setActiveRun(null);
    setRestoredTerminalRun(null);
    setStreaming(false);
    setRunConnection(null);
    setSubmissionUnconfirmed(retained?.status === "unknown");
    setSubmissionQueueFull(retained?.status === "queue-full");
    setStreamNotice("");
    setUploadingFiles(false);
    setFilePanel(null);
    setSourcePanel(null);
    setArtifactPanel(null);
    setWorkPanel(null);
    setContextNotice("");
    setBranchBusy(false);
    setBranchUnconfirmed(false);
    setBranchPendingMessageId(null);
    setError("");
    return viewRef.current;
  }

  useEffect(() => {
    mountedRef.current = true;
    accountInvalidatedRef.current = false;
    draftsRef.current.reset(user.id);
    retainedSubmissionsRef.current.clear();
    queueDraftsRef.current.clear();
    queueEditPreferences.current.clear();
    savedModelsRef.current.clear();
    draftProjectIdRef.current = undefined;
    savedModelRestoreRef.current = null;
    setDraftConflictLocal(null);
    setDraftConflictOpen(false);
    setSelectedConversation(null);
    conversationsAbortRef.current?.abort();
    conversationsAbortRef.current = null;
    conversationsEpochRef.current++;
    conversationsInitializedRef.current = false;
    conversationsCursorRef.current = "";
    setConversationsHasMore(false);
    setConversationsLoadingMore(false);
    setConversationsError("");
    if (viewRef.current.userId !== user.id) {
      composerRef.current?.clear();
      draftResourcesRef.current = { files: [], artifacts: [] };
      setPresentation("work");
      uploadUnconfirmedRef.current = false;
      uploadBatchRef.current = null;
      setUploadUnconfirmed(false);
      setCheckingUploads(false);
      resourceDropRef.current = null;
      setResolvingResources(false);
      setWorkspaceView("chat");
      setAccountSettingsOpen(false);
      setCustomize({ owner: user.id, open: false, visited: false });
      setExtensionLocation(DEFAULT_EXTENSION_LOCATION);
      setSpaceLocation(CLOUD_SPACE_HOME);
      setSpaceVisited(false);
      setProjectSettings({ owner: user.id, open: false });
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
      setProjectSettings({ owner: user.id, open: false });
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
      draftsRef.current.reset(0);
      retainedSubmissionsRef.current.clear();
      queueDraftsRef.current.clear();
      queueEditPreferences.current.clear();
      savedModelsRef.current.clear();
      draftProjectIdRef.current = undefined;
      savedModelRestoreRef.current = null;
      setDraftConflictLocal(null);
      setDraftConflictOpen(false);
      setSelectedConversation(null);
      composerRef.current?.clear();
      draftResourcesRef.current = { files: [], artifacts: [] };
      resourceDropRef.current = null;
      setResolvingResources(false);
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
      setProjectSettings({ owner: user.id, open: false });
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
      draftsRef.current.reset(0);
      retainedSubmissionsRef.current.clear();
      queueDraftsRef.current.clear();
      queueEditPreferences.current.clear();
      savedModelsRef.current.clear();
      draftProjectIdRef.current = undefined;
      savedModelRestoreRef.current = null;
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

  const readerRoute: CloudReaderRoute | undefined = filePanel?.fileId
    ? { kind: "file", id: filePanel.fileId }
    : artifactPanel?.versionId
      ? { kind: artifactPanel.site ? "site" : "artifact", id: artifactPanel.versionId }
      : undefined;
  const cloudRoute: CloudChatRoute =
    projectSettings.open && projectSettings.owner === user.id
      ? { page: "projects", id: projectSettings.id }
      : customizeOpen
        ? { page: "extensions", location: extensionLocation }
        : accountSettingsOpen
          ? { page: "settings", section: settingsDetail ? settingsSection : undefined }
          : (scheduleRoute ??
            (workspaceView === "library"
              ? { page: "library", location: spaceLocation, reader: readerRoute }
              : { page: "chat", id: conversationId, reader: readerRoute }));
  const replaceNextCloudRoute = useCloudChatHistory({
    owner: user.id,
    active:
      !embeddedTask &&
      workbenchActive &&
      viewRef.current.userId === user.id &&
      !accountInvalidatedRef.current,
    listen: !embeddedTask,
    route: cloudRoute,
    conversation: scheduleRoute
      ? (taskReturnConversation.current ?? conversationId)
      : conversationId,
    apply: applyCloudLocation,
    isDirty: projectNavigation.isDirty,
    confirm: projectNavigation.request,
  });
  useEffect(() => {
    const restore = draftRestoreRef.current;
    if (restore && isCurrentView(restore.view) && composerRef.current) {
      if (restore.draft.composer) composerRef.current.setDraft(restore.draft.composer);
      else composerRef.current.clear();
      draftRestoreRef.current = null;
    }
  });

  const refreshConversations = useCallback(
    async (reset = false) => {
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
        const page = await conversationClient.list({
          scope: "unassigned",
          signal: controller.signal,
        });
        if (current()) {
          const wasInitialized = conversationsInitializedRef.current && !reset;
          setConversations((previous) =>
            wasInitialized
              ? mergeCloudChatConversations(previous, page.conversations).filter(
                  (item) => !item.archived,
                )
              : page.conversations,
          );
          if (!wasInitialized) {
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
    },
    [conversationClient],
  );

  const registerProjectRows = useCallback(
    (projectId: string, items: readonly SidebarConversation[], position: number) => {
      if (ownerRef.current !== user.id || accountInvalidatedRef.current) return;
      setProjectRows((previous) => ({
        owner: user.id,
        groups: {
          ...(previous.owner === user.id ? previous.groups : {}),
          [projectId]: { items, position },
        },
      }));
    },
    [user.id],
  );
  const moveSidebarConversation = useCallback(
    async (id: string, project: CloudProject | null) => {
      if (sidebarMoves.current.has(id)) return;
      const guard = captureAccountRequestGuard();
      guard();
      if (
        id === viewRef.current.conversationId &&
        latestRunRef.current &&
        !isCloudChatRunTerminal(latestRunRef.current)
      )
        throw new Error("请先停止当前任务，再移动对话。");
      if (
        id === viewRef.current.conversationId &&
        (projectContextMutation.current ||
          dispatchPreparationRef.current ||
          modelPreparationAbortRef.current ||
          branchAbortRef.current ||
          pendingSubmissionRef.current)
      )
        throw new Error("请等待当前操作确认后，再移动对话。");
      const token = Symbol(id);
      sidebarMoves.current.set(id, token);
      setConversationMutations((current) => new Map(current).set(id, "move"));
      try {
        const binding = await projectsClient.getAssociation(id);
        guard();
        if (binding.project_id !== (project?.id ?? "")) {
          await projectsClient.setAssociation(id, project?.id ?? "", binding.version);
          guard();
        }
        if (!mountedRef.current || accountInvalidatedRef.current) return;
        setNavigationRevision((revision) => revision + 1);
        if (project) setConversations((current) => current.filter((item) => item.id !== id));
        await refreshConversations(true);
      } finally {
        if (sidebarMoves.current.get(id) === token) {
          sidebarMoves.current.delete(id);
          try {
            guard();
            setConversationMutations((current) => {
              const next = new Map(current);
              next.delete(id);
              return next;
            });
          } catch {
            /* Retired account. */
          }
        }
      }
    },
    [projectsClient, refreshConversations],
  );

  async function manageConversation(id: string, update: { pinned?: boolean; archived?: boolean }) {
    if (conversationMutations.has(id)) return;
    const guard = captureAccountRequestGuard();
    const owner = ownerRef.current;
    setConversationMutations((current) => new Map(current).set(id, "pin"));
    try {
      const conversation = await conversationClient.get(id);
      guard();
      const updated = await conversationClient.manage(conversation, update);
      guard();
      if (!mountedRef.current || ownerRef.current !== owner || accountInvalidatedRef.current)
        return;
      setConversations((current) =>
        current.map((item) => (item.id === id ? updated : item)).filter((item) => !item.archived),
      );
      if (viewRef.current.conversationId === id) setSelectedConversation(updated);
      setNavigationRevision((revision) => revision + 1);
      void refreshConversations().catch(() => undefined);
    } catch (cause) {
      try {
        guard();
        if (mountedRef.current && ownerRef.current === owner)
          setError(cause instanceof Error ? cause.message : "对话更新失败，请刷新后重试。");
      } catch {
        /* Retired account. */
      }
    } finally {
      if (ownerRef.current === owner)
        setConversationMutations((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
    }
  }

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
      const page = await conversationClient.list({
        scope: "unassigned",
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

  useEffect(() => {
    if (desktopCloudHost && workbenchActive) void refreshModels();
  }, [desktopCloudHost, refreshModels, workbenchActive]);

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
  }, [user.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes reload the catalog without replacing the run subscriber callback.
  useEffect(() => {
    void refreshConversations().catch(() => undefined);
  }, [refreshConversations, user.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly refreshes canonical metadata without navigating or creating a record.
  useEffect(() => {
    const view = viewRef.current;
    const controller = new AbortController();
    setSelectedConversation(null);
    if (conversationId)
      void conversationClient
        .get(conversationId, controller.signal)
        .then((conversation) => {
          if (!controller.signal.aborted && isCurrentView(view))
            setSelectedConversation(conversation);
        })
        .catch((cause) => {
          if (!controller.signal.aborted && isCurrentView(view))
            setError(cause instanceof Error ? cause.message : "无法读取对话信息。");
        });
    return () => controller.abort();
  }, [conversationId, conversationClient, isCurrentView, historyReloadRevision]);

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
          presentation: run.presentation,
          created_at:
            run.presentation?.completed_at || run.presentation?.started_at || run.created_at,
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
        .then(async (terminal) => {
          if (!isCurrentView(view) || attachedRunIdRef.current !== run.id) return;
          // The terminal event is committed with the final message; replace optimistic rows by its IDs.
          const response = await historyClient.list(view.conversationId, {
            signal: controller.signal,
          });
          if (isCurrentView(view) && attachedRunIdRef.current === run.id)
            setMessages((current) => mergeCloudChatHistory(current, response.messages));
          await refreshConversations();
          if (
            terminal.state === "completed" &&
            response.messages.filter((message) => message.role === "user").length === 1
          ) {
            titleRefreshAbort.current?.abort();
            const titleController = new AbortController();
            titleRefreshAbort.current = titleController;
            // Read-only bounded refresh: it never starts or retries model generation.
            void (async () => {
              const preferences = await cloudGenerationSettings(undefined, titleController.signal);
              if (!preferences.title.enabled || !isCurrentView(view)) return;
              const original = await conversationClient.get(
                view.conversationId,
                titleController.signal,
              );
              for (const delay of [500, 1500, 3000, 5000, 10000]) {
                await waitForCloudChatRetry(delay, titleController.signal);
                if (!isCurrentView(view)) return;
                const next = await conversationClient.get(
                  view.conversationId,
                  titleController.signal,
                );
                if (!isCurrentView(view)) return;
                setSelectedConversation(next);
                if (next.title !== original.title) {
                  await refreshConversations();
                  return;
                }
              }
            })().catch(() => undefined);
          }
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
    [
      displayRun,
      isCurrentView,
      refreshConversations,
      runsClient,
      historyClient,
      conversationClient,
    ],
  );

  const pendingQueue = useCloudChatQueueController({
    userId: accountInvalidatedRef.current ? 0 : user.id,
    conversationId,
    client: queueClient,
    activeRun,
    blocked:
      accountInvalidatedRef.current ||
      historyLoading ||
      historyRestoreFailed ||
      !!historySelection ||
      submissionUnconfirmed ||
      submissionQueueFull ||
      branchBusy ||
      branchUnconfirmed ||
      !!pendingSubmissionRef.current ||
      preparingExecution ||
      uploadingFiles ||
      uploadUnconfirmed,
    captureDraft: captureComposerDraft,
    restoreDraft: (draft) => {
      const view = viewRef.current;
      restoreComposerDraft(draft, view);
      const preferences = queueEditPreferences.current.get(view.conversationId);
      if (preferences) {
        setModel(preferences.model);
        setProviderKeyId(preferences.providerKeyId);
        setReasoning(preferences.reasoning);
        setRuntimeControls(preferences.runtimeControls);
        queueEditPreferences.current.delete(view.conversationId);
      }
    },
    onEdit: async (item) => {
      const view = viewRef.current;
      const guard = captureAccountRequestGuard();
      const [files, artifacts] = await Promise.all([
        Promise.all(cloudFileReferences(item.content).map((file) => filesClient.get(file.file_id))),
        Promise.all(
          cloudArtifactReferences(item.content).map((version) =>
            artifactsClient.get(version.version_id),
          ),
        ),
      ]);
      guard();
      if (!isCurrentView(view)) return;
      queueEditPreferences.current.set(view.conversationId, {
        model,
        providerKeyId,
        reasoning,
        runtimeControls,
      });
      restoreComposerDraft(
        {
          composer: item.composer ?? null,
          files,
          artifacts,
          presentation: item.presentation,
          researchEnabled: Boolean(item.public_research),
        },
        view,
      );
      if (!item.composer) composerRef.current?.setText(messageText(item.content));
      setModel(item.model);
      setProviderKeyId(item.provider_key_id ?? 0);
      setReasoning(cloudChatReasoningLevel(item.reasoning_effort ?? "none"));
      setRuntimeControls((current) => ({
        ...current,
        reasoning: cloudChatReasoningLevel(item.reasoning_effort ?? "none"),
        thinkingEnabled: item.reasoning_effort !== "none",
        nativeWebSearchEnabled: Boolean(item.public_research),
      }));
      composerRef.current?.focus();
    },
    onAccepted: async (run, item) => {
      const view = viewRef.current;
      if (!isCurrentView(view) || view.conversationId !== run.conversation_id) return;
      const guard = captureAccountRequestGuard();
      try {
        const page = await historyClient.list(view.conversationId);
        guard();
        if (!isCurrentView(view)) return;
        setMessages((current) => mergeCloudChatHistory(current, page.messages));
      } catch (cause) {
        guard();
        if (!isCurrentView(view)) return;
        if (!item) throw cause;
        setMessages((current) =>
          current.some((message) => message.id === run.user_message_id)
            ? current
            : [
                ...current,
                {
                  id: run.user_message_id,
                  role: "user",
                  content: item.content,
                  created_at: run.created_at,
                },
              ],
        );
      }
      if (!isCurrentView(view)) return;
      setHistorySelection(null);
      attachRun(run, view);
      void refreshConversations().catch(() => undefined);
    },
  });
  queueEditingItemId.current = pendingQueue.editingItem?.client_item_id ?? null;

  async function reconcileQueuedWrite() {
    const result = await pendingQueue.reconcileUnknown();
    if (!result || !("client_item_id" in result)) return;
    const retained = queueDraftsRef.current.get(result.client_item_id);
    if (
      !retained ||
      retained.view.userId !== ownerRef.current ||
      cloudChatCanonicalJSON(retained.input.content) !== cloudChatCanonicalJSON(result.content)
    )
      return;
    if (
      isCurrentView(retained.view) &&
      cloudChatDraftContentMatches(captureComposerDraft(), retained.draft)
    ) {
      if (retained.saved)
        void savedDraftSyncRef.current?.clearIfUnchanged(retained.saved, retained.scope);
      restoreComposerDraft(
        { ...retained.draft, composer: null, files: [], artifacts: [] },
        retained.view,
      );
    }
    queueDraftsRef.current.delete(result.client_item_id);
  }

  function captureSavedSnapshot(scope: string): CloudChatSavedDraft | null {
    const id = scope === "blank" ? "" : scope;
    const view = viewRef.current;
    if (
      accountInvalidatedRef.current ||
      ownerRef.current !== user.id ||
      queueEditPreferences.current.has(id)
    )
      return null;
    const current = view.conversationId === id;
    const draft = current
      ? captureComposerDraft()
      : draftsRef.current.read({ userId: user.id, conversationId: id });
    if (!draft) return null;
    const selection = current
      ? { model, providerKeyId, reasoningEffort: cloudChatReasoningEffort(reasoning) }
      : savedModelsRef.current.get(scope);
    if (selection) savedModelsRef.current.set(scope, selection);
    return { version: 1, draft, ...(selection ? { modelSelection: selection } : {}) };
  }

  const savedDraft = useCloudSavedDraft({
    ownerId: accountInvalidatedRef.current ? null : user.id,
    scope: conversationId,
    client: savedDraftClient,
    captureSnapshot: captureSavedSnapshot,
    applySnapshot: (snapshot, scope) => {
      const view = viewRef.current;
      if (
        !isCurrentView(view) ||
        (view.conversationId || "blank") !== scope ||
        pendingQueue.editingItem
      )
        return;
      const draft = snapshot?.draft ?? emptyCloudChatDraft();
      draftsRef.current.write(view, draft);
      restoreComposerDraft(draft, view);
      if (snapshot?.modelSelection) {
        savedModelsRef.current.set(scope, snapshot.modelSelection);
        savedModelRestoreRef.current = { scope, model: snapshot.modelSelection };
      }
    },
  });
  savedDraftSyncRef.current = savedDraft;

  // biome-ignore lint/correctness/useExhaustiveDependencies: these host-owned fields trigger a fresh editor snapshot; the callback reads their current values.
  useEffect(() => {
    if (
      !webSettingsLoaded ||
      modelsLoading ||
      pendingQueue.editingItem ||
      savedModelRestoreRef.current ||
      accountInvalidatedRef.current
    )
      return;
    savedDraft.markDirty();
  }, [
    attachments,
    artifactAttachments,
    presentation,
    model,
    providerKeyId,
    reasoning,
    runtimeControls.nativeWebSearchEnabled,
    modelsLoading,
    webSettingsLoaded,
    pendingQueue.editingItem,
    savedDraft.markDirty,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: async draft restoration publishes state after assigning the matching model restore ref.
  useEffect(() => {
    if (!webSettingsLoaded || modelsLoading || pendingQueue.editingItem) return;
    const restore = savedModelRestoreRef.current;
    if (!restore || restore.scope !== (conversationId || "blank")) return;
    savedModelRestoreRef.current = null;
    setModel(restore.model.model);
    setProviderKeyId(restore.model.providerKeyId ?? 0);
    if (restore.model.reasoningEffort) {
      const nextReasoning = cloudChatReasoningLevel(restore.model.reasoningEffort);
      setReasoning(nextReasoning);
      setRuntimeControls((current) => ({
        ...current,
        reasoning: nextReasoning,
        thinkingEnabled: restore.model.reasoningEffort !== "none",
      }));
    }
  }, [
    conversationId,
    webSettingsLoaded,
    modelsLoading,
    pendingQueue.editingItem,
    savedDraft.state.status,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry revision starts a read-only restoration without changing conversation identity.
  useEffect(() => {
    if (viewRef.current.userId !== user.id || viewRef.current.conversationId !== conversationId) {
      viewRef.current = { userId: user.id, conversationId };
    }
    const view = viewRef.current;
    const controller = new AbortController();
    const attachedAtStart = attachedRunIdRef.current;
    const anchor =
      historySelection?.conversationId === conversationId ? historySelection.messageId : "";
    setHistoryLoading(Boolean(conversationId));
    setHistoryError("");
    if (conversationId) {
      void Promise.all([
        anchor
          ? conversationClient
              .window(conversationId, anchor, { signal: controller.signal })
              .then((page) => ({
                messages: page.messages,
                nextBeforeId: page.nextBeforeId,
                hasMore: page.hasBefore,
                afterId: page.nextAfterId,
                hasAfter: page.hasAfter,
              }))
          : historyClient
              .list(conversationId, { signal: controller.signal })
              .then((page) => ({ ...page, afterId: "", hasAfter: false })),
        runsClient.listRuns(conversationId, true, controller.signal),
      ])
        .then(async ([response, runs]) => {
          if (
            controller.signal.aborted ||
            !isCurrentView(view) ||
            attachedRunIdRef.current !== attachedAtStart
          )
            return;
          setHistoryAfter(response.afterId);
          setHistoryHasAfter(response.hasAfter);
          if (pendingSubmissionRef.current) {
            // Returning to an uncertain submission restores reading, not a second send.
            setMessages(response.messages);
            setHistoryBefore(response.nextBeforeId);
            setHistoryHasMore(response.hasMore);
            setHistoryError("");
            return;
          }
          const run = runs.find((item) => !isCloudChatRunTerminal(item));
          let page = response;
          let history = page.messages;
          if (run && !anchor && !history.some((message) => message.id === run.user_message_id)) {
            // A run may have been accepted between the concurrent history and status reads.
            page = {
              ...(await historyClient.list(conversationId, { signal: controller.signal })),
              afterId: "",
              hasAfter: false,
            };
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
          if (run && !anchor) attachRun(run, view);
          else if (!anchor) {
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
          setHistoryRetryKind("restore");
          setHistoryError(cause instanceof Error ? cause.message : "会话恢复失败");
        })
        .finally(() => {
          if (!controller.signal.aborted && isCurrentView(view)) setHistoryLoading(false);
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
    conversationClient,
    historySelection,
    historyReloadRevision,
  ]);

  useEffect(() => {
    if (
      !historySelection ||
      historyLoading ||
      historySelection.conversationId !== conversationId ||
      historyJumpedToken.current === historySelection.token ||
      !messages.some((item) => item.id === historySelection.messageId)
    )
      return;
    transcriptFollow.restoreFollowing(false);
    const frame = requestAnimationFrame(() => {
      transcriptNavigation.current?.scrollToRowKey(historySelection.messageId);
      historyJumpedToken.current = historySelection.token;
    });
    return () => cancelAnimationFrame(frame);
  }, [historySelection, historyLoading, conversationId, messages, transcriptFollow]);

  async function loadLaterHistory() {
    const view = viewRef.current;
    if (!isCurrentView(view) || !historyHasAfter || !historyAfter || historyPageAbortRef.current)
      return;
    const controller = new AbortController();
    historyPageAbortRef.current = controller;
    setHistoryPageLoading(true);
    try {
      const page = await conversationClient.window(view.conversationId, historyAfter, {
        before: 0,
        after: 49,
        signal: controller.signal,
      });
      if (!isCurrentView(view) || controller.signal.aborted) return;
      setMessages((current) => mergeCloudChatHistory(current, page.messages));
      setHistoryAfter(page.nextAfterId);
      setHistoryHasAfter(page.hasAfter);
      setHistoryError("");
    } catch (cause) {
      if (isCurrentView(view) && !controller.signal.aborted) setHistoryRetryKind("later");
      if (isCurrentView(view) && !controller.signal.aborted)
        setHistoryError(cause instanceof Error ? cause.message : "无法读取后续消息。");
    } finally {
      if (historyPageAbortRef.current === controller) {
        historyPageAbortRef.current = null;
        if (isCurrentView(view)) setHistoryPageLoading(false);
      }
    }
  }

  async function loadEarlierHistory() {
    const view = viewRef.current;
    if (!isCurrentView(view) || !historyHasMore || !historyBefore || historyPageAbortRef.current)
      return;
    const controller = new AbortController();
    historyPageAbortRef.current = controller;
    setHistoryPageLoading(true);
    transcriptFollow.restoreFollowing(false);
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
        setHistoryRetryKind("earlier");
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
    const cached = messages.find(
      (message) => message.id === id && !message.content_omitted && !message.presentation_omitted,
    );
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

  function openCloudMessageLink(link: ChatFileLink) {
    if (!isCurrentView(viewRef.current)) return;
    const extensionDraft = extensionDraftFromLink(link.path);
    if (extensionDraft) {
      requestCustomize(extensionDraft, true);
      return;
    }
    const message = /^cloud-messages\/([A-Za-z0-9_-]{1,128})$/.exec(link.path);
    if (message) {
      void readMessageBody(message[1]);
      return;
    }
    const uuid = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
    const site = new RegExp(`^cloud-sites/${uuid}$`, "i").exec(link.path);
    if (site) {
      showResourceDetail(() => showArtifactResource({ versionId: site[1], site: true }));
      return;
    }
    const artifactId = cloudArtifactVersionFromLink(link.path);
    if (artifactId) {
      showResourceDetail(() => showArtifactResource({ versionId: artifactId }));
      return;
    }
    const source = new RegExp(`^cloud-sources/${uuid}$`, "i").exec(link.path);
    if (source) {
      showResourceDetail(() =>
        setSourcePanel({ sourceId: source[1], fromLine: link.line, toLine: link.endLine }),
      );
      return;
    }
    const file = new RegExp(`^cloud-files/${uuid}$`, "i").exec(link.path);
    if (file) {
      showResourceDetail(() =>
        showFileResource({ fileId: file[1], fromLine: link.line, toLine: link.endLine }),
      );
      return;
    }
    setError("云端对话仅支持打开当前账户的资料引用。");
  }

  async function createConversation() {
    if (conversationCreationRef.current) return conversationCreationRef.current;
    const operation = createConversationOnce();
    conversationCreationRef.current = operation;
    try {
      return await operation;
    } finally {
      if (conversationCreationRef.current === operation) conversationCreationRef.current = null;
    }
  }

  async function createConversationOnce() {
    const previousView = viewRef.current;
    const response = await webChatRequest<{ conversation: Conversation }>(
      "/api/web-chat/conversations",
      { method: "POST", body: JSON.stringify({ model }) },
    );
    if (!isCurrentView(previousView)) return "";
    // Creation assigns an identity to this draft; edits made while awaiting it still belong here.
    const savedDraft = captureComposerDraft();
    setConversations((current) => [response.conversation, ...current]);
    replaceNextCloudRoute.current = true;
    selectConversationView(response.conversation.id, true, savedDraft);
    draftsRef.current.remove(previousView);
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
    setNavigationRevision((revision) => revision + 1);
    if (conversationId === id) {
      replaceNextCloudRoute.current = true;
      selectConversationView("");
    }
    draftsRef.current.remove({ userId: user.id, conversationId: id });
    retainedSubmissionsRef.current.delete(id);
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
    if (viewRef.current.conversationId === id) setSelectedConversation(response.conversation);
    setNavigationRevision((revision) => revision + 1);
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
      const newView = selectConversationView(branch.conversation.id, false, pending.draft);
      setConversations((current) => [
        branch.conversation,
        ...current.filter((item) => item.id !== branch.conversation.id),
      ]);
      setMessages(history.messages);
      setHistoryBefore(history.nextBeforeId);
      setHistoryHasMore(history.hasMore);
      setHistoryLoading(false);
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

  async function branchConversation(messageRef: HistoryMessageRef) {
    const view = viewRef.current;
    if (
      !isCurrentView(view) ||
      streaming ||
      historyLoading ||
      historyRestoreFailed ||
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
    let anchor = original.id;
    for (let next = index + 1; next < messages.length && messages[next].role !== "user"; next++)
      if (messages[next].role === "assistant") anchor = messages[next].id;
    setBranchPendingMessageId(original.id);
    await applyBranch({
      view,
      request: { client_request_id: createUuid(), message_id: anchor, action: "fork" },
      draft: captureComposerDraft(),
      execution: {
        model,
        reasoning: cloudChatReasoningEffort(reasoning),
        providerKeyId: 0,
        parameters: {},
      },
    });
  }

  async function editAndResend(
    messageRef: HistoryMessageRef,
    text: string,
    files: PendingUploadedFile[],
  ) {
    const view = viewRef.current;
    if (
      !isCurrentView(view) ||
      streaming ||
      historyLoading ||
      historyRestoreFailed ||
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
    if (original.content_omitted) {
      void readMessageBody(original.id);
      return;
    }
    if (historyHasAfter) {
      setError("请返回最新消息后再编辑重发。");
      return;
    }
    const ids = files.map((file) => file.relativePath);
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
    const content = ids.length
      ? [
          ...(text.trim() ? [{ type: "text", text: text }] : []),
          ...ids.map((id) => {
            const versionId = cloudArtifactVersionFromLink(id);
            return versionId
              ? { type: "artifact_reference", version_id: versionId }
              : { type: "file_reference", file_id: id };
          }),
        ]
      : text;
    if (!text.trim() && !ids.length) {
      setError("编辑后的消息不能为空。");
      return;
    }
    const providerId = selectedModelOption?.providerId ?? "";
    const providerKeyId = relayProviderKeyId(providerId);
    if (providerKeyId <= 0) {
      setError("请选择可用的模型分组后重试。");
      return;
    }
    const requestId = createUuid();
    const tail = messages.at(-1);
    const lastRun = latestRunRef.current ?? restoredTerminalRun;
    const transientReply =
      lastRun && tail?.id === lastRun.assistant_message_id && isCloudChatRunTerminal(lastRun);
    const reasoningEffort = cloudChatReasoningEffort(reasoning);
    try {
      const parameters = await prepareModelParameters(view, providerId, providerKeyId, model);
      if (!isCurrentView(view)) return;
      const current = await historyClient.list(view.conversationId);
      if (!isCurrentView(view)) return;
      const expectedTailId = current.messages.at(-1)?.id;
      if (
        !expectedTailId ||
        (expectedTailId !== tail?.id &&
          !(transientReply && expectedTailId === lastRun.user_message_id))
      ) {
        setError("会话历史已变化。请重新加载会话后再编辑。");
        return;
      }
      const proceed = (publicResearch?: CloudChatPublicResearch) => {
        if (!isCurrentView(view) || pendingSubmissionRef.current || pendingBranchRef.current)
          return;
        void submitRun(
          {
            request: {
              conversation_id: view.conversationId,
              client_request_id: requestId,
              model,
              content,
              reasoning_effort: reasoningEffort,
              provider_key_id: providerKeyId,
              model_parameters: parameters,
              public_research: publicResearch,
              edit: { message_id: original.id, expected_tail_id: expectedTailId },
            },
            optimisticUserId: createUuid(),
            optimisticAssistantId: createUuid(),
            optimisticContent: content,
            preserveDraft: true,
          },
          view,
        );
      };
      if (runtimeControls.nativeWebSearchEnabled) {
        requestResearchConfirmation(messageText(content), view, proceed);
      } else proceed();
    } catch (cause) {
      if (isCurrentView(view)) setError(cause instanceof Error ? cause.message : "编辑重发失败。");
    }
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

  async function attachFileList(files: File[], directories = 0) {
    if (!files.length && !directories) return;
    const blocked = cloudAttachmentBlockedReason();
    if (blocked) {
      setError(blocked);
      return;
    }
    const resourceCount = attachments.length + artifactAttachments.length;
    const batch = prepareCloudFileBatch(files, 8 - resourceCount, directories);
    if (!batch.files.length) {
      setError(batch.message);
      return;
    }
    // Claim the batch before creating a conversation or causing a React render.
    const token = Symbol("attachment upload");
    uploadBatchRef.current = token;
    const guard = captureAccountRequestGuard();
    const view = viewRef.current;
    setUploadingFiles(true);
    setUploadingAttachments({
      view,
      files: batch.files.map((file) => ({ id: `upload:${++uploadPreviewSequence.current}`, file })),
    });
    try {
      if (!isCurrentView(view) || uploadBatchRef.current !== token) return;
      const controller = new AbortController();
      uploadAbortRef.current = controller;
      setUploadingFiles(true);
      setError("");
      try {
        for (const file of batch.files) {
          if (!isCurrentView(view) || controller.signal.aborted) return;
          const uploaded = await filesClient.upload(file, view.conversationId, controller.signal);
          guard();
          if (!isCurrentView(view) || controller.signal.aborted) return;
          setAttachments((current) =>
            current.some((item) => item.id === uploaded.id) ? current : [...current, uploaded],
          );
          setUploadingAttachments((current) =>
            current?.view === view
              ? { ...current, files: current.files.filter((item) => item.file !== file) }
              : current,
          );
        }
        if (batch.message) setError(batch.message);
      } finally {
        if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      }
    } catch (cause) {
      if (!isCurrentView(view)) return;
      if (cause instanceof CloudChatFileError && cause.status === 401) notifyRelaySessionExpired();
      if (cause instanceof CloudFileUploadUnconfirmedError) {
        uploadUnconfirmedRef.current = true;
        setUploadUnconfirmed(true);
      }
      setError(cause instanceof Error ? cause.message : "附件上传失败，请在文件库中核对。");
    } finally {
      if (uploadBatchRef.current === token) {
        uploadBatchRef.current = null;
        if (isCurrentView(view)) setUploadingFiles(false);
        setUploadingAttachments((current) => (current?.view === view ? null : current));
      }
    }
  }

  async function reconcileUploads() {
    if (checkingUploads || !isCurrentView(viewRef.current)) return;
    const view = viewRef.current,
      guard = captureAccountRequestGuard();
    setCheckingUploads(true);
    try {
      await filesClient.list();
      guard();
      if (!isCurrentView(view)) return;
      uploadUnconfirmedRef.current = false;
      setUploadUnconfirmed(false);
      setError("");
      setContextNotice("文件库已刷新，请核对已保存的原件后再添加；本次没有重新上传。");
      openResource("files");
    } catch (cause) {
      if (isCurrentView(view)) {
        if (cause instanceof CloudChatFileError && cause.status === 401)
          notifyRelaySessionExpired();
        setError(cause instanceof Error ? cause.message : "文件库核对失败，请稍后再次核对。");
      }
    } finally {
      if (isCurrentView(view)) setCheckingUploads(false);
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
    retainedSubmissionsRef.current.set(view.conversationId, {
      pending,
      status: "unknown",
      cancelRequested: cancelSubmissionRef.current,
    });
    attachedRunIdRef.current = `pending:${pending.request.client_request_id}`;
    setRestoredTerminalRun(null);
    setSubmissionQueueFull(false);
    setMessages((current) =>
      pending.request.edit || current.some((message) => message.id === pending.optimisticUserId)
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
      if (!mountedRef.current || accountInvalidatedRef.current || ownerRef.current !== view.userId)
        return;
      retainedSubmissionsRef.current.delete(view.conversationId);
      if (!pending.preserveDraft && pending.submittedSavedDraft) {
        void savedDraftSyncRef.current?.clearIfUnchanged(
          pending.submittedSavedDraft,
          pending.submittedDraftScope ?? view.conversationId,
        );
        if (pending.submittedDraftScope === "blank" && view.conversationId)
          void savedDraftSyncRef.current?.clearIfUnchanged(
            pending.submittedSavedDraft,
            view.conversationId,
          );
      }
      if (!pending.preserveDraft && pending.submittedDraft) {
        const currentDraft = isCurrentView(view)
          ? captureComposerDraft()
          : draftsRef.current.read(view);
        if (currentDraft && cloudChatDraftContentMatches(currentDraft, pending.submittedDraft)) {
          const cleared = { ...currentDraft, composer: null, files: [], artifacts: [] };
          draftsRef.current.write(view, cleared);
          if (isCurrentView(view)) restoreComposerDraft(cleared, view);
        }
      }
      if (!isCurrentView(view)) return;
      pendingSubmissionRef.current = null;
      setSubmissionUnconfirmed(false);
      if (pending.request.edit) setHistorySelection(null);
      setMessages((current) => {
        if (pending.request.edit) {
          const index = current.findIndex(
            (message) => message.id === pending.request.edit?.message_id,
          );
          if (index >= 0) {
            return [
              ...current.slice(0, index),
              { id: run.user_message_id, role: "user", content: pending.optimisticContent },
            ];
          }
          // A view reopened after a lost response may already have the canonical history.
          if (!current.some((message) => message.id === run.user_message_id)) {
            return [
              ...current,
              { id: run.user_message_id, role: "user", content: pending.optimisticContent },
            ];
          }
        }
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
        retainedSubmissionsRef.current.set(view.conversationId, {
          pending,
          status: "queue-full",
          cancelRequested: false,
        });
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
        retainedSubmissionsRef.current.delete(view.conversationId);
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
      const retained = retainedSubmissionsRef.current.get(view.conversationId);
      if (retained) retained.cancelRequested = true;
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

  async function send(revisionDraft?: CloudChatDraft) {
    if (historyRestoreFailed) return;
    if (dispatchPreparationRef.current) return;
    if (historySelection) {
      setHistorySelection(null);
      setContextNotice("已返回最新消息，草稿已保留，请确认后发送。");
      transcriptFollow.stickToBottom();
      return;
    }
    if (projectContextMutation.current) return;
    if (sidebarMoves.current.has(viewRef.current.conversationId)) return;
    if (modelPreparationAbortRef.current) return;
    if (!isCurrentView(viewRef.current)) return;
    if (researchConfirmationRef.current) return;
    if (pendingQueue.busy || pendingQueue.loading || pendingQueue.unknown) return;
    if (branchBusy || branchUnconfirmed || branchAbortRef.current || pendingBranchRef.current)
      return;
    if (pendingSubmissionRef.current) {
      await submitRun(pendingSubmissionRef.current, viewRef.current);
      return;
    }
    const submittedDraft = revisionDraft ?? captureComposerDraft();
    const submittedDraftScope = viewRef.current.conversationId || "blank";
    const submittedSavedDraft = captureSavedSnapshot(submittedDraftScope) ?? undefined;
    if (submittedSavedDraft && !pendingQueue.editingItem)
      savedDraftSyncRef.current?.markDirty(submittedSavedDraft);
    const draft = submittedDraft.composer;
    const submittedFiles = submittedDraft.files;
    const submittedArtifacts = submittedDraft.artifacts;
    const text = draft ? buildCloudComposerText(draft).trim() : "";
    const editingItem = pendingQueue.editingItem;
    const queueInstead = streaming || Boolean(editingItem);
    if (
      uploadingFiles ||
      uploadAbortRef.current ||
      uploadBatchRef.current ||
      resourceDropRef.current ||
      modelsLoading ||
      !webSettingsLoaded ||
      modelOptions.length === 0 ||
      !selectedModelOption ||
      (!text && submittedFiles.length === 0 && submittedArtifacts.length === 0)
    )
      return;
    if (submittedFiles.some((file) => !cloudFileCanReference(file))) {
      setError("有附件尚未完成解析或需要拆分，请在文件库中查看状态，或从本条消息移除后发送。");
      return;
    }
    if (submittedArtifacts.some((version) => version.state !== "ready")) {
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
      // Editing text keeps the accepted queue snapshot. A deliberate model/group change
      // prepares a new snapshot; merely opening the editor must not change execution settings.
      parameters =
        editingItem &&
        editingItem.model === model &&
        editingItem.provider_key_id === executionProviderKeyId
          ? structuredClone(editingItem.model_parameters ?? {})
          : await prepareModelParameters(
              preparedView,
              selectedModelOption.providerId,
              executionProviderKeyId,
              model,
            );
      if (!isCurrentView(preparedView)) return;
      if (
        parameters.input_modalities?.length === 1 &&
        submittedFiles.some((file) => file.state === "vision_ready")
      )
        throw new Error("所选模型设置为仅文本输入，请开启图片输入或从消息中移除图片。");
    } catch (cause) {
      if (isCurrentView(preparedView))
        setError(cause instanceof Error ? cause.message : "请检查模型参数。");
      return;
    }
    const dispatchResult = { accepted: false };
    let proceedingView = preparedView;
    const proceed = async (publicResearch?: CloudChatPublicResearch) => {
      if (!isCurrentView(preparedView)) return;
      if (dispatchPreparationRef.current) return;
      if (editingItem && queueEditingItemId.current !== editingItem.client_item_id) return;
      if (!queueInstead && latestRunRef.current && !isCloudChatRunTerminal(latestRunRef.current)) {
        setError("请等待当前任务完成，或停止后再发送。");
        return;
      }
      dispatchPreparationRef.current = true;
      setPreparingExecution(true);
      try {
        setError("");
        setContextNotice("");
        const id = conversationId || (await createConversation());
        if (!id) return;
        proceedingView = viewRef.current;
        if (submittedDraft.projectId) {
          const bindingView = viewRef.current;
          const guard = captureWorkGuard();
          // A blank draft can select a project without creating a conversation record.
          // Apply that selection only when the user actually sends the first message.
          const project = await projectsClient.getProject(submittedDraft.projectId);
          guard();
          const binding = await projectsClient.getAssociation(id);
          guard();
          if (binding.project_id !== project.id) {
            await projectsClient.setAssociation(id, project.id, binding.version);
            guard();
          }
          if (!isCurrentView(bindingView)) return;
          setComposerProject({ scope: `${user.id}:${id}`, project });
          setNavigationRevision((current) => current + 1);
          setConversations((current) => current.filter((item) => item.id !== id));
        }
        const hasResources = submittedFiles.length + submittedArtifacts.length > 0;
        const content: unknown = hasResources
          ? [
              ...(text ? [{ type: "text", text }] : []),
              ...submittedFiles.map((attachment) => ({
                type: "file_reference",
                file_id: attachment.id,
              })),
              ...submittedArtifacts.map((version) => ({
                type: "artifact_reference",
                version_id: version.id,
              })),
            ]
          : text;
        const view = viewRef.current;
        const optimisticContent = hasResources
          ? [
              ...(text ? [{ type: "text", text }] : []),
              ...submittedFiles.map((file) => ({
                type: "file_reference",
                file_id: file.id,
                name: file.name,
                mime: file.mime,
                size: file.size,
              })),
              ...submittedArtifacts.map((version) => ({
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
        if (queueInstead) {
          const input: CloudChatPendingInput = {
            client_item_id: editingItem?.client_item_id ?? createUuid(),
            model,
            provider_key_id: executionProviderKeyId,
            reasoning_effort: cloudChatReasoningEffort(reasoning),
            model_parameters: parameters,
            presentation: submittedDraft.presentation,
            content,
            ...(draft ? { composer: draft } : {}),
            ...(publicResearch ? { public_research: publicResearch } : {}),
          };
          const queueView = viewRef.current;
          const editing = Boolean(editingItem);
          if (!editing)
            queueDraftsRef.current.set(input.client_item_id, {
              view: queueView,
              draft: submittedDraft,
              input,
              saved: submittedSavedDraft,
              scope: submittedDraftScope,
            });
          const saved = editing
            ? await pendingQueue.saveEdit(input)
            : await pendingQueue.enqueue(input);
          dispatchResult.accepted = Boolean(saved);
          if (saved && !editing) {
            if (submittedSavedDraft)
              void savedDraftSyncRef.current?.clearIfUnchanged(
                submittedSavedDraft,
                submittedDraftScope,
              );
            const currentDraft = isCurrentView(queueView)
              ? captureComposerDraft()
              : draftsRef.current.read(queueView);
            if (currentDraft && cloudChatDraftContentMatches(currentDraft, submittedDraft)) {
              const cleared = { ...currentDraft, composer: null, files: [], artifacts: [] };
              draftsRef.current.write(queueView, cleared);
              if (isCurrentView(queueView)) restoreComposerDraft(cleared, queueView);
            }
            queueDraftsRef.current.delete(input.client_item_id);
          }
          return;
        }
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
        dispatchResult.accepted = true;
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
            submittedDraft,
            submittedSavedDraft,
            submittedDraftScope,
          },
          view,
        );
      } finally {
        dispatchPreparationRef.current = false;
        if (isCurrentView(proceedingView)) setPreparingExecution(false);
      }
    };
    if (runtimeControls.nativeWebSearchEnabled) {
      requestResearchConfirmation(text, preparedView, (research) => {
        void proceed(research).catch((cause) => {
          if (isCurrentView(proceedingView))
            setError(cause instanceof Error ? cause.message : "发送失败，请重试。");
        });
      });
    } else
      await proceed().catch((cause) => {
        if (isCurrentView(proceedingView))
          setError(cause instanceof Error ? cause.message : "发送失败，请重试。");
      });
    return dispatchResult.accepted;
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
            timestamp: cloudChatMessageTimestamp(message),
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
        const mapText = (value: string) =>
          linkExtensionDraftCitations(
            linkCloudArtifactCitations(linkCloudSourceCitations(linkCloudFileCitations(value))),
          );
        const fallbackText = message.content_omitted
          ? `正文按需加载。[查看消息正文](cloud-messages/${message.id})`
          : preview.truncated
            ? `${mapText(text)}\n\n${preview.notice} [分段查看完整正文](cloud-messages/${message.id})`
            : `${mapText(text)}${message.presentation_omitted ? `\n\n[查看完整工作过程](cloud-messages/${message.id})` : ""}`;
        return {
          key: message.id,
          origin: streaming && message.id === messages.at(-1)?.id ? "stream" : "history",
          kind: "assistant",
          deliverables: cloudChatAssistantDeliverables(message),
          timestamp: cloudChatMessageTimestamp(message),
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
          rounds: cloudChatAssistantRounds(message, {
            live: streaming && message.id === messages.at(-1)?.id,
            fallbackText,
            mapText,
            processVisible: !message.content_omitted && !preview.truncated,
          }),
        };
      }),
    [messages, streaming, conversationId, copyMessageText],
  );
  const taskJump =
    taskMessageJump?.conversationId === conversationId ? taskMessageJump.jump : undefined;
  useTranscriptMessageJump({
    target: taskJump,
    rowKey: taskJump && transcriptRows.find((row) => row.key === taskJump.messageId)?.key,
    historyBoundary: historyBefore,
    hasMoreHistory: historyHasMore,
    loadEarlier: loadEarlierHistory,
    ready:
      Boolean(transcriptViewport) &&
      !historyLoading &&
      !historyPageLoading &&
      !historyRestoreFailed,
    jumpToRow: (key) => {
      transcriptFollow.restoreFollowing(false);
      transcriptNavigation.current?.scrollToRowKey(key);
    },
  });

  const sidebarItems = useMemo<SidebarConversation[]>(() => {
    const cloud: SidebarConversation[] = conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      providerId: "web-chat",
      model: conversation.model,
      createdAt: toEpoch(conversation.created_at),
      updatedAt: toEpoch(conversation.updated_at),
      isPinned: conversation.pinned === true,
      isArchived: conversation.archived === true,
    }));
    return cloud.sort(
      (left, right) =>
        Number(right.isPinned === true) - Number(left.isPinned === true) ||
        right.updatedAt - left.updatedAt,
    );
  }, [conversations]);
  const currentConversation = accountInvalidatedRef.current
    ? null
    : (conversations.find((item) => item.id === conversationId) ??
      (selectedConversation?.id === conversationId ? selectedConversation : null));

  const runningConversationIds = useMemo(
    () => (streaming && conversationId ? new Set([conversationId]) : new Set<string>()),
    [conversationId, streaming],
  );
  const projectSidebarItems = useMemo(
    () =>
      projectRows.owner === user.id
        ? Object.values(projectRows.groups)
            .sort((a, b) => a.position - b.position)
            .flatMap((group) => group.items)
        : [],
    [projectRows, user.id],
  );

  const renderConversationMoveMenu = useCallback(
    (item: SidebarConversation) => (
      <CloudConversationMoveMenu
        conversationId={item.id}
        client={projectsClient}
        captureGuard={captureAccountRequestGuard}
        disabled={conversationMutations.has(item.id) || runningConversationIds.has(item.id)}
        onMove={(project) => moveSidebarConversation(item.id, project)}
        onCreate={() => setProjectCreate({ owner: user.id, open: true, conversationId: item.id })}
        onError={setError}
      />
    ),
    [
      projectsClient,
      conversationMutations,
      runningConversationIds,
      moveSidebarConversation,
      user.id,
    ],
  );
  const pendingUploadedFiles = useMemo<PendingUploadedFile[]>(
    () => [
      ...attachments.map((attachment) => ({
        relativePath: attachment.id,
        fileName: attachment.name,
        statusText: cloudFileStatus(attachment),
        kind: attachmentKind(attachment),
        sizeBytes: attachment.size,
      })),
      ...artifactAttachments.map((version) => ({
        relativePath: `cloud-artifacts/${version.id}`,
        fileName: version.name,
        statusText: `已保存 · v${version.number}`,
        kind: "text" as const,
        sizeBytes: version.size,
      })),
    ],
    [attachments, artifactAttachments],
  );
  const catalogVersion = useCatalogLiveVersion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Catalog-only changes also invalidate model badges.
  const modelOptions = useMemo(
    () =>
      buildModelOptions(settings, { floatSelectedFirst: false, modelType: "text" }).map((option) => ({
        ...option,
        nativeWebSearchSupported: true,
      })),
    [settings, catalogVersion],
  );
  const selectedModelValue = providerKeyId
    ? toModelValue(relayProviderId(providerKeyId), model)
    : modelOptions.find((option) => option.model === model)?.value;
  const selectedModelOption = modelOptions.find((option) => option.value === selectedModelValue);
  const configuredModel = settings.customProviders
    .find((provider) => provider.id === relayProviderId(providerKeyId))
    ?.models.find((entry) => entry.id === model);
  const modelTypeMismatch =
    providerKeyId > 0 && !!model && !modelTypesFor(model, configuredModel).includes("text");
  const scheduleModel = selectedModelOption ?? modelOptions[0];

  useEffect(() => {
    if (
      modelsLoading ||
      modelTypeMismatch ||
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
    modelTypeMismatch,
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

  const landing =
    !historyLoading && !historyRestoreFailed && transcriptRows.length === 0 && !streaming;
  const canSwitchPresentation = landing && !preparingExecution;
  const composerLocked =
    pendingQueue.busy ||
    pendingQueue.loading ||
    Boolean(pendingQueue.unknown) ||
    projectContextBusy ||
    conversationMutations.get(conversationId) === "move" ||
    preparingExecution ||
    historyLoading ||
    historyRestoreFailed ||
    uploadingFiles ||
    resolvingResources ||
    uploadUnconfirmed ||
    submissionUnconfirmed ||
    submissionQueueFull ||
    branchBusy ||
    branchUnconfirmed;
  function cloudAttachmentBlockedReason(resources = false) {
    if (!isCurrentView(viewRef.current) || accountInvalidatedRef.current)
      return "登录状态已更新，请刷新页面后继续。";
    if (uploadUnconfirmedRef.current) return "上传结果尚未确认，请先刷新文件库核对。";
    if (resourceDropRef.current) return "正在核对资料，请稍候。";
    if (uploadBatchRef.current || uploadingFiles) return "正在上传附件，请等待当前上传完成。";
    if (
      composerLocked ||
      pendingQueue.busy ||
      pendingQueue.loading ||
      pendingQueue.unknown ||
      modelPreparationAbortRef.current ||
      researchConfirmationRef.current
    )
      return "请等待当前操作完成后再添加资料。";
    if (!resources && attachments.length + artifactAttachments.length >= 8)
      return "每条消息最多引用 8 个文件或成果，请先移除附件。";
    return "";
  }
  async function dropCloudResources(transfer: DataTransfer) {
    const items = readCloudResourceDragPayload(transfer);
    if (!items) {
      setError("拖入的资料身份无效，请从资料空间重新选择。");
      return;
    }
    if (resourceDropRef.current) {
      setError("正在核对资料，请稍候。");
      return;
    }
    const view = viewRef.current;
    try {
      await referenceSpaceItems(items);
    } catch (cause) {
      if (isCurrentView(view)) {
        if (
          (cause instanceof CloudChatFileError || cause instanceof CloudChatArtifactError) &&
          cause.status === 401
        )
          notifyRelaySessionExpired();
        setError(cause instanceof Error ? cause.message : "资料引用失败，请重新选择。");
      }
    }
  }
  const readerOpen = Boolean(
    (filePanel && (workspaceView !== "library" || filePanel.fileId)) ||
      (artifactPanel && (workspaceView !== "library" || artifactPanel.versionId)),
  );
  const workingInSpace = workspaceView === "library" && spaceWork && readerOpen;
  const chatWorkspaceVisible = workspaceView === "chat" || workingInSpace;
  function showFileResource(target: NonNullable<typeof filePanel>) {
    setFilePanel(target);
    setArtifactPanel(null);
    setSourcePanel(null);
    setWorkPanel(null);
  }
  function showArtifactResource(target: NonNullable<typeof artifactPanel>) {
    setArtifactPanel(target);
    setFilePanel(null);
    setSourcePanel(null);
    setWorkPanel(null);
  }
  function clearResources() {
    setScheduleRoute(undefined);
    taskReturnConversation.current = undefined;
    taskRunSelection.current = null;
    setTaskMessageJump(undefined);
    setWorkspaceHandoff(undefined);
    setSpaceWork(false);
    setAccountSettingsOpen(false);
    sidebarPreview.dismiss();
    setComposerMenu(null);
    setFilePanel(null);
    setArtifactPanel(null);
    setSourcePanel(null);
    setWorkPanel(null);
    setWorkspaceView("chat");
  }
  function applyCloudLocation({ route, conversation }: ReturnType<typeof readCloudChatLocation>) {
    if (
      route.page === "tasks" &&
      scheduleRoute &&
      !accountSettingsOpen &&
      !customizeOpen &&
      !projectSettings.open
    ) {
      taskReturnConversation.current = conversation;
      setScheduleRoute(route);
      if (sidebar.isMobile) setSidebarOpen(false);
      return;
    }
    if (conversation !== viewRef.current.conversationId) {
      pendingQueue.pause();
      selectConversationView(conversation);
    }
    clearResources();
    if (route.page === "tasks") {
      taskReturnConversation.current = conversation;
      setScheduleRoute(route);
    }
    setCustomize((current) => ({
      owner: user.id,
      open: route.page === "extensions",
      visited: (current.owner === user.id && current.visited) || route.page === "extensions",
    }));
    setProjectSettings({
      owner: user.id,
      id: route.page === "projects" ? route.id : undefined,
      open: route.page === "projects",
    });
    if (route.page === "settings") {
      setActiveSettingsSection(route.section ?? "system");
      setSettingsDetail(!!route.section);
      setAccountSettingsOpen(true);
    } else if (route.page === "extensions") {
      setExtensionLocation(route.location);
    } else if (route.page === "library" || route.page === "chat") {
      if (route.page === "library") {
        setSpaceVisited(true);
        setSpaceLocation(route.location);
        setWorkspaceView("library");
      }
      if (route.reader?.kind === "file") setFilePanel({ fileId: route.reader.id });
      else if (route.reader) {
        setArtifactPanel({ versionId: route.reader.id, site: route.reader.kind === "site" });
      }
    }
    if (sidebar.isMobile) setSidebarOpen(false);
  }
  function closeResources() {
    projectNavigation.request(() => {
      leaveTaskConversation();
      clearResources();
      if (sidebar.isMobile) setSidebarOpen(false);
    });
  }
  function leaveTaskConversation() {
    const previous = taskReturnConversation.current;
    taskReturnConversation.current = undefined;
    taskRunSelection.current = null;
    setTaskMessageJump(undefined);
    if (previous !== undefined && previous !== viewRef.current.conversationId) {
      pendingQueue.pause();
      selectConversationView(previous);
    }
  }
  function selectTaskConversation(selection: CloudTaskConversationSelection) {
    const { id, runId, followLatest, jump } = selection;
    const sameConversation = viewRef.current.conversationId === id;
    const previous = taskRunSelection.current;
    const sameRun = previous?.id === id && previous.runId === runId;
    if (
      sameConversation &&
      sameRun &&
      previous?.jump?.key === jump?.key &&
      previous?.jump?.messageId === jump?.messageId &&
      previous?.followLatest === followLatest
    )
      return;
    taskRunSelection.current = selection;
    if (!sameConversation) {
      pendingQueue.pause();
      setFilePanel(null);
      setArtifactPanel(null);
      setSourcePanel(null);
      setWorkPanel(null);
      selectConversationView(id);
    }
    if (historySelection?.conversationId === id) setHistorySelection(null);
    setTaskMessageJump(jump ? { conversationId: id, jump } : undefined);
    if (
      followLatest &&
      sameConversation &&
      runId &&
      !sameRun &&
      !streaming &&
      !pendingSubmissionRef.current
    )
      setHistoryReloadRevision((revision) => revision + 1);
  }
  function showTaskResultResource(resource: CloudChatPresentationResource) {
    if (resource.kind === "source") {
      setFilePanel(null);
      setArtifactPanel(null);
      setWorkPanel(null);
      setSourcePanel({ sourceId: resource.id });
    }
    if (resource.kind === "file") showFileResource({ fileId: resource.id });
    if (resource.kind === "artifact" || resource.kind === "site")
      showArtifactResource({ versionId: resource.id, site: resource.kind === "site" });
    if (resource.kind === "extension-draft") requestCustomize(resource.id, true);
  }
  const applyEmbeddedTask = useEffectEvent((selection: CloudTaskConversationSelection) =>
    selectTaskConversation(selection),
  );
  const openEmbeddedTaskResource = useEffectEvent(showTaskResultResource);
  useEffect(() => {
    if (embeddedTaskId)
      applyEmbeddedTask({
        id: embeddedTaskId,
        runId: embeddedTaskRun,
        followLatest: embeddedTaskFollowLatest,
        jump: embeddedTaskJump,
      });
  }, [embeddedTaskId, embeddedTaskRun, embeddedTaskFollowLatest, embeddedTaskJump]);
  useEffect(() => {
    if (embeddedTaskId && embeddedTaskResource) openEmbeddedTaskResource(embeddedTaskResource);
  }, [embeddedTaskId, embeddedTaskResource]);
  useEffect(() => {
    if (!isEmbeddedMobileRuntime()) return;
    const handleBack = (event: Event) => {
      // Settings owns its native Back handler, including the mobile list/detail step.
      if (event.defaultPrevented || accountSettingsOpen) return;
      if (projectSettings.open && projectSettings.owner === user.id) return;
      if (composerMenu) {
        setComposerMenu(null);
      } else if (
        filePanel ||
        artifactPanel ||
        sourcePanel ||
        workPanel ||
        workspaceView !== "chat"
      ) {
        projectNavigation.request(() => {
          setFilePanel(null);
          setArtifactPanel(null);
          setSourcePanel(null);
          setWorkPanel(null);
          if (!(workspaceView === "library" && (filePanel?.fileId || artifactPanel?.versionId))) {
            setWorkspaceView("chat");
          }
        });
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener(MOBILE_BACK_EVENT, handleBack, { capture: true });
    return () => window.removeEventListener(MOBILE_BACK_EVENT, handleBack, { capture: true });
  }, [
    accountSettingsOpen,
    artifactPanel,
    composerMenu,
    filePanel,
    projectNavigation.request,
    projectSettings.open,
    projectSettings.owner,
    user.id,
    sourcePanel,
    workPanel,
    workspaceView,
  ]);
  function navigateConversation(id?: string, messageId?: string) {
    projectNavigation.request(() => {
      clearResources();
      setCustomize((value) => ({ ...value, open: false }));
      if (id !== undefined) {
        if (messageId) {
          pendingQueue.pause();
          selectConversationView(id);
        } else void openConversation(id);
      } else {
        void savedDraftSyncRef.current?.resetBlank();
        selectConversationView("", false, emptyCloudChatDraft(), true);
        composerRef.current?.focus();
      }
      setHistorySelection(
        id && messageId ? { conversationId: id, messageId, token: createUuid() } : null,
      );
      if (sidebar.isMobile) setSidebarOpen(false);
    });
  }
  useEffect(() => {
    if (!workbenchActive || embeddedTask) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        accountInvalidatedRef.current ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey
      )
        return;
      if (event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        navigateConversationRef.current();
      } else if (!event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setConversationSearchRequest((current) => current + 1);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [embeddedTask, workbenchActive]);
  function openResource(
    resource: "files" | "artifacts" | "sources" | "projects" | "memory",
    page = false,
    projectId?: string,
    fileId?: string,
    pinSidebar = false,
  ) {
    if (resource === "projects") {
      openProject(projectId);
      return;
    }
    projectNavigation.request(() => {
      if (page) {
        leaveTaskConversation();
        setScheduleRoute(undefined);
        setCustomize((value) => ({ ...value, open: false }));
      }
      setAccountSettingsOpen(false);
      sidebarPreview.dismiss();
      if (pinSidebar) sidebar.setOpen(true);
      setFilePanel(resource === "files" ? { fileId } : null);
      setArtifactPanel(resource === "artifacts" ? {} : null);
      setSourcePanel(resource === "sources" ? {} : null);
      setWorkPanel(resource === "memory" ? resource : null);
      setWorkspaceView(page ? "library" : "chat");
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
  function openProject(id?: string) {
    projectNavigation.request(() => {
      sidebarPreview.dismiss();
      setProjectSettings({ owner: user.id, id: id || undefined, open: true });
      if (sidebar.isMobile) setSidebarOpen(false);
    });
  }
  function newProjectConversation(project: CloudProject) {
    projectNavigation.request(() => {
      clearResources();
      setCustomize((value) => ({ ...value, open: false }));
      const draft = { ...emptyCloudChatDraft(), projectId: project.id };
      void savedDraftSyncRef.current?.resetBlank({ version: 1, draft });
      selectConversationView("", false, draft, true);
      composerRef.current?.focus();
      if (sidebar.isMobile) setSidebarOpen(false);
    });
  }
  function navigateSpace(location: CloudSpaceLocation) {
    projectNavigation.request(() => {
      setSpaceVisited(true);
      leaveTaskConversation();
      clearResources();
      setCustomize((value) => ({ ...value, open: false }));
      setSpaceLocation(location);
      setWorkspaceView("library");
      if (sidebar.isMobile) setSidebarOpen(false);
    });
  }
  function openSpaceItem(item: CloudSpaceItem, siteAction?: "share" | "settings") {
    if (item.kind === "folder") {
      navigateSpace({ ...CLOUD_SPACE_HOME, folder: item.id });
      return;
    }
    projectNavigation.request(() => {
      if (scheduleRoute || customizeOpen) {
        leaveTaskConversation();
        clearResources();
        setCustomize((value) => ({ ...value, open: false }));
      }
      setSpaceWork(false);
      setSpaceVisited(true);
      setFilePanel(item.kind === "file" ? { fileId: item.target_id } : null);
      setArtifactPanel(
        item.kind === "artifact"
          ? {
              versionId: item.site_version_id ?? item.target_id,
              site: Boolean(item.site_version_id),
              item,
              siteAction,
            }
          : null,
      );
      setSourcePanel(null);
      setWorkPanel(null);
      setWorkspaceView("library");
      sidebarPreview.dismiss();
      if (sidebar.isMobile) setSidebarOpen(false);
    });
  }
  async function referenceSpaceItems(
    items: readonly Pick<CloudSpaceItem, "kind" | "id" | "target_id" | "site_version_id">[],
  ) {
    if (
      composerLocked ||
      pendingQueue.busy ||
      pendingQueue.loading ||
      pendingQueue.unknown ||
      modelPreparationAbortRef.current
    )
      throw new Error("请等待当前操作完成后再引用资料。");
    if (resourceDropRef.current) throw new Error("正在核对资料，请稍候。");
    const token = Symbol("resource reference");
    resourceDropRef.current = token;
    setResolvingResources(true);
    const view = viewRef.current,
      guard = captureWorkGuard();
    try {
      const files: CloudChatFile[] = [],
        versions: CloudChatArtifactVersion[] = [];
      for (const item of items) {
        guard();
        if (item.kind === "file") {
          const file = await filesClient.get(item.target_id);
          guard();
          if (file.id !== item.id) throw new Error("资料身份已变化，请刷新后再引用。");
          if (!cloudFileCanReference(file))
            throw new Error(`${file.name}暂不能引用，请打开预览查看处理状态。`);
          if (!files.some((old) => old.id === file.id)) files.push(file);
        } else if (item.kind === "artifact") {
          const version = await artifactsClient.get(item.site_version_id ?? item.target_id);
          guard();
          if (version.family_id !== item.id) throw new Error("成果身份已变化，请刷新后再引用。");
          if (version.state !== "ready") throw new Error(`${version.name}尚未保存完成。`);
          if (!versions.some((old) => old.id === version.id)) versions.push(version);
        }
      }
      guard();
      if (!isCurrentView(view)) return;
      if (
        composerLocked ||
        pendingQueue.busy ||
        pendingQueue.unknown ||
        modelPreparationAbortRef.current ||
        uploadBatchRef.current ||
        pendingSubmissionRef.current
      )
        throw new Error("请等待当前操作完成后再引用资料。");
      const current = draftResourcesRef.current;
      const newFiles = files.filter((file) => !current.files.some((old) => old.id === file.id)),
        newVersions = versions.filter(
          (version) => !current.artifacts.some((old) => old.id === version.id),
        );
      if (
        current.files.length + current.artifacts.length + newFiles.length + newVersions.length >
        8
      )
        throw new Error("每条消息最多引用 8 个文件或成果。");
      setAttachments((old) => [...old, ...newFiles]);
      setArtifactAttachments((old) => [...old, ...newVersions]);
      setError("");
      clearResources();
      requestAnimationFrame(() => composerRef.current?.focus());
    } finally {
      if (resourceDropRef.current === token) {
        resourceDropRef.current = null;
        if (isCurrentView(view)) setResolvingResources(false);
      }
    }
  }
  function openTaskWorkspace(
    next: Extract<CloudChatRoute, { page: "tasks" }>,
    options: { mobile?: boolean; pin?: boolean } = {},
  ) {
    projectNavigation.request(() => {
      if (desktopCloudHost?.onOpenScheduledTasks) {
        desktopCloudHost.onOpenScheduledTasks();
        return;
      }
      if (!scheduleRoute) {
        clearResources();
        taskReturnConversation.current = viewRef.current.conversationId;
        setCustomize((value) => ({ ...value, open: false }));
      }
      sidebarPreview.dismiss();
      setScheduleRoute(next);
      if (options.mobile) setSidebarOpen(false);
      if (options.pin) sidebar.setOpen(true);
    });
  }
  function pinSidebarPreview() {
    if (shownSidebarDestination === sidebarDestination) {
      sidebarPreview.dismiss();
      sidebar.setOpen(true);
      return;
    }
    if (shownSidebarDestination === "cron-hub") {
      openTaskWorkspace(scheduleRoute ?? taskPreviewRoute, { pin: true });
      return;
    }
    if (shownSidebarDestination === "customize") {
      requestCustomize(undefined, false, undefined, true);
      return;
    }
    if (shownSidebarDestination === "library") {
      openResource("files", true, undefined, undefined, true);
      return;
    }
    projectNavigation.request(() => {
      leaveTaskConversation();
      clearResources();
      setCustomize((value) => ({ ...value, open: false }));
      if (shownSidebarDestination === "devices") {
        setSettingsSection("devices");
        setAccountSettingsOpen(true);
      }
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
  function openCustomize() {
    requestCustomize();
  }
  function openExtensionDetails(pkg: ExtensionPackage) {
    requestCustomize(pkg.id);
  }
  function openExtensionMention(reference: string) {
    const target = resolveExtensionMention(reference);
    if (target) requestCustomize(target.packageId, false, target.skillName);
  }
  function requestCustomize(packageId?: string, draft = false, skillName?: string, pin = false) {
    projectNavigation.request(() => {
      leaveTaskConversation();
      setScheduleRoute(undefined);
      sidebarPreview.dismiss();
      setComposerMenu(null);
      setAccountSettingsOpen(false);
      setCustomize({ owner: user.id, open: true, visited: true });
      if (pin) sidebar.setOpen(true);
      if (packageId) {
        const pkg = extensionCatalog?.packages.find((item) => item.id === packageId);
        const reader =
          !draft && (pkg?.kind === "skill" || skillName)
            ? { id: packageId, skillName, returnToChat: true }
            : undefined;
        setExtensionLocation({
          route: draft
            ? { page: "editor", draftId: packageId }
            : pkg?.kind === "skill"
              ? { page: "skills" }
              : { page: "plugin", id: packageId },
          reader,
        });
      }
      if (sidebar.isMobile) setSidebarOpen(false);
    });
  }
  function tryExtension(pkg: ExtensionPackage, skill: ExtensionSkill, text?: string) {
    const view = viewRef.current;
    if (!isCurrentView(view) || pendingSubmissionRef.current || composerLocked) return;
    const mention = cloudPackageSkill(pkg, skill.name, settings.locale);
    if (!mention) {
      setError("这个技能尚未启用，请在自定义中启用后使用。");
      return;
    }
    setCustomize((value) => ({ ...value, open: false }));
    setAccountSettingsOpen(false);
    closeResources();
    if (landing) setPresentation("work");
    requestAnimationFrame(() => {
      if (!isCurrentView(view)) return;
      if (text) fillStarter(text);
      const exists = composerRef.current
        ?.getDraft()
        .skillMentions.some(
          (selected) => parseExtensionReference(selected.skillFile)?.packageId === pkg.id,
        );
      if (!exists) composerRef.current?.insertSkillMention(mention);
      savedDraft.scheduleCapture();
      composerRef.current?.focus();
    });
  }
  function tryBuiltinExtension(id: string, text: string) {
    const pkg = extensionCatalog?.packages.find((item) => item.id === id);
    if (!pkg) {
      openCustomize();
      return;
    }
    tryExtension(
      pkg,
      pkg.skills[0],
      pkg.native || pkg.publisher === "OpenAI" ? pkg.examples?.[0] : text,
    );
  }
  function fillStarter(text: string) {
    if (!isCurrentView(viewRef.current) || pendingSubmissionRef.current || composerLocked) return;
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
    savedDraft.scheduleCapture();
    composerRef.current?.focus();
  }
  async function editGeneratedImage(item: AssistantDeliverable) {
    const view = viewRef.current,
      guard = captureWorkGuard();
    if (composerLocked || uploadingFiles || resolvingResources) return;
    try {
      const version = await artifactsClient.get(item.id);
      guard();
      if (!isCurrentView(view) || version.state !== "ready") return;
      const draft = captureComposerDraft();
      if (!draft.artifacts.some((artifact) => artifact.id === version.id))
        draft.artifacts.push(version);
      if (draft.artifacts.length + draft.files.length > 8) {
        setContextNotice("本条消息已有 8 项资料，请先移除一项。 ");
        return;
      }
      restoreComposerDraft(draft, view);
      fillStarter("使用生成图像修改这张图片：");
      savedDraft.scheduleCapture();
      composerRef.current?.focus();
    } catch (cause) {
      if (isCurrentView(view))
        setContextNotice(cause instanceof Error ? cause.message : "图片暂不可用，请重新打开。");
    }
  }
  async function requestDocumentRevision(
    resource: CloudChatFile | CloudChatArtifactVersion,
    comments: readonly DocumentRevisionComment[],
  ) {
    if (
      !comments.length ||
      comments.length > 20 ||
      composerLocked ||
      uploadingFiles ||
      resolvingResources ||
      submissionUnconfirmed ||
      branchBusy ||
      branchUnconfirmed ||
      historySelection ||
      pendingQueue.busy ||
      pendingQueue.unknown ||
      !isCurrentView(viewRef.current)
    )
      return false;
    const view = viewRef.current,
      guard = captureWorkGuard();
    const artifact = "family_id" in resource;
    const latest = artifact
      ? await artifactsClient.get(resource.id)
      : await filesClient.get(resource.id);
    guard();
    if (
      !isCurrentView(view) ||
      (artifact ? latest.state !== "ready" : !cloudFileCanReference(latest as CloudChatFile))
    )
      return false;
    const text =
      artifact && comments.every((comment) => comment.block.startsWith("site:"))
        ? siteRevisionText(resource.name, comments)
        : documentRevisionText(resource.name, comments);
    const original = captureComposerDraft();
    if (!original.composer?.text.includes(text)) fillStarter(text);
    const next = captureComposerDraft();
    if (artifact) {
      if (!next.artifacts.some((item) => item.id === resource.id))
        next.artifacts.push(latest as CloudChatArtifactVersion);
    } else if (!next.files.some((item) => item.id === resource.id))
      next.files.push(latest as CloudChatFile);
    if (next.files.length + next.artifacts.length > 8) {
      restoreComposerDraft(original, view);
      throw new Error("本条消息已有 8 项资料，请先移除一项后再发送批注。");
    }
    restoreComposerDraft(next, view);
    savedDraft.scheduleCapture();
    const accepted = await send(next);
    return accepted === true;
  }
  function openComposerPicker(kind: CloudComposerPicker, anchor: HTMLElement | null) {
    if (composerLocked || (kind === "projects" && streaming)) return;
    setComposerMenuAnchor(anchor);
    setComposerMenu((old) => (old === kind ? null : kind));
  }
  function attachLibraryFile(file: CloudChatFile) {
    if (
      !isCurrentView(viewRef.current) ||
      resourceDropRef.current ||
      composerLocked ||
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
    if (!conversationId) {
      draftProjectIdRef.current = project?.id;
      setComposerProject({ scope: `${user.id}:`, project });
      savedDraft.scheduleCapture();
      setContextNotice(project ? `已选择项目：${project.name}` : "已移出项目。");
      return;
    }
    projectContextMutation.current = true;
    setProjectContextBusy(true);
    let actionView = viewRef.current;
    try {
      const id = conversationId || (await createConversation());
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
      draftProjectIdRef.current = undefined;
      setNavigationRevision((old) => old + 1);
      if (project) setConversations((current) => current.filter((item) => item.id !== id));
      void refreshConversations(true).catch(() => undefined);
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
              className="app-status-action"
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
    uploadingFiles && "正在保存并校验附件…",
    resolvingResources && "正在核对资料…",
  ]
    .filter(Boolean)
    .join(" · ");
  const modelTypeNotice =
    webSettingsLoaded && !modelsLoading && (modelTypeMismatch || modelOptions.length === 0)
      ? modelOptions.length > 0
        ? settings.locale === "en-US"
          ? "Choose a text model to continue. Your draft is kept."
          : "当前模型不支持文本对话，请选择文本模型。草稿会保留。"
        : settings.locale === "en-US"
          ? "No text models available. You can keep drafting."
          : "暂无可用的文本模型，仍可编辑草稿。"
      : "";
  const composerFeedback =
    modelTypeNotice ||
    error ||
    historyError ||
    streamNotice ||
    preparationNotice ||
    contextNotice ||
    submissionUnconfirmed ||
    submissionQueueFull ||
    branchUnconfirmed ||
    pendingQueue.error ||
    pendingQueue.unknown ||
    pendingQueue.editingItem ||
    ["error", "unknown", "conflict"].includes(savedDraft.state.status) ||
    uploadUnconfirmed ? (
      <div className="app-status-stack" data-cloud-composer-feedback="">
        {modelTypeNotice ? <CloudChatFeedback tone="warning" compact message={modelTypeNotice} /> : null}
        {["error", "unknown", "conflict"].includes(savedDraft.state.status) ? (
          <CloudChatFeedback
            tone="warning"
            compact
            message={
              savedDraft.state.status === "conflict"
                ? "草稿在其他页面有更新"
                : savedDraft.state.error || "草稿尚未保存到云端，当前输入已保留。"
            }
            description={savedDraft.state.status === "conflict" ? "当前输入已保留。" : undefined}
            actions={
              <button
                type="button"
                className="app-status-action"
                onClick={() => {
                  if (savedDraft.state.status === "conflict") {
                    setDraftConflictLocal(captureSavedSnapshot(conversationId || "blank"));
                    setDraftConflictOpen(true);
                  } else void savedDraft.retry();
                }}
              >
                {savedDraft.state.status === "conflict"
                  ? "比较草稿"
                  : savedDraft.state.status === "unknown"
                    ? "核对保存结果"
                    : "重试保存"}
              </button>
            }
          />
        ) : null}
        {pendingQueue.error || pendingQueue.unknown ? (
          <CloudChatFeedback
            tone={pendingQueue.unknown ? "warning" : "error"}
            message={pendingQueue.error || "队列更新结果待确认，输入已保留。"}
            actions={
              <button
                type="button"
                className="app-status-action"
                disabled={pendingQueue.busy || pendingQueue.loading}
                onClick={() =>
                  void (pendingQueue.unknown ? reconcileQueuedWrite() : pendingQueue.refresh())
                }
              >
                {pendingQueue.busy || pendingQueue.loading
                  ? "正在读取…"
                  : pendingQueue.unknown
                    ? "核对原请求"
                    : "刷新待发送列表"}
              </button>
            }
          />
        ) : null}
        {pendingQueue.editingItem ? (
          <CloudChatFeedback
            compact
            message={`正在修改待发送消息 · ${pendingQueue.editingItem.model}`}
            actions={
              <>
                <button
                  type="button"
                  className="app-status-action"
                  disabled={pendingQueue.busy || Boolean(pendingQueue.unknown)}
                  onClick={() => void send()}
                >
                  保存修改
                </button>
                <button
                  type="button"
                  className="app-status-action"
                  disabled={pendingQueue.busy || Boolean(pendingQueue.unknown)}
                  onClick={() => void pendingQueue.cancelEdit()}
                >
                  取消修改
                </button>
              </>
            }
          />
        ) : null}
        {error ? <CloudChatFeedback tone="error" message={error} /> : null}
        {uploadUnconfirmed ? (
          <CloudChatFeedback
            tone="warning"
            message="上传结果尚未确认，继续添加前请核对文件库。"
            actions={
              <button
                type="button"
                className="app-status-action"
                disabled={checkingUploads}
                onClick={() => void reconcileUploads()}
              >
                {checkingUploads ? "正在核对…" : "刷新文件库核对"}
              </button>
            }
          />
        ) : null}
        {historyError && historyError !== error ? (
          <CloudChatFeedback
            tone="error"
            message={historyError}
            actions={
              <button
                type="button"
                className="app-status-action"
                disabled={historyLoading || historyPageLoading}
                onClick={() => {
                  if (historyRetryKind === "restore") {
                    setError("");
                    setHistoryReloadRevision((current) => current + 1);
                  } else if (historyRetryKind === "later") void loadLaterHistory();
                  else void loadEarlierHistory();
                }}
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
                className="app-status-action"
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
                  className="app-status-action"
                  disabled={streaming}
                  onClick={() => void send()}
                >
                  重试提交
                </button>
                <button
                  type="button"
                  className="app-status-action"
                  disabled={streaming}
                  onClick={() => {
                    pendingSubmissionRef.current = null;
                    retainedSubmissionsRef.current.delete(viewRef.current.conversationId);
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
                className="app-status-action"
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
      onOpenAccount={() => openComposerSettings("account")}
      onOpenSettings={() => openComposerSettings("system")}
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
          <BrandMark />
        )
      }
      activeId={
        customizeOpen
          ? "customize"
          : accountSettingsOpen
            ? "settings"
            : scheduleRoute
              ? "cron-hub"
              : workspaceView
      }
      items={[
        createWorkbenchNavigationItem("chat", "对话", () => {
          setCustomize((value) => ({ ...value, open: false }));
          closeResources();
        }),
        createWorkbenchNavigationItem("library", "资料空间", () => {
          setCustomize((value) => ({ ...value, open: false }));
          openResource("files", true);
        }),
        {
          id: "customize",
          label: "自定义",
          icon: <Blend className="size-5" />,
          onSelect: openCustomize,
        },
        createWorkbenchNavigationItem(
          "cron-hub",
          settings.locale === "zh-CN" ? "定时任务" : "Scheduled tasks",
          () => openTaskWorkspace({ page: "tasks" }, { mobile }),
        ),
        createWorkbenchNavigationItem("devices", "设备", () => {
          if (mobile) setSidebarOpen(false);
          setCustomize((value) => ({ ...value, open: false }));
          leaveTaskConversation();
          setScheduleRoute(undefined);
          setSettingsSection("devices");
          setAccountSettingsOpen(true);
        }),
      ]}
      footer={
        <>
          <MobileSidebarUpdate />
          {!sidebar.isMobile || workspaceView !== "library" || sidebarOpen ? accountMenu : null}
        </>
      }
    />
  );

  const taskConversationVisible =
    !!scheduleRoute &&
    !accountSettingsOpen &&
    !customizeOpen &&
    taskConversationMount?.element.dataset.conversationId === conversationId;
  const scheduledConversation = taskConversationVisible || embeddedTask;
  const taskChromeTarget = embeddedTask
    ? embeddedTaskConversation?.onChromeTarget
    : taskConversationVisible
      ? taskConversationMount?.onChromeTarget
      : undefined;
  const contextSidebar = !embeddedTask && contextDestination && (
    <div
      hidden={!embeddedAccount && workingInSpace && !sidebarPreview.open}
      data-workbench-account-navigation={embeddedAccount || undefined}
      data-space-working={(workingInSpace && !sidebarPreview.open) || undefined}
      data-sidebar-preview-region
      data-sidebar-context={contextDestination}
      className={embeddedAccount ? "cloud-chat-shell" : "relative h-full shrink-0"}
    >
      {!sidebar.isMobile || contextDestination === "chat" ? (
        <div
          className={contextDestination === "chat" ? "contents" : "hidden"}
          aria-hidden={contextDestination !== "chat"}
          inert={contextDestination !== "chat"}
        >
          <ChatHistorySidebar
            mobileRail={sidebar.isMobile ? renderApplicationRail(true) : undefined}
            newConversationIcon={<SquarePen className="size-4 shrink-0" />}
            onPinPreview={desktopAccountLayout?.onPinSidebar ?? pinSidebarPreview}
            previewOpen={
              (desktopAccountLayout?.sidebarPreview ?? sidebarPreview.open) &&
              contextDestination === "chat"
            }
            brand={
              <div className="cloud-sidebar-brand">
                <GatewayBrand />
              </div>
            }
            navigationContent={({ renderConversation }) => (
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
                {!accountInvalidatedRef.current ? (
                  <CloudChatProjectNavigation
                    key={user.id}
                    client={projectsClient}
                    captureGuard={captureAccountRequestGuard}
                    revision={navigationRevision}
                    onOpen={openProject}
                    onCreate={() => setProjectCreate({ owner: user.id, open: true })}
                    renderConversation={renderConversation}
                    onVisibleConversationsChange={registerProjectRows}
                    onNewConversation={newProjectConversation}
                    currentConversationId={workspaceView === "chat" ? conversationId : ""}
                    activeProjectId={
                      composerProject.scope === `${user.id}:${conversationId}`
                        ? composerProject.project?.id
                        : undefined
                    }
                    isOpen={contextDestination === "chat" && (sidebarOpen || sidebarPreview.open)}
                  />
                ) : null}
              </>
            )}
            onOpenResourceHub={() => showFileResource({})}
            navigationItems={accountInvalidatedRef.current ? undefined : projectSidebarItems}
            renderConversationMoveMenu={renderConversationMoveMenu}
            items={sidebarItems}
            currentConversationId={workspaceView === "chat" ? conversationId : ""}
            busyConversationIds={conversationMutations}
            conversationSearchAdapter={conversationSearchAdapter}
            conversationSearchRequestKey={conversationSearchRequest}
            runningConversationIds={runningConversationIds}
            listStatus={conversationsLoading ? "loading" : "ready"}
            scopeKey={`${user.id}:web-chat`}
            totalItems={sidebarItems.length}
            hasMore={conversationsHasMore}
            isLoadingMore={conversationsLoadingMore}
            loadMoreMode="scroll"
            errorMessage={conversationsError || null}
            actionErrorMessage={error || null}
            renamingId={renamingId}
            renameDraft={renameDraft}
            isOpen={contextDestination === "chat" && (sidebarOpen || sidebarPreview.open)}
            fontScale={settings.customSettings.fontScale.sidebar}
            activeView="chat"
            showProjects={false}
            recentCollapsed={recentSection.owner === user.id && recentSection.collapsed}
            onRecentCollapsedChange={(collapsed) => setRecentSection({ owner: user.id, collapsed })}
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
            onSetPinned={(id, pinned) => void manageConversation(id, { pinned })}
            onSetArchived={(id, archived) => void manageConversation(id, { archived })}
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
      {contextDestination !== "chat" ? (
        <CloudContextSidebar
          mobileRail={sidebar.isMobile ? renderApplicationRail(true) : undefined}
          key={`${user.id}:${contextDestination}`}
          destination={contextDestination}
          preview={desktopAccountLayout?.sidebarPreview ?? sidebarPreview.open}
          reportLoadErrors={!embeddedAccount}
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
          onSpaceNewFolder={() => {
            navigateSpace(spaceLocation);
            setSpaceFolderRequest((old) => old + 1);
          }}
          spaceRevision={spaceRevision}
          onSpaceNavigate={navigateSpace}
          onSpaceOpen={openSpaceItem}
          onSpaceStorage={() =>
            projectNavigation.request(() => {
              leaveTaskConversation();
              clearResources();
              setCustomize((value) => ({ ...value, open: false }));
              setSpaceVisited(true);
              setWorkspaceView("library");
              setSpaceStorageOpen(true);
              if (sidebar.isMobile) setSidebarOpen(false);
            })
          }
          environments={environments}
          onOpenResource={(resource) => openResource(resource, true)}
          onOpenFile={(id) => openResource("files", true, undefined, id)}
          onOpenDevices={() =>
            projectNavigation.request(() => {
              leaveTaskConversation();
              clearResources();
              setCustomize((value) => ({ ...value, open: false }));
              setSettingsSection("devices");
              setAccountSettingsOpen(true);
            })
          }
          onPin={desktopAccountLayout?.onPinSidebar ?? pinSidebarPreview}
        />
      ) : null}
    </div>
  );
  const standaloneWorkspace = !!scheduleRoute || customizeOpen;
  const showTaskWorkspace = (!!scheduleRoute || previewTasks) && !accountSettingsOpen;
  return (
    <AppErrorBoundary>
      <CloudDraftConflictDialog
        open={
          draftConflictOpen &&
          !accountInvalidatedRef.current &&
          savedDraft.state.status === "conflict"
        }
        local={draftConflictLocal}
        server={savedDraft.state.conflict?.server?.draft ?? null}
        onClose={() => setDraftConflictOpen(false)}
        onChoose={(choice) => {
          void savedDraft.resolveConflict(choice).then(() => setDraftConflictOpen(false));
        }}
      />
      <FileDropBoundary
        className={`${embeddedWorkbench ? "gateway-shell relative flex size-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background text-foreground" : GATEWAY_SHELL_CLASS} cloud-chat-shell`}
        data-embedded-task={embeddedTask || undefined}
        data-embedded-account={embeddedAccount || undefined}
        data-workspace-view={workspaceView}
        coverage={embeddedWorkbench || scheduleRoute ? "local" : "viewport"}
        active={
          workbenchActive &&
          chatWorkspaceVisible &&
          (!scheduleRoute || taskConversationVisible) &&
          !accountSettingsOpen &&
          !customizeOpen &&
          !draftConflictOpen &&
          !projectSettings.open &&
          !projectCreate.open &&
          !researchConfirmation &&
          !messageReader
        }
        resetKey={`${user.id}:${conversationId}`}
        fileLabel="添加文件到对话"
        resourceLabel="引用资料到对话"
        hint="将文件拖放到此处 · 最多 8 个文件，单个不超过 32 MB"
        resourceMime={CLOUD_RESOURCE_DRAG_MIME}
        disabledReason={cloudAttachmentBlockedReason()}
        resourceDisabledReason={cloudAttachmentBlockedReason(true)}
        onFiles={(files, directories) => void attachFileList(files, directories)}
        onResources={(transfer) => void dropCloudResources(transfer)}
        onRejected={setError}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={CLOUD_FILE_ACCEPT}
          className="gateway-hidden-file-input hidden"
          aria-label="选择附件"
          onChange={(event) => void attachFiles(event)}
        />
        <WorkbenchShell
          ref={sidebarPreview.rootRef}
          layout={embeddedWorkbench ? "stacked-panels" : "page"}
          className="gateway-editor-host flex-1"
        >
          {!embeddedWorkbench && !sidebar.isMobile ? renderApplicationRail() : null}
          {!embeddedWorkbench && standaloneWorkspace && !sidebar.isMobile && !sidebar.open ? (
            <div data-sidebar-hover-edge="" aria-hidden="true" />
          ) : null}
          {standaloneWorkspace && sidebarPreview.open && contextDestination ? (
            <WorkbenchCanvas mode="sidebar-preview">{contextSidebar}</WorkbenchCanvas>
          ) : null}
          <WorkbenchCanvas
            mode={embeddedWorkbench ? "embedded" : "page"}
            data-cloud-conversation-workspace
            aria-hidden={accountSettingsOpen || customizeOpen || !!scheduleRoute}
            inert={accountSettingsOpen || customizeOpen || !!scheduleRoute}
            className={
              accountSettingsOpen || customizeOpen || scheduleRoute
                ? "hidden"
                : "relative flex min-h-0 min-w-0 flex-1"
            }
          >
            {!embeddedWorkbench && !sidebar.isMobile && !sidebar.open ? (
              <div data-cloud-sidebar-hover-edge aria-hidden="true" />
            ) : null}
            {!embeddedWorkbench && (
              <button
                type="button"
                className="gateway-sidebar-backdrop"
                data-state={sidebarOpen ? "open" : "closed"}
                aria-label="关闭侧栏"
                aria-hidden={!sidebarOpen}
                tabIndex={sidebarOpen ? 0 : -1}
                onClick={() => setSidebarOpen(false)}
              />
            )}
            {!standaloneWorkspace &&
              (embeddedAccount
                ? workbenchActive &&
                  desktopAccountLayout?.sidebarTarget &&
                  createPortal(contextSidebar, desktopAccountLayout.sidebarTarget)
                : contextSidebar)}
            <CloudConversationMain
              mount={taskConversationVisible ? (taskConversationMount?.element ?? null) : null}
              className={`${GATEWAY_MAIN_SHELL_CLASS} gateway-cloud-main`}
              data-scheduled-conversation={scheduledConversation || undefined}
              data-resource-panel-open={
                workspaceView === "chat" && Boolean(sourcePanel || workPanel)
              }
            >
              <div className={GATEWAY_MAIN_BACKDROP_CLASS} />
              <CloudChatResourceWorkbench
                headerInFlow={scheduledConversation}
                header={
                  scheduledConversation ? (
                    taskChromeTarget && (
                      <div
                        ref={taskChromeTarget}
                        className="relative z-20"
                        data-task-result-chrome=""
                      />
                    )
                  ) : workingInSpace ? (
                    <div className="cloud-space-work-header">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSpaceWork(false);
                          setFilePanel(null);
                          setArtifactPanel(null);
                        }}
                      >
                        <ArrowLeft className="size-4" />
                        返回资料
                      </Button>
                      <span>{currentConversation?.title || "与 AI 一起工作"}</span>
                    </div>
                  ) : embeddedAccount && workspaceView === "library" ? undefined : workspaceView ===
                      "library" && sidebar.isMobile ? (
                    <header className="cloud-space-mobile-header">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="打开边栏"
                        title="打开边栏"
                        onClick={() => setSidebarOpen(true)}
                      >
                        <PanelLeft className="size-5" />
                      </Button>
                      <h1>资料空间</h1>
                      <div>{!sidebarOpen ? accountMenu : null}</div>
                    </header>
                  ) : (
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
                            tooltipShortcut="Ctrl+Shift+O"
                            onClick={() => navigateConversation()}
                            className="cloud-header-new-chat rounded-lg"
                          >
                            <SquarePen className="size-4.5" />
                          </Button>
                        ) : undefined
                      }
                      leadingActions={
                        <>
                          {sidebar.isMobile &&
                          workspaceView === "chat" &&
                          !canSwitchPresentation ? (
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
                              title={currentConversation?.title || "新对话"}
                              renameRequest={headerRenameRequest}
                              onRename={(title) => saveConversationTitle(conversationId, title)}
                            />
                          ) : (
                            <span
                              className={`min-w-0 truncate text-sm font-medium ${landing && workspaceView === "chat" ? "cloud-header-title-landing" : ""}`}
                            >
                              {workspaceView === "library"
                                ? "资料空间"
                                : currentConversation?.title || "新对话"}
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
                        desktopCloudHost ? (
                          <span ref={desktopCloudHost.onHeaderTarget} />
                        ) : workspaceView === "chat" ? (
                          <>
                            {conversationId ? (
                              <CloudConversationBranches
                                key={`branches:${user.id}:${conversationId}`}
                                conversationId={conversationId}
                                client={conversationClient}
                                onNavigate={navigateConversation}
                              />
                            ) : null}
                            {conversationId ? (
                              <CloudChatHeaderActions
                                key={`actions:${user.id}:${conversationId}`}
                                title={currentConversation?.title || "新对话"}
                                pinned={!!currentConversation?.pinned}
                                archived={!!currentConversation?.archived}
                                disabled={
                                  !currentConversation || conversationMutations.has(conversationId)
                                }
                                deleteDisabled={streaming || historyLoading || branchBusy}
                                moveDisabled={composerLocked || streaming || projectContextBusy}
                                projectId={
                                  composerProject.scope === `${user.id}:${conversationId}`
                                    ? composerProject.project?.id
                                    : undefined
                                }
                                projectsClient={projectsClient}
                                captureGuard={captureWorkGuard}
                                onRename={() => setHeaderRenameRequest((request) => request + 1)}
                                onTogglePinned={() =>
                                  void manageConversation(conversationId, {
                                    pinned: !currentConversation?.pinned,
                                  })
                                }
                                onToggleArchived={() =>
                                  void manageConversation(conversationId, {
                                    archived: !currentConversation?.archived,
                                  })
                                }
                                onDelete={() => removeConversation(conversationId)}
                                onError={setError}
                                onMoveToProject={selectComposerProject}
                              />
                            ) : null}
                          </>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={closeResources}>
                            返回对话
                          </Button>
                        )
                      }
                      settings={settings}
                      sidebarOpen={sidebarOpen}
                      onOpenSettings={openComposerSettings}
                      onToggleTheme={() =>
                        setSettings((current) => ({
                          ...current,
                          theme: getNextTheme(current.theme),
                        }))
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
                  )
                }
                readingScope={`${user.id}:${accountInvalidatedRef.current ? "retired" : "current"}`}
                defaultSplitRatio={workingInSpace ? 0.34 : undefined}
                open={readerOpen}
                primaryVisible={
                  chatWorkspaceVisible ||
                  (workspaceView === "library" && !sourcePanel && !workPanel && !readerOpen)
                }
                primary={(readingOnly) => (
                  <>
                    <ApplicationView
                      activeView="chat"
                      settings={settings}
                      setSettings={setSettings}
                      isAgentMode={false}
                      className={chatWorkspaceVisible ? "contents" : "hidden"}
                      chat={{
                        containerRef: cloudChatFrameRef,
                        containerProps: {
                          className: `${GATEWAY_CHAT_FRAME_CLASS} zone-font-scale`,
                          style: {
                            "--zone-font-scale": settings.customSettings.fontScale.chat,
                          } as CSSProperties,
                        },
                        content: (
                          <>
                            <div
                              data-conversation-scope=""
                              onInputCapture={() => {
                                if (!pendingQueue.editingItem && !accountInvalidatedRef.current)
                                  savedDraft.scheduleCapture();
                              }}
                              className="gateway-transcript-stage cloud-conversation-layout relative min-h-0 flex-1 overflow-hidden @container"
                              data-layout={landing && !workingInSpace ? "landing" : "thread"}
                              data-presentation={presentation}
                            >
                              {landing && !workingInSpace ? (
                                <CloudChatEmptyState mode={presentation} />
                              ) : null}
                              <div className="gateway-transcript-scroll-shell relative h-full min-h-0">
                                <ScrollArea
                                  viewportRef={setTranscriptViewport}
                                  className={GATEWAY_TRANSCRIPT_SCROLL_CLASS}
                                >
                                  <CloudChatVisualProvider
                                    key={`visuals:${user.id}:${conversationId}`}
                                    client={artifactsClient}
                                    messages={messages}
                                    running={streaming}
                                    onConfigure={openModelPreferences}
                                    onEdit={(item) => void editGeneratedImage(item)}
                                  >
                                    <GatewayTranscript
                                      navRef={transcriptNavigation}
                                      onAnchorUserRowChange={(rowKey) => {
                                        const scope = `${user.id}:${conversationId}`;
                                        setFloorAnchor((previous) =>
                                          previous.scope === scope && previous.rowKey === rowKey
                                            ? previous
                                            : { scope, rowKey },
                                        );
                                      }}
                                      showUsage
                                      emptyState={
                                        workingInSpace ? (
                                          <div className="cloud-space-work-empty">
                                            <h2>这份资料，你想如何处理？</h2>
                                            <p>提出目标，在右侧对照原文继续工作。</p>
                                            <div>
                                              {[
                                                [
                                                  "总结要点",
                                                  "请总结这份资料的核心内容和关键结论。",
                                                ],
                                                [
                                                  "检查并完善",
                                                  "请检查这份资料，指出需要改进的地方，并给出具体建议。",
                                                ],
                                                [
                                                  "提取行动项",
                                                  "请根据这份资料提取行动项，列出待确认事项。",
                                                ],
                                              ].map(([label, prompt]) => (
                                                <Button
                                                  key={label}
                                                  variant="outline"
                                                  size="sm"
                                                  onClick={() => fillStarter(prompt)}
                                                >
                                                  {label}
                                                </Button>
                                              ))}
                                            </div>
                                          </div>
                                        ) : null
                                      }
                                      hasMoreHistory={historyHasMore}
                                      isLoadingMoreHistory={historyPageLoading}
                                      onLoadEarlierHistory={() => void loadEarlierHistory()}
                                      isViewportFollowing={transcriptFollow.isFollowing}
                                      viewportFollowing={followingTranscript}
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
                                      footer={
                                        <>
                                          {historySelection ? (
                                            <div
                                              className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
                                              role="status"
                                            >
                                              <span>正在查看历史消息附近</span>
                                              <div className="flex gap-1">
                                                {historyHasAfter ? (
                                                  <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    disabled={historyPageLoading}
                                                    onClick={() => void loadLaterHistory()}
                                                  >
                                                    {historyPageLoading ? "正在读取…" : "后续消息"}
                                                  </Button>
                                                ) : null}
                                                <Button
                                                  variant="ghost"
                                                  size="sm"
                                                  onClick={() => {
                                                    setHistorySelection(null);
                                                    transcriptFollow.stickToBottom();
                                                  }}
                                                >
                                                  返回最新消息
                                                </Button>
                                              </div>
                                            </div>
                                          ) : null}
                                          {terminalFeedback}
                                        </>
                                      }
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
                                        savedDraft.scheduleCapture();
                                        composerRef.current?.focus();
                                      }}
                                      onOpenFileLink={openCloudMessageLink}
                                      onResendFromEdit={
                                        branchBusy || branchUnconfirmed || streaming
                                          ? undefined
                                          : editAndResend
                                      }
                                      onBranchConversation={
                                        branchBusy || branchUnconfirmed || streaming
                                          ? undefined
                                          : (ref) => branchConversation(ref)
                                      }
                                      branchPendingMessageId={branchPendingMessageId}
                                    />
                                  </CloudChatVisualProvider>
                                </ScrollArea>
                                {conversationId && !readingOnly ? (
                                  <FloorNavRail
                                    key={`floors:${user.id}:${conversationId}`}
                                    conversationId={`cloud:${user.id}:${conversationId}`}
                                    floors={buildFloorEntries(transcriptRows)}
                                    activeRowKey={
                                      floorAnchor.scope === `${user.id}:${conversationId}`
                                        ? floorAnchor.rowKey
                                        : null
                                    }
                                    bottomOffset="calc(var(--gateway-chat-composer-overlay-height) + var(--gateway-chat-composer-bottom) + 8px)"
                                    scrollViewport={transcriptViewport}
                                    onJump={(rowKey) => {
                                      transcriptFollow.restoreFollowing(false);
                                      transcriptNavigation.current?.scrollToRowKey(rowKey);
                                    }}
                                  />
                                ) : null}
                                {!followingTranscript && messages.length > 0 ? (
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    title="回到最新消息"
                                    aria-label="回到最新消息"
                                    className="absolute bottom-4 left-1/2 z-10 size-9 -translate-x-1/2 rounded-full border-border/60 bg-background shadow-md transition-transform hover:scale-105 active:scale-95"
                                    style={{
                                      bottom:
                                        "calc(var(--gateway-chat-composer-overlay-height) + var(--gateway-chat-composer-bottom) + 12px)",
                                    }}
                                    onClick={() => {
                                      if (historySelection) {
                                        setHistorySelection(null);
                                        transcriptFollow.stickToBottom();
                                      } else transcriptFollow.jumpToBottom();
                                    }}
                                  >
                                    <ChevronDown className="size-4" />
                                  </Button>
                                ) : null}
                              </div>
                              <ChatComposerBar
                                overlayHeightOwnerRef={cloudChatFrameRef}
                                capabilities={CLOUD_COMPOSER_CAPABILITIES}
                                feedback={composerFeedback}
                                layout="inline"
                                expandedInput={presentation === "work"}
                                contextBarPosition={sidebar.isMobile ? "above" : "below"}
                                allowQueueWhileSending
                                submitLabel={
                                  pendingQueue.editingItem ? "保存待发送消息" : undefined
                                }
                                onPickWorkspaceFolder={() => undefined}
                                onRefreshModels={() => void refreshModels()}
                                modelsRefreshing={modelsLoading}
                                presentation="column"
                                conversationId={conversationId}
                                composerRef={composerRef}
                                isSending={streaming}
                                isUploadingFiles={uploadingFiles}
                                isSubmissionDisabled={modelTypeMismatch || modelOptions.length === 0}
                                isInputDisabled={
                                  projectContextBusy ||
                                  conversationMutations.get(conversationId) === "move" ||
                                  resolvingResources ||
                                  preparingExecution ||
                                  historyLoading ||
                                  historyRestoreFailed ||
                                  modelsLoading ||
                                  modelOptions.length === 0 ||
                                  submissionUnconfirmed ||
                                  submissionQueueFull ||
                                  branchBusy ||
                                  branchUnconfirmed ||
                                  Boolean(researchConfirmation) ||
                                  pendingQueue.busy ||
                                  pendingQueue.loading ||
                                  Boolean(pendingQueue.unknown)
                                }
                                allowUploadsWithoutWorkspace
                                inputPlaceholder={
                                  presentation === "work" ? "使用 ZeroAgent 工作" : "询问 ZeroAgent"
                                }
                                capabilityMenu={
                                  <CloudChatComposerMenu
                                    extensions={extensionCatalog?.packages ?? []}
                                    onTryExtension={tryExtension}
                                    onDataAnalysis={() =>
                                      fillStarter(
                                        "请帮我分析数据，先与我确认数据来源、分析目标和交付格式。",
                                      )
                                    }
                                    disabled={composerLocked}
                                    projectDisabled={streaming}
                                    open={composerMenu === "add"}
                                    onOpenChange={(open) =>
                                      setComposerMenu((old) =>
                                        open ? "add" : old === "add" ? null : old,
                                      )
                                    }
                                    researchEnabled={runtimeControls.nativeWebSearchEnabled}
                                    onUpload={() => fileRef.current?.click()}
                                    onCreateImage={() =>
                                      tryBuiltinExtension("imagegen", "创建图片：")
                                    }
                                    onCustomize={openCustomize}
                                    onProductDesign={() =>
                                      tryBuiltinExtension(
                                        "product-design",
                                        "帮我梳理用户任务与布局，探索视觉方案，再按选定方案实现。我的需求是：",
                                      )
                                    }
                                    onOpenFiles={(anchor) => openComposerPicker("files", anchor)}
                                    onOpenProjects={(anchor) =>
                                      openComposerPicker("projects", anchor)
                                    }
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
                                  scheduledConversation ? undefined : (
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
                                          disabled={composerLocked}
                                          projectDisabled={streaming}
                                          projectName={
                                            composerProject.scope === `${user.id}:${conversationId}`
                                              ? composerProject.project?.name
                                              : undefined
                                          }
                                          onOpen={openComposerPicker}
                                        />
                                      </div>
                                    </div>
                                  )
                                }
                                workdir=""
                                enabledSkills={enabledCloudSkills}
                                slashSkills={slashCloudSkills}
                                mentionExtensions={mentionCloudExtensions}
                                resolveExtensionMention={resolveExtensionMention}
                                onOpenExtensionMention={openExtensionMention}
                                mentionActions={[
                                  {
                                    id: "upload",
                                    name: "添加照片和文件",
                                    description: "从设备上传资料",
                                    icon: "upload",
                                    onSelect: () => fileRef.current?.click(),
                                  },
                                  {
                                    id: "library",
                                    name: "从资料库添加",
                                    description: "引用已保存的文件",
                                    icon: "library",
                                    onSelect: (anchor) => openComposerPicker("files", anchor),
                                  },
                                  {
                                    id: "project",
                                    name: "选择项目",
                                    description: "使用项目资料与指令",
                                    icon: "project",
                                    disabled: streaming,
                                    onSelect: (anchor) => openComposerPicker("projects", anchor),
                                  },
                                ]}
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
                                  const nextProviderKeyId = relayProviderKeyId(
                                    next.customProviderId,
                                  );
                                  setModel(next.model);
                                  setProviderKeyId(nextProviderKeyId);
                                  setSettings((current) => ({ ...current, selectedModel: next }));
                                  void saveWebSettings(
                                    next.model,
                                    reasoning,
                                    nextProviderKeyId,
                                  ).catch((cause) => setError(String(cause)));
                                }}
                                onSelectExecutionMode={() => undefined}
                                onOpenSettings={openComposerSettings}
                                onChatRuntimeControlsChange={(patch) => {
                                  const next = patchCloudChatRuntimeControls(
                                    runtimeControls,
                                    patch,
                                  );
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
                                    if (versionId) showArtifactResource({ versionId });
                                    else showFileResource({ fileId: path });
                                  });
                                }}
                                renderPendingUploadPreview={(file) => {
                                  const original = attachments.find(
                                    (item) => item.id === file.relativePath,
                                  );
                                  const artifact = artifactAttachments.find(
                                    (item) => `cloud-artifacts/${item.id}` === file.relativePath,
                                  );
                                  const target = original ?? artifact;
                                  if (
                                    !target ||
                                    (original &&
                                      (!original.uploaded_at ||
                                        ["deleting", "deleted"].includes(original.state)))
                                  )
                                    return null;
                                  const view = viewRef.current;
                                  return (
                                    <ResourceThumbnail
                                      key={`${user.id}:${target.id}:${target.sha256}`}
                                      resource={{
                                        ...target,
                                        identity: `thumbnail:${user.id}:${target.id}:${target.sha256}`,
                                      }}
                                      load={async (signal) => {
                                        const guard = captureAccountRequestGuard();
                                        const result = original
                                          ? await filesClient.download(original, signal)
                                          : artifact
                                            ? await artifactsClient.download(artifact, signal)
                                            : null;
                                        if (!result) throw new Error("资料已移除");
                                        const assertCurrent = () => {
                                          guard();
                                          result.guard();
                                          if (!isCurrentView(view))
                                            throw new DOMException("资料已关闭", "AbortError");
                                        };
                                        assertCurrent();
                                        return { blob: result.blob, assertCurrent };
                                      }}
                                    />
                                  );
                                }}
                                uploadingAttachments={
                                  uploadingAttachments?.view === viewRef.current
                                    ? uploadingAttachments.files.map((item) => ({
                                        id: item.id,
                                        fileName: item.file.name,
                                        sizeBytes: item.file.size,
                                      }))
                                    : undefined
                                }
                                onRemovePendingUpload={(id) => {
                                  const versionId = cloudArtifactVersionFromLink(id);
                                  if (versionId)
                                    setArtifactAttachments((current) =>
                                      current.filter((item) => item.id !== versionId),
                                    );
                                  else
                                    setAttachments((current) =>
                                      current.filter((item) => item.id !== id),
                                    );
                                }}
                                queuedTurns={pendingQueue.queuedPreviews}
                                queuePaused={
                                  pendingQueue.items.length > 0 ? pendingQueue.paused : undefined
                                }
                                queueControlPending={
                                  pendingQueue.busy ||
                                  pendingQueue.loading ||
                                  Boolean(pendingQueue.unknown)
                                }
                                queueRunDisabled={streaming || Boolean(historySelection)}
                                queueRunLabel="发送这条消息"
                                queueNotice="尚未发送。正常完成后依次发送；停止、失败或重新打开页面后需点击继续。"
                                onQueuePausedChange={(paused) => {
                                  if (paused) pendingQueue.pause();
                                  else void pendingQueue.resume();
                                }}
                                onRunQueuedTurnNow={(id) => void pendingQueue.runNow(id)}
                                onMoveQueuedTurnUp={(id) => void pendingQueue.moveUp(id)}
                                onEditQueuedTurn={(id) => void pendingQueue.beginEdit(id)}
                                onRemoveQueuedTurn={(id) => void pendingQueue.remove(id)}
                              />
                              {landing && !workingInSpace ? (
                                <CloudChatStarters mode={presentation} onSelect={fillStarter} />
                              ) : null}
                            </div>
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
                      disabled={composerLocked || (composerMenu === "projects" && streaming)}
                      researchEnabled={runtimeControls.nativeWebSearchEnabled}
                      onClose={() => setComposerMenu(null)}
                      onSelectProject={selectComposerProject}
                      onAttach={attachLibraryFile}
                      onBrowse={(kind) => openResource(kind, true)}
                      onCreateProject={() => setProjectCreate({ owner: user.id, open: true })}
                      onToggleResearch={() =>
                        setRuntimeControls((current) => ({
                          ...current,
                          nativeWebSearchEnabled: !current.nativeWebSearchEnabled,
                        }))
                      }
                      extensions={extensionCatalog?.packages ?? []}
                      selectedSkillFiles={
                        composerRef.current
                          ?.getDraft()
                          .skillMentions.map((skill) => skill.skillFile) ?? []
                      }
                      onRemoveSkill={(file) => {
                        if (composerLocked || !isCurrentView(viewRef.current)) return;
                        const draft = composerRef.current?.getDraft();
                        if (!draft) return;
                        composerRef.current?.setDraft({
                          ...draft,
                          segments: draft.segments.filter(
                            (segment) =>
                              segment.type !== "skillMention" || segment.skill.skillFile !== file,
                          ),
                        });
                        savedDraft.scheduleCapture();
                      }}
                      onTryExtension={tryExtension}
                      onViewExtension={openExtensionDetails}
                      onCustomize={openCustomize}
                      onFillDraft={fillStarter}
                      onFocusComposer={() => {
                        if (isCurrentView(viewRef.current)) composerRef.current?.focus();
                      }}
                    />
                    {spaceVisited &&
                    !accountInvalidatedRef.current &&
                    viewRef.current.userId === user.id ? (
                      <div
                        className={
                          workspaceView === "library" && !sourcePanel && !workPanel && !readerOpen
                            ? "contents"
                            : "hidden"
                        }
                        inert={
                          workspaceView !== "library" ||
                          Boolean(sourcePanel || workPanel) ||
                          readerOpen
                        }
                      >
                        <CloudSpacePage
                          key={user.id}
                          client={spaceClient}
                          files={filesClient}
                          artifacts={artifactsClient}
                          revision={spaceRevision}
                          newFolderRequest={spaceFolderRequest}
                          active={
                            workspaceView === "library" &&
                            !sourcePanel &&
                            !workPanel &&
                            !readerOpen &&
                            !readingOnly
                          }
                          storageOpen={spaceStorageOpen}
                          onStorageOpenChange={setSpaceStorageOpen}
                          location={spaceLocation}
                          onNavigate={navigateSpace}
                          onOpen={openSpaceItem}
                          onHandoff={(source) => setWorkspaceHandoff({ owner: user.id, source })}
                          onReference={referenceSpaceItems}
                          onCreateWork={(text) => {
                            if (composerLocked) return;
                            clearResources();
                            if (landing) setPresentation("work");
                            fillStarter(text);
                          }}
                          canReference={!composerLocked}
                          captureGuard={captureAccountRequestGuard}
                          onChanged={() => setSpaceRevision((old) => old + 1)}
                          onError={(cause) => {
                            if (
                              (cause instanceof CloudSpaceError ||
                                cause instanceof CloudChatFileError) &&
                              cause.status === 401
                            )
                              notifyRelaySessionExpired();
                          }}
                        />
                        {workspaceHandoff?.owner === user.id &&
                          workbenchActive &&
                          workspaceView === "library" && (
                            <WorkspaceHandoffDialog
                              key={workspaceHandoff.source.target_id}
                              owner={user.id}
                              source={workspaceHandoff.source}
                              targets={desktopCloudHost?.getHandoffEnvironments?.() ?? environments}
                              onClose={() => setWorkspaceHandoff(undefined)}
                              read={async (signal) => {
                                const source = workspaceHandoff.source;
                                if (source.kind === "file") {
                                  const file = await filesClient.get(source.target_id, signal);
                                  const result = await filesClient.download(file, signal);
                                  result.guard();
                                  return { blob: result.blob, filename: file.name };
                                }
                                const version = await artifactsClient.get(source.target_id, signal);
                                const result = await artifactsClient.download(version, signal);
                                result.guard();
                                return result;
                              }}
                              send={
                                desktopCloudHost?.sendWorkspaceHandoff ??
                                ((request) => sendBrowserWorkspaceHandoff(request, environments))
                              }
                            />
                          )}
                      </div>
                    ) : null}
                  </>
                )}
              >
                <CloudChatResourcePresentation.Provider
                  value={
                    filePanel || artifactPanel
                      ? "inline"
                      : workspaceView === "chat"
                        ? "panel"
                        : "page"
                  }
                >
                  <div
                    className={
                      filePanel ||
                      artifactPanel ||
                      workspaceView === "chat" ||
                      (workspaceView === "library" && !sourcePanel && !workPanel)
                        ? "contents"
                        : "cloud-workspace-content"
                    }
                  >
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
                              workFromSpace={workspaceView === "library"}
                              workActive={workingInSpace}
                              onRequestRevision={requestDocumentRevision}
                              onOpenInSpace={() => openResource("files", true)}
                              onOpenSourceConversation={navigateConversation}
                              conversationsClient={conversationClient}
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
                              attached={attachments.some((file) => file.id === filePanel.fileId)}
                              fromLine={filePanel.fromLine}
                              toLine={filePanel.toLine}
                              canAttach={
                                !preparingExecution &&
                                !uploadingFiles &&
                                !resolvingResources &&
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
                                if (
                                  !isCurrentView(view) ||
                                  modelPreparationAbortRef.current ||
                                  resourceDropRef.current
                                )
                                  return false;
                                if (
                                  !attachments.some((item) => item.id === file.id) &&
                                  attachments.length + artifactAttachments.length >= 8
                                ) {
                                  return false;
                                }
                                setAttachments((current) =>
                                  current.some((item) => item.id === file.id)
                                    ? current
                                    : [...current, file],
                                );
                                if (workspaceView === "library" && !sidebar.isMobile)
                                  setSpaceWork(true);
                                else closeResources();
                                requestAnimationFrame(() => composerRef.current?.focus());
                                return true;
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
                            !uploadingFiles &&
                            !resolvingResources &&
                            !submissionUnconfirmed &&
                            !submissionQueueFull &&
                            !branchBusy &&
                            !branchUnconfirmed;
                          return (
                            <CloudChatArtifactsPanel
                              key={JSON.stringify([
                                user.id,
                                conversationId,
                                artifactPanel.versionId ?? "library",
                                artifactPanel.site === true,
                              ])}
                              client={artifactsClient}
                              workFromSpace={workspaceView === "library"}
                              workActive={workingInSpace}
                              onRequestRevision={requestDocumentRevision}
                              conversationId={conversationId || undefined}
                              initialVersionId={artifactPanel.versionId}
                              initialSite={artifactPanel.site}
                              siteAction={artifactPanel.siteAction}
                              siteName={artifactPanel.item?.name.replace(/\.zip$/i, "")}
                              onSiteRename={
                                artifactPanel.item
                                  ? async (name) => {
                                      const item = artifactPanel.item;
                                      if (!item || !isCurrentView(view))
                                        throw new Error("站点视图已失效");
                                      const guard = captureAccountRequestGuard();
                                      const saved = await spaceClient.update(item, { name });
                                      guard();
                                      if (!isCurrentView(view)) return;
                                      setArtifactPanel((old) =>
                                        old?.item?.id === item.id
                                          ? { ...old, item: { ...item, ...saved } }
                                          : old,
                                      );
                                      setSpaceRevision((old) => old + 1);
                                    }
                                  : undefined
                              }
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
                                      if (
                                        !isCurrentView(view) ||
                                        version.state !== "ready" ||
                                        resourceDropRef.current
                                      )
                                        return false;
                                      if (
                                        artifactAttachments.some((item) => item.id === version.id)
                                      ) {
                                        if (workspaceView === "library" && !sidebar.isMobile)
                                          setSpaceWork(true);
                                        else closeResources();
                                        requestAnimationFrame(() => composerRef.current?.focus());
                                        return true;
                                      }
                                      if (attachments.length + artifactAttachments.length >= 8) {
                                        return false;
                                      }
                                      setArtifactAttachments((current) =>
                                        current.some((item) => item.id === version.id)
                                          ? current
                                          : [...current, version],
                                      );
                                      if (workspaceView === "library" && !sidebar.isMobile)
                                        setSpaceWork(true);
                                      else closeResources();
                                      requestAnimationFrame(() => composerRef.current?.focus());
                                      return true;
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
                                navigateConversation(sourceConversationId);
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
                        title="记忆"
                        description="管理后续对话使用的资料和偏好。"
                        onClose={closeResources}
                      >
                        <div className="min-h-0 flex-1 overflow-auto">
                          <CloudChatMemoryPanel
                            key={user.id}
                            client={projectsClient}
                            captureGuard={captureWorkGuard}
                            onContextChanged={() => {
                              setNavigationRevision((old) => old + 1);
                              setContextNotice("已保存，将用于后续消息。");
                            }}
                          />
                        </div>
                      </CloudChatResourcePanel>
                    ) : null}
                  </div>
                </CloudChatResourcePresentation.Provider>
              </CloudChatResourceWorkbench>
            </CloudConversationMain>
          </WorkbenchCanvas>

          {(customize.owner === user.id && customize.visited) || previewCustomize ? (
            <WorkbenchCanvas
              mode={
                embeddedAccount
                  ? "embedded"
                  : previewCustomize && !customizeOpen
                    ? "sidebar-preview"
                    : "page"
              }
              hidden={!customizeOpen && !previewCustomize}
              inert={!customizeOpen && !previewCustomize}
              className={!customizeOpen && !previewCustomize ? "hidden" : undefined}
            >
              <Suspense
                fallback={
                  <div
                    className={`flex flex-1 flex-col gap-5 p-8 ${previewCustomize ? "h-full w-(--sidebar-width) rounded-2xl bg-background shadow-lg" : ""}`}
                    role="status"
                    aria-label="正在加载自定义工作区"
                  >
                    <div className="h-7 w-24 animate-pulse rounded-lg bg-muted" />
                    <div className="h-14 max-w-2xl animate-pulse rounded-xl bg-muted" />
                    <div className="h-14 max-w-2xl animate-pulse rounded-xl bg-muted" />
                  </div>
                }
              >
                <ExtensionsWorkspace
                  key={user.id}
                  adapter={extensionsAdapter}
                  catalog={extensionCatalog}
                  location={extensionLocation}
                  onNavigate={(location) => {
                    if (previewCustomize) {
                      projectNavigation.request(() => {
                        leaveTaskConversation();
                        setScheduleRoute(undefined);
                        sidebarPreview.dismiss();
                        setAccountSettingsOpen(false);
                        setCustomize({ owner: user.id, open: true, visited: true });
                        setExtensionLocation(location);
                      });
                    } else setExtensionLocation(location);
                  }}
                  sharedSidebar
                  sidebarTarget={
                    desktopAccountLayout
                      ? workbenchActive && customizeOpen
                        ? desktopAccountLayout.sidebarTarget
                        : null
                      : undefined
                  }
                  sidebarOnly={!customizeOpen}
                  previewOpen={desktopAccountLayout?.sidebarPreview ?? previewCustomize}
                  onPinSidebar={desktopAccountLayout?.onPinSidebar ?? pinSidebarPreview}
                  loading={extensions.loading}
                  error={extensions.error}
                  onCatalog={(catalog) =>
                    setExtensions({ owner: user.id, catalog, loading: false, error: "" })
                  }
                  onRefresh={() => setExtensionRefresh((value) => value + 1)}
                  onBack={() => {
                    if (desktopAccountLayout) {
                      desktopAccountLayout.onClose();
                      return;
                    }
                    setCustomize((value) => ({ ...value, open: false }));
                    if (!sidebar.isMobile) {
                      requestAnimationFrame(() =>
                        composerRef.current?.focus({ restoreSelection: true }),
                      );
                    }
                  }}
                  onTry={tryExtension}
                  onConfigureImages={openModelPreferences}
                  onOpenDeviceSettings={desktopCloudHost?.onOpenDeviceSettings}
                />
              </Suspense>
            </WorkbenchCanvas>
          ) : null}
          {showTaskWorkspace && (!customizeOpen || previewTasks) ? (
            <WorkbenchCanvas mode={scheduleRoute ? "page" : "sidebar-preview"}>
              <CloudScheduleWorkspace
                key={user.id}
                owner={user.id}
                route={scheduleRoute ?? taskPreviewRoute}
                onNavigate={(next) => {
                  if (scheduleRoute) setScheduleRoute(next);
                  else if (next.id) openTaskWorkspace(next);
                  else setTaskPreviewRoute(next);
                }}
                onBack={closeResources}
                previewOpen={previewTasks}
                onPinSidebar={pinSidebarPreview}
                sidebarOnly={!scheduleRoute}
                hideSidebar={sidebarPreview.open && !previewTasks}
                onOpenConversation={navigateConversation}
                onSelectConversation={(selection) => {
                  taskReturnConversation.current ??= viewRef.current.conversationId;
                  selectTaskConversation(selection);
                }}
                renderConversation={
                  scheduleRoute
                    ? (id, onChromeTarget) => (
                        <TaskResultMount
                          key={id}
                          id={id}
                          loading={id !== conversationId}
                          onMount={setTaskConversationMount}
                          onChromeTarget={onChromeTarget}
                        />
                      )
                    : undefined
                }
                runClient={runsClient}
                onOpenResultResource={(id, resource) =>
                  projectNavigation.request(() => {
                    if (id !== viewRef.current.conversationId) selectTaskConversation({ id });
                    showTaskResultResource(resource);
                  })
                }
                locale={settings.locale}
                fontScale={settings.customSettings.fontScale.sidebar}
                currentModel={{
                  name: scheduleModel?.label ?? "",
                  model: scheduleModel?.model ?? "",
                  keyId: scheduleModel ? relayProviderKeyId(scheduleModel.providerId) : 0,
                }}
                models={modelOptions.map((option) => ({
                  name: option.label,
                  model: option.model,
                  keyId: relayProviderKeyId(option.providerId),
                  pickerOption: option,
                }))}
                space={spaceClient}
                projects={projectsClient}
                mobileRail={sidebar.isMobile ? renderApplicationRail(true) : undefined}
                environments={environments}
                onOpenDevice={async (environment, taskRoute) => {
                  const workspace = environment.workspaces[0];
                  if (workspace)
                    await (onOpenDeviceTasks ?? onSwitch)(environment, workspace, taskRoute);
                }}
              />
            </WorkbenchCanvas>
          ) : null}
          {accountSettingsOpen && !customizeOpen ? (
            <SettingsWorkspace navigation="external" className="cloud-settings-page flex-1">
              <SettingsPage
                presentation="page"
                settings={settings}
                setSettings={setSettings}
                saveState={settingsSaveState}
                onOpenModelPreferences={openModelPreferences}
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
                onSectionChange={(section) => {
                  const target = cloudSettingsSection(section);
                  if (target) setActiveSettingsSection(target);
                }}
                mobileDetail={settingsDetail}
                onMobileDetailChange={setSettingsDetail}
                hiddenSections={[
                  "skills",
                  "mcp",
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
            </SettingsWorkspace>
          ) : null}
        </WorkbenchShell>
        {modelPreferencesOwner === user.id ? (
          <ProviderSettingsDialog
            settings={settings}
            setSettings={setSettings}
            providerType="codex"
            onClose={() => setModelPreferencesOwner(null)}
            singleColumn
            description="标题设置保存后生效；其他偏好修改自动保存。"
            content={
              <CloudModelPreferencesSection
                key={user.id}
                settings={settings}
                setSettings={setSettings}
                ownerId={user.id}
              />
            }
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
        {projectSettings.open &&
        projectSettings.owner === user.id &&
        !accountInvalidatedRef.current ? (
          <CloudProjectSettingsDialog
            key={`project-settings:${user.id}:${projectSettings.id || "catalog"}`}
            projectId={projectSettings.id}
            client={projectsClient}
            filesClient={filesClient}
            captureGuard={captureAccountRequestGuard}
            onDirtyChange={projectNavigation.setDirty}
            onClose={() => setProjectSettings({ owner: user.id, open: false })}
            onSelect={(id) => setProjectSettings({ owner: user.id, id, open: true })}
            onCreate={() => {
              setProjectSettings({ owner: user.id, open: false });
              setProjectCreate({ owner: user.id, open: true });
            }}
            onChanged={() => {
              setNavigationRevision((revision) => revision + 1);
              void refreshConversations(true).catch(() => undefined);
            }}
            onPreviewFile={(fileId) => showFileResource({ fileId })}
          />
        ) : null}
        <CloudProjectCreateDialog
          key={`create-project:${user.id}:${projectCreate.conversationId ?? "new"}`}
          open={
            projectCreate.owner === user.id && projectCreate.open && !accountInvalidatedRef.current
          }
          onOpenChange={(open) =>
            setProjectCreate((current) => ({ ...current, owner: user.id, open }))
          }
          client={projectsClient}
          captureGuard={captureAccountRequestGuard}
          moveAfterCreate={!!projectCreate.conversationId}
          onCreated={async (project) => {
            if (projectCreate.conversationId)
              await moveSidebarConversation(projectCreate.conversationId, project);
            else setNavigationRevision((revision) => revision + 1);
          }}
        />
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
              showFileResource({ fileId });
            }}
            onOpenArtifact={(versionId) => {
              closeMessageReader();
              showArtifactResource({ versionId });
            }}
            onOpenFileLink={(link) => {
              closeMessageReader();
              openCloudMessageLink(link);
            }}
          />
        ) : null}
        {projectNavigation.dialog}
        {!desktopCloudHost && (
          <FirstRunOnboarding
            userId={user.id}
            onSyncKeys={async (keys, groups) => {
              const next = await bindRelayKeysToSettings(settings, keys, groups, true);
              setSettings(() => next);
            }}
          />
        )}
      </FileDropBoundary>
    </AppErrorBoundary>
  );
}
