import { mountWorkbenchLayout } from "@liveagent/ui/application/workbenchLayoutPortal";
import { ModelPicker, type ModelPickerOption } from "@liveagent/ui/pages/settings/modelPicker";
import { ConversationStarter } from "@liveagent/ui/components/chat/ConversationStarter";
import {
  ArrowLeft,
  BookOpen,
  CalendarDays,
  ChartColumn,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileText,
  Globe,
  Lightbulb,
  ListFilter,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
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
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import { t as translate } from "@liveagent/ui/i18n/index";
import {
  type CronRunRecord,
  type CronTask,
  isCronRunActive,
  type ScheduledConversationRun,
} from "@liveagent/ui/lib/automation/types";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import type { TranscriptMessageJump } from "@liveagent/ui/lib/transcript-virtual/useTranscriptMessageJump";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  CLOUD_CHAT_REASONING_OPTIONS,
  cloudChatReasoningEffort,
} from "../../lib/cloudChatModelParameters";
import type { CloudChatPresentationResource } from "../../lib/cloudChatPresentation";
import type { CloudChatProjectsClient, CloudProject } from "../../lib/cloudChatProjects";
import { type CloudChatRoute, type TaskStatus, taskStatuses } from "../../lib/cloudChatRoute";
import type { createCloudChatRunsClient } from "../../lib/cloudChatRuns";
import {
  type CloudTaskConversationSelection,
  cloudSchedules,
  type Schedule,
  ScheduleEndpointUnavailableError,
  type ScheduleInput,
  ScheduleRequestError,
  type ScheduleRule,
  type ScheduleRun,
} from "../../lib/cloudSchedules";
import type { CloudSpaceClient, CloudSpaceItem } from "../../lib/cloudSpace";
import type { DeviceScheduleEditorProps, DeviceScheduleHost } from "../../lib/deviceScheduleHost";
import type { ExecutionEnvironment } from "../../lib/executionTargets";
import { useScheduledRunPreview } from "./useScheduledRunPreview";

type Route = Extract<CloudChatRoute, { page: "tasks" }>;
type Model = { name: string; model: string; keyId: number; pickerOption?: ModelPickerOption };
type Text = (zh: string, en: string) => string;
type CreationTarget = {
  id: string;
  label: string;
  ready: boolean;
  inline?: boolean;
  open: () => void | Promise<void>;
};
type TaskRow = {
  id: string;
  target: string;
  name: string;
  secondary: string;
  group: NonNullable<Route["status"]>;
};
const row =
  "flex min-h-11 w-full min-w-0 items-center rounded-lg px-3 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9";
