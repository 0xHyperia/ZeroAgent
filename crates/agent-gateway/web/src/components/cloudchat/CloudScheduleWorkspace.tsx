import type { RenderWorkbenchPageHeader } from "@liveagent/ui/application/AppWorkbenchChrome";
import { mountWorkbenchLayout } from "@liveagent/ui/application/workbenchLayoutPortal";
import { ConversationStarter } from "@liveagent/ui/components/chat/ConversationStarter";
import {
  ArrowLeft,
  BookOpen,
  CalendarDays,
  ChartColumn,
  ChevronDown,
  Clock3,
  FileText,
  Globe,
  Lightbulb,
  Link2,
  ListFilter,
  MoreHorizontal,
  PanelLeft,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Share2,
  ShieldCheck,
  SquarePen,
  Trash2,
  X,
} from "@liveagent/ui/components/IconSet";
import { DocumentMarkdown } from "@liveagent/ui/components/markdown/DocumentMarkdown";
import { TimeZonePicker } from "@liveagent/ui/components/settings/TimeZonePicker";
import { Button } from "@liveagent/ui/components/ui/button";
import { Checkbox } from "@liveagent/ui/components/ui/checkbox";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@liveagent/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { EmptyState } from "@liveagent/ui/components/ui/empty-state";
import { Input } from "@liveagent/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarHeaderRow,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@liveagent/ui/components/ui/sidebar";
import { StatusNotice } from "@liveagent/ui/components/ui/status-notice";
import { Switch } from "@liveagent/ui/components/ui/switch";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { toast } from "@liveagent/ui/components/ui/toast-manager";
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import { t as translate } from "@liveagent/ui/i18n/index";
import {
  type CronRunRecord,
  type CronTask,
  isCronRunActive,
  type ScheduledConversationRun,
} from "@liveagent/ui/lib/automation/types";
import { OFFICIAL_GATEWAY_URL } from "@liveagent/ui/lib/settings";
import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import type { TranscriptMessageJump } from "@liveagent/ui/lib/transcript-virtual/useTranscriptMessageJump";
import { ModelPicker, type ModelPickerOption } from "@liveagent/ui/pages/settings/modelPicker";
import { WorkbenchScheduleDialog } from "@liveagent/ui/pages/settings/WorkbenchScheduleDialog";
import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CLOUD_CHAT_REASONING_OPTIONS,
  cloudChatReasoningEffort,
} from "../../lib/cloudChatModelParameters";
import type { CloudChatPresentationResource } from "../../lib/cloudChatPresentation";
import type { CloudChatProjectsClient, CloudProject } from "../../lib/cloudChatProjects";
import {
  type CloudChatRoute,
  cloudChatRouteHref,
  type TaskStatus,
  taskStatuses,
} from "../../lib/cloudChatRoute";
import { type createCloudChatRunsClient, readCloudChatRunView } from "../../lib/cloudChatRuns";
import {
  type CloudTaskConversationSelection,
  cloudSchedules,
  SCHEDULE_CONTENT_PART_LIMIT,
  type Schedule,
  type ScheduleApprovalReceipt,
  ScheduleEndpointUnavailableError,
  type ScheduleInput,
  ScheduleRequestError,
  type ScheduleRule,
  type ScheduleRun,
} from "../../lib/cloudSchedules";
import type { CloudSpaceClient } from "../../lib/cloudSpace";
import {
  DEVICE_SCHEDULE_DRAFT_RECEIVED,
  type DeviceScheduleDraft,
  discardDeviceScheduleDraft,
  receiveDeviceScheduleDraft,
  stageDeviceScheduleDraft,
} from "../../lib/deviceScheduleDraft";
import type { DeviceScheduleEditorProps, DeviceScheduleHost } from "../../lib/deviceScheduleHost";
import type { ExecutionEnvironment } from "../../lib/executionTargets";
import { ScheduleRunApprovalCard } from "./ScheduleRunApprovalCard";
import { type ScheduleSourceMetadata, ScheduleSourcePicker } from "./ScheduleSourcePicker";
import { useScheduledRunPreview } from "./useScheduledRunPreview";

type Route = Extract<CloudChatRoute, { page: "tasks" }>;
type Model = { name: string; model: string; keyId: number; pickerOption?: ModelPickerOption };
type Text = (zh: string, en: string) => string;
type CreationTarget = {
  id: string;
  label: string;
  ready: boolean;
  inline?: boolean;
  open: (draft: DeviceScheduleDraft) => void | Promise<void>;
};
type TaskRow = {
  id: string;
  target: string;
  name: string;
  secondary: string;
  group: NonNullable<Route["status"]>;
};
const taskDetailsClass =
  "za-floating-surface za-native-scroll z-20 order-1 mx-auto mt-1 max-h-[min(62dvh,24rem)] w-[calc(100%-2rem)] max-w-3xl min-w-0 shrink-0 divide-y divide-border/60 overflow-auto overscroll-contain border border-border/60 bg-popover text-sm @min-[56rem]:absolute @min-[56rem]:top-0 @min-[56rem]:right-2 @min-[56rem]:w-[17.5rem]";
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function requiresCloudSignIn(cause: unknown) {
  return cause instanceof ScheduleRequestError && [401, 403].includes(cause.status);
}

function formatTaskTime(locale: string, value: string, timeZone?: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}

function status(task: Schedule): NonNullable<Route["status"]> {
  return !task.enabled ? "paused" : task.next_at ? "enabled" : "completed";
}

function devicePlanStatus(task: CronTask): NonNullable<Route["status"]> {
  return task.remainingExecutions === 0 ? "completed" : task.enabled ? "enabled" : "paused";
}

function taskInput(task: Schedule): ScheduleInput {
  return {
    name: task.name,
    rule: task.rule,
    run: task.run,
    new_conversation: task.new_conversation,
    project_id: task.project_id,
    archive_successful_runs: task.archive_successful_runs,
    notification: task.notification,
    require_approval: task.require_approval,
  };
}

function defaultScheduleClock() {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Android can report a numeric UTC offset instead of a zone in the scheduler's database.
  const time_zone = /^[+-]/.test(browserZone) ? "UTC" : browserZone || "UTC";
  const now = new Date();
  const next = new Date(now);
  next.setHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const wallTime =
    time_zone === "UTC" ? next : new Date(next.getTime() - next.getTimezoneOffset() * 60_000);
  return { start: wallTime.toISOString().slice(0, 16), time_zone };
}

const workdays = [1, 2, 3, 4, 5] as const;