const taskDetailsClass =
  "z-20 order-1 mx-auto mt-1 max-h-[min(34dvh,16rem)] w-[calc(100%-2rem)] max-w-3xl min-w-0 shrink-0 divide-y divide-border/60 overflow-auto rounded-2xl border border-border/60 bg-popover text-sm shadow-sm @min-[56rem]:absolute @min-[56rem]:top-0 @min-[56rem]:right-3 @min-[56rem]:max-h-[calc(100%-1rem)] @min-[56rem]:w-64";
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function status(task: Schedule): NonNullable<Route["status"]> {
  return !task.enabled ? "paused" : task.next_at ? "enabled" : "completed";
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

function localStart() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return new Date(next.getTime() - next.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
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
  mobileRail,
  previewOpen,
  onPinSidebar,
  sidebarTarget,
  sidebarOnly,
  hideSidebar,
  hostSidebarTrigger,
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
  onOpenResultResource: (conversation: string, resource: CloudChatPresentationResource) => void;
  runClient?: Pick<ReturnType<typeof createCloudChatRunsClient>, "getRun">;
  onBack: () => void;
  locale: string;
  fontScale?: number;
  currentModel: Model;
  models: readonly Model[];
  space?: CloudSpaceClient;
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
  mobileRail?: ReactNode;
  previewOpen?: boolean;
  onPinSidebar?: () => void;
  sidebarTarget?: HTMLElement | null;
  sidebarOnly?: boolean;
  hideSidebar?: boolean;
  hostSidebarTrigger?: boolean;
}) {
  const text: Text = (zh, en) => (locale === "zh-CN" ? zh : en);
  const { isMobile, open, openMobile, setOpenMobile } = useSidebar();
  const [items, setItems] = useState<Awaited<ReturnType<typeof cloudSchedules.list>> | null>(null);
  const [history, setHistory] = useState<{ task: string; runs: ScheduleRun[] }>({
    task: "",
    runs: [],
  });
  const [deviceTasks, setDeviceTasks] = useState<Awaited<ReturnType<DeviceScheduleHost["list"]>>>();
  const [deviceHistory, setDeviceHistory] = useState<{
    target: string;
    task: string;
    runs: Awaited<ReturnType<DeviceScheduleHost["runs"]>>;
  }>({ target: "", task: "", runs: [] });
  const [deviceFailure, setDeviceFailure] = useState("");
  const [taskDetailsOpen, setTaskDetailsOpen] = useState(false);
  const taskDetailsInset = taskDetailsOpen ? "@min-[56rem]:pr-[17.5rem] @min-[83rem]:pr-0" : "";
  const taskDetailsId = useId();
  const [chromeHost, setChromeHost] = useState<{ id: string; element: HTMLDivElement }>();
  const taskDetailsTrigger = useRef<HTMLElement>(null);
  function closeTaskDetails() {
    setTaskDetailsOpen(false);
    taskDetailsTrigger.current?.focus({ preventScroll: true });
  }
  const [runResources, setRunResources] = useState<{
    id: string;
    items: CloudChatPresentationResource[];
    messageId?: string;
    error?: boolean;
  }>();
  const [manualCloudRun, setManualCloudRun] = useState<{
    owner: typeof owner;
    taskId: string;
    runId: string;
    previousConversationId?: string;
  }>();
  const [cloudJumpSequence, setCloudJumpSequence] = useState(0);
  const [unavailableCloudJump, setUnavailableCloudJump] = useState<string>();
  const [deviceReadAt, setDeviceReadAt] = useState(0);
  const [deviceJumpSequence, setDeviceJumpSequence] = useState(0);
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
  const [searchOpen, setSearchOpen] = useState(!!query);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<TaskStatus>>(() => new Set());
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const { confirm, dialog: authorityDialog } = useConfirmDialog();
  const [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState<{
    existing?: Schedule;
    input: ScheduleInput;
    id: string;
    target?: string;
  }>();
  const [deviceEditor, setDeviceEditor] = useState<{
    id: string;
    task?: CronTask;
    prompt?: string;
  }>();
  const currentWrite = useRef(false);
  const scope = route.scope ?? (!route.id ? route.target : undefined);
  const onDevice = !!device && route.target === device.targetId;
  const task =
    !route.target || route.target === "cloud"
      ? items?.tasks.find((item) => item.id === route.id)
      : undefined;
  const pendingRunKey = task ? `zeroagent.task-manual:${owner}:${task.id}` : undefined;
  const hasPendingRun = pendingRunKey ? Boolean(sessionStorage.getItem(pendingRunKey)) : false;
  const deviceTask = onDevice ? deviceTasks?.tasks.find((item) => item.id === route.id) : undefined;
  const deviceRuns =
    deviceTask && deviceHistory.task === deviceTask.id && deviceHistory.target === route.target
      ? deviceHistory.runs
      : [];
  const deviceRun = route.run
    ? deviceRuns.find((run) => run.id === route.run || run.runId === route.run)
    : deviceRuns[0];
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
          deviceJumpSequence,
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
  const runs = history.task === route.id ? history.runs : [];
  const cloudHistoryLoading = Boolean(task && history.task !== task.id && !loadError);
  const targetLabel =
    scope === "cloud"
      ? text("云端", "Cloud")
      : scope === device?.targetId
        ? device?.label
        : environments.find((environment) => environment.device_id === scope)?.name;
  const selectedRun = route.run ? runs.find((run) => run.id === route.run) : runs[0];
  const cloudRunBusy = runs.some((run) =>
    ["pending", "awaiting_approval", "queued", "running", "cancelling"].includes(run.state),
  );
  const selectedConversationId = selectedRun?.conversation_id;
  const selectedCloudRunId = selectedRun?.run_id;
  const isManualSelection =
    manualCloudRun?.owner === owner &&
    manualCloudRun.taskId === task?.id &&
    manualCloudRun.runId === route.run;
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
  const selectedRunResources = runResources?.id === selectedCloudRunId ? runResources : undefined;
  const selectedMessageId = cloudJumpKey ? selectedRunResources?.messageId : undefined;
  const cloudJumpUnavailable = Boolean(
    cloudJumpKey &&
      (unavailableCloudJump === cloudJumpKey || (selectedRunResources && !selectedMessageId)),
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
  const selectConversation = useEffectEvent((selection: CloudTaskConversationSelection) =>
    onSelectConversation?.(selection),
  );
  useEffect(() => {
    if (!liveConversationId || !selectedCloudRunId) return;
    selectConversation({
      id: liveConversationId,
      runId: selectedCloudRunId,
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
  ]);
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(
    selectedRun?.state ?? "",
  );
  const time = (value: string, timeZone?: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(
      new Date(value),
    );
  const labels = {
    enabled: text("已启用", "Active"),
    paused: text("已暂停", "Paused"),
    completed: text("已完成", "Completed"),
  };
  function backToList() {
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
  const manualRunAwaitingRecord = isManualSelection && !selectedRun;
  const runCardState = liveConversationId ? (selectedRun?.state ?? "pending") : undefined;
  const runCardStatus = runCardState ?? (manualRunAwaitingRecord ? "pending" : undefined);
  const runReasons: Record<string, string> = {
    authorization_required: text("账户登录已失效，请重新登录后恢复计划。", "Sign in again, then resume the schedule."),
    cloud_execution_unavailable: text(
      "当前服务暂不支持从桌面启用云端任务。你可以在网页端用同一账户操作。",
      "Cloud execution from the desktop is unavailable. You can use the same account on the web.",
    ),
    schedule_project_unavailable: text(
      "所选项目或结果对话的项目归属已变更。请编辑任务并核对项目。",
      "The selected project or result chat's project changed. Review the project's settings on this task.",
    ),
    missed: text("已超过五分钟补发窗口。", "The five-minute catch-up window has passed."),
    overlap: text("上一轮仍在运行。", "The previous run is still active."),
  };
  function deviceRunStatus(run: (typeof deviceRuns)[number]) {
    if (run.terminationReason === "cancelled") return runLabels.cancelled;
    if (run.state === "done") return run.success ? labels.completed : runLabels.failed;
    if (run.state === "leased") return runLabels.running;
    return run.state === "expired" ? runLabels.interrupted : runLabels.pending;
  }
  const taskDetailsButton = (
    <TooltipButton
      ref={taskDetailsTrigger}
      size="icon"
      variant="ghost"
      title={text("任务详情", "Task details")}
      aria-label={text("任务详情", "Task details")}
      aria-expanded={taskDetailsOpen}
      aria-controls={taskDetailsOpen ? taskDetailsId : undefined}
      className={taskDetailsOpen ? "bg-muted" : undefined}
      onClick={(event) => {
        setTaskDetailsOpen(!taskDetailsOpen);
        if (!taskDetailsOpen && event.detail === 0) {
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
      <Settings2 className="size-4" />
    </TooltipButton>
  );

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
  }, [onlineDevices, schedules]);

  useEffect(() => {
    if (
      !runClient ||
      !selectedCloudRunId ||
      !selectedConversationId ||
      (!cloudJumpKey && !(taskDetailsOpen && terminal))
    )
      return;
    const abort = new AbortController();
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
        setRunResources({
          id: run.id,
          items: [...resources.values()],
          messageId: run.user_message_id || run.assistant_message_id || undefined,
        });
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setRunResources({ id: selectedCloudRunId, items: [], error: true });
      });
    return () => abort.abort();
  }, [
    cloudJumpKey,
    runClient,
    selectedCloudRunId,
    selectedConversationId,
    taskDetailsOpen,
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
    let timer: number;
    async function load() {
      try {
        const snapshot = await client.list(abort.signal);
        if (abort.signal.aborted) return;
        setItems(snapshot);
        if (
          route.id &&
          (!route.target || route.target === "cloud") &&
          snapshot.tasks.some((item) => item.id === route.id)
        ) {
          const { runs } = await client.runs(route.id, abort.signal);
          if (!abort.signal.aborted) setHistory({ task: route.id, runs });
        }
        if (!abort.signal.aborted) setLoadError("");
      } catch (cause) {
        if (!abort.signal.aborted)
          setLoadError(
            cause instanceof ScheduleEndpointUnavailableError
              ? text(
                  "无法连接云端定时任务。请重试。",
                  "Cloud scheduled tasks are unreachable. Try again.",
                )
              : message(cause),
          );
      } finally {
        if (!abort.signal.aborted) timer = window.setTimeout(() => void load(), 5000);
      }
    }
    void load();
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [refresh, route.id, route.target, schedules, locale]);

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
        setDeviceTasks(next);
        setDeviceReadAt(Date.now());
        setDeviceFailure("");
        if (onDevice && route.id && next.tasks.some((item) => item.id === route.id)) {
          const runs = await device.runs(route.id);
          if (current) setDeviceHistory({ target: device.targetId, task: route.id, runs });
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
  }, [device, onDevice, refresh, route.id]);

  async function write(action: () => Promise<void>) {
    if (currentWrite.current) return;
    currentWrite.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      const reason = cause instanceof ScheduleRequestError ? cause.reason : undefined;
      setError(reason && Object.hasOwn(runReasons, reason) ? runReasons[reason] : message(cause));
    } finally {
      currentWrite.current = false;
      setBusy(false);
      setRefresh((value) => value + 1);
    }
  }

  function newTask(prompt = "", research = false) {
    if (device && renderDeviceEditor && !items?.enabled && !deviceFailure) {
      openDeviceEditor(undefined, prompt);
      return;
    }
    setEditor({
      id: createUuid(),
      target: prompt ? "cloud" : undefined,
      input: {
        name: "",
        rule: {
          frequency: "daily",
          start: localStart(),
          time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
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

  function openDeviceEditor(task?: CronTask, prompt?: string) {
    setError("");
    setEditor(undefined);
    setDeviceEditor({ id: task?.id ?? createUuid(), task, prompt });
  }

  const deviceRunDisabled = !!deviceFailure || busy || deviceRuns.some(isCronRunActive);

  function runDeviceTask(item: CronTask) {
    if (!device) return;
    void write(async () => {
      const receipt = await device.runNow(item.id);
      setManualDeviceRun(receipt.executionId);
      onNavigate({ ...route, run: receipt.executionId });
    });
  }

  function deviceTaskMenu(item: CronTask, showRunActions = false) {
    if (!device) return null;
    return (
      <>
        {showRunActions && (
          <DropdownMenuItem disabled={deviceRunDisabled} onClick={() => runDeviceTask(item)}>
            {text("立即运行", "Run now")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={!!deviceFailure || busy || !renderDeviceEditor}
          onClick={() => openDeviceEditor(item)}
        >
          {text("编辑任务", "Edit task")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!!deviceFailure || busy || item.remainingExecutions === 0}
          onClick={() =>
            void write(async () => {
              await device.toggle(item);
            })
          }
        >
          {item.enabled ? text("暂停", "Pause") : text("恢复", "Resume")}
        </DropdownMenuItem>
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
          {text("删除任务", "Delete task")}
        </DropdownMenuItem>
      </>
    );
  }


  function runNow(task: Schedule) {
    if (!schedules || !pendingRunKey || currentWrite.current) return;
    const request = sessionStorage.getItem(pendingRunKey) ?? createUuid();
    sessionStorage.setItem(pendingRunKey, request);
    void write(async () => {
      const run = await schedules.run(task.id, request);
      sessionStorage.removeItem(pendingRunKey);
      setManualCloudRun({
        owner,
        taskId: task.id,
        runId: run.id,
        previousConversationId: task.new_conversation ? undefined : liveConversationId,
      });
      onNavigate({ ...route, id: task.id, run: run.id });
    });
  }

  function cancelCloudRun(task: Schedule, run: ScheduleRun) {
    if (!schedules) return;
    return write(async () => {
      if (run.run_id) await schedules.cancel(run.run_id);
      else await schedules.cancelPending(task.id, run.id);
    });
  }

  function openCloudEditor(item: Schedule) {
    setEditor({ existing: item, input: taskInput(item), id: createUuid() });
  }

  const cloudRunDisabled =
    !items?.enabled ||
    busy ||
    (!hasPendingRun && (cloudRunBusy || manualRunAwaitingRecord));
  const cloudRunLabel = hasPendingRun
    ? text("核对运行", "Check submission")
    : text("立即运行", "Run now");

  function cloudTaskMenu(item: Schedule, showRunActions = false) {
    return (
      <>
        {showRunActions && (
          <DropdownMenuItem disabled={cloudRunDisabled} onClick={() => runNow(item)}>
            {cloudRunLabel}
          </DropdownMenuItem>
        )}
        {showRunActions && waitingInPreviousConversation && selectedRun && (
          <DropdownMenuItem disabled={busy} onClick={() => void cancelCloudRun(item, selectedRun)}>
            {text("取消本次运行", "Cancel this run")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={!items?.enabled || busy} onClick={() => openCloudEditor(item)}>
          {text("编辑任务", "Edit task")}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!schedules || !items?.enabled || busy}
          onClick={() =>
            void write(async () => {
              await schedules?.save(taskInput(item), !item.enabled, createUuid(), item);
            })
          }
        >
          {item.enabled ? text("暂停", "Pause") : text("恢复", "Resume")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive data-[highlighted]:text-destructive"
          disabled={busy || !schedules}
          onClick={() => {
            if (!schedules) return;
            void write(async () => {
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
          {text("删除", "Delete")}
        </DropdownMenuItem>
      </>
    );
  }

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
            item.notification !== "none" &&
            (attention || (latest === "completed" && item.notification === "all"));
          return {
            id: item.id,
            target: "cloud",
            name: item.name,
            group: status(item),
            secondary: [
              text("云端", "Cloud"),
              item.next_at ? time(item.next_at, item.rule.time_zone) : labels[status(item)],
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
          const group =
            item.remainingExecutions === 0 ? "completed" : item.enabled ? "enabled" : "paused";
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
  const showMobileListOnly = isMobile && !route.id && (taskRows.length > 0 || filtersActive);
  const creationTargets: CreationTarget[] = [];
  if (device && renderDeviceEditor)
    creationTargets.push({
      id: device.targetId,
      label: device.label,
      ready: !deviceFailure,
      inline: true,
      open: () =>
        openDeviceEditor(undefined, editor ? schedulePrompt(editor.input.run.content) : undefined),
    });
  for (const environment of environments) {
    if (environment.runtime_kind !== "device_agent" || !environment.device_id) continue;
    creationTargets.push({
      id: environment.device_id,
      label: environment.name,
      ready: environment.online && environment.workspaces.length > 0,
      open: () => onOpenDevice(environment),
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
  const newTaskLabel = text("新建任务", "New task");
  const searchLabel = text("搜索任务", "Search tasks");
  const canCreate = items?.enabled || creationTargets.some((target) => target.ready);
  const filterTrigger = (
    <TooltipButton
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
  const renderSidebarContents = (focusable: boolean) => (
    <>
      <SidebarHeader className="shrink-0 px-3 pb-2 pt-2.5">
        <SidebarHeaderRow
          actions={
            <>
              {isMobile ? (
                <Dialog>
                  <DialogTrigger render={filterTrigger} />
                  <DialogContent
                    layout="bottom-sheet-mobile"
                    showCloseButton
                    closeLabel={text("关闭", "Close")}
                  >
                    <DialogHeader>
                      <DialogTitle>{filterLabel}</DialogTitle>
                      <DialogDescription>
                        {text(
                          "按状态或执行位置查看任务。",
                          "Find tasks by status or execution target.",
                        )}
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
                          <SelectValue>{targetLabel ?? targets[0].label}</SelectValue>
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
                  <DropdownMenuTrigger render={filterTrigger} />
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
              {isMobile ? (
                <SidebarTrigger
                  showShortcut={false}
                  className="size-11 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                  aria-label={
                    openMobile
                      ? text("关闭边栏", "Close sidebar")
                      : text("打开导航", "Open navigation")
                  }
                >
                  {openMobile ? <X className="size-4" /> : <PanelLeft className="size-4" />}
                </SidebarTrigger>
              ) : (
                <SidebarTrigger
                  showShortcut={!previewOpen}
                  className="shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                  title={
                    previewOpen
                      ? text("固定边栏", "Pin sidebar")
                      : text("收起边栏", "Collapse sidebar")
                  }
                  aria-label={
                    previewOpen
                      ? text("固定边栏", "Pin sidebar")
                      : text("收起边栏", "Collapse sidebar")
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
          }
        >
          {!isMobile && (
            <TooltipButton
              variant="ghost"
              size="icon-sm"
              className="shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
              title={text("返回工作台", "Back to workbench")}
              aria-label={text("返回工作台", "Back to workbench")}
              onClick={onBack}
            >
              <ArrowLeft className="size-4" />
            </TooltipButton>
          )}
          <h1 className="min-w-0 truncate text-base font-semibold leading-6">
            {text("定时任务", "Scheduled tasks")}
          </h1>
        </SidebarHeaderRow>
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
        <SidebarMenu className="mt-2.5">
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
      </SidebarHeader>
      <SidebarContent className="overflow-hidden">
        <div className="za-native-scroll scroll-fade flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-3 pb-3">
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
                      return (
                        <SidebarMenuItem key={`${item.target}:${item.id}`}>
                          <SidebarMenuButton
                            type="button"
                            variant="navigation"
                            isActive={selected}
                            aria-current={selected ? "page" : undefined}
                            className={`h-auto min-w-0 py-1 ${isMobile ? "min-h-11 group-has-data-[sidebar=menu-action]/menu-item:pr-13" : "min-h-10 group-has-data-[sidebar=menu-action]/menu-item:pr-9"}`}
                            onClick={() => {
                              setOpenMobile(false);
                              onNavigate({
                                ...route,
                                scope,
                                target: item.target,
                                id: item.id,
                                run: undefined,
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
          {!taskRows.length &&
          filtersActive &&
          !unavailable &&
          (!schedules || items || loadError) &&
          (!device || deviceTasks || deviceFailure) ? (
            <EmptyState className="h-auto gap-2 px-2 py-7">
              <span>{text("没有匹配的任务", "No matching tasks")}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  updateQuery("");
                  onNavigate({
                    ...route,
                    scope: undefined,
                    status: undefined,
                    statuses: undefined,
                    target: route.id ? route.target : undefined,
                  });
                }}
              >
                {text("清除筛选", "Clear filters")}
              </Button>
            </EmptyState>
          ) : null}
          {!taskRows.length &&
          !filtersActive &&
          (!schedules || items) &&
          (!device || deviceTasks) ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {text("还没有定时任务", "No scheduled tasks yet")}
            </p>
          ) : null}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (onRetryCloud) onRetryCloud();
                      else {
                        setLoadError("");
                        setRefresh((value) => value + 1);
                      }
                    }}
                  >
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
      className="workbench-feature-sidebar zone-font-scale bg-background"
      style={{ "--zone-font-scale": fontScale } as CSSProperties}
    >
      {renderSidebarContents(!isMobile || openMobile)}
    </Sidebar>
  );
  const cloudTaskHeader = task && (
    <TaskDetailHeader
      name={task.name}
      compact
      leading={!open && !isMobile && !hostSidebarTrigger ? <SidebarTrigger /> : undefined}
      text={text}
      onBack={isMobile ? backToList : undefined}
      menu={cloudTaskMenu(task, Boolean(liveConversationId))}
    >
      {waitingInPreviousConversation && (
        <span role="status" className="max-w-24 truncate text-xs text-muted-foreground">
          {runLabels.pending}
        </span>
      )}
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
          : sidebarTarget && createPortal(navigation, sidebarTarget))}
      {!sidebarOnly && isMobile && !route.id && (
        <div
          className={`zone-font-scale flex min-h-0 min-w-0 flex-col bg-background ${showMobileListOnly ? "flex-1" : "shrink-0"}`}
          style={{ "--zone-font-scale": fontScale } as CSSProperties}
        >
          {renderSidebarContents(!openMobile)}
        </div>
      )}
      {!sidebarOnly && (
        <div
          className={`@container min-h-0 min-w-0 flex-1 flex-col ${liveConversationId || deviceConversationId ? "overflow-hidden" : "overflow-auto"} ${showMobileListOnly ? "hidden" : "flex"}`}
        >
          {!task && !open && !isMobile && !hostSidebarTrigger && (
            <div className="px-3 pt-2">
              <SidebarTrigger />
            </div>
          )}
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
                compact
                text={text}
                onBack={isMobile ? backToList : undefined}
                menu={deviceTaskMenu(deviceTask, Boolean(deviceConversationId))}
              >
                {taskDetailsButton}
              </TaskDetailHeader>
              <div
                className={`relative flex min-h-0 min-w-0 flex-1 flex-col px-4 md:px-6 ${deviceConversationId ? "gap-2" : "gap-4 pb-8"} ${taskDetailsInset}`}
              >
                {(!deviceConversationId || (deviceAnchor && !deviceAnchor.messageId)) && (
                  <main
                    className={`order-2 mx-auto w-full max-w-3xl min-w-0 ${deviceConversationId ? "shrink-0 space-y-2 pt-2" : "space-y-7 pt-5"}`}
                    aria-label={text("任务结果", "Task results")}
                  >
                    {!deviceConversationId && deviceTask.prompt && (
                      <TaskPromptBubble>{deviceTask.prompt}</TaskPromptBubble>
                    )}
                    {!deviceConversationId && (
                      <div className="space-y-3">
                        <p className="text-sm leading-relaxed">
                          {deviceNext
                            ? `${text("下次运行", "Next run")} · ${time(new Date(deviceNext).toISOString(), deviceTasks?.timeZone)}`
                            : deviceTask.enabled
                              ? text("暂无下次运行时间。", "No upcoming run is available.")
                              : text("任务已暂停。", "This task is paused.")}
                        </p>
                        <TaskPlanCard
                          name={deviceTask.name}
                          metadata={`${device.label} · ${
                            labels[
                              deviceTask.remainingExecutions === 0
                                ? "completed"
                                : deviceTask.enabled
                                  ? "enabled"
                                  : "paused"
                            ]
                          }`}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!!deviceFailure || busy || !renderDeviceEditor}
                            onClick={() => openDeviceEditor(deviceTask)}
                          >
                            {text("打开", "Open")}
                          </Button>
                          <Button
                            size="sm"
                            disabled={deviceRunDisabled}
                            onClick={() => runDeviceTask(deviceTask)}
                          >
                            {text("立即运行", "Run now")}
                          </Button>
                        </TaskPlanCard>
                      </div>
                    )}
                    {deviceRun && !deviceConversationId && (
                      <article className="space-y-4" aria-label={text("运行结果", "Run result")}>
                        <p className="text-center text-xs text-muted-foreground">
                          {time(new Date(deviceRun.startedAt).toISOString(), deviceTasks?.timeZone)}
                        </p>
                        {deviceRun.counted === false && (
                          <TaskPromptBubble>{text("立即运行", "Run now")}</TaskPromptBubble>
                        )}
                        <p
                          className="border-b border-border/60 pb-2 text-sm text-muted-foreground"
                          role="status"
                        >
                          {deviceRunStatus(deviceRun)}
                        </p>
                        {deviceRun.output && (
                          <pre className="whitespace-pre-wrap break-words text-sm">
                            {deviceRun.output}
                          </pre>
                        )}
                        {deviceRun.sessionId && onOpenDeviceConversation && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              if (deviceRun.sessionId)
                                onOpenDeviceConversation(deviceRun.sessionId);
                            }}
                          >
                            {text("打开结果对话", "Open result conversation")}
                          </Button>
                        )}
                        {cancelDeviceRun}
                      </article>
                    )}
                    {deviceAnchor && !deviceAnchor.messageId && (
                      <p className="px-2 text-xs text-muted-foreground" role="status">
                        {text(
                          "正文中无法定位这次运行。可在任务详情中查看本次输出。",
                          "This run cannot be located in the conversation. Its output is in task details.",
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
                {taskDetailsOpen && (
                  <TaskInspector id={taskDetailsId} text={text} onClose={closeTaskDetails}>
                    <TaskInspectorGroup title={text("定时任务", "Scheduled task")}>
                      <TaskInspectorPlan
                        name={deviceTask.name}
                        status={
                          labels[
                            deviceTask.remainingExecutions === 0
                              ? "completed"
                              : deviceTask.enabled
                                ? "enabled"
                                : "paused"
                          ]
                        }
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
                      <ScheduleDisclosure title={text("运行记录", "Run history")}>
                        {deviceRuns.length ? (
                          <div className="max-h-56 overflow-y-auto">
                            {deviceRuns.map((run) => (
                              <Button
                                type="button"
                                variant="ghost"
                                key={run.id}
                                aria-current={run.id === deviceRun?.id ? "true" : undefined}
                                className={`h-auto min-h-11 w-full flex-col items-start justify-center gap-0.5 px-2 py-1 font-normal ${deviceRun?.id === run.id ? "bg-muted" : ""}`}
                                onClick={() => {
                                  setManualDeviceRun(undefined);
                                  setDeviceJumpSequence((sequence) => sequence + 1);
                                  onNavigate({ ...route, run: run.id });
                                }}
                              >
                                {time(new Date(run.startedAt).toISOString(), deviceTasks?.timeZone)}
                                <span className="text-xs text-muted-foreground">
                                  {deviceRunStatus(run)}
                                </span>
                              </Button>
                            ))}
                          </div>
                        ) : (
                          <p className="text-muted-foreground">
                            {text("暂无运行记录", "No runs yet")}
                          </p>
                        )}
                      </ScheduleDisclosure>
                    </TaskInspectorGroup>
                    {deviceConversationId && deviceRun && (
                      <TaskInspectorGroup title={text("输出", "Outputs")}>
                        {deviceRun.output ? (
                          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                            {deviceRun.output}
                          </pre>
                        ) : (
                          <p className="text-muted-foreground">
                            {text("暂无输出", "No output yet")}
                          </p>
                        )}
                        {onOpenDeviceConversation && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => onOpenDeviceConversation(deviceConversationId)}
                          >
                            {text("打开结果对话", "Open result conversation")}
                          </Button>
                        )}
                      </TaskInspectorGroup>
                    )}
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
              <div
                className={`relative flex min-h-0 min-w-0 flex-1 flex-col gap-4 ${liveConversationId ? "" : "px-4 pb-8 md:px-6"} ${inspectorTarget ? "" : taskDetailsInset}`}
              >
                {cloudHistoryLoading && (
                  <p
                    role="status"
                    className="order-2 mx-auto w-full max-w-3xl px-4 pt-4 text-sm text-muted-foreground"
                  >
                    {text("正在读取运行记录…", "Loading run history…")}
                  </p>
                )}
                {!cloudHistoryLoading && (!liveConversationId || cloudJumpUnavailable) && (
                  <main
                    className={`order-2 mx-auto w-full max-w-3xl min-w-0 shrink-0 ${liveConversationId ? "px-4 md:px-6" : "space-y-7 pt-5"}`}
                    aria-label={text("任务对话", "Task conversation")}
                  >
                    {!liveConversationId && (
                      <TaskPromptBubble>{schedulePrompt(task.run.content)}</TaskPromptBubble>
                    )}
                    {!liveConversationId && (
                      <div className="space-y-3">
                        <p className="text-sm leading-relaxed">
                          {task.next_at
                            ? `${text("任务已安排。下次运行", "Task scheduled. Next run")} · ${time(task.next_at, task.rule.time_zone)}`
                            : task.enabled
                              ? text("此任务暂无下次运行。", "This task has no upcoming run.")
                              : text("任务已暂停。", "This task is paused.")}
                        </p>
                        <TaskPlanCard
                          name={task.name}
                          metadata={`${text("云端", "Cloud")} · ${labels[status(task)]}${runCardStatus ? ` · ${runLabels[runCardStatus] ?? runCardStatus}` : ""}`}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={!items?.enabled || busy}
                            onClick={() => openCloudEditor(task)}
                          >
                            {text("打开", "Open")}
                          </Button>
                          <Button
                            size="sm"
                            disabled={cloudRunDisabled}
                            onClick={() => runNow(task)}
                          >
                            {cloudRunLabel}
                          </Button>
                        </TaskPlanCard>
                      </div>
                    )}
                    {selectedRun?.archived && !liveConversationId && (
                      <p className="text-sm text-muted-foreground">
                        {text("结果对话已归档", "Result conversation archived")}
                      </p>
                    )}
                    {cloudJumpUnavailable && (
                      <p role="status" className="text-xs text-muted-foreground">
                        {text(
                          "正文中无法定位这次运行。可在任务详情中查看本次输出。",
                          "This run cannot be located in the conversation. Its output is in task details.",
                        )}
                      </p>
                    )}
                    {selectedRun && !liveConversationId ? (
                      <article className="space-y-4" aria-label={text("运行结果", "Run result")}>
                        <p className="text-center text-xs text-muted-foreground">
                          {time(selectedRun.trigger_at, task.rule.time_zone)}
                        </p>
                        {selectedRun.manual && (
                          <div className="flex justify-end">
                            <span className="rounded-full bg-foreground px-4 py-2 text-sm text-background">
                              {text("立即运行", "Run now")}
                            </span>
                          </div>
                        )}
                        <div
                          className="border-b border-border/60 pb-2 text-sm text-muted-foreground"
                          role="status"
                        >
                          {runLabels[selectedRun.state] ?? selectedRun.state}
                        </div>
                        {selectedRun.approval && (
                          <div className="space-y-3">
                            <h4 className="font-medium">
                              {text("批准这次运行？", "Approve this run?")}
                            </h4>
                            <p className="whitespace-pre-wrap break-words text-sm">
                              {typeof selectedRun.approval.run.content === "string"
                                ? selectedRun.approval.run.content
                                : selectedRun.approval.run.content
                                    .filter((part) => part.type === "text")
                                    .map((part) => part.text)
                                    .join("\n")}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {selectedRun.approval.run.model} ·{" "}
                              {text("关联资料", "Attached resources")}{" "}
                              {Array.isArray(selectedRun.approval.run.content)
                                ? selectedRun.approval.run.content.filter(
                                    (part) => part.type !== "text",
                                  ).length
                                : 0}
                            </p>
                            {selectedRun.approval.run.public_research && (
                              <p className="break-words text-xs text-muted-foreground">
                                {text("公开主题", "Public topic")} ·{" "}
                                {selectedRun.approval.run.public_research.topic}
                              </p>
                            )}
                            <div className="flex flex-wrap gap-2">
                              <Button
                                variant="outline"
                                disabled={busy || !items?.enabled}
                                onClick={() =>
                                  void write(() =>
                                    schedules.decide(task.id, selectedRun.id, "reject"),
                                  )
                                }
                              >
                                {text("拒绝", "Reject")}
                              </Button>
                              <Button
                                disabled={busy || !items?.enabled}
                                onClick={() =>
                                  void write(() =>
                                    schedules.decide(task.id, selectedRun.id, "approve"),
                                  )
                                }
                              >
                                {text("批准本次运行", "Approve this run")}
                              </Button>
                            </div>
                          </div>
                        )}
                        {selectedRun.output && (
                          <DocumentMarkdown content={selectedRun.output} readOnly />
                        )}
                        {selectedRun.error_code && (
                          <p className="text-xs text-muted-foreground">
                            {runReasons[selectedRun.error_code] ?? selectedRun.error_code}
                          </p>
                        )}
                        {["pending", "queued", "running"].includes(selectedRun.state) && (
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void cancelCloudRun(task, selectedRun)}
                          >
                            {text("取消本次运行", "Cancel this run")}
                          </Button>
                        )}
                      </article>
                    ) : null}
                  </main>
                )}
                {liveConversationId && (
                  <div className="relative order-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                    {renderConversation?.(liveConversationId, onTaskChromeTarget)}
                  </div>
                )}
                {taskDetailsOpen && (
                  <TaskInspector
                    id={taskDetailsId}
                    text={text}
                    anchorTarget={inspectorTarget}
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
                      <ScheduleDisclosure title={text("运行记录", "Run history")}>
                        {cloudHistoryLoading ? (
                          <p role="status" className="text-muted-foreground">
                            {text("正在读取运行记录…", "Loading run history…")}
                          </p>
                        ) : runs.length ? (
                          <div className="max-h-56 overflow-y-auto">
                            {runs.map((run) => (
                              <Button
                                type="button"
                                variant="ghost"
                                key={run.id}
                                aria-current={selectedRun?.id === run.id ? "true" : undefined}
                                className={`h-auto min-h-11 w-full flex-col items-start justify-center gap-0.5 px-2 py-1 font-normal ${selectedRun?.id === run.id ? "bg-muted" : ""}`}
                                onClick={() => {
                                  setManualCloudRun(undefined);
                                  setCloudJumpSequence((sequence) => sequence + 1);
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
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            {text("暂无运行记录", "No runs yet")}
                          </p>
                        )}
                      </ScheduleDisclosure>
                    </TaskInspectorGroup>
                    {(
                      [
                        ["outputs", text("输出", "Outputs")],
                        ["sources", text("来源", "Sources")],
                      ] as const
                    ).map(([category, title]) => {
                      const resources = selectedRunResources?.items.filter((item) =>
                        category === "outputs" ? item.role === "output" : item.role !== "output",
                      );
                      return (
                        <TaskInspectorGroup key={category} title={title}>
                          {category === "outputs" &&
                            cloudJumpUnavailable &&
                            selectedRun?.output && (
                              <div className="max-h-48 overflow-auto">
                                <DocumentMarkdown content={selectedRun.output} readOnly />
                              </div>
                            )}
                          {selectedCloudRunId && terminal && !selectedRunResources ? (
                            <p className="text-muted-foreground" role="status">
                              {text("正在读取", "Loading")}
                            </p>
                          ) : !resources?.length ? (
                            <p className="text-muted-foreground">
                              {selectedRunResources?.error
                                ? text(
                                    "暂时无法读取本次运行的资料。",
                                    "Resources for this run are unavailable.",
                                  )
                                : category === "outputs"
                                  ? text("暂无输出", "No outputs yet")
                                  : text("暂无来源", "No sources yet")}
                            </p>
                          ) : (
                            <ul>
                              {resources.map((item) => (
                                <li key={`${item.kind}:${item.id}`}>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    className="h-auto min-h-11 w-full min-w-0 justify-start px-2 font-normal md:min-h-8"
                                    onClick={() => {
                                      if (selectedConversationId)
                                        onOpenResultResource(selectedConversationId, item);
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
                              ))}
                            </ul>
                          )}
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
            <EmptyState className="mx-auto h-auto w-full max-w-3xl flex-1 gap-3 px-5 py-8">
              {isMobile && route.id && (
                <Button variant="ghost" className="min-h-11 self-start" onClick={backToList}>
                  <ArrowLeft className="size-4" />
                  {text("返回任务", "Back to tasks")}
                </Button>
              )}
              <span className="grid size-12 place-items-center rounded-2xl bg-muted text-foreground">
                <Clock3 className="size-6" aria-hidden="true" />
              </span>
              <div className="space-y-1">
                <h2 className="text-lg font-medium tracking-tight text-foreground">
                  {route.id
                    ? text("暂时无法打开任务", "Task unavailable")
                    : text("安排任务", "Schedule a task")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {route.id
                    ? text(
                        "返回列表，或在连接恢复后重试。",
                        "Return to the list or try again when connected.",
                      )
                    : text(
                        "选择执行位置和时间，回到这里查看结果。",
                        "Choose when and where to run, then come back here for the results.",
                      )}
                </p>
              </div>
              {items?.enabled && !route.id && !filtersActive && (
                <div className="mt-6 grid w-full max-w-2xl gap-3 min-[480px]:grid-cols-2">
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
          prompt: deviceEditor.prompt,
          onSave: async (data) => {
            const saved = await device.save(data, deviceEditor.id, deviceEditor.task);
            setDeviceTasks((current) => {
              const next = { ...current?.next };
              if (deviceEditor.task?.cron !== saved.cron) delete next[saved.id];
              return {
                ...current,
                tasks: [...(current?.tasks ?? []).filter((item) => item.id !== saved.id), saved],
                next,
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
          input={editor.input}
          existing={editor.existing}
          text={text}
          locale={locale}
          models={models}
          space={space}
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
            void write(async () => {
              await target.open();
              setEditor(undefined);
            })
          }
          onChange={(input) => setEditor({ ...editor, input })}
          onClose={() => {
            setEditor(undefined);
            setError("");
          }}
          onSave={(input) =>
            void write(async () => {
              if (!schedules) return;
              const saved = await schedules.save(
                input,
                editor.existing?.enabled ?? true,
                editor.id,
                editor.existing,
              );
              setEditor(undefined);
              onNavigate({
                page: "tasks",
                id: saved.id,
                target: "cloud",
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
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/60 p-3">
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
  target,
  compact,
  leading,
  text,
  onBack,
  menu,
  children,
}: {
  name: string;
  target?: string;
  compact?: boolean;
  leading?: ReactNode;
  text: Text;
  onBack?: () => void;
  menu: ReactNode;
  children: ReactNode;
}) {
  const actions = text("任务操作", "Task actions");
  return (
    <header
      className={`sticky top-0 z-10 bg-background ${compact ? "" : "border-b border-border/60"}`}
    >
      <div
        className={`mx-auto flex w-full flex-wrap items-center gap-2 px-4 py-2 ${compact ? "min-h-12" : "min-h-14 max-w-6xl sm:px-6 lg:px-8"}`}
      >
        {leading}
        {onBack && (
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
        )}
        <div className="min-w-0 flex-1">
          {target && <p className="truncate text-xs text-muted-foreground">{target}</p>}
          <h2
            className={`truncate leading-6 ${compact ? "text-sm font-medium" : "text-[17px] font-semibold"}`}
            title={name}
          >
            {name}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 max-md:[&>button]:min-h-11">
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
          {children}
        </div>
      </div>
    </header>
  );
}

function TaskInspector({
  id,
  text,
  anchorTarget,
  onClose,
  children,
}: {
  id: string;
  text: Text;
  anchorTarget?: HTMLElement;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = (
    <aside
      id={id}
      tabIndex={-1}
      aria-label={text("任务详情", "Task details")}
      className={
        anchorTarget
          ? "za-floating-surface absolute top-full right-3 z-20 max-h-[min(64dvh,34rem)] w-[min(calc(100%-1.5rem),17.5rem)] divide-y divide-border/60 overflow-auto rounded-2xl text-sm"
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
  return anchorTarget ? mountWorkbenchLayout(panel, anchorTarget, "task-inspector") : panel;
}

function TaskInspectorGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1 px-3 py-2.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
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
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    </Button>
  );
}

function ScheduleDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-8 [&::-webkit-details-marker]:hidden">
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
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onCheckedChange={onChange}
      />
    </ScheduleFormRow>
  );
}

function ScheduleEditor({
  input,
  existing,
  text,
  locale,
  models,
  space,
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
  text: Text;
  locale: string;
  models: readonly Model[];
  space?: CloudSpaceClient;
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
  const [next, setNext] = useState<string | null>();
  const [previewError, setPreviewError] = useState("");
  const [resources, setResources] = useState<CloudSpaceItem[]>([]);
  const [resourceQuery, setResourceQuery] = useState("");
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [projectItems, setProjectItems] = useState<CloudProject[]>();
  const [projectLoadFailed, setProjectLoadFailed] = useState(false);
  const [projectRetry, setProjectRetry] = useState(0);
  const [targetId, setTargetId] = useState(initialTarget);
  const target = !existing ? creationTargets.find((item) => item.id === targetId) : undefined;
  const isDeviceTarget = !!target;
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
  const refs = content.filter((part) => part.type !== "text");
  const inferredName = Array.from(prompt.trim().split(/\r?\n/, 1)[0] ?? "")
    .slice(0, 60)
    .join("");
  const publicTopic = input.run.public_research?.topic;
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
  useEffect(() => {
    if (!schedules || isDeviceTarget) return;
    const client = schedules;
    const controller = new AbortController();
    setNext(undefined);
    setPreviewError("");
    const timer = window.setTimeout(
      () =>
        void client
          .preview(rule, existing?.admitted ?? 0, controller.signal)
          .then((result) => {
            if (!controller.signal.aborted) setNext(result.next_at);
          })
          .catch((cause) => {
            if (!controller.signal.aborted) setPreviewError(message(cause));
          }),
      200,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [rule, existing?.admitted, schedules, isDeviceTarget]);
  useEffect(() => {
    if (!resourcesOpen || !space) return;
    const controller = new AbortController();
    void space
      .list(undefined, resourceQuery, "updated", "", controller.signal)
      .then((page) => {
        if (!controller.signal.aborted)
          setResources(
            page.items.filter((item) => item.kind !== "folder" && item.state === "ready"),
          );
      })
      .catch(() => {
        if (!controller.signal.aborted) setResources([]);
      });
    return () => controller.abort();
  }, [resourceQuery, resourcesOpen, space]);
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
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        layout="fullscreen-mobile"
        showCloseButton
        closeDisabled={busy}
        closeLabel={text("关闭", "Close")}
        className="flex max-h-[min(90dvh,760px)] flex-col overflow-hidden max-[720px]:max-h-none sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>
            {existing ? text("编辑任务", "Edit task") : text("设置定时任务", "Schedule a task")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {text(
              "选择执行位置，按计划运行并在任务中查看结果。",
              "Choose where to run and find the results in the task.",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !target &&
              cloudEnabled &&
              !busy &&
              prompt.trim() &&
              input.run.model &&
              (publicTopic === undefined || publicTopic.trim()) &&
              !previewError &&
              (existing || next)
            )
              onSave({ ...input, name: input.name.trim() || inferredName });
          }}
        >
          <DialogBody className="space-y-3">
            <label className="block space-y-1 text-sm" htmlFor={`${labelId}-prompt`}>
              <span className="sr-only">{text("任务说明", "Task instructions")}</span>
              <Textarea
                id={`${labelId}-prompt`}
                required={!target}
                className="min-h-28 rounded-2xl px-4 py-3.5"
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
            <fieldset hidden={!!target} disabled={!!target} className="min-w-0 space-y-3">
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
                    id={`${labelId}-start`}
                    className="w-auto max-w-full min-w-0 border-transparent bg-transparent text-muted-foreground"
                    type="datetime-local"
                    required
                    value={rule.start}
                    onChange={(event) => setRule({ start: event.target.value })}
                  />
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
              <p aria-live="polite" className="px-2 text-xs text-muted-foreground">
                {text("下次运行", "Next run")} ·{" "}
                {previewError ||
                  (next
                    ? new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: rule.time_zone,
                      }).format(new Date(next))
                    : next === null
                      ? text("暂无", "None")
                      : text("正在计算", "Calculating"))}{" "}
                · {rule.time_zone}
              </p>
            </fieldset>
            <details
              className="group"
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {text("高级", "Advanced")}
                <ChevronDown aria-hidden="true" className="size-3 group-open:rotate-180" />
              </summary>
              {!existing && creationTargets.length ? (
                <div className="space-y-1 text-sm">
                  <label htmlFor={`${labelId}-target`}>{text("执行位置", "Runs on")}</label>
                  <Select value={targetId} onValueChange={setTargetId}>
                    <SelectTrigger id={`${labelId}-target`} className="min-h-11 w-full md:min-h-9">
                      <SelectValue>{target?.label ?? text("云端", "Cloud")}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cloud" disabled={!cloudEnabled}>
                        {cloudEnabled
                          ? text("云端", "Cloud")
                          : text("云端暂不可用", "Cloud unavailable")}
                      </SelectItem>
                      {creationTargets.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {target ? (
                <p className="text-sm text-muted-foreground">
                  {target.ready
                    ? text(
                        target.inline
                          ? "使用此设备的时区、模型和工作区安排任务。"
                          : "在设备的定时任务中填写计划和执行选项。",
                        target.inline
                          ? "Schedule with this device’s time zone, models and workspace."
                          : "Configure the schedule and execution options on the device.",
                      )
                    : text(
                        "设备暂时不可用，请连接后继续。",
                        "This device is unavailable. Connect it to continue.",
                      )}
                </p>
              ) : null}
              <fieldset hidden={!!target} disabled={!!target} className="min-w-0 divide-y divide-border/60 rounded-2xl border border-border/60">
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
                <ScheduleFormRow>
                  <label htmlFor={`${labelId}-timezone`}>{text("时区", "Time zone")}</label>
                  <TimeZonePicker
                    id={`${labelId}-timezone`}
                    label={text("时区", "Time zone")}
                    triggerClassName="w-fit max-w-[72%] border-transparent bg-transparent"
                    value={rule.time_zone}
                    onChange={(time_zone) => setRule({ time_zone })}
                  />
                </ScheduleFormRow>
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
                <ScheduleFormRow>
                  <span className="shrink-0">{text("模型", "Model")}</span>
                  <div className="w-full max-w-[68%] min-w-0">
                    <ModelPicker
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
                <ScheduleSwitch
                  id={`${labelId}-research`}
                  label={text("公开网页调研", "Research the public web")}
                  checked={!!input.run.public_research}
                  onChange={(checked) =>
                    setRun({ public_research: checked ? { topic: "" } : undefined })
                  }
                />
                <ScheduleFormRow>
                  <span>{text("来源", "Sources")}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-expanded={resourcesOpen}
                    disabled={!space}
                    onClick={() => setResourcesOpen(!resourcesOpen)}
                  >
                    {text("从资料空间选择", "Choose from library")} · {refs.length}
                  </Button>
                </ScheduleFormRow>
                {resourcesOpen && (
                  <div className="space-y-2 p-3">
                    <Input
                      value={resourceQuery}
                      aria-label={text("搜索资料", "Search files")}
                      onChange={(event) => setResourceQuery(event.target.value)}
                    />
                    <div className="max-h-36 overflow-auto">
                      {resources.map((item) => {
                        const id = item.target_id;
                        const selected = refs.some((part) =>
                          part.type === "file_reference"
                            ? part.file_id === id
                            : part.version_id === id,
                        );
                        return (
                          <label
                            key={item.id}
                            htmlFor={`${labelId}-resource-${item.id}`}
                            className={`${row} gap-2`}
                          >
                            <Checkbox
                              id={`${labelId}-resource-${item.id}`}
                              checked={selected}
                              disabled={!selected && refs.length >= 8}
                              onCheckedChange={() =>
                                setRun({
                                  content: [
                                    { type: "text", text: prompt },
                                    ...(selected
                                      ? refs.filter((part) =>
                                          part.type === "file_reference"
                                            ? part.file_id !== id
                                            : part.version_id !== id,
                                        )
                                      : [
                                          ...refs,
                                          item.kind === "file"
                                            ? { type: "file_reference" as const, file_id: id }
                                            : {
                                                type: "artifact_reference" as const,
                                                version_id: id,
                                              },
                                        ]),
                                  ],
                                })
                              }
                            />
                            <span className="truncate">{item.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </fieldset>
            </details>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogActions>
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                {text("取消", "Cancel")}
              </Button>
              {target ? (
                <Button
                  type="button"
                  disabled={busy || !target.ready}
                  onClick={() => onOpenTarget(target)}
                >
                  {target.inline
                    ? text("继续", "Continue")
                    : text("打开设备任务", "Open device tasks")}
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    !prompt.trim() ||
                    !input.run.model ||
                    (publicTopic !== undefined && !publicTopic.trim()) ||
                    !cloudEnabled ||
                    !!previewError ||
                    (!existing && !next)
                  }
                >
                  {existing ? text("保存", "Save") : text("创建", "Create")}
                </Button>
              )}
            </DialogActions>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