function schedulePrompt(content: ScheduleInput["run"]["content"]) {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

function scheduleApprovalKey(owner: number, taskId: string, runId: string) {
  return `zeroagent.task-approval:${JSON.stringify([owner, taskId, runId])}`;
}

function isWorkdaySchedule(rule: ScheduleRule) {
  return (
    rule.frequency === "weekly" &&
    rule.weekdays?.length === workdays.length &&
    workdays.every((day) => rule.weekdays?.includes(day))
  );
}

export function CloudScheduleWorkspace({
  owner,
  route,
  onNavigate,
  onOpenConversation,
  onSelectConversation,
  renderConversation,
  onOpenResultResource,
  runClient,
  onBack,
  locale,
  fontScale = 1,
  currentModel,
  models,
  space,
  sourceMetadata,
  projects,
  device,
  renderDeviceEditor,
  renderDeviceConversation,
  onOpenDeviceConversation,
  environments,
  onOpenDevice,
  schedules = cloudSchedules,
  includeCloud = true,
  onRetryCloud,
  defaultCreationTarget,
  taskLinkOrigin,
  mobileRail,
  previewOpen,
  onPinSidebar,
  sidebarTarget,
  sidebarOnly,
  hideSidebar,
  hostSidebarTrigger,
  renderWorkbenchHeader,
}: {
  owner: number;
  route: Route;
  onNavigate: (route: Route) => void;
  onOpenConversation: (id: string) => void;
  onSelectConversation?: (selection: CloudTaskConversationSelection) => void;
  renderConversation?: (
    id: string,
    onChromeTarget: (element: HTMLDivElement | null) => void,
  ) => ReactNode;
  onOpenResultResource: (
    conversation: string,
    resource: CloudChatPresentationResource,
    occurrenceId: string,
  ) => void;
  runClient?: Pick<ReturnType<typeof createCloudChatRunsClient>, "getRun">;
  onBack: () => void;
  locale: string;
  fontScale?: number;
  currentModel: Model;
  models: readonly Model[];
  space?: CloudSpaceClient;
  sourceMetadata?: ScheduleSourceMetadata;
  projects?: Pick<CloudChatProjectsClient, "listProjects">;
  device?: DeviceScheduleHost;
  renderDeviceEditor?: (props: DeviceScheduleEditorProps) => ReactNode;
  renderDeviceConversation?: (
    conversationId: string,
    run: CronRunRecord,
    jump?: TranscriptMessageJump,
    scheduledRun?: ScheduledConversationRun,
  ) => ReactNode;
  onOpenDeviceConversation?: (id: string) => void;
  environments: readonly ExecutionEnvironment[];
  onOpenDevice: (environment: ExecutionEnvironment, taskRoute?: Route) => Promise<void>;
  schedules?: typeof cloudSchedules | null;
  includeCloud?: boolean;
  onRetryCloud?: () => void;
  defaultCreationTarget?: string;
  taskLinkOrigin?: string;
  mobileRail?: ReactNode;
  previewOpen?: boolean;
  onPinSidebar?: () => void;
  sidebarTarget?: HTMLElement | null;
  sidebarOnly?: boolean;
  hideSidebar?: boolean;
  hostSidebarTrigger?: boolean;
  renderWorkbenchHeader?: RenderWorkbenchPageHeader;
}) {
  const text: Text = (zh, en) => (locale === "zh-CN" ? zh : en);
  const { isMobile, open, openMobile, setOpenMobile } = useSidebar();
  const [items, setItems] = useState<Awaited<ReturnType<typeof cloudSchedules.list>> | null>(null);
  const cloudPlanRead = useRef<AbortController | null>(null);
  const [history, setHistory] = useState<{
    owner: number;
    task: string;
    runs: ScheduleRun[];
    error?: string;
    exact?: { id: string; run?: ScheduleRun; error?: string };
  }>({
    owner,
    task: "",
    runs: [],
  });
  const [deviceSnapshot, setDeviceSnapshot] = useState<{
    host: DeviceScheduleHost;
    items: Awaited<ReturnType<DeviceScheduleHost["list"]>>;
    readAt: number;
  }>();
  const currentDeviceSnapshot = deviceSnapshot?.host === device ? deviceSnapshot : undefined;
  const deviceTasks = currentDeviceSnapshot?.items;
  const deviceReadAt = currentDeviceSnapshot?.readAt;
  const [deviceHistory, setDeviceHistory] = useState<{
    owner: number;
    target: string;
    task: string;
    runs: Awaited<ReturnType<DeviceScheduleHost["runs"]>>;
    error?: true;
  }>();
  const [deviceFailure, setDeviceFailure] = useState("");
  const [taskDetailsOpen, setTaskDetailsOpen] = useState(false);
  const taskDetailsInset = taskDetailsOpen ? "@min-[56rem]:pr-[18.5rem] @min-[83rem]:pr-0" : "";
  const taskDetailsId = useId();
  const taskConversationArea = useRef<HTMLDivElement>(null);
  const [chromeHost, setChromeHost] = useState<{ id: string; element: HTMLDivElement }>();
  const taskDetailsTrigger = useRef<HTMLElement>(null);
  const taskDetailsReturnFocus = useRef<boolean | { approvalKey: string }>(true);
  const detailsTarget = route.target ?? "cloud";
  const detailsPosition = useMemo(
    () => ({
      owner,
      target: detailsTarget,
      task: route.id,
      top: 0,
      resource: undefined as { occurrenceId: string; key: string } | undefined,
    }),
    [owner, detailsTarget, route.id],
  );
  const [openHistory, setOpenHistory] = useState<typeof detailsPosition>();
  const mobileHistorySummary = useRef<HTMLElement>(null);
  const mobileHistoryRetry = useRef<HTMLButtonElement>(null);
  const mobileHistoryVisible = isMobile && taskDetailsOpen && openHistory === detailsPosition;
  const historyDisclosure = {
    open: openHistory === detailsPosition,
    onOpenChange: (open: boolean) => setOpenHistory(open ? detailsPosition : undefined),
    summaryRef: mobileHistorySummary,
  };
  const restoreMobileHistoryFocus = useEffectEvent(() => {
    if (mobileHistoryRetry.current && document.activeElement === mobileHistoryRetry.current)
      mobileHistorySummary.current?.focus({ preventScroll: true });
  });
  const taskTitle = useRef<HTMLHeadingElement>(null);
  const createdTaskFocus = useRef<{ owner: number; id: string } | undefined>(undefined);
  const returnRun = useRef<
    { owner: number; target: string; task: string; run: string } | undefined
  >(undefined);
  const selectedCloudRunRetry = useRef<HTMLButtonElement>(null);
  const restoreSelectedCloudRunFocus = useEffectEvent(() => {
    if (selectedCloudRunRetry.current && document.activeElement === selectedCloudRunRetry.current)
      taskTitle.current?.focus({ preventScroll: true });
  });
  const approvalTitle = useRef<HTMLHeadingElement>(null);
  const [focusApproval, setFocusApproval] = useState<string>();
  const [lastApprovalReceipt, setLastApprovalReceipt] = useState<{
    key: string;
    outcome: Exclude<ScheduleApprovalReceipt, "pending">;
  }>();
  function closeTaskDetails() {
    setTaskDetailsOpen(false);
    if (!isMobile) taskDetailsTrigger.current?.focus({ preventScroll: true });
  }
  function leaveMobileTaskDetails(focusDestination: typeof taskDetailsReturnFocus.current) {
    if (!isMobile || !taskDetailsOpen) return;
    taskDetailsReturnFocus.current = focusDestination;
    closeTaskDetails();
  }
  const [runResources, setRunResources] = useState<{
    key: string;
    attempt: number;
    items: CloudChatPresentationResource[];
    messageId?: string;
    error?: boolean;
  }>();
  const [runDetailsAttempt, setRunDetailsAttempt] = useState(0);
  const runDetailsRetry = useRef<HTMLButtonElement>(null);
  const restoreRunDetailsFocus = useEffectEvent(() => {
    if (document.activeElement !== runDetailsRetry.current) return;
    const target = taskDetailsOpen
      ? document.getElementById(taskDetailsId)
      : taskDetailsTrigger.current;
    target?.focus({ preventScroll: true });
  });
  const [manualCloudRun, setManualCloudRun] = useState<{
    owner: typeof owner;
    taskId: string;
    runId: string;
    previousConversationId?: string;
  }>();
  const [cloudJumpSequence, setCloudJumpSequence] = useState(0);
  const [unavailableCloudJump, setUnavailableCloudJump] = useState<string>();
  const [manualDeviceRun, setManualDeviceRun] = useState<string>();
  const [deviceAnchorResult, setDeviceAnchorResult] = useState<{
    key: string;
    messageId?: string;
  }>();
  const [remoteSummaries, setRemoteSummaries] = useState<
    Record<
      string,
      {
        items: Awaited<ReturnType<typeof cloudSchedules.deviceSummary>>["tasks"];
        readAt?: string;
        unavailable?: boolean;
      }
    >
  >({});
  const [remoteRefresh, setRemoteRefresh] = useState(0);
  const onlineDevices = JSON.stringify(
    environments
      .filter(
        (target) => target.runtime_kind === "device_agent" && target.device_id && target.online,
      )
      .map((target) => target.device_id)
      .sort(),
  );
  const searchKey = `zeroagent.task-search:${owner}`;
  const [query, setQuery] = useState(() => sessionStorage.getItem(searchKey) ?? "");
  const [requestedRowRun, setRequestedRowRun] = useState<{
    owner: number;
    target: string;
    id: string;
    fromId?: string;
    fromTarget?: string;
  }>();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<TaskStatus>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(!!query);
  const filterButton = useRef<HTMLElement>(null);
  const mobileListViewport = useRef<HTMLDivElement>(null);
  const mobileListReturn = useRef<
    { key: string; row: string; top: number; offset: number } | undefined
  >(undefined);
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const { confirm, dialog: authorityDialog } = useConfirmDialog();
  const [refresh, setRefresh] = useState(0);
  const deviceHistoryError = text(
    "暂时无法读取设备运行记录。",
    "Device run history is temporarily unavailable.",
  );
  function mobileHistoryFeedback(loading: boolean, failure?: string) {
    if (!mobileHistoryVisible) return null;
    if (failure)
      return (
        <StatusNotice
          compact
          stackActions
          tone="warning"
          message={failure}
          actions={
            <Button
              ref={mobileHistoryRetry}
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() => setRefresh((value) => value + 1)}
            >
              {text("重试读取运行记录", "Retry run history")}
            </Button>
          }
        />
      );
    if (loading)
      return (
        <p role="status" className="text-muted-foreground">
          {text("正在读取运行记录…", "Loading run history…")}
        </p>
      );
    return null;
  }
  const [editor, setEditor] = useState<{
    existing?: Schedule;
    input: ScheduleInput;
    id: string;
    target?: string;
    resumeAfterEdit?: boolean;
    editSources?: boolean;
  }>();
  const [deviceEditor, setDeviceEditor] = useState<{
    id: string;
    task?: CronTask;
    name?: string;
    prompt?: string;
  }>();
  const pendingDeviceDraft = useRef("");
  const readyDeviceEditor =
    !sidebarOnly && device && deviceTasks && !deviceFailure && renderDeviceEditor && !deviceEditor
      ? device.targetId
      : "";
  useEffect(() => {
    if (!readyDeviceEditor) return;
    const draft = receiveDeviceScheduleDraft(owner, readyDeviceEditor);
    if (draft) setDeviceEditor(draft);
  }, [owner, readyDeviceEditor]);
  useEffect(() => {
    const onReceived = (event: Event) => {
      const { detail } = event as CustomEvent<{ owner: number; id: string }>;
      if (detail?.owner !== owner || detail.id !== pendingDeviceDraft.current) return;
      pendingDeviceDraft.current = "";
      setEditor((current) => (current?.id === detail.id ? undefined : current));
    };
    window.addEventListener(DEVICE_SCHEDULE_DRAFT_RECEIVED, onReceived);
    return () => window.removeEventListener(DEVICE_SCHEDULE_DRAFT_RECEIVED, onReceived);
  }, [owner]);
  const currentWrite = useRef(false);
  const scope = route.scope ?? (!route.id ? route.target : undefined);
  const onDevice = !!device && route.target === device.targetId;
  const task =
    !route.target || route.target === "cloud"
      ? items?.tasks.find((item) => item.id === route.id)
      : undefined;
  const selectedCloudTaskId = task?.id;
  useLayoutEffect(() => {
    if (
      createdTaskFocus.current?.owner !== owner ||
      createdTaskFocus.current.id !== selectedCloudTaskId ||
      !taskTitle.current
    )
      return;
    createdTaskFocus.current = undefined;
    taskTitle.current.focus({ preventScroll: true });
  }, [owner, selectedCloudTaskId]);
  const pendingRunKey = task ? `zeroagent.task-manual:${owner}:${task.id}` : undefined;
  const pendingCloudRun = pendingRunKey ? sessionStorage.getItem(pendingRunKey) : null;
  const [cloudRunFeedback, setCloudRunFeedback] = useState<{
    request: string;
    state: "submitting" | "checking" | "missing" | "unavailable" | "sign-in";
  }>();
  const cloudRunFeedbackState =
    cloudRunFeedback?.request === pendingCloudRun ? cloudRunFeedback.state : undefined;
  const cloudRunChecking =
    cloudRunFeedbackState === "submitting" || cloudRunFeedbackState === "checking";
  const deviceTask = onDevice ? deviceTasks?.tasks.find((item) => item.id === route.id) : undefined;
  const [missingDeviceRun, setMissingDeviceRun] = useState<string>();
  const deviceRunKey =
    deviceTask && device
      ? `zeroagent.device-task-manual:${JSON.stringify([owner, device.targetId, deviceTask.id])}`
      : undefined;
  const pendingDeviceRun = deviceRunKey ? sessionStorage.getItem(deviceRunKey) : null;
  const deviceRunSelection = useMemo(
    () => ({ key: deviceRunKey, run: route.run }),
    [deviceRunKey, route.run],
  );
  const cloudRunSelection = useMemo(
    () => ({ key: pendingRunKey, run: route.run, schedules }),
    [pendingRunKey, route.run, schedules],
  );
  const currentRunView = useRef<{
    owner: number;
    cloud: typeof cloudRunSelection;
    device: typeof deviceRunSelection;
    route: typeof route;
    onNavigate: typeof onNavigate;
  } | null>(null);
  useLayoutEffect(() => {
    currentRunView.current = {
      owner,
      cloud: cloudRunSelection,
      device: deviceRunSelection,
      route,
      onNavigate,
    };
    return () => {
      currentRunView.current = null;
    };
  }, [cloudRunSelection, deviceRunSelection, onNavigate, owner, route]);
  const currentDeviceHistory =
    deviceTask &&
    deviceHistory?.owner === owner &&
    deviceHistory.task === deviceTask.id &&
    deviceHistory.target === route.target
      ? deviceHistory
      : undefined;
  const deviceRuns = currentDeviceHistory?.runs ?? [];
  const deviceRun = route.run
    ? deviceRuns.find((run) => run.id === route.run || run.runId === route.run)
    : deviceRuns[0];
  const deviceHistoryUnavailable = Boolean(deviceFailure || currentDeviceHistory?.error);
  const deviceRunSelectionState =
    route.run && !deviceRun && route.run !== pendingDeviceRun
      ? route.run === manualDeviceRun
        ? "accepted"
        : deviceHistoryUnavailable
          ? "unavailable"
          : currentDeviceHistory
            ? "missing"
            : "loading"
      : undefined;
  const deviceRunAwaitingRecord = deviceRunSelectionState === "accepted";
  const deviceRunRetry = useRef<HTMLButtonElement>(null);
  const restoreDeviceRunFocus = useEffectEvent((runs: typeof deviceRuns) => {
    if (
      deviceRunRetry.current &&
      document.activeElement === deviceRunRetry.current &&
      runs.some((run) => run.id === route.run || run.runId === route.run)
    )
      taskTitle.current?.focus({ preventScroll: true });
  });
  const resultSessionId =
    deviceTask?.type === "prompt" && renderDeviceConversation ? deviceRun?.sessionId : undefined;
  const deviceConversationId = deviceFailure ? undefined : resultSessionId;
  const activeConversationRun = resultSessionId
    ? deviceRuns.find((run) => run.sessionId === resultSessionId && isCronRunActive(run))
    : undefined;
  const latestConversationRun = resultSessionId
    ? deviceRuns.find((run) => run.sessionId === resultSessionId)
    : undefined;
  const conversationRun = activeConversationRun ?? latestConversationRun ?? deviceRun;
  const devicePreview = useScheduledRunPreview(
    owner,
    device,
    resultSessionId ? conversationRun : undefined,
  );
  const anchorTaskId = deviceTask?.id;
  const anchorExecutionId =
    route.run &&
    route.run !== manualDeviceRun &&
    (deviceRun?.state === "done" || deviceRun?.state === "expired")
      ? deviceRun.id
      : undefined;
  const anchorRunId = deviceRun?.runId;
  const deviceAnchorKey =
    deviceConversationId && anchorTaskId && anchorExecutionId
      ? JSON.stringify([
          owner,
          route.target,
          anchorTaskId,
          anchorExecutionId,
          deviceConversationId,
          anchorRunId,
        ])
      : undefined;
  const readRunAnchor = useEffectEvent((taskId: string, executionId: string) =>
    device?.runAnchor?.(taskId, executionId),
  );
  useEffect(() => {
    if (!deviceAnchorKey || !anchorTaskId || !anchorExecutionId || !deviceConversationId) return;
    let retired = false;
    const setResult = (messageId?: string) => {
      if (!retired) setDeviceAnchorResult({ key: deviceAnchorKey, messageId });
    };
    if (!anchorRunId) {
      setResult();
      return;
    }
    void Promise.resolve(readRunAnchor(anchorTaskId, anchorExecutionId)).then(
      (anchor) =>
        setResult(
          anchor?.sessionId === deviceConversationId &&
            anchor.runId === anchorRunId &&
            typeof anchor.messageId === "string"
            ? anchor.messageId.trim() || undefined
            : undefined,
        ),
      () => setResult(),
    );
    return () => {
      retired = true;
    };
  }, [anchorExecutionId, anchorRunId, anchorTaskId, deviceAnchorKey, deviceConversationId]);
  const deviceAnchor = deviceAnchorResult?.key === deviceAnchorKey ? deviceAnchorResult : undefined;
  const showDeviceRunResult =
    !deviceRunSelectionState &&
    (!deviceConversationId || (deviceAnchor && !deviceAnchor.messageId));
  const deviceMessageJump: TranscriptMessageJump | undefined = deviceAnchor?.messageId
    ? {
        key: deviceAnchor.key,
        messageId: deviceAnchor.messageId,
        onUnavailable: () =>
          setDeviceAnchorResult((result) =>
            result?.key === deviceAnchor.key ? { key: deviceAnchor.key } : result,
          ),
      }
    : undefined;
  const deviceNext = deviceTask && deviceTasks?.next[deviceTask.id];
  const unavailable = environments.find(
    (environment) =>
      !!route.id &&
      environment.runtime_kind === "device_agent" &&
      environment.device_id === route.target,
  );
  const remoteSummary = unavailable?.device_id ? remoteSummaries[unavailable.device_id] : undefined;
  const remoteTask = remoteSummary?.items.find((item) => item.id === route.id);
  const currentHistory = history.owner === owner && history.task === route.id ? history : undefined;
  const runs = currentHistory?.runs ?? [];
  const exact = currentHistory?.exact?.id === route.run ? currentHistory?.exact : undefined;
  const cloudHistoryError = currentHistory?.error;
  const cloudHistoryLoading = Boolean(task && !currentHistory && !loadError);
  const targetLabel =
    scope === "cloud"
      ? text("云端", "Cloud")
      : scope === device?.targetId
        ? device?.label
        : environments.find((environment) => environment.device_id === scope)?.name;
  const awaitingApproval = runs.find((run) => run.state === "awaiting_approval");
  const listedRun = route.run ? runs.find((run) => run.id === route.run) : undefined;
  const selectedRun = route.run ? (listedRun ?? exact?.run) : (awaitingApproval ?? runs[0]);
  const cancelableCloudRun =
    selectedRun &&
    (selectedRun.state === "pending" ||
      (selectedRun.run_id && ["queued", "running"].includes(selectedRun.state)))
      ? selectedRun
      : undefined;
  const displayedRuns = exact?.run && !listedRun ? [exact.run, ...runs] : runs;
  const selectedApproval =
    selectedRun?.state === "awaiting_approval" ? selectedRun.approval : undefined;
  const approvalRunId = selectedRun?.id ?? route.run;
  const approvalKey =
    task && approvalRunId ? scheduleApprovalKey(owner, task.id, approvalRunId) : undefined;
  const recordedApproval =
    approvalKey && lastApprovalReceipt?.key === approvalKey
      ? lastApprovalReceipt.outcome
      : undefined;
  const reviewApproval = Boolean(
    selectedApproval || recordedApproval || (approvalKey && sessionStorage.getItem(approvalKey)),
  );
  const mobileTaskDetails = isMobile
    ? {
        open: taskDetailsOpen,
        position: detailsPosition,
        returnFocus: (): HTMLElement | null | false => {
          const destination = taskDetailsReturnFocus.current;
          if (typeof destination === "object") {
            if (destination.approvalKey !== approvalKey) return false;
            return approvalTitle.current ?? taskDetailsTrigger.current;
          }
          return destination ? taskDetailsTrigger.current : false;
        },
      }
    : undefined;
  useLayoutEffect(() => {
    if (!focusApproval || !approvalTitle.current || approvalKey !== focusApproval) return;
    approvalTitle.current.focus();
    setFocusApproval(undefined);
  }, [approvalKey, focusApproval]);
  const cloudRunBusy = displayedRuns.some((run) =>
    ["pending", "awaiting_approval", "queued", "running", "cancelling"].includes(run.state),
  );
  const selectedConversationId = selectedRun?.conversation_id;
  const selectedCloudRunId = selectedRun?.run_id;
  const isManualSelection =
    manualCloudRun?.owner === owner &&
    manualCloudRun.taskId === task?.id &&
    manualCloudRun.runId === route.run;
  const awaitingSelectedRun = Boolean(
    route.run && !selectedRun && !isManualSelection && !reviewApproval,
  );
  const selectedRunLoading = awaitingSelectedRun && !exact && !cloudHistoryLoading && !loadError;
  const manualRunAwaitingRecord = isManualSelection && !selectedRun;
  const acceptedRunReadFailure =
    manualRunAwaitingRecord && (exact || loadError)
      ? exact?.error ||
        loadError ||
        text(
          "暂时读不到这次运行的记录，可以重试。",
          "This run's record is temporarily unavailable. You can retry.",
        )
      : undefined;
  const selectedRunNotice = acceptedRunReadFailure
    ? text("云端已接受这次运行", "The cloud accepted this run")
    : !listedRun && !isManualSelection && !reviewApproval && exact
      ? exact.error ||
        (!exact.run && text("所选运行已不可用。", "The selected run is unavailable."))
      : undefined;
  const followLatestCloudRun = !route.run || isManualSelection;
  const cloudJumpKey =
    !followLatestCloudRun && selectedConversationId && selectedCloudRunId
      ? JSON.stringify([
          owner,
          route.id,
          route.run,
          selectedConversationId,
          selectedCloudRunId,
          cloudJumpSequence,
        ])
      : undefined;
  const runDetailsKey =
    task && selectedRun && selectedCloudRunId && selectedConversationId
      ? JSON.stringify([owner, task.id, selectedRun.id, selectedCloudRunId, selectedConversationId])
      : undefined;
  const selectedRunResources = runResources?.key === runDetailsKey ? runResources : undefined;
  const selectedMessageId = cloudJumpKey ? selectedRunResources?.messageId : undefined;
  const cloudJumpUnavailable = Boolean(
    cloudJumpKey &&
      (unavailableCloudJump === cloudJumpKey ||
        (selectedRunResources && !selectedRunResources.error && !selectedMessageId)),
  );
  // Keep the same transcript mounted between the manual receipt and Cloud Run admission.
  const previousConversationId = manualCloudRun?.previousConversationId;
  const waitingInPreviousConversation =
    isManualSelection &&
    previousConversationId &&
    !selectedCloudRunId &&
    (!selectedRun || selectedRun.state === "pending") &&
    (!selectedConversationId || selectedConversationId === previousConversationId);
  const liveConversationId = renderConversation
    ? selectedCloudRunId
      ? selectedConversationId
      : waitingInPreviousConversation
        ? previousConversationId
        : undefined
    : undefined;
  const onTaskChromeTarget = useCallback(
    (element: HTMLDivElement | null) => {
      if (!liveConversationId) return;
      setChromeHost((current) =>
        element
          ? { id: liveConversationId, element }
          : current?.id === liveConversationId
            ? undefined
            : current,
      );
    },
    [liveConversationId],
  );
  const taskChromeTarget = chromeHost?.id === liveConversationId ? chromeHost?.element : undefined;
  const inspectorTarget = isMobile ? undefined : taskChromeTarget;

  const showTaskConversation =
    (!cloudHistoryLoading || !route.run) &&
    !awaitingSelectedRun &&
    (!liveConversationId || cloudJumpUnavailable);
  const selectConversation = useEffectEvent((selection: CloudTaskConversationSelection) =>
    onSelectConversation?.(selection),
  );
  useEffect(() => {
    if (!liveConversationId || !selectedCloudRunId) return;
    selectConversation({
      id: liveConversationId,
      runId: selectedCloudRunId,
      occurrenceId: selectedRun?.id,
      followLatest: followLatestCloudRun,
      jump:
        cloudJumpKey && selectedMessageId
          ? {
              key: cloudJumpKey,
              messageId: selectedMessageId,
              onUnavailable: () => setUnavailableCloudJump(cloudJumpKey),
            }
          : undefined,
    });
  }, [
    cloudJumpKey,
    followLatestCloudRun,
    liveConversationId,
    selectedMessageId,
    selectedCloudRunId,
    selectedRun?.id,
  ]);
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(
    selectedRun?.state ?? "",
  );
  const runDetailsExpected = Boolean(
    runDetailsKey && (cloudJumpKey || (taskDetailsOpen && terminal)),
  );
  const runDetailsLoading = Boolean(
    runDetailsExpected && runClient && selectedRunResources?.attempt !== runDetailsAttempt,
  );
  const runDetailsUnavailable = Boolean(
    runDetailsExpected && (!runClient || selectedRunResources?.error),
  );
  const fallbackRunOutput =
    !liveConversationId || cloudJumpUnavailable || runDetailsUnavailable
      ? selectedRun?.output
      : undefined;
  const runDetailsNotice = (
    <StatusNotice
      compact
      stackActions={taskDetailsOpen}
      busy={runDetailsLoading}
      tone={runDetailsLoading ? "info" : "warning"}
      message={
        runDetailsLoading
          ? text("正在读取本次运行的详情…", "Reading details for this run…")
          : text("暂时无法读取本次运行的详情。", "Run details are temporarily unavailable.")
      }
      actions={
        runClient && selectedRunResources?.error ? (
          <Button
            ref={runDetailsRetry}
            type="button"
            variant="ghost"
            className="min-h-11 md:min-h-9"
            aria-disabled={runDetailsLoading}
            onClick={() => {
              if (!runDetailsLoading) setRunDetailsAttempt((attempt) => attempt + 1);
            }}
          >
            {text("重试读取运行详情", "Retry reading run details")}
          </Button>
        ) : undefined
      }
    />
  );
  const time = (value: string, timeZone?: string) => formatTaskTime(locale, value, timeZone);
  const labels = {
    enabled: text("已开启", "Active"),
    paused: text("已暂停", "Paused"),
    completed: text("已完成", "Completed"),
  };
  function backToList() {
    returnRun.current =
      route.id && route.run
        ? { owner, target: route.target ?? "cloud", task: route.id, run: route.run }
        : undefined;
    onNavigate({ page: "tasks", scope, status: route.status, statuses: route.statuses });
  }
  function updateQuery(value: string) {
    setQuery(value);
    sessionStorage.setItem(searchKey, value);
  }
  function closeSearch() {
    setSearchOpen(false);
    updateQuery("");
    searchButton.current?.focus();
  }
  const runLabels: Record<string, string> = {
    pending: text("等待执行", "Waiting"),
    awaiting_approval: text("待审批", "Awaiting approval"),
    rejected: text("已拒绝", "Rejected"),
    queued: text("已排队", "Queued"),
    running: text("运行中", "Running"),
    cancelling: text("正在取消", "Cancelling"),
    cancelled: text("已取消", "Cancelled"),
    failed: text("失败", "Failed"),
    skipped: text("已跳过", "Skipped"),
    interrupted: text("已中断", "Interrupted"),
    needs_attention: text("待处理", "Needs attention"),
    submitted: text("运行记录不可用", "Run record unavailable"),
    completed: text("已完成", "Completed"),
  };
  const liveCancellationStatus =
    liveConversationId &&
    (selectedRun?.state === "cancelling" || selectedRun?.state === "cancelled")
      ? runLabels[selectedRun.state]
      : undefined;
  const runReasons: Record<string, string> = {
    authorization_required: text(
      "账户登录已失效，请重新登录后恢复计划。",
      "Sign in again, then resume the schedule.",
    ),
    cloud_execution_unavailable: text(
      "当前服务暂不支持从桌面启用云端任务。你可以在网页端用同一账户操作。",
      "Cloud execution from the desktop is unavailable. You can use the same account on the web.",
    ),
    schedule_project_unavailable: text(
      "所选项目或结果对话的项目归属已变更。请编辑任务并核对项目。",
      "The selected project or result chat's project changed. Review the project's settings on this task.",
    ),
    cloud_schedules_disabled: text("云端定时触发暂不可用。", "Cloud scheduling is unavailable."),
    request_conflict: text(
      "任务或运行状态已变化。请刷新核对后重试。",
      "The task or run has changed. Refresh to check, then try again.",
    ),
    run_active: text("已有运行正在进行。", "A run is already in progress."),
    account_queue_full: text(
      "账户队列已满。请等待已有任务完成后再试。",
      "The account queue is full. Wait for an existing task to finish and try again.",
    ),
    missed: text("已超过五分钟补发窗口。", "The five-minute catch-up window has passed."),
    overlap: text("上一轮仍在运行。", "The previous run is still active."),
  };
  function cloudWriteMessage(cause: unknown) {
    if (requiresCloudSignIn(cause))
      return text("请重新登录后再操作云端任务。", "Sign in again to manage cloud tasks.");
    if (cause instanceof ScheduleRequestError) {
      if (cause.reason && Object.hasOwn(runReasons, cause.reason)) return runReasons[cause.reason];
      if (cause.status === 400)
        return text("请检查任务设置后重试。", "Check the task settings and try again.");
      if (cause.status === 404)
        return text("该任务或运行已不可用。", "This task or run is no longer available.");
      if (cause.status === 413)
        return text(
          "任务内容超过大小限制。请缩短说明或减少资料后重试。",
          "The task exceeds the size limit. Shorten the instructions or remove resources and try again.",
        );
    }
    return text(
      "暂时无法确认云端任务操作结果。请刷新核对。",
      "The cloud task operation could not be confirmed. Refresh to check.",
    );
  }
  function deviceRunStatus(run: (typeof deviceRuns)[number]) {
    if (run.terminationReason === "cancelled") return runLabels.cancelled;
    if (run.state === "done") return run.success ? labels.completed : runLabels.failed;
    if (run.state === "leased") return runLabels.running;
    return run.state === "expired" ? runLabels.interrupted : runLabels.pending;
  }
  const taskDetailsLabel = text("任务详情", "Task details");
  const taskDetailsButton = (
    <TooltipButton
      ref={taskDetailsTrigger}
      data-cloud-task-details-trigger=""
      size="icon"
      variant="ghost"
      title={taskDetailsLabel}
      aria-label={taskDetailsLabel}
      aria-expanded={taskDetailsOpen}
      aria-haspopup={isMobile ? "dialog" : undefined}
      aria-controls={taskDetailsOpen ? taskDetailsId : undefined}
      className={`max-md:size-11 @min-[36rem]:w-auto @min-[36rem]:gap-1.5 @min-[36rem]:px-2.5 ${taskDetailsOpen ? "bg-muted" : ""}`}
      onClick={(event) => {
        taskDetailsReturnFocus.current = true;
        setTaskDetailsOpen(!taskDetailsOpen);
        if (!isMobile && !taskDetailsOpen && event.detail === 0) {
          requestAnimationFrame(() => {
            const panel = document.getElementById(taskDetailsId);
            const firstAction = panel?.querySelector<HTMLElement>(
              "button:not([disabled]), summary",
            );
            (firstAction ?? panel)?.focus({ preventScroll: true });
          });
        }
      }}
    >
      <Settings2 aria-hidden="true" className="size-4" />
    </TooltipButton>
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit list retry refreshes remote summaries.
  useEffect(() => {
    if (!schedules) return;
    const client = schedules;
    const abort = new AbortController();
    let timer: number;
    async function load() {
      const devices = JSON.parse(onlineDevices) as string[];
      for (let index = 0; index < devices.length && !abort.signal.aborted; index += 4) {
        await Promise.all(
          devices.slice(index, index + 4).map(async (id) => {
            try {
              const { tasks } = await client.deviceSummary(id, abort.signal);
              if (!abort.signal.aborted) {
                setRemoteSummaries((current) => ({
                  ...current,
                  [id]: { items: tasks, readAt: new Date().toISOString() },
                }));
              }
            } catch (cause) {
              if (!abort.signal.aborted) {
                setRemoteSummaries((current) => {
                  const previous =
                    cause instanceof ScheduleRequestError && cause.status === 404
                      ? undefined
                      : current[id];
                  return {
                    ...current,
                    [id]: {
                      items: previous?.items ?? [],
                      readAt: previous?.readAt,
                      unavailable: true,
                    },
                  };
                });
              }
            }
          }),
        );
      }
      if (!abort.signal.aborted && devices.length)
        timer = window.setTimeout(() => void load(), 30_000);
    }
    void load();
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [onlineDevices, remoteRefresh, schedules]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Completion may add resources to a run already read for its anchor.
  useEffect(() => {
    if (
      !runClient ||
      !runDetailsKey ||
      !selectedCloudRunId ||
      !selectedConversationId ||
      !runDetailsExpected
    )
      return;
    const abort = new AbortController();
    const markUnavailable = () => {
      if (abort.signal.aborted) return;
      setRunResources((current) => ({
        key: runDetailsKey,
        attempt: runDetailsAttempt,
        items: current?.key === runDetailsKey ? current.items : [],
        messageId: current?.key === runDetailsKey ? current.messageId : undefined,
        error: true,
      }));
    };
    const deadline = window.setTimeout(() => {
      markUnavailable();
      abort.abort();
    }, 8_000);
    void runClient
      .getRun(selectedCloudRunId, abort.signal)
      .then((run) => {
        if (abort.signal.aborted) return;
        if (run.id !== selectedCloudRunId || run.conversation_id !== selectedConversationId)
          throw new Error("The run does not belong to the selected result conversation");
        const resources = new Map<string, CloudChatPresentationResource>();
        for (const block of run.presentation?.blocks ?? []) {
          for (const item of block.resources ?? []) {
            if (item.role !== "input" && item.kind !== "extension-draft")
              resources.set(`${item.kind}:${item.id}`, item);
          }
        }
        restoreRunDetailsFocus();
        setRunResources({
          key: runDetailsKey,
          attempt: runDetailsAttempt,
          items: [...resources.values()],
          messageId: run.user_message_id || run.assistant_message_id || undefined,
        });
      })
      .catch(markUnavailable)
      .finally(() => window.clearTimeout(deadline));
    return () => {
      window.clearTimeout(deadline);
      abort.abort();
    };
  }, [
    cloudJumpKey,
    runClient,
    runDetailsAttempt,
    runDetailsExpected,
    runDetailsKey,
    selectedCloudRunId,
    selectedConversationId,
    terminal,
  ]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A mutation requests an immediate reload.
  useEffect(() => {
    if (!schedules) {
      setItems(null);
      setLoadError("");
      return;
    }
    const client = schedules;
    const abort = new AbortController();
    cloudPlanRead.current = abort;
    let timer: number;
    async function load() {
      try {
        const snapshot = await readCloudChatRunView(abort.signal, (signal) => client.list(signal));
        if (abort.signal.aborted) return;
        setItems(snapshot);
        setLoadError("");
        const taskId = route.id;
        if (
          !taskId ||
          (route.target && route.target !== "cloud") ||
          !snapshot.tasks.some((item) => item.id === taskId)
        )
          return;
        let runs: ScheduleRun[] | undefined;
        let historyError: string | undefined;
        try {
          ({ runs } = await readCloudChatRunView(abort.signal, (signal) =>
            client.runs(taskId, signal),
          ));
          if (!abort.signal.aborted) restoreMobileHistoryFocus();
        } catch (cause) {
          historyError = requiresCloudSignIn(cause)
            ? text("请重新登录以读取运行记录。", "Sign in again to read run history.")
            : text("暂时无法读取运行记录。", "Run history is temporarily unavailable.");
        }
        if (abort.signal.aborted) return;
        const occurrence = runs?.some((run) => run.id === route.run) ? undefined : route.run;
        if (route.run && !occurrence) restoreSelectedCloudRunFocus();
        setHistory((current) => {
          const cached = current.owner === owner && current.task === taskId ? current : undefined;
          const previousExact = cached?.exact;
          return {
            owner,
            task: taskId,
            runs: runs ?? cached?.runs ?? [],
            exact: occurrence && previousExact?.id === occurrence ? previousExact : undefined,
            error: historyError,
          };
        });
        if (!occurrence) return;
        try {
          const { run } = await readCloudChatRunView(abort.signal, (signal) =>
            client.readRun(taskId, occurrence, signal),
          );
          if (run?.id !== occurrence) throw new Error("Unexpected schedule run identity");
          if (abort.signal.aborted) return;
          restoreSelectedCloudRunFocus();
          setHistory((current) => ({
            ...current,
            runs: current.runs.map((item) => (item.id === occurrence ? run : item)),
            exact: { id: occurrence, run },
          }));
        } catch (cause) {
          if (abort.signal.aborted) return;
          const notFound =
            cause instanceof ScheduleRequestError &&
            !(cause instanceof ScheduleEndpointUnavailableError) &&
            cause.status === 404;
          setHistory((current) => ({
            ...current,
            runs: notFound ? current.runs.filter((item) => item.id !== occurrence) : current.runs,
            exact: notFound
              ? { id: occurrence }
              : {
                  id: occurrence,
                  run: current.exact?.id === occurrence ? current.exact.run : undefined,
                  error: requiresCloudSignIn(cause)
                    ? text("请重新登录以读取所选运行。", "Sign in again to read the selected run.")
                    : text("暂时无法读取所选运行。", "Couldn't read the selected run."),
                },
          }));
        }
      } catch (cause) {
        if (!abort.signal.aborted)
          setLoadError(
            requiresCloudSignIn(cause)
              ? text("请重新登录以读取云端任务。", "Sign in again to read cloud tasks.")
              : text("暂时无法读取云端任务。", "Cloud tasks are temporarily unavailable."),
          );
      } finally {
        if (!abort.signal.aborted) timer = window.setTimeout(() => void load(), 5000);
      }
    }
    void load();
    return () => {
      abort.abort();
      if (cloudPlanRead.current === abort) cloudPlanRead.current = null;
      window.clearTimeout(timer);
    };
  }, [refresh, route.id, route.run, route.target, schedules, locale, owner]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A mutation requests an immediate reload.
  useEffect(() => {
    if (!device) return;
    let current = true;
    let timer: number;
    async function load() {
      try {
        if (!device) return;
        const next = await device.list();
        if (!current) return;
        setDeviceSnapshot({ host: device, items: next, readAt: Date.now() });
        setDeviceFailure("");
        if (onDevice && route.id && next.tasks.some((item) => item.id === route.id)) {
          const task = route.id;
          const target = device.targetId;
          try {
            const runs = await device.runs(task);
            if (current) {
              restoreDeviceRunFocus(runs);
              setDeviceHistory({ owner, target, task, runs });
            }
          } catch {
            if (current)
              setDeviceHistory((previous) => ({
                owner,
                target,
                task,
                runs:
                  previous?.owner === owner && previous.target === target && previous.task === task
                    ? previous.runs
                    : [],
                error: true,
              }));
          }
        }
      } catch (cause) {
        if (current) setDeviceFailure(message(cause));
      } finally {
        if (current) timer = window.setTimeout(() => void load(), onDevice ? 5000 : 30_000);
      }
    }
    void load();
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [device, onDevice, owner, refresh, route.id]);

  async function write(action: () => Promise<void>, errorMessage = message) {
    if (currentWrite.current) return;
    currentWrite.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      currentWrite.current = false;
      setBusy(false);
      setRefresh((value) => value + 1);
    }
  }

  const writeCloud = (action: () => Promise<void>) => write(action, cloudWriteMessage);

  function newTask(prompt = "", research = false, fromDevice?: DeviceScheduleDraft) {
    const target =
      (fromDevice || prompt) && items?.enabled ? "cloud" : (scope ?? defaultCreationTarget);
    if (
      device &&
      renderDeviceEditor &&
      !deviceFailure &&
      (target === device.targetId || (!items?.enabled && !target))
    ) {
      openDeviceEditor(undefined, prompt);
      return;
    }
    setEditor({
      id: fromDevice?.id ?? createUuid(),
      target,
      input: {
        name: fromDevice?.name ?? "",
        rule: {
          frequency: "daily",
          ...defaultScheduleClock(),
        },
        run: {
          model: currentModel.model,
          provider_key_id: currentModel.keyId,
          content: prompt,
          public_research: research ? { topic: "" } : undefined,
        },
        new_conversation: false,
        notification: "attention",
      },
    });
  }

  function openDeviceEditor(task?: CronTask, prompt?: string, seed?: DeviceScheduleDraft) {
    leaveMobileTaskDetails(false);
    setError("");
    setEditor(undefined);
    setDeviceEditor({ id: task?.id ?? seed?.id ?? createUuid(), task, name: seed?.name, prompt });
  }

  const deviceRunDisabled =
    !!deviceFailure ||
    busy ||
    deviceRunAwaitingRecord ||
    (!pendingDeviceRun && deviceRuns.some(isCronRunActive));
  const deviceRunLabel = pendingDeviceRun
    ? text("核对运行", "Check run")
    : text("立即运行", "Run now");

  function runDeviceTask(item: CronTask) {
    if (!device || !deviceRunKey || item.id !== deviceTask?.id || deviceRunDisabled) return;
    void write(async () => {
      const prior = sessionStorage.getItem(deviceRunKey);
      const executionId = prior ?? `manual-${createUuid()}`;
      if (!prior) sessionStorage.setItem(deviceRunKey, executionId);
      setMissingDeviceRun(undefined);
      const receipt = await (prior
        ? device.readRunReceipt(item.id, executionId)
        : device.runNowOnce(item.id, executionId)
      ).catch(() => null);
      if (!receipt || sessionStorage.getItem(deviceRunKey) !== executionId) return;
      const current = currentRunView.current;
      const sameSelection = current?.device === deviceRunSelection;
      if (receipt.status === "unsupported") {
        if (!prior) sessionStorage.removeItem(deviceRunKey);
        if (!sameSelection) return;
        throw new Error(
          text("请更新所选设备后再运行。", "Update the selected device before running the task."),
        );
      }
      if (receipt.status === "rejected" && !prior) {
        sessionStorage.removeItem(deviceRunKey);
        if (!sameSelection) return;
        throw new Error(
          text(
            "设备未接受运行。请检查任务状态后重试。",
            "The device did not accept the run. Check the task state and try again.",
          ),
        );
      }
      if (receipt.status === "missing" && prior) {
        if (sameSelection) setMissingDeviceRun(executionId);
        return;
      }
      if (!sameSelection || receipt.status !== "admitted" || receipt.executionId !== executionId)
        return;
      sessionStorage.removeItem(deviceRunKey);
      setManualDeviceRun(executionId);
      current.onNavigate({ ...current.route, run: executionId });
    });
  }

  function dismissDeviceRunCheck() {
    if (!deviceRunKey || !pendingDeviceRun || missingDeviceRun !== pendingDeviceRun) return;
    void write(async () => {
      const confirmed = await confirm({
        title: text("结束本次核对？", "Stop checking this run?"),
        description: text(
          "设备未找到这次运行的回执。结束核对后，再点立即运行会发起一次新执行。",
          "The device has no receipt for this run. If you select Run now later, it starts a new execution.",
        ),
        confirmLabel: text("结束核对", "Stop checking"),
        cancelLabel: text("继续核对", "Keep checking"),
        preferCancel: true,
        touchActions: true,
      });
      if (!confirmed || sessionStorage.getItem(deviceRunKey) !== pendingDeviceRun) return;
      sessionStorage.removeItem(deviceRunKey);
      setMissingDeviceRun(undefined);
    });
  }

  function deviceTaskMenu(item: CronTask, showRunActions = false) {
    if (!device) return null;
    const selected = item.id === deviceTask?.id;
    return (
      <>
        <DropdownMenuItem
          disabled={!!deviceFailure || busy || item.remainingExecutions === 0}
          onClick={() =>
            void write(async () => {
              await device.toggle(item);
            })
          }
        >
          {item.enabled ? <Pause /> : <Play />}
          {item.enabled ? text("暂停", "Pause") : text("继续", "Resume")}
        </DropdownMenuItem>
        {(showRunActions || !sidebarOnly) && (
          <DropdownMenuItem
            disabled={selected ? deviceRunDisabled : Boolean(deviceFailure || busy)}
            onClick={() => requestTaskRun(device.targetId, item.id)}
          >
            <RefreshCw />
            {selected ? deviceRunLabel : text("立即运行", "Run now")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={!!deviceFailure || busy || !renderDeviceEditor}
          onClick={() => openDeviceEditor(item)}
        >
          <SquarePen />
          {text("编辑", "Edit")}
        </DropdownMenuItem>
        {route.deviceView && (
          <DropdownMenuItem onClick={() => void copyTaskLink(device.targetId, item.id)}>
            <Link2 />
            {text("分享", "Share")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive data-[highlighted]:text-destructive"
          disabled={!!deviceFailure || busy}
          onClick={() =>
            void write(async () => {
              const confirmed = await confirm({
                title: text(`删除「${item.name}」？`, `Delete “${item.name}”?`),
                description: text(
                  "此设备会停止后续定时运行并移除任务运行记录。已经生成的结果对话仍可查看。",
                  "This device will stop future scheduled runs and remove the run history. Existing result conversations remain available.",
                ),
                confirmLabel: text("删除定时任务", "Delete scheduled task"),
                cancelLabel: text("取消", "Cancel"),
                preferCancel: true,
              });
              if (!confirmed) return;
              await device.remove(item);
              if (!onDevice || item.id !== route.id) return;
              if (deviceRun?.sessionId && onOpenDeviceConversation) {
                onOpenDeviceConversation(deviceRun.sessionId);
              } else {
                backToList();
              }
            })
          }
        >
          <Trash2 />
          {text("删除", "Delete")}
        </DropdownMenuItem>
      </>
    );
  }

  function runNow(task: Schedule) {
    if (!schedules || !pendingRunKey || currentWrite.current) return;
    const prior = sessionStorage.getItem(pendingRunKey);
    if (
      !prior &&
      (!items?.enabled || cloudHistoryLoading || cloudRunBusy || manualRunAwaitingRecord)
    )
      return;
    const request = prior ?? createUuid();
    if (!prior) sessionStorage.setItem(pendingRunKey, request);
    void writeCloud(async () => {
      setCloudRunFeedback({ request, state: prior ? "checking" : "submitting" });
      try {
        const receipt = prior
          ? await schedules.readRunReceipt(task.id, request)
          : { status: "admitted" as const, id: (await schedules.run(task.id, request)).id };
        if (sessionStorage.getItem(pendingRunKey) !== request) return;
        if (receipt?.status === "missing") {
          setCloudRunFeedback({ request, state: "missing" });
          return;
        }
        if (receipt?.status !== "admitted" || typeof receipt.id !== "string" || !receipt.id)
          throw new Error("Invalid cloud run receipt");
        const current = currentRunView.current;
        if (current?.cloud !== cloudRunSelection) return;
        sessionStorage.removeItem(pendingRunKey);
        setManualCloudRun({
          owner,
          taskId: task.id,
          runId: receipt.id,
          previousConversationId: task.new_conversation ? undefined : liveConversationId,
        });
        current.onNavigate({ ...current.route, id: task.id, run: receipt.id });
      } catch (cause) {
        if (sessionStorage.getItem(pendingRunKey) !== request) return;
        if (
          !prior &&
          cause instanceof ScheduleRequestError &&
          [400, 401, 403, 404, 409, 413, 422].includes(cause.status)
        ) {
          sessionStorage.removeItem(pendingRunKey);
          if (currentRunView.current?.cloud === cloudRunSelection) throw cause;
          return;
        }
        if (prior)
          setCloudRunFeedback({
            request,
            state: requiresCloudSignIn(cause) ? "sign-in" : "unavailable",
          });
      } finally {
        setCloudRunFeedback((current) =>
          current?.request === request &&
          (current.state === "submitting" || current.state === "checking")
            ? undefined
            : current,
        );
      }
    });
  }

  function dismissCloudRunCheck() {
    if (!pendingRunKey || !pendingCloudRun || cloudRunFeedbackState !== "missing") return;
    void writeCloud(async () => {
      const confirmed = await confirm({
        title: text("结束本次核对？", "Stop checking this run?"),
        description: text(
          "原提交仍可能完成。结束核对后，再点立即运行会发起一次新请求。",
          "The original submission may still finish. If you stop checking, the next Run now starts a new execution.",
        ),
        confirmLabel: text("结束核对", "Stop checking"),
        cancelLabel: text("继续核对", "Keep checking"),
        preferCancel: true,
        touchActions: true,
      });
      if (
        !confirmed ||
        currentRunView.current?.cloud !== cloudRunSelection ||
        sessionStorage.getItem(pendingRunKey) !== pendingCloudRun
      )
        return;
      sessionStorage.removeItem(pendingRunKey);
      setCloudRunFeedback(undefined);
    });
  }

  function cancelCloudRun(task: Schedule, run: ScheduleRun) {
    if (!schedules) return;
    return writeCloud(async () => {
      if (run.run_id) await schedules.cancel(run.run_id);
      else await schedules.cancelPending(task.id, run.id);
    });
  }

  function openCloudEditor(item: Schedule, resumeAfterEdit = false, editSources = false) {
    leaveMobileTaskDetails(false);
    setEditor({
      existing: item,
      input: taskInput(item),
      id: createUuid(),
      resumeAfterEdit,
      editSources,
    });
  }

  function acceptCloudPlan(existing: Schedule | undefined, saved: Schedule | undefined) {
    const active = currentRunView.current;
    if (
      active?.owner !== owner ||
      active.cloud.schedules !== schedules ||
      !saved?.id ||
      !Number.isSafeInteger(saved.revision) ||
      (existing && (saved.id !== existing.id || saved.revision <= existing.revision))
    )
      return;
    cloudPlanRead.current?.abort();
    setItems((current) => {
      if (!current) return current;
      const previous = current.tasks.find((item) => item.id === saved.id);
      if (previous && previous.revision > saved.revision) return current;
      const confirmed = { ...saved, latest_state: saved.latest_state ?? previous?.latest_state };
      return {
        ...current,
        tasks: previous
          ? current.tasks.map((item) => (item.id === saved.id ? confirmed : item))
          : [confirmed, ...current.tasks],
      };
    });
  }

  function toggleCloudSchedule(item: Schedule) {
    if (!schedules) return;
    const view = currentRunView.current?.cloud;
    const input = taskInput(item);
    void writeCloud(async () => {
      if (!item.enabled) {
        const next = await schedules
          .preview(input.rule, item.admitted, AbortSignal.timeout(15_000))
          .catch((cause: unknown) => {
            if (currentRunView.current?.cloud !== view) return;
            if (cause instanceof ScheduleRequestError && cause.status === 400) {
              openCloudEditor(item, true);
              return;
            }
            setError(
              requiresCloudSignIn(cause)
                ? text("请重新登录后恢复计划。", "Sign in again to resume the schedule.")
                : text(
                    `暂时无法检查「${item.name}」的下次运行时间。请重试恢复。`,
                    `Couldn't check the next run for “${item.name}”. Try resuming again.`,
                  ),
            );
          });
        if (!next || currentRunView.current?.cloud !== view) return;
        if (!next.next_at) {
          openCloudEditor(item, true);
          return;
        }
      }
      const saved = await schedules.save(input, !item.enabled, createUuid(), item);
      acceptCloudPlan(item, saved);
    });
  }

  const cloudRunDisabled =
    busy ||
    (!pendingCloudRun &&
      (!items?.enabled || cloudHistoryLoading || cloudRunBusy || manualRunAwaitingRecord));
  const cloudRunLabel = pendingCloudRun
    ? text("核对运行", "Check run")
    : text("立即运行", "Run now");

  function requestTaskRun(target: string, id: string) {
    if (busy || currentWrite.current) return;
    if (id === route.id && target === (route.target ?? "cloud")) {
      if (target === "cloud" && task?.id === id && !cloudRunDisabled) runNow(task);
      else if (deviceTask?.id === id) runDeviceTask(deviceTask);
      return;
    }
    setRequestedRowRun({ owner, target, id, fromId: route.id, fromTarget: route.target });
    onNavigate({ ...route, id, target, run: undefined, reader: undefined });
  }

  const submitRowRun = useEffectEvent(() => {
    if (requestedRowRun?.target === "cloud") {
      if (task && !cloudRunDisabled) runNow(task);
    } else if (deviceTask && !deviceRunDisabled) {
      runDeviceTask(deviceTask);
    }
  });
  useEffect(() => {
    if (!requestedRowRun) return;
    const { id, target, fromId, fromTarget } = requestedRowRun;
    const matches = id === route.id && target === (route.target ?? "cloud");
    if (
      requestedRowRun.owner !== owner ||
      (!matches && (route.id !== fromId || route.target !== fromTarget))
    ) {
      setRequestedRowRun(undefined);
      return;
    }
    if (!matches) return;
    const ready =
      target === "cloud"
        ? task?.id === id && !cloudHistoryLoading
        : deviceTask?.id === id && Boolean(currentDeviceHistory || deviceFailure);
    if (!ready) return;
    if (target === "cloud" ? !cloudHistoryError : !deviceHistoryUnavailable) submitRowRun();
    setRequestedRowRun(undefined);
  }, [
    requestedRowRun,
    owner,
    route.id,
    route.target,
    task?.id,
    deviceTask?.id,
    cloudHistoryLoading,
    cloudHistoryError,
    currentDeviceHistory,
    deviceHistoryUnavailable,
    deviceFailure,
  ]);

  async function copyTaskLink(target: string, id: string) {
    const origin =
      taskLinkOrigin ??
      (defaultCreationTarget === "local" || !/^https?:$/.test(window.location.protocol)
        ? OFFICIAL_GATEWAY_URL
        : window.location.origin);
    const base = new URL(origin);
    const href = cloudChatRouteHref(
      { page: "tasks", id, target, deviceView: target !== "cloud" ? true : undefined },
      base,
    );
    if (await copyTextToClipboard(new URL(href, base).href)) {
      toast.success(text("已复制任务链接", "Task link copied"));
    } else {
      toast.error(text("无法复制任务链接", "Couldn't copy the task link"));
    }
  }

  function cloudTaskMenu(item: Schedule, showRunActions = false) {
    const selected = item.id === task?.id;
    return (
      <>
        {(!item.enabled || item.next_at) && (
          <DropdownMenuItem
            disabled={!schedules || !items?.enabled || busy}
            onClick={() => toggleCloudSchedule(item)}
          >
            {item.enabled ? <Pause /> : <Play />}
            {item.enabled ? text("暂停", "Pause") : text("继续", "Resume")}
          </DropdownMenuItem>
        )}
        {(showRunActions || !sidebarOnly) && (
          <DropdownMenuItem
            disabled={selected ? cloudRunDisabled : !items?.enabled || busy}
            onClick={() => requestTaskRun("cloud", item.id)}
          >
            <RefreshCw />
            {selected ? cloudRunLabel : text("立即运行", "Run now")}
          </DropdownMenuItem>
        )}
        {showRunActions && cancelableCloudRun && (
          <DropdownMenuItem
            disabled={busy}
            onClick={() => void cancelCloudRun(item, cancelableCloudRun)}
          >
            {text("取消本次运行", "Cancel this run")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={!items?.enabled || busy} onClick={() => openCloudEditor(item)}>
          <SquarePen />
          {text("编辑", "Edit")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void copyTaskLink("cloud", item.id)}>
          <Link2 />
          {text("分享", "Share")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive data-[highlighted]:text-destructive"
          disabled={busy || !schedules}
          onClick={() => {
            if (!schedules) return;
            void writeCloud(async () => {
              if (
                !(await confirm({
                  title: text(`删除「${item.name}」？`, `Delete “${item.name}”?`),
                  description: text(
                    "删除会停止后续定时运行，已经生成的结果对话仍可查看。",
                    "Deleting stops future scheduled runs. Existing result conversations remain available.",
                  ),
                  confirmLabel: text("删除定时任务", "Delete scheduled task"),
                  cancelLabel: text("取消", "Cancel"),
                  preferCancel: true,
                }))
              )
                return;
              await schedules.remove(item.id);
              if (item.id === route.id) {
                if (selectedConversationId) onOpenConversation(selectedConversationId);
                else backToList();
              }
            });
          }}
        >
          <Trash2 />
          {text("删除", "Delete")}
        </DropdownMenuItem>
      </>
    );
  }

  const repeatLabel = (rule: ScheduleRule) => {
    if (isWorkdaySchedule(rule)) return text("工作日", "Weekdays");
    return {
      once: text("一次", "Once"),
      daily: text("每天", "Daily"),
      weekly: text("每周", "Weekly"),
      monthly: text("每月", "Monthly"),
      interval: text("按间隔", "At intervals"),
    }[rule.frequency];
  };
  const groups = route.statuses ?? (route.status ? [route.status] : taskStatuses);
  const cloudRows: TaskRow[] =
    !scope || scope === "cloud"
      ? (items?.tasks ?? []).map((item) => {
          const latest = item.latest_state;
          const attention =
            latest &&
            [
              "failed",
              "skipped",
              "interrupted",
              "needs_attention",
              "awaiting_approval",
              "submitted",
            ].includes(latest);
          const showNotice =
            latest === "awaiting_approval" ||
            (item.notification !== "none" &&
              (attention || (latest === "completed" && item.notification === "all")));
          return {
            id: item.id,
            target: "cloud",
            name: item.name,
            group: status(item),
            secondary: [
              item.next_at ? time(item.next_at, item.rule.time_zone) : labels[status(item)],
              item.rule && repeatLabel(item.rule),
              showNotice && latest ? runLabels[latest] : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
          };
        })
      : [];
  const deviceRows: TaskRow[] =
    device && deviceTasks && (!scope || scope === device.targetId)
      ? deviceTasks.tasks.map((item) => {
          const group = devicePlanStatus(item);
          const next = deviceTasks.next[item.id];
          return {
            id: item.id,
            target: device.targetId,
            name: item.name,
            group,
            secondary: `${device.label} · ${next ? time(new Date(next).toISOString(), deviceTasks.timeZone) : labels[group]}`,
          };
        })
      : [];
  const remoteRows: TaskRow[] = environments.flatMap((environment) => {
    const target = environment.device_id;
    if (!target || (scope && scope !== target)) return [];
    const summary = remoteSummaries[target];
    return (summary?.items ?? []).map((item) => ({
      id: item.id,
      target,
      name: item.name,
      group: item.status,
      secondary: `${environment.name} · ${
        !environment.online || summary.unavailable
          ? text("上次读取", "Last read")
          : item.next_at
            ? time(new Date(item.next_at).toISOString())
            : labels[item.status]
      }`,
    }));
  });
  const taskRows = [...cloudRows, ...deviceRows, ...remoteRows].filter(
    (item) =>
      groups.includes(item.group) && item.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const statusFiltered = groups.length < taskStatuses.length;
  const filtersActive = !!(query.trim() || statusFiltered || scope);
  const cloudInScope = includeCloud && (!scope || scope === "cloud");
  const localInScope = !!device && (!scope || scope === device.targetId);
  const remoteInScope = environments.flatMap(({ runtime_kind, device_id, online }) =>
    runtime_kind === "device_agent" && device_id && (!scope || scope === device_id)
      ? [{ id: device_id, online }]
      : [],
  );
  const listLoading =
    (cloudInScope && !items && !loadError && (!!schedules || !onRetryCloud)) ||
    (localInScope && !deviceTasks && !deviceFailure) ||
    (!!schedules && remoteInScope.some(({ id, online }) => online && !remoteSummaries[id]));
  const mobileListKey = JSON.stringify([
    owner,
    includeCloud,
    device?.targetId,
    scope,
    groups,
    query,
  ]);
  useLayoutEffect(() => {
    const saved = mobileListReturn.current;
    if (!saved) return;
    if (saved.key !== mobileListKey) {
      mobileListReturn.current = undefined;
      return;
    }
    const viewport = mobileListViewport.current;
    if (!isMobile || route.id || openMobile || !viewport) return;
    const row = [...viewport.querySelectorAll<HTMLElement>("[data-mobile-task-row]")].find(
      (item) => item.dataset.mobileTaskRow === saved.row,
    );
    if (!row && listLoading) return;
    mobileListReturn.current = undefined;
    viewport.scrollTop = row
      ? viewport.scrollTop +
        row.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        saved.offset
      : saved.top;
    if (document.activeElement === document.body)
      (row ?? filterButton.current)?.focus({ preventScroll: true });
  }, [isMobile, listLoading, mobileListKey, openMobile, route.id]);
  const listUnavailable =
    (!!scope && !cloudInScope && !localInScope && !remoteInScope.length) ||
    (cloudInScope && (!!loadError || (!schedules && !!onRetryCloud))) ||
    (localInScope && !!deviceFailure) ||
    remoteInScope.some(
      ({ id, online }) => !online || !schedules || remoteSummaries[id]?.unavailable,
    );
  const noMatches = !taskRows.length && filtersActive && !listLoading && !listUnavailable;
  const showMobileListOnly = isMobile && !route.id && (taskRows.length > 0 || noMatches);
  const canRetryCloud = cloudInScope && (!!loadError || (!schedules && !!onRetryCloud));
  const canRetryDevice = localInScope && !!deviceFailure;
  const canRetryRemote =
    !!schedules &&
    remoteInScope.some(({ id, online }) => online && remoteSummaries[id]?.unavailable);
  function retryCloudList() {
    if (onRetryCloud) {
      onRetryCloud();
      return;
    }
    setLoadError("");
    setRefresh((value) => value + 1);
  }
  function retryTaskLists() {
    if (canRetryCloud && onRetryCloud) onRetryCloud();
    if (canRetryCloud && !onRetryCloud) setLoadError("");
    if ((canRetryCloud && !onRetryCloud) || canRetryDevice) setRefresh((value) => value + 1);
    if (canRetryRemote) setRemoteRefresh((value) => value + 1);
  }
  const creationTargets: CreationTarget[] = [];
  if (device && renderDeviceEditor)
    creationTargets.push({
      id: device.targetId,
      label: device.label,
      ready: !deviceFailure,
      inline: true,
      open: (draft) => openDeviceEditor(undefined, draft.prompt, draft),
    });
  for (const environment of environments) {
    if (environment.runtime_kind !== "device_agent" || !environment.device_id) continue;
    creationTargets.push({
      id: environment.device_id,
      label: environment.name,
      ready: environment.online && environment.workspaces.length > 0,
      open: () =>
        onOpenDevice(environment, {
          page: "tasks",
          status: route.status,
          statuses: route.statuses,
        }),
    });
  }
  const templates = [
    [
      text("公开新闻简报", "Public news briefing"),
      text(
        "汇总最近一天值得关注的公开技术新闻并附来源。",
        "Summarize notable public technology news from the past day, with sources.",
      ),
      true,
      Globe,
    ],
    [
      text("资料周报", "Weekly reading summary"),
      text(
        "总结所选资料，列出本周的发现和待办事项。",
        "Summarize the selected files and list the week's findings and next actions.",
      ),
      false,
      BookOpen,
    ],
    [
      text("价格跟踪", "Price watch"),
      text(
        "查找我指定商品的公开价格，列出当前报价及来源。",
        "Check public prices for a product I specify and cite the listings.",
      ),
      true,
      ChartColumn,
    ],
    [
      text("安排周末", "Plan the weekend"),
      text(
        "查找我所在城市本周末的公开活动，整理时间、地点和来源。",
        "Find public events for this weekend in my city with times, locations, and sources.",
      ),
      true,
      CalendarDays,
    ],
    [
      text("安全动态", "Security updates"),
      text(
        "汇总最近一天的公开网络安全通告，标记需要优先处理的更新。",
        "Summarize the past day's public security advisories and prioritize the updates.",
      ),
      true,
      ShieldCheck,
    ],
    [
      text("学习计划", "Learning plan"),
      text(
        "根据我提供的主题制定一次可在 20 分钟内完成的练习。",
        "Plan a 20-minute practice session around a topic I provide.",
      ),
      false,
      Lightbulb,
    ],
  ] as const;
  const chooseScope = (value: string) =>
    onNavigate({
      ...route,
      target: route.id ? route.target : undefined,
      scope: value === "all" ? undefined : value,
    });
  const toggleStatus = (value: TaskStatus) => {
    const statuses = taskStatuses.filter((status) =>
      status === value ? !groups.includes(status) : groups.includes(status),
    );
    onNavigate({
      ...route,
      status: statuses.length === 1 ? statuses[0] : undefined,
      statuses: statuses.length === 0 || statuses.length === 2 ? statuses : undefined,
    });
  };
  function clearTaskFilters() {
    updateQuery("");
    onNavigate({
      ...route,
      scope: undefined,
      status: undefined,
      statuses: undefined,
      target: route.id ? route.target : undefined,
    });
    (searchOpen ? searchInput : filterButton).current?.focus({ preventScroll: true });
  }
  const targets = [
    { id: "all", label: text("所有执行位置", "All targets") },
    ...(schedules || onRetryCloud ? [{ id: "cloud", label: text("云端", "Cloud") }] : []),
    ...(device ? [{ id: device.targetId, label: device.label }] : []),
    ...environments.flatMap((environment) =>
      environment.runtime_kind === "device_agent" && environment.device_id
        ? [{ id: environment.device_id, label: environment.name }]
        : [],
    ),
  ];
  const filterLabel = text("筛选任务", "Filter tasks");
  const clearFiltersLabel = text("清除筛选", "Clear filters");
  const scopedTargetLabel = scope
    ? (targetLabel ?? text("执行位置不可用", "Execution target unavailable"))
    : undefined;
  const statusFilterLabel = statusFiltered
    ? groups.length
      ? groups.map((status) => labels[status]).join(text("、", ", "))
      : text("未选择状态", "No statuses selected")
    : undefined;
  const hasSidebarFilters = Boolean(scopedTargetLabel || statusFilterLabel);
  const showSidebarNoMatches = noMatches && (isMobile || Boolean(route.id));
  const showSearchReset =
    !hasSidebarFilters && !!query.trim() && !taskRows.length && !unavailable && !listLoading;
  const newTaskLabel = text("新建任务", "New task");
  const searchLabel = text("搜索任务", "Search tasks");
  const canCreate = items?.enabled || creationTargets.some((target) => target.ready);
  const cloudTaskLink = Boolean(
    includeCloud && route.id && (!route.target || route.target === "cloud"),
  );
  const cloudTaskLinkLoading =
    cloudTaskLink && !items && !loadError && Boolean(schedules || !onRetryCloud);
  const canRetryCloudTaskLink = cloudTaskLink && Boolean(loadError || (!schedules && onRetryCloud));
  const landing = route.id
    ? cloudTaskLinkLoading
      ? "loading"
      : "missing-task"
    : taskRows.length
      ? "browse"
      : listLoading
        ? "loading"
        : listUnavailable
          ? "unavailable"
          : noMatches
            ? "no-matches"
            : "empty";
  const landingCopy = {
    "missing-task": [
      text("暂时无法打开任务", "Task unavailable"),
      (cloudTaskLink && loadError) ||
        text("返回列表，或在连接恢复后重试。", "Return to the list or try again when connected."),
    ],
    browse: [
      text("安排任务", "Schedule tasks"),
      text(
        "为重复工作设定时间，回来查看每次运行的结果。",
        "Schedule recurring work and come back to view its results.",
      ),
    ],
    loading: [
      text("正在读取任务", "Loading tasks"),
      text("正在读取当前执行位置的任务。", "Getting tasks from the selected execution targets."),
    ],
    unavailable: [
      text("暂时无法读取任务", "Tasks are temporarily unavailable"),
      text(
        "检查连接，或筛选到其他执行位置。",
        "Check the connection or filter by a different execution target.",
      ),
    ],
    "no-matches": [
      text("没有匹配的任务", "No matching tasks"),
      text(
        "更改搜索或筛选条件，查看其他任务。",
        "Change your search or filters to see other tasks.",
      ),
    ],
    empty: canCreate
      ? [
          text("安排任务", "Schedule a task"),
          text(
            "为重复工作设定时间，回来查看每次运行的结果。",
            "Schedule recurring work and come back here to see the results.",
          ),
        ]
      : [
          text("还没有定时任务", "No scheduled tasks yet"),
          text(
            "连接可用的执行位置后即可新建任务。",
            "Connect an available execution target to create a task.",
          ),
        ],
  }[landing];
  const filterTrigger = (focusable: boolean) => (
    <TooltipButton
      ref={focusable ? filterButton : undefined}
      variant="ghost"
      size="icon-sm"
      className={`${isMobile ? "size-11" : "size-8"} shrink-0 rounded-lg text-muted-foreground hover:text-foreground data-[active=true]:bg-settings-active data-[active=true]:text-foreground`}
      title={filterLabel}
      aria-label={filterLabel}
      data-active={!!(scope || statusFiltered)}
    >
      <ListFilter className="size-4" />
    </TooltipButton>
  );
  const renderTaskListHeader = (focusable: boolean, inWorkbench: boolean) => {
    const actions = (
      <>
        {isMobile ? (
          <Dialog>
            <DialogTrigger render={filterTrigger(focusable)} />
            <DialogContent
              layout="bottom-sheet-mobile"
              showCloseButton
              closeLabel={text("关闭", "Close")}
            >
              <DialogHeader>
                <DialogTitle>{filterLabel}</DialogTitle>
                <DialogDescription>
                  {text("按状态或执行位置查看任务。", "Find tasks by status or execution target.")}
                </DialogDescription>
              </DialogHeader>
              <DialogBody className="space-y-3">
                <fieldset className="space-y-1">
                  <legend className="text-sm text-muted-foreground">
                    {text("状态", "Status")}
                  </legend>
                  {taskStatuses.map((status) => (
                    <label
                      key={status}
                      htmlFor={`task-filter-${status}`}
                      className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-2 text-sm"
                    >
                      {labels[status]}
                      <Checkbox
                        id={`task-filter-${status}`}
                        checked={groups.includes(status)}
                        onCheckedChange={() => toggleStatus(status)}
                      />
                    </label>
                  ))}
                </fieldset>
                <Select value={scope ?? "all"} onValueChange={chooseScope}>
                  <SelectTrigger
                    className="min-h-11"
                    aria-label={text("筛选执行位置", "Filter by target")}
                  >
                    <SelectValue>{scopedTargetLabel ?? targets[0].label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {targets.map(({ id, label }) => (
                      <SelectItem key={id} value={id}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </DialogBody>
              <DialogFooter>
                <DialogActions>
                  <DialogClose render={<Button />}>{text("完成", "Done")}</DialogClose>
                </DialogActions>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger render={filterTrigger(focusable)} />
            <DropdownMenuContent align="end" variant="soft" className="sidebar-context-menu">
              <DropdownMenuLabel>{text("状态", "Status")}</DropdownMenuLabel>
              {taskStatuses.map((status) => (
                <DropdownMenuCheckboxItem
                  key={status}
                  checked={groups.includes(status)}
                  closeOnClick={false}
                  onCheckedChange={() => toggleStatus(status)}
                >
                  {labels[status]}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{text("执行位置", "Runs on")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={scope ?? "all"} onValueChange={chooseScope}>
                {targets.map(({ id, label }) => (
                  <DropdownMenuRadioItem key={id} value={id}>
                    {label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <TooltipButton
          ref={focusable ? searchButton : undefined}
          variant="ghost"
          size="icon-sm"
          className={`${isMobile ? "size-11" : "size-8"} shrink-0 rounded-lg text-muted-foreground hover:text-foreground`}
          title={searchLabel}
          aria-label={searchLabel}
          aria-expanded={searchOpen}
          onClick={() => {
            if (searchOpen) closeSearch();
            else {
              setSearchOpen(true);
              requestAnimationFrame(() => searchInput.current?.focus());
            }
          }}
        >
          <Search className="size-4" />
        </TooltipButton>
        {inWorkbench ? null : isMobile ? (
          <SidebarTrigger
            showShortcut={false}
            className="size-11 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
            aria-label={
              openMobile ? text("关闭边栏", "Close sidebar") : text("打开导航", "Open navigation")
            }
          >
            {openMobile ? <X className="size-4" /> : <PanelLeft className="size-4" />}
          </SidebarTrigger>
        ) : (
          <SidebarTrigger
            showShortcut={!previewOpen}
            className="shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
            title={
              previewOpen ? text("固定边栏", "Pin sidebar") : text("收起边栏", "Collapse sidebar")
            }
            aria-label={
              previewOpen ? text("固定边栏", "Pin sidebar") : text("收起边栏", "Collapse sidebar")
            }
            onClick={(event) => {
              if (previewOpen && onPinSidebar) {
                event.preventDefault();
                onPinSidebar();
              }
            }}
          />
        )}
      </>
    );
    const title = (
      <h1 className="min-w-0 truncate text-base font-semibold leading-6">
        {text("定时任务", "Scheduled tasks")}
      </h1>
    );
    return inWorkbench && renderWorkbenchHeader ? (
      renderWorkbenchHeader({ title, actions })
    ) : (
      <SidebarHeaderRow actions={actions}>
        {!isMobile && (
          <TooltipButton
            variant="ghost"
            size="icon-sm"
            className="shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
            title={text("返回工作台", "Back to workbench")}
            aria-label={text("返回工作台", "Back to workbench")}
            data-cloud-view-navigation=""
            onClick={onBack}
          >
            <ArrowLeft className="size-4" />
          </TooltipButton>
        )}
        {title}
      </SidebarHeaderRow>
    );
  };
  const renderSidebarContents = (focusable: boolean, showCreate = true, mobileList = false) => (
    <>
      {mobileList && renderWorkbenchHeader && renderTaskListHeader(focusable, true)}
      <SidebarHeader className={mobileList ? "px-3 pb-2 pt-2.5" : undefined}>
        {!(mobileList && renderWorkbenchHeader) && renderTaskListHeader(focusable, false)}
        {searchOpen && (
          <SidebarInput
            ref={focusable ? searchInput : undefined}
            type="search"
            className={isMobile ? "mt-2 min-h-11" : "mt-2"}
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.stopPropagation();
              closeSearch();
            }}
            maxLength={120}
            placeholder={searchLabel}
            aria-label={searchLabel}
          />
        )}
      </SidebarHeader>
      {(showCreate || hasSidebarFilters) && (
        <div className="workbench-sidebar-list shrink-0 pb-2">
          {showCreate && (
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  variant="navigation"
                  className={`sidebar-list-row ${isMobile ? "min-h-11" : "min-h-9"}`}
                  disabled={!canCreate}
                  onClick={() => newTask()}
                >
                  <Plus className="size-4" />
                  <span>{newTaskLabel}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          )}
          {hasSidebarFilters && (
            <section
              aria-label={text("当前筛选", "Active filters")}
              className="mt-1 flex min-w-0 items-center gap-1 border-t border-border/60 pt-1.5"
            >
              <div className="min-w-0 flex-1 px-2 text-xs leading-4 text-muted-foreground">
                {scopedTargetLabel && (
                  <p className="truncate" title={scopedTargetLabel}>
                    {scopedTargetLabel}
                  </p>
                )}
                {statusFilterLabel && (
                  <p className="truncate" title={statusFilterLabel}>
                    {statusFilterLabel}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                className={`${isMobile ? "min-h-11" : "min-h-8"} h-auto shrink-0 whitespace-nowrap px-2 text-xs`}
                onClick={clearTaskFilters}
              >
                {clearFiltersLabel}
              </Button>
            </section>
          )}
        </div>
      )}
      <SidebarContent className="overflow-hidden">
        <div
          ref={mobileList ? mobileListViewport : undefined}
          className="za-native-scroll scroll-fade flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-(--workbench-sidebar-gutter,12px) pb-3"
        >
          {groups.map((group) => {
            const rows = taskRows.filter((item) => item.group === group);
            return rows.length ? (
              <SidebarGroup key={group} className="shrink-0 pb-2 pt-1">
                <SidebarGroupLabel
                  render={
                    <button
                      type="button"
                      aria-expanded={!collapsedGroups.has(group)}
                      className="group/status w-fit gap-1.5"
                      onClick={() =>
                        setCollapsedGroups((previous) => {
                          const next = new Set(previous);
                          if (next.has(group)) next.delete(group);
                          else next.add(group);
                          return next;
                        })
                      }
                    />
                  }
                  className="h-7 max-md:h-11"
                >
                  {labels[group]}
                  <ChevronDown
                    aria-hidden="true"
                    className={`size-3 ${collapsedGroups.has(group) ? "-rotate-90" : "[@media(hover:hover)]:opacity-0 group-hover/status:opacity-100 group-focus-visible/status:opacity-100"}`}
                  />
                </SidebarGroupLabel>
                <SidebarGroupContent hidden={collapsedGroups.has(group)}>
                  <SidebarMenu className="gap-px">
                    {rows.map((item) => {
                      const cloudItem =
                        item.target === "cloud"
                          ? items?.tasks.find(({ id }) => id === item.id)
                          : undefined;
                      const localItem =
                        item.target === device?.targetId
                          ? deviceTasks?.tasks.find(({ id }) => id === item.id)
                          : undefined;
                      const hasMenu = !!cloudItem || !!localItem;
                      const selected =
                        item.id === route.id && item.target === (route.target ?? "cloud");
                      const mobileRow = mobileList
                        ? JSON.stringify([item.target, item.id])
                        : undefined;
                      return (
                        <SidebarMenuItem key={`${item.target}:${item.id}`}>
                          <SidebarMenuButton
                            type="button"
                            variant="navigation"
                            isActive={selected}
                            aria-current={selected ? "page" : undefined}
                            data-mobile-task-row={mobileRow}
                            className={`h-auto min-w-0 py-1 ${isMobile ? "min-h-11 group-has-data-[sidebar=menu-action]/menu-item:pr-13" : "min-h-10 group-has-data-[sidebar=menu-action]/menu-item:pr-9"}`}
                            onClick={(event) => {
                              const viewport = mobileListViewport.current;
                              if (mobileRow && viewport) {
                                mobileListReturn.current = {
                                  key: mobileListKey,
                                  row: mobileRow,
                                  top: viewport.scrollTop,
                                  offset:
                                    event.currentTarget.getBoundingClientRect().top -
                                    viewport.getBoundingClientRect().top,
                                };
                              }
                              setOpenMobile(false);
                              if (selected) {
                                if (sidebarOnly) onNavigate(route);
                                return;
                              }
                              const previous = returnRun.current;
                              returnRun.current = undefined;
                              onNavigate({
                                ...route,
                                scope,
                                target: item.target,
                                id: item.id,
                                run:
                                  previous?.owner === owner &&
                                  previous.target === item.target &&
                                  previous.task === item.id
                                    ? previous.run
                                    : undefined,
                              });
                            }}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate" title={item.name}>
                                {item.name}
                              </span>
                              <span className="block truncate text-xs leading-4 font-normal text-muted-foreground">
                                {item.secondary}
                              </span>
                            </span>
                          </SidebarMenuButton>
                          {hasMenu && (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <SidebarMenuAction
                                    showOnHover={!isMobile}
                                    className={`top-1/2 -translate-y-1/2 rounded-lg text-muted-foreground peer-data-[size=default]/menu-button:top-1/2 ${isMobile ? "size-11 after:hidden" : "size-7"}`}
                                    aria-label={text(
                                      `${item.name} 的操作`,
                                      `Actions for ${item.name}`,
                                    )}
                                  >
                                    <MoreHorizontal className="size-4" />
                                  </SidebarMenuAction>
                                }
                              />
                              <DropdownMenuContent
                                align="end"
                                variant="soft"
                                className="sidebar-context-menu"
                              >
                                {cloudItem
                                  ? cloudTaskMenu(cloudItem)
                                  : localItem && deviceTaskMenu(localItem)}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ) : null;
          })}
          {(showSidebarNoMatches || showSearchReset) && (
            <EmptyState className="h-auto gap-2 px-2 py-7">
              {showSidebarNoMatches && <span>{text("没有匹配的任务", "No matching tasks")}</span>}
              {showSearchReset && (
                <Button
                  variant="ghost"
                  className={isMobile ? "min-h-11" : undefined}
                  size="sm"
                  onClick={clearTaskFilters}
                >
                  {clearFiltersLabel}
                </Button>
              )}
            </EmptyState>
          )}
          {!isMobile && landing === "empty" && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {text("还没有定时任务", "No scheduled tasks yet")}
            </p>
          )}
          {schedules && !items && !loadError && !onDevice ? (
            <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
              {text("正在读取云端任务", "Loading cloud tasks")}
            </p>
          ) : null}
          {items && !items.enabled && !onDevice ? (
            <p className="px-3 text-xs text-muted-foreground">
              {text("云端定时触发暂不可用", "Cloud scheduling is unavailable")}
            </p>
          ) : null}
          {deviceFailure && (
            <p className="px-3 text-xs text-muted-foreground" role="status">
              {text("设备任务暂不可读", "Device tasks are unavailable")}
              {deviceReadAt ? ` · ${time(new Date(deviceReadAt).toISOString())}` : ""}
            </p>
          )}
          {includeCloud && (!schedules || loadError) && (
            <StatusNotice
              compact
              tone={loadError || onRetryCloud ? "warning" : "info"}
              message={
                loadError ||
                (onRetryCloud
                  ? text("云端任务暂不可用", "Cloud tasks are unavailable")
                  : text("正在连接云端任务", "Connecting to cloud tasks"))
              }
              className="mt-2"
              actions={
                loadError || onRetryCloud ? (
                  <Button variant="ghost" size="sm" onClick={retryCloudList}>
                    {text("重试", "Retry")}
                  </Button>
                ) : undefined
              }
            />
          )}
        </div>
      </SidebarContent>
    </>
  );
  const stopDeviceRun = (run: CronRunRecord) => {
    const cancel = device?.cancel;
    if (!cancel || !deviceTask || busy || deviceFailure) return;
    void write(() => cancel(deviceTask.id, run.runId ?? run.id));
  };

  const cancelDeviceRun =
    device?.cancel && deviceTask && deviceRun && isCronRunActive(deviceRun) ? (
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || !!deviceFailure}
        onClick={() => stopDeviceRun(deviceRun)}
      >
        {text("取消本次运行", "Cancel this run")}
      </Button>
    ) : null;
  const navigation = (
    <Sidebar
      label={text("定时任务导航", "Scheduled task navigation")}
      previewOpen={previewOpen}
      mobileRail={mobileRail}
      data-sidebar-preview-region=""
      className="workbench-sidebar zone-font-scale"
      style={{ "--zone-font-scale": fontScale } as CSSProperties}
    >
      {renderSidebarContents(!isMobile || openMobile)}
    </Sidebar>
  );
  const showSidebarTrigger = !open && !isMobile && !hostSidebarTrigger;
  const cloudTaskHeader = task && (
    <TaskDetailHeader
      name={task.name}
      titleRef={taskTitle}
      target={text("云端", "Cloud")}
      planStatus={labels[status(task)]}
      text={text}
      leading={showSidebarTrigger && !renderWorkbenchHeader ? <SidebarTrigger /> : undefined}
      renderWorkbenchHeader={renderWorkbenchHeader}
      onBack={isMobile ? backToList : undefined}
      menu={cloudTaskMenu(task, Boolean(liveConversationId))}
      onShare={() => void copyTaskLink("cloud", task.id)}
    >
      {taskDetailsButton}
    </TaskDetailHeader>
  );
  return (
    <section
      aria-label={text("定时任务", "Scheduled tasks")}
      className={
        sidebarOnly
          ? "contents"
          : `flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background ${isMobile ? "flex-col" : ""}`
      }
    >
      {!hideSidebar &&
        (isMobile || sidebarTarget === undefined
          ? navigation
          : sidebarTarget && mountWorkbenchLayout(navigation, sidebarTarget, "account-sidebar"))}
      {!sidebarOnly && isMobile && !route.id && (
        <div
          className={`zone-font-scale flex min-h-0 min-w-0 flex-col bg-background ${showMobileListOnly ? "flex-1" : "shrink-0"}`}
          style={{ "--zone-font-scale": fontScale } as CSSProperties}
        >
          {renderSidebarContents(!openMobile, landing !== "empty" || !canCreate, true)}
        </div>
      )}
      {!sidebarOnly && (
        <div
          className={`@container min-h-0 min-w-0 flex-1 flex-col ${liveConversationId || deviceConversationId ? "overflow-hidden" : "overflow-auto"} ${showMobileListOnly ? "hidden" : "flex"}`}
        >
          {(!isMobile || route.id) && renderWorkbenchHeader && !(task && schedules) ? (
            renderWorkbenchHeader({})
          ) : showSidebarTrigger && !(task && schedules) ? (
            <div className="px-3 pt-2">
              <SidebarTrigger />
            </div>
          ) : null}
          {error && !editor ? (
            <div className="mx-auto w-full max-w-3xl px-4 pt-4">
              <StatusNotice
                compact
                tone="error"
                message={error}
                actions={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setError("");
                      setRefresh((value) => value + 1);
                    }}
                  >
                    {text("刷新核对", "Refresh to check")}
                  </Button>
                }
              />
            </div>
          ) : null}
          {deviceTask && device ? (
            <>
              <TaskDetailHeader
                name={deviceTask.name}
                titleRef={taskTitle}
                target={device.label}
                planStatus={labels[devicePlanStatus(deviceTask)]}
                text={text}
                onBack={isMobile ? backToList : undefined}
                menu={deviceTaskMenu(deviceTask, Boolean(deviceConversationId))}
              >
                {taskDetailsButton}
              </TaskDetailHeader>
              {pendingDeviceRun && (
                <div className="mx-auto w-full max-w-3xl px-4 pt-3">
                  <StatusNotice
                    compact
                    tone="warning"
                    message={text("运行结果待核对", "Run result unconfirmed")}
                    description={
                      missingDeviceRun === pendingDeviceRun
                        ? text(
                            "设备未找到这次运行的回执。",
                            "The device has no receipt for this execution.",
                          )
                        : text(
                            "核对会读取这次运行的原回执。",
                            "Checking looks up the original receipt for this run.",
                          )
                    }
                    actions={
                      <>
                        {deviceConversationId && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={deviceRunDisabled}
                            onClick={() => runDeviceTask(deviceTask)}
                          >
                            {deviceRunLabel}
                          </Button>
                        )}
                        {missingDeviceRun === pendingDeviceRun && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={dismissDeviceRunCheck}
                          >
                            {text("结束核对", "Stop checking")}
                          </Button>
                        )}
                      </>
                    }
                  />
                </div>
              )}
              <div
                className={`relative flex min-h-0 min-w-0 flex-1 flex-col px-4 md:px-6 ${deviceConversationId ? "gap-2" : "gap-4 pb-8"} ${taskDetailsInset}`}
              >
                {currentDeviceHistory?.error && !deviceRunSelectionState && (
                  <div className="order-1 mx-auto w-full max-w-3xl shrink-0 pt-4">
                    <StatusNotice
                      compact
                      tone="warning"
                      message={deviceHistoryError}
                      actions={
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-11 md:min-h-9"
                          onClick={() => setRefresh((value) => value + 1)}
                        >
                          {text("重试", "Retry")}
                        </Button>
                      }
                    />
                  </div>
                )}
                {deviceRunSelectionState === "loading" ? (
                  <p
                    role="status"
                    className="order-1 mx-auto w-full max-w-3xl pt-4 text-sm text-muted-foreground"
                  >
                    {text("正在读取所选运行…", "Reading the selected run…")}
                  </p>
                ) : deviceRunSelectionState ? (
                  <div className="order-1 mx-auto w-full max-w-3xl shrink-0 pt-4">
                    <StatusNotice
                      compact
                      stackActions
                      tone={
                        deviceRunAwaitingRecord && !deviceHistoryUnavailable ? "info" : "warning"
                      }
                      message={
                        deviceRunAwaitingRecord
                          ? text("设备已接受这次运行", "The device accepted this run")
                          : deviceRunSelectionState === "unavailable"
                            ? deviceHistoryError
                            : text(
                                "该设备当前可读取的历史中没有所选运行。",
                                "The selected run is unavailable in this device's history.",
                              )
                      }
                      description={
                        deviceRunAwaitingRecord
                          ? deviceHistoryUnavailable
                            ? text(
                                "暂时无法读取本次运行记录，可以重试。",
                                "The record for this run is temporarily unavailable. You can retry.",
                              )
                            : text(
                                "正在等待设备提供这次运行的记录。",
                                "Waiting for the device to return this run's record.",
                              )
                          : undefined
                      }
                      actions={
                        <>
                          <Button
                            ref={deviceRunRetry}
                            type="button"
                            variant="ghost"
                            className="min-h-11 md:min-h-9"
                            onClick={() => setRefresh((value) => value + 1)}
                          >
                            {text("重试读取所选运行", "Retry selected run")}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            className="min-h-11 md:min-h-9"
                            onClick={() => {
                              taskTitle.current?.focus({ preventScroll: true });
                              onNavigate({ ...route, run: undefined });
                            }}
                          >
                            {text("返回任务", "Back to task")}
                          </Button>
                        </>
                      }
                    />
                  </div>
                ) : null}
                {showDeviceRunResult && (
                  <main
                    className={`order-2 mx-auto w-full max-w-3xl min-w-0 ${deviceConversationId ? "shrink-0 space-y-2 pt-2" : "space-y-7 pt-5"}`}
                    aria-label={text("任务结果", "Task results")}
                  >
                    {!deviceConversationId && !deviceRun && deviceTask.prompt && (
                      <TaskPromptBubble>{deviceTask.prompt}</TaskPromptBubble>
                    )}
                    {deviceRun && (!deviceConversationId || deviceRun.output) && (
                      <article className="space-y-4" aria-label={text("运行结果", "Run result")}>
                        <TaskStoredRunHeader
                          text={text}
                          triggeredAt={new Date(deviceRun.startedAt).toISOString()}
                          triggerLabel={time(
                            new Date(deviceRun.startedAt).toISOString(),
                            deviceTasks?.timeZone,
                          )}
                          status={deviceRunStatus(deviceRun)}
                          manual={deviceRun.counted === false}
                        />
                        {deviceRun.output && (
                          <pre
                            className={`whitespace-pre-wrap break-words text-sm ${deviceConversationId ? "max-h-48 overflow-auto" : ""}`}
                          >
                            {deviceRun.output}
                          </pre>
                        )}
                        {!deviceConversationId &&
                          deviceRun.sessionId &&
                          onOpenDeviceConversation && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="max-md:min-h-11"
                              onClick={() => {
                                if (deviceRun.sessionId)
                                  onOpenDeviceConversation(deviceRun.sessionId);
                              }}
                            >
                              {text("打开结果对话", "Open result conversation")}
                            </Button>
                          )}
                        {!deviceConversationId && cancelDeviceRun}
                      </article>
                    )}
                    {!deviceConversationId && (
                      <section aria-label={text("当前计划", "Current plan")} className="space-y-3">
                        {deviceRun && (
                          <h3 className="text-sm font-medium">
                            {text("当前计划", "Current plan")}
                          </h3>
                        )}
                        <p className="text-sm leading-relaxed">
                          {deviceNext
                            ? `${text("下次运行", "Next run")} · ${time(new Date(deviceNext).toISOString(), deviceTasks?.timeZone)}`
                            : deviceTask.enabled
                              ? text("暂无下次运行时间。", "No upcoming run is available.")
                              : text("任务已暂停。", "This task is paused.")}
                        </p>
                        <TaskPlanCard
                          name={deviceTask.name}
                          metadata={`${device.label} · ${labels[devicePlanStatus(deviceTask)]}`}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!!deviceFailure || busy || !renderDeviceEditor}
                            onClick={() => openDeviceEditor(deviceTask)}
                          >
                            {text("编辑任务", "Edit task")}
                          </Button>
                          <Button
                            size="sm"
                            disabled={deviceRunDisabled}
                            onClick={() => runDeviceTask(deviceTask)}
                          >
                            {deviceRunLabel}
                          </Button>
                        </TaskPlanCard>
                      </section>
                    )}
                    {deviceAnchor && !deviceAnchor.messageId && (
                      <p className="px-2 text-xs text-muted-foreground" role="status">
                        {text(
                          "正文中无法定位这次运行。",
                          "This run cannot be located in the conversation.",
                        )}
                      </p>
                    )}
                  </main>
                )}
                {deviceConversationId && deviceRun && conversationRun && (
                  <div className="relative order-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    {renderDeviceConversation?.(
                      deviceConversationId,
                      deviceRun,
                      deviceMessageJump,
                      {
                        run: conversationRun,
                        active: Boolean(activeConversationRun),
                        preview: devicePreview,
                        cancel:
                          activeConversationRun && device.cancel && !busy
                            ? () => stopDeviceRun(activeConversationRun)
                            : undefined,
                      },
                    )}
                  </div>
                )}
                {(taskDetailsOpen || mobileTaskDetails) && (
                  <TaskInspector
                    id={taskDetailsId}
                    text={text}
                    mobile={mobileTaskDetails}
                    onClose={closeTaskDetails}
                  >
                    <TaskInspectorGroup title={text("定时任务", "Scheduled task")}>
                      <TaskInspectorPlan
                        name={deviceTask.name}
                        status={labels[devicePlanStatus(deviceTask)]}
                        disabled={!!deviceFailure || busy || !renderDeviceEditor}
                        onOpen={() => openDeviceEditor(deviceTask)}
                      />
                      <p className="break-words text-xs text-muted-foreground">
                        {device.label} · <code>{deviceTask.cron}</code>
                      </p>
                      {deviceNext && (
                        <p className="text-xs text-muted-foreground">
                          {text("下次运行", "Next run")} ·{" "}
                          {time(new Date(deviceNext).toISOString(), deviceTasks?.timeZone)}
                        </p>
                      )}
                    </TaskInspectorGroup>
                  </TaskInspector>
                )}
              </div>
            </>
          ) : unavailable ? (
            <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-3 p-6 max-md:justify-start max-md:pt-3">
              {isMobile && route.id && (
                <Button variant="ghost" className="min-h-11 self-start" onClick={backToList}>
                  <ArrowLeft className="size-4" />
                  {text("返回任务", "Back to tasks")}
                </Button>
              )}
              <h2 className="font-semibold">{remoteTask?.name ?? unavailable.name}</h2>
              {remoteTask && (
                <p className="text-sm">
                  {unavailable.name} · {labels[remoteTask.status]}
                  {remoteTask.next_at && unavailable.online && !remoteSummary?.unavailable
                    ? ` · ${time(new Date(remoteTask.next_at).toISOString())}`
                    : ""}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                {unavailable.online
                  ? text(
                      "连接设备后查看该设备的定时任务。",
                      "Connect to view this device's scheduled tasks.",
                    )
                  : text("设备离线", "Device offline")}
              </p>
              {remoteSummary?.readAt && (!unavailable.online || remoteSummary.unavailable) && (
                <p className="text-xs text-muted-foreground">
                  {text("上次读取", "Last read")} · {time(remoteSummary.readAt)}
                </p>
              )}
              <Button
                className="self-start"
                variant="outline"
                disabled={!unavailable.online || !unavailable.workspaces.length || busy}
                onClick={() => void write(() => onOpenDevice(unavailable, route))}
              >
                {text("连接设备", "Connect device")}
              </Button>
            </div>
          ) : task && schedules ? (
            <>
              {taskChromeTarget
                ? mountWorkbenchLayout(cloudTaskHeader, taskChromeTarget, "task-header")
                : cloudTaskHeader}
              {isMobile && loadError && (
                <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-3">
                  <StatusNotice
                    compact
                    stackActions
                    tone="warning"
                    message={loadError}
                    actions={
                      <Button variant="ghost" className="min-h-11" onClick={retryCloudList}>
                        {text("重试读取任务", "Retry loading tasks")}
                      </Button>
                    }
                  />
                </div>
              )}
              {(liveCancellationStatus ||
                (waitingInPreviousConversation && !acceptedRunReadFailure)) && (
                <p
                  role="status"
                  className="mx-auto w-full max-w-3xl px-4 pt-2 text-xs text-muted-foreground md:px-6"
                >
                  {liveCancellationStatus ?? runLabels.pending}
                </p>
              )}
              {awaitingApproval && awaitingApproval.id !== selectedRun?.id && (
                <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-3">
                  <StatusNotice
                    compact
                    stackActions={isMobile}
                    tone="warning"
                    message={text("有一次运行待审批", "A run awaits approval")}
                    actions={
                      <Button
                        variant="ghost"
                        className="min-h-11 md:min-h-9"
                        onClick={() => {
                          setManualCloudRun(undefined);
                          setFocusApproval(
                            scheduleApprovalKey(owner, task.id, awaitingApproval.id),
                          );
                          onNavigate({ ...route, run: awaitingApproval.id });
                        }}
                      >
                        {text("审阅待审批运行", "Review pending run")}
                      </Button>
                    }
                  />
                </div>
              )}
              {pendingCloudRun && (
                <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-3">
                  <StatusNotice
                    compact
                    stackActions={isMobile || cloudRunFeedbackState === "missing"}
                    busy={cloudRunChecking}
                    tone={cloudRunChecking ? "info" : "warning"}
                    message={
                      cloudRunFeedbackState === "submitting"
                        ? text("正在提交这次运行…", "Submitting this run…")
                        : cloudRunFeedbackState === "checking"
                          ? text("正在核对原回执…", "Checking the original receipt…")
                          : text("运行结果待核对", "Run result unconfirmed")
                    }
                    description={
                      cloudRunChecking
                        ? undefined
                        : cloudRunFeedbackState === "missing"
                          ? text(
                              "暂未找到这次运行的回执，可以稍后再查。",
                              "No receipt is available yet. You can check again later.",
                            )
                          : cloudRunFeedbackState === "sign-in"
                            ? text(
                                "请重新登录后核对，原提交编号已保留。",
                                "Sign in again to check. The original request was retained.",
                              )
                            : cloudRunFeedbackState === "unavailable"
                              ? text(
                                  "暂时无法读取原回执，可以重试。",
                                  "The original receipt is temporarily unavailable. Try checking again.",
                                )
                              : text(
                                  "核对会读取原回执。",
                                  "Checking looks up the original receipt.",
                                )
                    }
                    actions={
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-11 aria-disabled:opacity-50 md:min-h-9"
                          aria-disabled={cloudRunDisabled}
                          onClick={() => {
                            if (!cloudRunDisabled) runNow(task);
                          }}
                        >
                          {cloudRunLabel}
                        </Button>
                        {cloudRunFeedbackState === "missing" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="min-h-11 md:min-h-9"
                            disabled={busy}
                            onClick={dismissCloudRunCheck}
                          >
                            {text("结束核对", "Stop checking")}
                          </Button>
                        )}
                      </>
                    }
                  />
                </div>
              )}
              <div
                className={`relative flex min-h-0 min-w-0 flex-1 flex-col gap-4 ${liveConversationId ? "" : "px-4 pb-8 md:px-6"} ${taskChromeTarget ? "" : taskDetailsInset}`}
              >
                {cloudHistoryError && !mobileHistoryVisible && (
                  <div className="order-2 mx-auto w-full max-w-3xl shrink-0 px-4 pt-4">
                    <StatusNotice
                      compact
                      tone="warning"
                      message={cloudHistoryError}
                      actions={
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-11 md:min-h-9"
                          onClick={() => setRefresh((value) => value + 1)}
                        >
                          {text("重试", "Retry")}
                        </Button>
                      }
                    />
                  </div>
                )}
                {cloudHistoryLoading && !mobileHistoryVisible && (
                  <p
                    role="status"
                    className="order-2 mx-auto w-full max-w-3xl px-4 pt-4 text-sm text-muted-foreground"
                  >
                    {text("正在读取运行记录…", "Loading run history…")}
                  </p>
                )}
                {selectedRunLoading && (
                  <p
                    role="status"
                    className="order-2 mx-auto w-full max-w-3xl px-4 pt-4 text-sm text-muted-foreground"
                  >
                    {text("正在读取所选运行…", "Reading the selected run…")}
                  </p>
                )}
                {selectedRunNotice && (
                  <div className="order-2 mx-auto w-full max-w-3xl shrink-0 px-4 pt-4">
                    <StatusNotice
                      compact
                      stackActions={isMobile}
                      tone="warning"
                      message={selectedRunNotice}
                      description={acceptedRunReadFailure}
                      actions={
                        <>
                          <Button
                            ref={selectedCloudRunRetry}
                            type="button"
                            variant="ghost"
                            className="min-h-11 md:min-h-9"
                            onClick={() => setRefresh((value) => value + 1)}
                          >
                            {text("重试读取所选运行", "Retry selected run")}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            className="min-h-11 md:min-h-9"
                            onClick={() => onNavigate({ ...route, run: undefined })}
                          >
                            {text("返回任务", "Back to task")}
                          </Button>
                        </>
                      }
                    />
                  </div>
                )}
                {cloudJumpKey &&
                  runDetailsUnavailable &&
                  !selectedMessageId &&
                  !taskDetailsOpen && (
                    <div className="order-2 mx-auto w-full max-w-3xl shrink-0 px-4 pt-4">
                      {runDetailsNotice}
                    </div>
                  )}
                {reviewApproval && approvalRunId && approvalKey && (
                  <div
                    className={`order-1 mx-auto w-full max-w-3xl shrink-0 pt-4 ${liveConversationId ? "px-4 md:px-6" : ""}`}
                  >
                    <ScheduleRunApprovalCard
                      key={approvalKey}
                      client={schedules}
                      storageKey={approvalKey}
                      taskId={task.id}
                      runId={approvalRunId}
                      input={selectedApproval}
                      prompt={selectedApproval && schedulePrompt(selectedApproval.run.content)}
                      triggerLabel={
                        selectedRun &&
                        time(
                          selectedRun.trigger_at,
                          selectedApproval?.rule.time_zone ?? task.rule.time_zone,
                        )
                      }
                      disabledReason={
                        loadError ||
                        cloudHistoryError ||
                        (!items?.enabled
                          ? text("云端审批暂不可用。", "Cloud approvals are unavailable.")
                          : busy
                            ? text(
                                "请等待当前任务操作完成。",
                                "Wait for the current task action to finish.",
                              )
                            : undefined)
                      }
                      recorded={recordedApproval}
                      titleRef={approvalTitle}
                      text={text}
                      onSubmitting={() => {
                        if (route.run === approvalRunId) return;
                        setManualCloudRun(undefined);
                        onNavigate({ ...route, run: approvalRunId });
                      }}
                      onResolved={(outcome, restoreFocus) => {
                        if (restoreFocus) taskTitle.current?.focus({ preventScroll: true });
                        setLastApprovalReceipt({ key: approvalKey, outcome });
                        setRefresh((value) => value + 1);
                      }}
                    />
                  </div>
                )}
                {showTaskConversation && (
                  <main
                    className={`order-2 mx-auto w-full max-w-3xl min-w-0 shrink-0 ${liveConversationId ? "px-4 md:px-6" : "space-y-7 pt-5"}`}
                    aria-label={text("任务对话", "Task conversation")}
                  >
                    {!liveConversationId && !selectedRun && !reviewApproval && (
                      <TaskPromptBubble>{schedulePrompt(task.run.content)}</TaskPromptBubble>
                    )}
                    {cloudJumpUnavailable && (
                      <p role="status" className="text-xs text-muted-foreground">
                        {text(
                          "正文中无法定位这次运行。可在任务详情中查看本次输出。",
                          "This run cannot be located in the conversation. Its output is in task details.",
                        )}
                      </p>
                    )}
                    {selectedRun && !liveConversationId && !selectedApproval ? (
                      <article className="space-y-4" aria-label={text("运行结果", "Run result")}>
                        <TaskStoredRunHeader
                          text={text}
                          triggeredAt={selectedRun.trigger_at}
                          triggerLabel={time(selectedRun.trigger_at, task.rule.time_zone)}
                          status={runLabels[selectedRun.state] ?? selectedRun.state}
                          manual={selectedRun.manual}
                        />
                        {selectedRun.archived && (
                          <p className="text-xs text-muted-foreground">
                            {text("结果对话已归档", "Result conversation archived")}
                          </p>
                        )}
                        {selectedRun.state === "awaiting_approval" && !reviewApproval && (
                          <StatusNotice
                            compact
                            stackActions
                            tone="warning"
                            message={text(
                              "暂时无法读取本次运行的审批内容。",
                              "The approval details for this run are unavailable.",
                            )}
                            actions={
                              <Button
                                variant="ghost"
                                className="min-h-11 md:min-h-9"
                                onClick={() => setRefresh((value) => value + 1)}
                              >
                                {text("重新读取审批内容", "Reload approval details")}
                              </Button>
                            }
                          />
                        )}
                        {selectedRun.output && (
                          <DocumentMarkdown content={selectedRun.output} readOnly />
                        )}
                        {selectedRun.error_code && (
                          <p className="text-xs text-muted-foreground">
                            {Object.hasOwn(runReasons, selectedRun.error_code)
                              ? runReasons[selectedRun.error_code]
                              : text(
                                  "本次运行未能正常完成。请查看运行状态后重试。",
                                  "The run did not complete normally. Check its status before trying again.",
                                )}
                          </p>
                        )}
                        {cancelableCloudRun && (
                          <Button
                            variant="ghost"
                            className="min-h-11 md:min-h-9"
                            disabled={busy}
                            onClick={() => void cancelCloudRun(task, cancelableCloudRun)}
                          >
                            {text("取消本次运行", "Cancel this run")}
                          </Button>
                        )}
                      </article>
                    ) : null}
                    {!liveConversationId && (
                      <section aria-label={text("当前计划", "Current plan")} className="space-y-3">
                        {(selectedRun || reviewApproval) && (
                          <h3 className="text-sm font-medium">
                            {text("当前计划", "Current plan")}
                          </h3>
                        )}
                        <p className="text-sm leading-relaxed">
                          {task.next_at
                            ? `${text("任务已安排。下次运行", "Task scheduled. Next run")} · ${time(task.next_at, task.rule.time_zone)}`
                            : task.enabled
                              ? text("此任务暂无下次运行。", "This task has no upcoming run.")
                              : text("任务已暂停。", "This task is paused.")}
                        </p>
                        <TaskPlanCard
                          name={task.name}
                          metadata={`${text("云端", "Cloud")} · ${labels[status(task)]}`}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!items?.enabled || busy}
                            onClick={() => openCloudEditor(task)}
                          >
                            {text("编辑任务", "Edit task")}
                          </Button>
                          {!pendingCloudRun && (
                            <Button
                              size="sm"
                              disabled={cloudRunDisabled}
                              onClick={() => runNow(task)}
                            >
                              {cloudRunLabel}
                            </Button>
                          )}
                        </TaskPlanCard>
                      </section>
                    )}
                  </main>
                )}
                {liveConversationId && (
                  <div
                    ref={taskConversationArea}
                    className="relative order-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                  >
                    {renderConversation?.(liveConversationId, onTaskChromeTarget)}
                  </div>
                )}
                {(taskDetailsOpen || mobileTaskDetails) && (
                  <TaskInspector
                    id={taskDetailsId}
                    anchorTarget={inspectorTarget}
                    text={text}
                    mobile={
                      mobileTaskDetails && {
                        ...mobileTaskDetails,
                        takeResourceFocus: () => {
                          if (route.reader) return undefined;
                          const resource = detailsPosition.resource;
                          detailsPosition.resource = undefined;
                          return resource?.occurrenceId === selectedRun?.id
                            ? resource?.key
                            : undefined;
                        },
                      }
                    }
                    onClose={closeTaskDetails}
                  >
                    <TaskInspectorGroup title={text("定时任务", "Scheduled task")}>
                      <TaskInspectorPlan
                        name={task.name}
                        status={labels[status(task)]}
                        disabled={!items?.enabled || busy}
                        onOpen={() => openCloudEditor(task)}
                      />
                      {task.blocked && runReasons[task.blocked] && (
                        <p className="text-muted-foreground">{runReasons[task.blocked]}</p>
                      )}
                      {selectedRun?.archived && liveConversationId && (
                        <p className="text-xs text-muted-foreground">
                          {text("结果对话已归档", "Result conversation archived")}
                        </p>
                      )}
                      {task.next_at && (
                        <p className="text-xs text-muted-foreground">
                          {time(task.next_at, task.rule.time_zone)} · {task.rule.time_zone}
                        </p>
                      )}
                      <ScheduleDisclosure
                        title={text("运行记录", "Run history")}
                        {...historyDisclosure}
                      >
                        {mobileHistoryFeedback(cloudHistoryLoading, cloudHistoryError)}
                        {cloudHistoryLoading && !mobileHistoryVisible ? (
                          <p role="status" className="text-muted-foreground">
                            {text("正在读取运行记录…", "Loading run history…")}
                          </p>
                        ) : displayedRuns.length ? (
                          <div className={isMobile ? undefined : "max-h-56 overflow-y-auto"}>
                            {displayedRuns.map((run) => (
                              <Button
                                type="button"
                                variant="ghost"
                                key={run.id}
                                aria-current={selectedRun?.id === run.id ? "true" : undefined}
                                className={`h-auto min-h-11 w-full flex-col items-start justify-center gap-0.5 px-2 py-1 font-normal ${selectedRun?.id === run.id ? "bg-muted" : ""}`}
                                onClick={() => {
                                  const reviewKey =
                                    run.state === "awaiting_approval" && run.approval
                                      ? scheduleApprovalKey(owner, task.id, run.id)
                                      : undefined;
                                  setManualCloudRun(undefined);
                                  setCloudJumpSequence((sequence) => sequence + 1);
                                  leaveMobileTaskDetails(
                                    reviewKey ? { approvalKey: reviewKey } : true,
                                  );
                                  if (reviewKey && !isMobile) setFocusApproval(reviewKey);
                                  onNavigate({ ...route, run: run.id });
                                }}
                              >
                                <span className="min-w-0 truncate">
                                  {time(run.trigger_at, task.rule.time_zone)}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {run.manual ? text("手动 · ", "Manual · ") : ""}
                                  {runLabels[run.state] ?? run.state}
                                </span>
                              </Button>
                            ))}
                          </div>
                        ) : !cloudHistoryError && !cloudHistoryLoading ? (
                          <p className="text-sm text-muted-foreground">
                            {text("暂无运行记录", "No runs yet")}
                          </p>
                        ) : null}
                      </ScheduleDisclosure>
                    </TaskInspectorGroup>
                    {(runDetailsLoading || runDetailsUnavailable) && (
                      <div className="px-3 py-2.5">{runDetailsNotice}</div>
                    )}
                    {(
                      [
                        ["outputs", text("输出", "Outputs")],
                        ["sources", text("来源", "Sources")],
                      ] as const
                    ).map(([category, title]) => {
                      const resources = selectedRunResources?.items.filter((item) =>
                        category === "outputs" ? item.role === "output" : item.role !== "output",
                      );
                      const savedOutput = category === "outputs" ? fallbackRunOutput : undefined;
                      if (
                        (runDetailsLoading || runDetailsUnavailable) &&
                        !savedOutput &&
                        !resources?.length
                      )
                        return null;
                      const webSources = resources?.filter((item) => item.kind === "source");
                      const otherResources = resources?.filter((item) => item.kind !== "source");
                      const resourceList = (entries: CloudChatPresentationResource[]) => (
                        <ul>
                          {entries.map((item) => {
                            const key = `${item.kind}:${item.id}`;
                            return (
                              <li key={key}>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  data-task-result-resource={key}
                                  className="h-auto min-h-11 w-full min-w-0 justify-start px-2 font-normal md:min-h-8"
                                  onClick={() => {
                                    if (selectedConversationId && selectedRun) {
                                      if (isMobile)
                                        detailsPosition.resource = {
                                          occurrenceId: selectedRun.id,
                                          key,
                                        };
                                      leaveMobileTaskDetails(false);
                                      onOpenResultResource(
                                        selectedConversationId,
                                        item,
                                        selectedRun.id,
                                      );
                                    }
                                  }}
                                >
                                  {item.kind === "source" ? (
                                    <Globe className="size-4 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                                  )}
                                  <span className="truncate" title={item.name}>
                                    {item.name}
                                  </span>
                                </Button>
                              </li>
                            );
                          })}
                        </ul>
                      );
                      return (
                        <TaskInspectorGroup
                          key={category}
                          title={title}
                          action={
                            category === "sources" && items?.enabled && space
                              ? {
                                  label: text("添加来源", "Add sources"),
                                  onClick: () => openCloudEditor(task, false, true),
                                }
                              : category === "outputs" && liveConversationId
                                ? {
                                    label: text(
                                      "在结果对话中创建输出",
                                      "Create output in the result chat",
                                    ),
                                    onClick: () => {
                                      leaveMobileTaskDetails(false);
                                      requestAnimationFrame(() =>
                                        taskConversationArea.current
                                          ?.querySelector<HTMLElement>(
                                            'textarea:not([disabled]), [contenteditable="true"]',
                                          )
                                          ?.focus(),
                                      );
                                    },
                                  }
                                : undefined
                          }
                        >
                          {savedOutput && (
                            <ScheduleDisclosure title={text("查看运行结果", "View run result")}>
                              <div className={isMobile ? undefined : "max-h-40 overflow-auto"}>
                                <DocumentMarkdown content={savedOutput} readOnly />
                              </div>
                            </ScheduleDisclosure>
                          )}
                          {resources?.length ? (
                            <>
                              {webSources?.length ? (
                                <details open className="group/web-sources">
                                  <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted [&::-webkit-details-marker]:hidden">
                                    <Globe className="size-4" />
                                    <span className="flex-1">{text("网页搜索", "Web search")}</span>
                                    <ChevronDown
                                      className="size-3 group-open/web-sources:rotate-180"
                                      aria-hidden="true"
                                    />
                                  </summary>
                                  {resourceList(webSources)}
                                </details>
                              ) : null}
                              {otherResources?.length ? resourceList(otherResources) : null}
                            </>
                          ) : !savedOutput ? (
                            <p className="text-muted-foreground">
                              {category === "outputs"
                                ? text("暂无输出", "No outputs yet")
                                : text("暂无来源", "No sources yet")}
                            </p>
                          ) : null}
                        </TaskInspectorGroup>
                      );
                    })}
                  </TaskInspector>
                )}
              </div>
              {selectedConversationId && !liveConversationId && (
                <div className="sticky bottom-0 z-10 bg-background px-4 pb-4 pt-2">
                  <Button
                    variant="outline"
                    className="mx-auto flex h-12 w-full max-w-3xl justify-start rounded-2xl px-4 font-normal"
                    onClick={() => onOpenConversation(selectedConversationId)}
                  >
                    {text("继续此任务对话", "Continue this task conversation")}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <EmptyState
              aria-busy={landing === "loading" || undefined}
              className="mx-auto h-auto w-full max-w-3xl flex-1 gap-4 px-5 py-8 @min-[32rem]:px-8"
            >
              {isMobile && route.id && (
                <Button variant="ghost" className="min-h-11 self-start" onClick={backToList}>
                  <ArrowLeft className="size-4" />
                  {text("返回任务", "Back to tasks")}
                </Button>
              )}
              <span className="grid size-12 place-items-center rounded-2xl bg-muted text-foreground">
                <Clock3 className="size-6" aria-hidden="true" />
              </span>
              <div className="max-w-sm space-y-1.5">
                <h2 className="text-lg font-semibold tracking-tight text-foreground">
                  {landingCopy[0]}
                </h2>
                <p className="text-sm leading-6 text-muted-foreground">{landingCopy[1]}</p>
              </div>
              {(landing === "empty" || landing === "browse") &&
                canCreate &&
                (!items?.enabled || !open || isMobile || hideSidebar) && (
                  <Button
                    className="min-h-11 gap-2 rounded-full md:min-h-9"
                    onClick={() => newTask()}
                  >
                    <Plus className="size-4" />
                    {newTaskLabel}
                  </Button>
                )}
              {((landing === "unavailable" &&
                (canRetryCloud || canRetryDevice || canRetryRemote)) ||
                (landing === "missing-task" && canRetryCloudTaskLink)) && (
                <Button
                  variant="outline"
                  className="min-h-11 rounded-full md:min-h-9"
                  onClick={landing === "missing-task" ? retryCloudList : retryTaskLists}
                >
                  {text("重试读取任务", "Retry loading tasks")}
                </Button>
              )}
              {items?.enabled && (landing === "empty" || landing === "browse") && (
                <div className="mt-3 grid w-full max-w-2xl gap-3 @min-[32rem]:grid-cols-2">
                  {templates.map(([name, prompt, research, Icon]) => (
                    <ConversationStarter
                      key={name}
                      title={name}
                      description={prompt}
                      icon={<Icon className="size-5" />}
                      layout="inline"
                      onSelect={() => newTask(prompt, research)}
                    />
                  ))}
                </div>
              )}
            </EmptyState>
          )}
        </div>
      )}
      {authorityDialog}
      {device &&
        deviceEditor &&
        renderDeviceEditor?.({
          target: device.label,
          timeZone: deviceTasks?.timeZone,
          task: deviceEditor.task,
          name: deviceEditor.name,
          prompt: deviceEditor.prompt,
          onUseCloud:
            defaultCreationTarget === device.targetId && items?.enabled && !deviceEditor.task
              ? (name, prompt) => {
                  newTask(prompt, false, { id: deviceEditor.id, name, prompt });
                  setDeviceEditor(undefined);
                }
              : undefined,
          preview: device.preview,
          onSave: async (data) => {
            const saved = await device.save(data, deviceEditor.id, deviceEditor.task);
            setDeviceSnapshot((current) => {
              if (current?.host !== device) return current;
              const next = { ...current.items.next };
              if (deviceEditor.task?.cron !== saved.cron) delete next[saved.id];
              return {
                ...current,
                items: {
                  ...current.items,
                  tasks: [...current.items.tasks.filter((item) => item.id !== saved.id), saved],
                  next,
                },
              };
            });
            setDeviceEditor(undefined);
            setRefresh((revision) => revision + 1);
            onNavigate({
              ...route,
              target: device.targetId,
              id: saved.id,
              run: deviceEditor.task ? route.run : undefined,
            });
          },
          onClose: () => setDeviceEditor(undefined),
        })}
      {editor && (
        <ScheduleEditor
          key={editor.id}
          input={editor.input}
          existing={editor.existing}
          resumeAfterEdit={editor.resumeAfterEdit}
          editSources={editor.editSources}
          text={text}
          locale={locale}
          models={models}
          space={space}
          sourceMetadata={sourceMetadata}
          projects={projects}
          schedules={schedules}
          cloudEnabled={items?.enabled === true}
          initialTarget={
            editor.existing
              ? "cloud"
              : (editor.target ??
                defaultCreationTarget ??
                (!items?.enabled
                  ? creationTargets.find((target) => target.ready)?.id
                  : undefined) ??
                "cloud")
          }
          busy={busy}
          error={error}
          creationTargets={creationTargets}
          onOpenTarget={(target) =>
            void write(
              async () => {
                const draft = {
                  id: editor.id,
                  name: editor.input.name,
                  prompt: schedulePrompt(editor.input.run.content),
                };
                if (pendingDeviceDraft.current)
                  discardDeviceScheduleDraft(owner, pendingDeviceDraft.current);
                if (!target.inline) {
                  stageDeviceScheduleDraft(owner, target.id, draft);
                  pendingDeviceDraft.current = draft.id;
                }
                try {
                  await target.open(draft);
                } catch (error) {
                  discardDeviceScheduleDraft(owner, draft.id);
                  pendingDeviceDraft.current = "";
                  throw error;
                }
              },
              () =>
                text(
                  "无法打开所选设备。请检查连接后重试。",
                  "Couldn't open the device. Check the connection and try again.",
                ),
            )
          }
          onChange={(input) => setEditor({ ...editor, input })}
          onClose={() => {
            discardDeviceScheduleDraft(owner, editor.id);
            pendingDeviceDraft.current = "";
            setEditor(undefined);
            setError("");
          }}
          onSave={(input) =>
            void writeCloud(async () => {
              if (!schedules) return;
              const view = currentRunView.current?.cloud;
              discardDeviceScheduleDraft(owner, editor.id);
              pendingDeviceDraft.current = "";
              const saved = await schedules.save(
                input,
                editor.resumeAfterEdit || (editor.existing?.enabled ?? true),
                editor.id,
                editor.existing,
              );
              const active = currentRunView.current;
              if (active?.owner !== owner || active.cloud.schedules !== schedules) return;
              acceptCloudPlan(editor.existing, saved);
              setEditor((current) => (current?.id === editor.id ? undefined : current));
              if (active.cloud !== view) return;
              if (!editor.existing) createdTaskFocus.current = { owner, id: saved.id };
              active.onNavigate({
                page: "tasks",
                id: saved.id,
                target: "cloud",
                run:
                  editor.existing?.id === saved.id && task?.id === saved.id ? route.run : undefined,
                scope,
                status: route.status,
                statuses: route.statuses,
              });
            })
          }
        />
      )}
    </section>
  );
}

function TaskPromptBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[84%] whitespace-pre-wrap break-words rounded-3xl bg-foreground px-4 py-2.5 text-sm leading-relaxed text-background">
        {children}
      </p>
    </div>
  );
}

function TaskStoredRunHeader({
  text,
  triggeredAt,
  triggerLabel,
  status,
  manual,
}: {
  text: Text;
  triggeredAt: string;
  triggerLabel: string;
  status: string;
  manual?: boolean;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border/60 pb-3">
      <div className="min-w-0 space-y-1">
        <h3 className="text-base font-semibold">{text("运行结果", "Run result")}</h3>
        <p className="text-xs leading-5 text-muted-foreground">
          <time dateTime={triggeredAt}>{triggerLabel}</time>
          {manual && text(" · 手动触发", " · Manual trigger")}
        </p>
      </div>
      <span
        role="status"
        className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground"
      >
        {status}
      </span>
    </header>
  );
}

function TaskPlanCard({
  name,
  metadata,
  children,
}: {
  name: string;
  metadata: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/60 p-3 max-md:[&>button]:min-h-11">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted">
        <Clock3 aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={name}>
          {name}
        </p>
        <p className="text-xs text-muted-foreground">{metadata}</p>
      </div>
      {children}
    </div>
  );
}

function TaskDetailHeader({
  name,
  titleRef,
  target,
  planStatus,
  text,
  leading,
  renderWorkbenchHeader,
  onBack,
  menu,
  onShare,
  children,
}: {
  name: string;
  titleRef?: Ref<HTMLHeadingElement>;
  target: string;
  planStatus: string;
  text: Text;
  leading?: ReactNode;
  renderWorkbenchHeader?: RenderWorkbenchPageHeader;
  onBack?: () => void;
  menu: ReactNode;
  onShare?: () => void;
  children: ReactNode;
}) {
  const actions = text("任务操作", "Task actions");
  const back = onBack && (
    <TooltipButton
      variant="ghost"
      size="icon"
      className="size-11"
      title={text("返回任务", "Back to tasks")}
      aria-label={text("返回任务", "Back to tasks")}
      onClick={onBack}
    >
      <ArrowLeft className="size-4" />
    </TooltipButton>
  );
  const title = (
    <div className="min-w-0 flex-1">
      <h2
        ref={titleRef}
        tabIndex={titleRef ? -1 : undefined}
        className="truncate text-sm font-semibold leading-5"
        title={name}
      >
        {name}
      </h2>
      <p className="sr-only">
        <span className="truncate" title={target}>
          {target}
        </span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">{planStatus}</span>
      </p>
    </div>
  );
  const taskActions = (
    <div className="flex shrink-0 items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <TooltipButton
              variant="ghost"
              size="icon"
              title={actions}
              aria-label={actions}
              className="max-md:size-11"
            >
              <MoreHorizontal className="size-4" />
            </TooltipButton>
          }
        />
        <DropdownMenuContent align="end" variant="soft">
          {menu}
        </DropdownMenuContent>
      </DropdownMenu>
      {onShare && (
        <TooltipButton
          variant="ghost"
          size="sm"
          title={text("分享", "Share")}
          aria-label={text("分享", "Share")}
          className="max-md:min-h-11"
          onClick={onShare}
        >
          <Share2 className="size-4" />
          {text("分享", "Share")}
        </TooltipButton>
      )}
      {children}
    </div>
  );
  if (renderWorkbenchHeader) {
    return renderWorkbenchHeader({
      title: (
        <>
          {back}
          {title}
        </>
      ),
      actions: taskActions,
    });
  }
  return (
    <header className="sticky top-0 z-10 shrink-0 bg-background">
      <div className="flex min-h-12 w-full min-w-0 items-center gap-2 px-3 py-1.5 md:px-4">
        {leading}
        {back}
        {title}
        {taskActions}
      </div>
    </header>
  );
}

function TaskInspector({
  id,
  text,
  mobile,
  anchorTarget,
  onClose,
  children,
}: {
  id: string;
  text: Text;
  mobile?: {
    open: boolean;
    position: { top: number };
    returnFocus: () => HTMLElement | null | false;
    takeResourceFocus?: () => string | undefined;
  };
  anchorTarget?: HTMLElement;
  onClose: () => void;
  children: ReactNode;
}) {
  const label = text("任务详情", "Task details");
  const mobileCloseButton = useRef<HTMLElement>(null);
  const mobileBody = useRef<HTMLDivElement>(null);
  const position = mobile?.position;
  const restorePosition = useCallback(
    (body: HTMLDivElement | null) => {
      mobileBody.current = body;
      if (body && position) body.scrollTop = position.top;
    },
    [position],
  );
  if (mobile) {
    const closeLabel = text("关闭任务详情", "Close task details");
    return (
      <Dialog
        open={mobile.open}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          id={id}
          layout="bottom-sheet-mobile"
          initialFocus={() => {
            const key = mobile.takeResourceFocus?.();
            const resource = key
              ? [
                  ...(mobileBody.current?.querySelectorAll<HTMLButtonElement>(
                    "[data-task-result-resource]",
                  ) ?? []),
                ].find((button) => button.dataset.taskResultResource === key)
              : undefined;
            return resource ?? mobileCloseButton.current;
          }}
          finalFocus={mobile.returnFocus}
          className="flex max-h-[min(78dvh,42rem)] min-w-0 flex-col overflow-hidden"
        >
          <DialogHeader className="flex-row items-center justify-between gap-2 border-b border-border/60 px-4 py-1.5">
            <DialogTitle className="text-base">{label}</DialogTitle>
            <DialogDescription className="sr-only">
              {text("查看计划、运行记录和输出。", "Review the schedule, run history and outputs.")}
            </DialogDescription>
            <DialogClose
              render={
                <Button
                  ref={mobileCloseButton}
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label={closeLabel}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              }
            />
          </DialogHeader>
          <DialogBody
            ref={restorePosition}
            onScroll={(event) => {
              if (mobile.open) mobile.position.top = event.currentTarget.scrollTop;
            }}
            className="divide-y divide-border/60 px-1 pt-1 pb-safe-bottom-compact max-[820px]:px-1 max-[820px]:pt-1 max-[820px]:pb-safe-bottom-compact"
          >
            {children}
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }
  const inspector = (
    <aside
      id={id}
      tabIndex={-1}
      aria-label={label}
      className={
        anchorTarget
          ? "za-floating-surface za-native-scroll absolute top-full right-2 z-20 mt-1 max-h-[min(62dvh,24rem)] w-[min(17.5rem,calc(100%-1rem))] divide-y divide-border/60 overflow-auto overscroll-contain border border-border/60 bg-popover text-sm"
          : taskDetailsClass
      }
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      {children}
    </aside>
  );
  return anchorTarget ? mountWorkbenchLayout(inspector, anchorTarget, "task-inspector") : inspector;
}

function TaskInspectorGroup({
  title,
  action,
  children,
}: {
  title: string;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <section className="space-y-1 px-3 py-2.5">
      <div className="flex min-h-5 items-center justify-between gap-2 px-1">
        <h3 className="text-xs font-normal text-muted-foreground">{title}</h3>
        {action && (
          <TooltipButton
            variant="ghost"
            size="icon-sm"
            className="-mr-1 size-7 text-muted-foreground max-md:size-11"
            title={action.label}
            aria-label={action.label}
            onClick={action.onClick}
          >
            <Plus className="size-4" />
          </TooltipButton>
        )}
      </div>
      {children}
    </section>
  );
}

function TaskInspectorPlan({
  name,
  status,
  disabled,
  onOpen,
}: {
  name: string;
  status: string;
  disabled: boolean;
  onOpen: () => void;
}) {
  return (
    <Button
      variant="ghost"
      className="h-auto min-h-11 w-full min-w-0 justify-start gap-2 px-2 text-left font-normal md:min-h-8"
      disabled={disabled}
      onClick={onOpen}
    >
      <Clock3 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" title={name}>
        {name}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
    </Button>
  );
}

function ScheduleDisclosure({
  title,
  open,
  onOpenChange,
  summaryRef,
  children,
}: {
  title: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  summaryRef?: React.Ref<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <details
      className="group"
      open={open}
      onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
    >
      <summary
        ref={summaryRef}
        className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8 [&::-webkit-details-marker]:hidden"
      >
        {title}
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground group-open:rotate-180"
        />
      </summary>
      <div className="min-w-0 space-y-1">{children}</div>
    </details>
  );
}

function ScheduleSelect<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  return (
    <ScheduleFormRow>
      <label className="shrink-0" htmlFor={id}>
        {label}
      </label>
      <Select
        value={value}
        onValueChange={(selected) => {
          const option = options.find(([key]) => key === selected);
          if (option) onChange(option[0]);
        }}
      >
        <SelectTrigger
          id={id}
          variant="plain"
          className="min-h-11 w-fit min-w-0 max-w-[68%] justify-end gap-2 bg-transparent text-right text-muted-foreground md:min-h-9"
        >
          <SelectValue>{options.find(([key]) => key === value)?.[1]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map(([key, title]) => (
            <SelectItem key={key} value={key}>
              {title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </ScheduleFormRow>
  );
}

function ScheduleFormRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-3 text-sm">{children}</div>
  );
}

function ScheduleSwitch({
  id,
  label,
  checked,
  disabled,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <ScheduleFormRow>
      <div className="min-w-0 py-2">
        <label htmlFor={id}>{label}</label>
        {hint && (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <Switch
        id={id}
        size="sm"
        className="data-[checked]:bg-foreground dark:data-[checked]:bg-primary"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onCheckedChange={onChange}
      />
    </ScheduleFormRow>
  );
}

function scheduleDraftSnapshot(input: ScheduleInput) {
  const { archive_successful_runs, require_approval, notification, run, ...draft } = input;
  const { content, ...model } = run;
  return JSON.stringify({
    ...draft,
    archive_successful_runs: Boolean(archive_successful_runs),
    require_approval: Boolean(require_approval),
    notification: notification ?? "attention",
    run: {
      ...model,
      content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    },
  });
}

function ScheduleEditor({
  input,
  existing,
  resumeAfterEdit = false,
  editSources,
  text,
  locale,
  models,
  space,
  sourceMetadata,
  projects,
  schedules,
  cloudEnabled,
  initialTarget,
  busy,
  error,
  creationTargets,
  onOpenTarget,
  onChange,
  onClose,
  onSave,
}: {
  input: ScheduleInput;
  existing?: Schedule;
  resumeAfterEdit?: boolean;
  editSources?: boolean;
  text: Text;
  locale: string;
  models: readonly Model[];
  space?: CloudSpaceClient;
  sourceMetadata?: ScheduleSourceMetadata;
  projects?: Pick<CloudChatProjectsClient, "listProjects">;
  schedules: typeof cloudSchedules | null;
  cloudEnabled: boolean;
  initialTarget: string;
  busy: boolean;
  error: string;
  creationTargets: readonly CreationTarget[];
  onOpenTarget: (target: CreationTarget) => void;
  onChange: (input: ScheduleInput) => void;
  onClose: () => void;
  onSave: (input: ScheduleInput) => void;
}) {
  const original = useRef({ input, target: initialTarget });
  const { confirm: confirmDiscard, dialog: discardDialog } = useConfirmDialog();
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(editSources));
  const [projectItems, setProjectItems] = useState<CloudProject[]>();
  const [projectLoadFailed, setProjectLoadFailed] = useState(false);
  const [projectRetry, setProjectRetry] = useState(0);
  const [location, setLocation] = useState(() => ({
    id: initialTarget,
    label: creationTargets.find((item) => item.id === initialTarget)?.label,
  }));
  const startTime = useRef<HTMLInputElement>(null);
  const instructions = useRef<HTMLTextAreaElement>(null);
  const taskName = useRef<HTMLInputElement>(null);
  const sourceEditor = useRef<HTMLDivElement>(null);
  const isDeviceTarget = !existing && location.id !== "cloud";
  const target = isDeviceTarget
    ? creationTargets.find((item) => item.id === location.id)
    : undefined;
  const deviceLabel = target?.label ?? location.label ?? text("所选设备", "Selected device");
  const cloudTargetLabel = cloudEnabled
    ? text("云端", "Cloud")
    : text("云端暂不可用", "Cloud unavailable");
  const projectKey = input.project_id || "none";
  const projectOptions: [string, string][] = [["none", text("无", "None")]];
  for (const project of projectItems ?? []) projectOptions.push([project.id, project.name]);
  if (projectKey !== "none" && !projectItems?.some((project) => project.id === projectKey)) {
    projectOptions.push([
      projectKey,
      projectItems
        ? text("项目不可用", "Project unavailable")
        : text("已选项目", "Selected project"),
    ]);
  }
  const labelId = useId();
  const { rule } = input;
  const admitted = existing?.admitted ?? 0;
  const previewRequest = useMemo(
    () =>
      schedules && cloudEnabled && !isDeviceTarget
        ? { client: schedules, rule, admitted, attempt: previewAttempt }
        : undefined,
    [admitted, cloudEnabled, isDeviceTarget, previewAttempt, rule, schedules],
  );
  const [previewResponse, setPreviewResponse] = useState<{
    request: NonNullable<typeof previewRequest>;
    result: { next: string | null } | { error: "invalid" | "unavailable" };
  }>();
  const preview = previewResponse?.request === previewRequest ? previewResponse?.result : undefined;
  const previousRepeat = useRef<
    | Pick<ScheduleRule, "frequency" | "weekdays" | "interval_minutes" | "count" | "end_date">
    | undefined
  >(undefined);
  const content = Array.isArray(input.run.content)
    ? input.run.content
    : [{ type: "text" as const, text: input.run.content }];
  const prompt = content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const deviceSetupInstructions =
    input.name.trim() || prompt.trim()
      ? text(
          "任务名称和说明会保留。请在此设备确认时间、模型、工作区及执行权限。",
          "Your task name and instructions will carry over. Confirm the time, model, workspace, and permissions on this device.",
        )
      : text(
          "下一步在此设备填写任务，并确认运行时间和工作区。",
          "Continue on this device to enter the task and confirm its schedule and workspace.",
        );
  const refs = content.filter((part) => part.type !== "text");
  const hasSavedSources = Boolean(existing && refs.length);
  const sourcesOnly = hasSavedSources && !prompt.trim();
  const exceedsContentLimit = content.length > SCHEDULE_CONTENT_PART_LIMIT;
  const inferredName = Array.from(prompt.trim().split(/\r?\n/, 1)[0] ?? "")
    .slice(0, 60)
    .join("");
  const publicTopic = input.run.public_research?.topic;
  const canSave = Boolean(
    !isDeviceTarget &&
      cloudEnabled &&
      !busy &&
      (prompt.trim() || hasSavedSources) &&
      !exceedsContentLimit &&
      input.run.model &&
      (publicTopic === undefined || publicTopic.trim()) &&
      preview &&
      "next" in preview &&
      (preview.next || (existing && !resumeAfterEdit)),
  );
  const frequency = isWorkdaySchedule(rule) ? "workdays" : rule.frequency;
  const endMode = rule.count ? "count" : rule.end_date ? "date" : "never";
  const modelKey = `${input.run.provider_key_id ?? 0}:${input.run.model}`;
  const modelOptions: ModelPickerOption[] = models.map((item) => ({
    providerName: text("云端", "Cloud"),
    ...item.pickerOption,
    value: `${item.keyId}:${item.model}`,
    label: item.name,
    model: item.model,
  }));
  if (input.run.model && !modelOptions.some((option) => option.value === modelKey)) {
    modelOptions.unshift({
      value: modelKey,
      label: input.run.model,
      model: input.run.model,
      providerName: text("已保存模型", "Saved model"),
    });
  }
  const setRule = (patch: Partial<ScheduleRule>) =>
    onChange({ ...input, rule: { ...rule, ...patch } });
  const setRun = (patch: Partial<ScheduleInput["run"]>) =>
    onChange({ ...input, run: { ...input.run, ...patch } });
  async function requestClose() {
    if (busy || discardDialog) return;
    const changed =
      location.id !== original.current.target ||
      (input !== original.current.input &&
        scheduleDraftSnapshot(input) !== scheduleDraftSnapshot(original.current.input));
    if (
      changed &&
      !(await confirmDiscard({
        title: text("放弃任务修改？", "Discard task changes?"),
        description: text(
          "这次填写的任务内容和设置尚未保存。",
          "Your changes to this task have not been saved.",
        ),
        confirmLabel: text("放弃修改", "Discard changes"),
        cancelLabel: text("继续编辑", "Keep editing"),
        preferCancel: true,
        touchActions: true,
      }))
    )
      return;
    onClose();
  }
  useEffect(() => {
    if (!previewRequest) return;
    const controller = new AbortController();
    const { client, rule, admitted } = previewRequest;
    let deadline: number;
    const finish = (result: NonNullable<typeof previewResponse>["result"]) => {
      window.clearTimeout(deadline);
      if (!controller.signal.aborted) setPreviewResponse({ request: previewRequest, result });
    };
    const timer = window.setTimeout(() => {
      deadline = window.setTimeout(() => {
        finish({ error: "unavailable" });
        controller.abort();
      }, 8_000);
      void client
        .preview(rule, admitted, controller.signal)
        .then((result) => finish({ next: result.next_at }))
        .catch((cause) =>
          finish({
            error:
              cause instanceof ScheduleRequestError && cause.status === 400
                ? "invalid"
                : "unavailable",
          }),
        );
    }, 200);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(deadline);
      controller.abort();
    };
  }, [previewRequest]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads the project list.
  useEffect(() => {
    if (!advancedOpen || isDeviceTarget || !projects) return;
    const client = projects;
    let current = true;
    async function load() {
      setProjectLoadFailed(false);
      const result = new Map<string, CloudProject>();
      let cursor = "";
      for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
        const page = await client.listProjects(cursor);
        if (!current) return;
        for (const project of page.items) result.set(project.id, project);
        if (!page.next_before_id || page.next_before_id === cursor) break;
        cursor = page.next_before_id;
      }
      setProjectItems([...result.values()]);
    }
    void load().catch(() => {
      if (current) setProjectLoadFailed(true);
    });
    return () => {
      current = false;
    };
  }, [advancedOpen, isDeviceTarget, projectRetry, projects]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void requestClose();
      }}
    >
      <WorkbenchScheduleDialog
        data-schedule-editor="cloud"
        initialFocus={() =>
          editSources
            ? (sourceEditor.current?.querySelector("button") ?? taskName.current)
            : resumeAfterEdit
              ? startTime.current
              : existing
                ? taskName.current
                : instructions.current
        }
        closeDisabled={busy}
        closeLabel={text("关闭", "Close")}
      >
        <DialogHeader className="min-h-16 justify-center">
          <DialogTitle>
            {resumeAfterEdit
              ? text("调整计划并恢复", "Edit schedule to resume")
              : existing
                ? text("编辑任务", "Edit task")
                : text("设置定时任务", "Schedule a task")}
          </DialogTitle>
          <DialogDescription className={resumeAfterEdit ? undefined : "sr-only"}>
            {resumeAfterEdit
              ? text(
                  "调整时间或重复规则。保存并恢复前，任务仍保持暂停。",
                  "Adjust the time or repeat rule. The task stays paused until you save and resume.",
                )
              : text(
                  "填写任务说明和时间，按计划运行后查看结果。",
                  "Enter instructions and a schedule, then return to the task for results.",
                )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) onSave({ ...input, name: input.name.trim() || inferredName });
          }}
        >
          <DialogBody className="space-y-3">
            {existing && (
              <Input
                ref={taskName}
                aria-label={text("名称", "Name")}
                className="min-h-11 rounded-2xl px-4"
                value={input.name}
                maxLength={80}
                onChange={(event) => onChange({ ...input, name: event.target.value })}
              />
            )}
            <label className="block space-y-1 text-sm" htmlFor={`${labelId}-prompt`}>
              <span className="sr-only">{text("任务说明", "Task instructions")}</span>
              <Textarea
                id={`${labelId}-prompt`}
                data-schedule-instructions=""
                ref={instructions}
                required={!hasSavedSources}
                aria-describedby={sourcesOnly ? `${labelId}-saved-sources` : undefined}
                className="min-h-28 rounded-2xl px-4 py-3.5 focus-visible:ring-1 focus-visible:ring-ring/40"
                placeholder={text("说明…", "Instructions…")}
                value={prompt}
                onChange={(event) =>
                  setRun({
                    content: refs.length
                      ? [{ type: "text", text: event.target.value }, ...refs]
                      : event.target.value,
                  })
                }
              />
            </label>
            <fieldset
              hidden={isDeviceTarget}
              disabled={isDeviceTarget}
              className="min-w-0 space-y-3"
            >
              {sourcesOnly && (
                <p id={`${labelId}-saved-sources`} className="text-xs text-muted-foreground">
                  {text(
                    "此任务使用已保存的来源，可在「高级」中查看。",
                    "This task uses saved sources. Find them under Advanced.",
                  )}
                </p>
              )}
              {exceedsContentLimit && (
                <p role="alert" className="text-xs text-destructive">
                  {text(
                    "任务最多包含 32 个内容块，请先移除一项来源。",
                    "A task can include up to 32 content items. Remove a source to save.",
                  )}
                </p>
              )}
              {publicTopic !== undefined && (
                <label className="block space-y-1.5 text-sm" htmlFor={`${labelId}-topic`}>
                  <span>{text("公开检索主题", "Public search topic")}</span>
                  <Input
                    id={`${labelId}-topic`}
                    aria-describedby={`${labelId}-topic-description`}
                    required
                    value={publicTopic}
                    onChange={(event) => setRun({ public_research: { topic: event.target.value } })}
                  />
                  <span
                    id={`${labelId}-topic-description`}
                    className="block text-xs text-muted-foreground"
                  >
                    {text(
                      "此主题会发送给公开检索服务。请填写可公开的信息。",
                      "This topic is sent to public search. Use information that can be shared publicly.",
                    )}
                  </span>
                </label>
              )}
              <div className="divide-y divide-border/60 rounded-2xl border border-border/60">
                <ScheduleSwitch
                  id={`${labelId}-repeat`}
                  label={text("重复执行任务", "Repeat task")}
                  checked={rule.frequency !== "once"}
                  onChange={(repeat) => {
                    if (repeat) {
                      setRule(previousRepeat.current ?? { frequency: "daily" });
                      return;
                    }
                    const { frequency, weekdays, interval_minutes, count, end_date } = rule;
                    previousRepeat.current = {
                      frequency,
                      weekdays,
                      interval_minutes,
                      count,
                      end_date,
                    };
                    setRule({
                      frequency: "once",
                      weekdays: undefined,
                      interval_minutes: undefined,
                      count: undefined,
                      end_date: undefined,
                    });
                  }}
                />
                {rule.frequency !== "once" && (
                  <ScheduleSelect
                    id={`${labelId}-frequency`}
                    label={text("重复", "Repeat")}
                    value={frequency}
                    options={[
                      ["daily", text("每天", "Daily")],
                      ["workdays", text("工作日", "Weekdays")],
                      ["weekly", text("每周", "Weekly")],
                      ["monthly", text("每月", "Monthly")],
                      ["interval", text("运行频率", "At intervals")],
                    ]}
                    onChange={(selected) => {
                      const frequency = selected === "workdays" ? "weekly" : selected;
                      setRule({
                        frequency,
                        weekdays:
                          selected === "workdays"
                            ? [...workdays]
                            : frequency === "weekly"
                              ? [new Date(`${rule.start}:00`).getDay() || 0]
                              : undefined,
                        interval_minutes:
                          frequency === "interval" ? (rule.interval_minutes ?? 60) : undefined,
                      });
                    }}
                  />
                )}
                <ScheduleFormRow>
                  <label className="shrink-0" htmlFor={`${labelId}-start`}>
                    {text("时间", "Time")}
                  </label>
                  <Input
                    ref={startTime}
                    id={`${labelId}-start`}
                    aria-describedby={`${labelId}-start-zone`}
                    className="min-h-11 w-auto max-w-full min-w-0 border-transparent bg-transparent text-muted-foreground md:min-h-9"
                    type="datetime-local"
                    required
                    value={rule.start}
                    onChange={(event) => setRule({ start: event.target.value })}
                  />
                  <span id={`${labelId}-start-zone`} className="sr-only">
                    {text("按计划时区输入时间", "Enter the time in the schedule's time zone")} ·{" "}
                    {rule.time_zone}
                  </span>
                </ScheduleFormRow>
                {rule.frequency === "weekly" && frequency !== "workdays" && (
                  <fieldset className="flex min-w-0 flex-wrap gap-2 px-3 pb-2">
                    <legend className="text-sm">{text("每周执行日", "Days of the week")}</legend>
                    {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                      <label
                        key={i}
                        htmlFor={`${labelId}-day-${i}`}
                        className="flex min-h-11 items-center gap-1 px-1 text-sm"
                      >
                        <Checkbox
                          id={`${labelId}-day-${i}`}
                          checked={rule.weekdays?.includes(i) ?? false}
                          onCheckedChange={(checked) =>
                            setRule({
                              weekdays: checked
                                ? [...(rule.weekdays ?? []), i]
                                : rule.weekdays?.filter((day) => day !== i),
                            })
                          }
                        />
                        {new Intl.DateTimeFormat(locale, {
                          weekday: "short",
                          timeZone: "UTC",
                        }).format(new Date(Date.UTC(2026, 10, 1 + i)))}
                      </label>
                    ))}
                  </fieldset>
                )}
                {rule.frequency === "interval" && (
                  <ScheduleFormRow>
                    <label htmlFor={`${labelId}-interval`}>
                      {text("每隔（分钟）", "Every (minutes)")}
                    </label>
                    <Input
                      id={`${labelId}-interval`}
                      className="w-28 text-right"
                      required
                      type="number"
                      min={1}
                      max={525600}
                      value={rule.interval_minutes ?? ""}
                      onChange={(event) =>
                        setRule({ interval_minutes: Number(event.target.value) })
                      }
                    />
                  </ScheduleFormRow>
                )}
                {rule.frequency !== "once" && (
                  <ScheduleSelect
                    id={`${labelId}-end`}
                    label={text("结束重复", "End repeat")}
                    value={endMode}
                    options={[
                      ["never", text("永不", "Never")],
                      ["date", text("在指定日期", "On a date")],
                      ["count", text("执行指定次数后", "After a number of runs")],
                    ]}
                    onChange={(end) =>
                      setRule({
                        end_date:
                          end === "date" ? (rule.end_date ?? rule.start.slice(0, 10)) : undefined,
                        count:
                          end === "count"
                            ? (rule.count ?? (existing?.admitted ?? 0) + 1)
                            : undefined,
                      })
                    }
                  />
                )}
                {rule.frequency !== "once" && endMode === "date" && (
                  <ScheduleFormRow>
                    <label htmlFor={`${labelId}-end-date`}>{text("结束日期", "End date")}</label>
                    <Input
                      id={`${labelId}-end-date`}
                      type="date"
                      required
                      className="w-auto"
                      min={rule.start.slice(0, 10)}
                      value={rule.end_date ?? ""}
                      onChange={(event) => {
                        if (event.target.value) setRule({ end_date: event.target.value });
                      }}
                    />
                  </ScheduleFormRow>
                )}
                {rule.frequency !== "once" && endMode === "count" && (
                  <ScheduleFormRow>
                    <label htmlFor={`${labelId}-count`}>{text("总执行次数", "Total runs")}</label>
                    <Input
                      id={`${labelId}-count`}
                      type="number"
                      required
                      className="w-28 text-right"
                      min={1}
                      value={rule.count ?? ""}
                      onChange={(event) =>
                        setRule({ count: Math.max(1, Number(event.target.value)) })
                      }
                    />
                  </ScheduleFormRow>
                )}
              </div>
              {preview && "error" in preview ? (
                <StatusNotice
                  compact
                  tone="error"
                  message={text("无法预览下次运行", "Unable to preview the next run")}
                  description={
                    preview.error === "invalid"
                      ? text(
                          "请检查时间、时区和重复规则。",
                          "Check the time, time zone and repeat rule.",
                        )
                      : text("草稿已保留。", "Your draft is still here.")
                  }
                  actions={
                    preview.error === "unavailable" && (
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-11 md:min-h-9"
                        onClick={() => setPreviewAttempt((attempt) => attempt + 1)}
                      >
                        {text("重试预览", "Retry preview")}
                      </Button>
                    )
                  }
                />
              ) : (
                <p role="status" className="px-2 text-xs text-muted-foreground">
                  {text("下次运行", "Next run")} ·{" "}
                  {preview?.next
                    ? formatTaskTime(locale, preview.next, rule.time_zone)
                    : preview?.next === null
                      ? text("没有后续运行", "No future run")
                      : previewRequest
                        ? text("正在计算", "Calculating")
                        : text("预览不可用", "Preview unavailable")}{" "}
                  · {rule.time_zone}
                </p>
              )}
            </fieldset>
            <details
              className="group"
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {text("高级", "Advanced")}
                <ChevronDown aria-hidden="true" className="size-3 group-open:rotate-180" />
              </summary>
              <div className="space-y-2">
                {!existing && (creationTargets.length > 0 || isDeviceTarget) ? (
                  <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border/60 px-3 text-sm">
                    <label htmlFor={`${labelId}-target`}>{text("执行位置", "Runs on")}</label>
                    <Select
                      value={location.id}
                      onValueChange={(id) =>
                        setLocation({
                          id,
                          label: creationTargets.find((item) => item.id === id)?.label,
                        })
                      }
                    >
                      <SelectTrigger
                        id={`${labelId}-target`}
                        aria-describedby={isDeviceTarget ? `${labelId}-target-status` : undefined}
                        variant="plain"
                        className="min-h-11 w-fit min-w-0 max-w-[68%] justify-end bg-transparent text-muted-foreground md:min-h-9"
                      >
                        <SelectValue>{isDeviceTarget ? deviceLabel : cloudTargetLabel}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cloud" disabled={!cloudEnabled}>
                          {cloudTargetLabel}
                        </SelectItem>
                        {creationTargets.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.ready
                              ? item.label
                              : `${item.label} · ${text("暂不可用", "Unavailable")}`}
                          </SelectItem>
                        ))}
                        {isDeviceTarget && !target && (
                          <SelectItem value={location.id} disabled>
                            {deviceLabel}
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {isDeviceTarget ? (
                  <p
                    id={`${labelId}-target-status`}
                    role={target?.ready ? undefined : "status"}
                    className="text-sm text-muted-foreground"
                  >
                    {target?.ready
                      ? deviceSetupInstructions
                      : target
                        ? text(
                            "设备暂时不可用。请重新连接或改选执行位置。",
                            "This device is unavailable. Reconnect it or choose another location.",
                          )
                        : text(
                            "所选设备暂不可用。草稿已保留，可重新连接或改选执行位置。",
                            "The selected device is unavailable. Your draft is kept. Reconnect it or choose another location.",
                          )}
                  </p>
                ) : null}
              </div>
              <fieldset
                hidden={isDeviceTarget}
                disabled={isDeviceTarget}
                className="mt-2 min-w-0 space-y-2 [&>div]:rounded-xl [&>div]:border [&>div]:border-border/60"
              >
                <ScheduleFormRow>
                  <label className="shrink-0" htmlFor={`${labelId}-timezone`}>
                    {text("时区", "Time zone")}
                  </label>
                  <TimeZonePicker
                    id={`${labelId}-timezone`}
                    compactLabel
                    label={text("时区", "Time zone")}
                    triggerClassName="min-h-11 w-fit max-w-[72%] border-transparent bg-transparent md:min-h-9"
                    value={rule.time_zone}
                    onChange={(time_zone) => setRule({ time_zone })}
                  />
                </ScheduleFormRow>
                <ScheduleSwitch
                  id={`${labelId}-new-conversation`}
                  label={text("每次运行时都开启新对话", "Start a new chat for each run")}
                  checked={input.new_conversation}
                  onChange={(new_conversation) =>
                    onChange({
                      ...input,
                      new_conversation,
                      archive_successful_runs: new_conversation
                        ? input.archive_successful_runs
                        : undefined,
                    })
                  }
                />
                <ScheduleFormRow>
                  <span className="shrink-0">{text("模型", "Model")}</span>
                  <div className="w-full max-w-[68%] min-w-0">
                    <ModelPicker
                      modelType="text"
                      options={modelOptions}
                      value={modelKey}
                      ariaLabel={text("模型", "Model")}
                      placeholder={text("选择模型", "Choose a model")}
                      variant="plain"
                      disabled={modelOptions.length === 0}
                      onChange={(value) => {
                        const model = models.find(
                          (item) => `${item.keyId}:${item.model}` === value,
                        );
                        if (model) setRun({ model: model.model, provider_key_id: model.keyId });
                      }}
                    />
                  </div>
                </ScheduleFormRow>
                <ScheduleSelect
                  id={`${labelId}-reasoning`}
                  label={text("思考强度", "Reasoning effort")}
                  value={input.run.reasoning_effort || "default"}
                  options={[
                    ["default", text("模型默认", "Model default")],
                    ...CLOUD_CHAT_REASONING_OPTIONS.map(
                      (level) =>
                        [
                          cloudChatReasoningEffort(level),
                          translate(
                            `settings.reasoning.${level}`,
                            locale === "zh-CN" ? "zh-CN" : "en-US",
                          ),
                        ] as const,
                    ),
                  ]}
                  onChange={(effort) =>
                    setRun({ reasoning_effort: effort === "default" ? undefined : effort })
                  }
                />
                <details open={editSources || undefined} className="group/more">
                  <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    {text("更多设置", "More settings")}
                    <ChevronDown aria-hidden="true" className="size-3 group-open/more:rotate-180" />
                  </summary>
                  <div className="space-y-2 [&>div]:rounded-xl [&>div]:border [&>div]:border-border/60">
                    {!existing && (
                      <ScheduleFormRow>
                        <label htmlFor={`${labelId}-name`}>{text("名称", "Name")}</label>
                        <Input
                          id={`${labelId}-name`}
                          className="max-w-[68%] border-transparent bg-transparent text-right"
                          value={input.name}
                          placeholder={inferredName || text("根据说明生成", "From instructions")}
                          maxLength={80}
                          onChange={(event) => onChange({ ...input, name: event.target.value })}
                        />
                      </ScheduleFormRow>
                    )}
                    <ScheduleSelect
                      id={`${labelId}-notification`}
                      label={text("任务列表通知", "Task list notifications")}
                      value={input.notification ?? "attention"}
                      options={[
                        ["attention", text("需要处理时", "When attention is needed")],
                        [
                          "all",
                          text("完成或需要处理时", "On completion or when attention is needed"),
                        ],
                        ["none", text("关闭", "Off")],
                      ]}
                      onChange={(notification) =>
                        onChange({
                          ...input,
                          notification,
                        })
                      }
                    />
                    <ScheduleSwitch
                      id={`${labelId}-approval`}
                      label={text("每次运行前需要批准", "Require approval before each run")}
                      checked={input.require_approval ?? false}
                      onChange={(require_approval) => onChange({ ...input, require_approval })}
                    />
                    <ScheduleSwitch
                      id={`${labelId}-archive`}
                      label={text("归档成功运行记录", "Archive successful runs")}
                      disabled={!input.new_conversation}
                      checked={input.archive_successful_runs ?? false}
                      hint={
                        input.new_conversation
                          ? undefined
                          : text(
                              "仅在每次新建对话时可用",
                              "Available when each run starts a new chat",
                            )
                      }
                      onChange={(archive_successful_runs) =>
                        onChange({ ...input, archive_successful_runs })
                      }
                    />
                    {projects && (
                      <>
                        <ScheduleSelect
                          id={`${labelId}-project`}
                          label={text("项目", "Project")}
                          options={projectOptions}
                          value={projectKey}
                          onChange={(value) =>
                            onChange({ ...input, project_id: value === "none" ? undefined : value })
                          }
                        />
                        {advancedOpen && (projectLoadFailed || !projectItems) && (
                          <ScheduleFormRow>
                            <span className="text-xs text-muted-foreground" role="status">
                              {projectLoadFailed
                                ? text("暂时无法读取项目", "Projects are unavailable")
                                : text("正在读取项目", "Loading projects")}
                            </span>
                            {projectLoadFailed && (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => setProjectRetry((value) => value + 1)}
                              >
                                {text("重试", "Retry")}
                              </Button>
                            )}
                          </ScheduleFormRow>
                        )}
                      </>
                    )}
                    <ScheduleSwitch
                      id={`${labelId}-research`}
                      label={text("公开网页调研", "Research the public web")}
                      checked={!!input.run.public_research}
                      onChange={(checked) =>
                        setRun({ public_research: checked ? { topic: "" } : undefined })
                      }
                    />
                    <div ref={sourceEditor} className="border-0">
                      <ScheduleSourcePicker
                        content={input.run.content}
                        active={advancedOpen}
                        space={space}
                        files={sourceMetadata?.files}
                        artifacts={sourceMetadata?.artifacts}
                        text={text}
                        onChange={(content) => setRun({ content })}
                      />
                    </div>
                  </div>
                </details>
              </fieldset>
            </details>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogActions className="max-[720px]:[&>button]:min-h-11">
              <Button
                type="button"
                variant="secondary"
                className="rounded-full"
                disabled={busy}
                onClick={() => void requestClose()}
              >
                {text("取消", "Cancel")}
              </Button>
              {isDeviceTarget ? (
                <Button
                  type="button"
                  className="rounded-full"
                  disabled={busy || !target?.ready}
                  onClick={() => {
                    if (target?.ready) onOpenTarget(target);
                  }}
                >
                  {text("继续设置", "Continue to task editor")}
                </Button>
              ) : (
                <Button type="submit" className="rounded-full" disabled={!canSave}>
                  {resumeAfterEdit
                    ? text("保存并恢复", "Save and resume")
                    : existing
                      ? text("保存", "Save")
                      : text("创建", "Create")}
                </Button>
              )}
            </DialogActions>
          </DialogFooter>
        </form>
        {discardDialog}
      </WorkbenchScheduleDialog>
    </Dialog>
  );
}
