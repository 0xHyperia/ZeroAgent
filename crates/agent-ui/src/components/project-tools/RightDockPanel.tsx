import {
  closeRightDockBackgroundTasksTabState,
  openRightDockBackgroundTasksTabState,
  type RightDockBackgroundTasksState,
  type RightDockFileTreeState,
  type RightDockFileTreeStatePatch,
  type RightDockProjectState,
  type SshHostConfig,
  type WorkspaceProject,
} from "@liveagent/app/lib/settings";
import { openUrl } from "@liveagent/app/shims/tauriOpener";
import type { MentionComposerDraftSegment } from "@liveagent/ui/components/chat/MentionComposer";
import {
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  X,
} from "@liveagent/ui/components/IconSet";
import type {
  GitCommitContextPayload,
  GitFileContextPayload,
} from "@liveagent/ui/components/project-tools/git-review/index";
import type { WorkspaceProjectRootClient } from "@liveagent/ui/contracts/workspaceProjectRoots";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { GitClient } from "@liveagent/ui/lib/git/types";
import {
  type CSSProperties,
  memo,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProjectToolTextGenerationClient } from "../../lib/ai/projectToolTextGeneration";
import { ensureManagedProcessInit, useManagedProcesses } from "../../lib/managed-process/store";
import { cn } from "../../lib/shared/utils";
import type { TerminalClient, TerminalSession } from "../../lib/terminal/types";
import type { WorkspaceActivityClient } from "../../lib/workspace-activity/types";
import { Button } from "../ui/button";
import { useFileTreeExternalRoots } from "./file-tree/useFileTreeExternalRoots";
import type { LocalTunnelClient } from "./LocalTunnelPanel";
import { RightDockContent } from "./RightDockContent";
import {
  type GitReviewFocusRequest,
  RightDockToolContext,
  type RightDockToolContextValue,
} from "./RightDockContext";
import { RightDockChooser, RightDockCreateMenu } from "./RightDockLauncher";
import { RightDockTabStrip, type RightDockWorkspaceTab } from "./RightDockTabStrip";
import { RightWorkspaceFileTree } from "./RightWorkspaceFileTree";
import {
  dirname,
  expandedPathsForFileTreePath,
  formatTerminalSessionTitle,
  NO_LEASED_RIGHT_DOCK_TOOLS,
  type RightDockLeasedToolKind,
  type RightDockSingletonTabKind,
  rightDockTabRequiresProject,
} from "./rightDockModel";
import { useRightDockProjectTabs } from "./useRightDockProjectTabs";
import { useRightDockSessions } from "./useRightDockSessions";
import { useRightDockTabReorder } from "./useRightDockTabReorder";
import { WorkspaceNavigationSplit } from "./WorkspaceNavigationSplit";
import type { WorkspaceGitComparison } from "./workspaceGitPaths";
import "./workspace-panels.css";

export type WorkspaceBrowserTools = {
  changes?: () => void;
  terminal?: () => void;
  files?: () => void;
  more?: readonly { label: string; run: () => void }[];
};

export type WorkspaceFileChrome = {
  headerTarget: HTMLElement | null;
  tree?: { open: boolean; toggle: () => void };
};

export type RightWorkspaceDock = {
  tabs: readonly RightDockWorkspaceTab[];
  activeTabId: string | null;
  browserActive: boolean;
  renderContent: (
    browserTools: WorkspaceBrowserTools,
    fileChrome: WorkspaceFileChrome,
  ) => ReactNode;
  expanded: boolean;
  onToggleExpanded: () => void;
  treeOpen: boolean;
  treeGroups: { changes: boolean; files: boolean };
  treeWidth: number;
  onTreeWidthChange: (width: number) => void;
  comparison: WorkspaceGitComparison;
  comparisonConversationId?: string;
  onComparisonChange: (comparison: WorkspaceGitComparison) => void;
  onToggleTreeGroup: (group: "changes" | "files") => void;
  onToggleTree: () => void;
  onOpenTree: () => void;
  onOpenDiff: (path: string, temporary?: boolean) => void;
  onActivateTool: () => void;
  onNewBrowser?: () => void;
  onReopenTab: () => void;
  onMoveTab: (id: string, target: string) => void;
};

type RightDockPanelProps = {
  isOpen: boolean;
  workspace?: RightWorkspaceDock;
  workspaceViewScope?: string;
  fontScale?: number;
  projectPathKey: string;
  cwd: string;
  workspaceProject?: WorkspaceProject;
  workspaceProjectRootClient?: WorkspaceProjectRootClient;
  workspaceRootRevision?: number;
  sessions?: TerminalSession[];
  sessionsLoaded?: boolean;
  /**
   * 被工作台 Pane 租用的会话:tab 保留并标记,视口换成"聚焦面板"占位。
   * 视口互斥(绝不同时挂两个 XTermViewport)是这里唯一的硬不变量。
   */
  leasedSessionIds?: ReadonlySet<string>;
  /**
   * 被工作台 Pane 租用的项目工具(文件树/审查/内网穿透/SSH/后台任务):
   * dock 不再挂其 tab、内容与新建入口;Pane 关闭后自动回归。
   */
  leasedTools?: ReadonlySet<RightDockLeasedToolKind>;
  theme: "light" | "dark";
  disabledMessage?: string;
  terminalDisabledMessage?: string;
  projectState: RightDockProjectState;
  fileTreeState: RightDockFileTreeState;
  sshHosts?: SshHostConfig[];
  associatedSshHostIds?: string[];
  client: TerminalClient;
  gitClient?: GitClient | null;
  gitWriteEnabled?: boolean;
  gitDisabledMessage?: string;
  textGenerationClient?: ProjectToolTextGenerationClient | null;
  tunnelClient?: LocalTunnelClient | null;
  tunnelEnabled?: boolean;
  tunnelDisabledMessage?: string;
  tunnelPublicBaseUrl: string;
  workspaceActivityClient?: WorkspaceActivityClient | null;
  onProjectStateChange: (
    updater: (current: RightDockProjectState) => RightDockProjectState,
  ) => void;
  onFileTreeStateChange: (patch: RightDockFileTreeStatePatch) => void;
  onSshProjectHostIdsChange?: (hostIds: string[]) => void;
  onOpenSshSession?: (session: TerminalSession, kind?: "bash" | "sftp") => void;
  onSessionsChange?: (sessions: TerminalSession[]) => void;
  /** 存在时终端 tab 可拖出 dock(工作台宿主);默认无行为。 */
  onTerminalTabDragStart?: (
    session: TerminalSession,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** 存在时空态"新建终端"入口可拖出到工作台画板;点击行为不变。 */
  onNewTerminalDragStart?: (event: {
    pointerId: number;
    clientX: number;
    clientY: number;
    currentTarget?: EventTarget | null;
  }) => void;
  /** 终端 tab 右键菜单「在工作台打开」;省略时菜单不出现(拖拽仍可用)。 */
  onOpenTerminalInWorkbench?: (session: TerminalSession) => void;
  /** 项目工具 tab / 空态入口拖出到 Workbench(落点打开该工具 Pane)。 */
  onToolDragStart?: (
    kind: RightDockLeasedToolKind,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** 项目工具 tab 菜单式“在分屏中打开”。 */
  onOpenToolInWorkbench?: (kind: RightDockLeasedToolKind) => void;
  /** 新建菜单「在分屏中新建终端」;与拖拽 newTerminal 走同一提交语义。 */
  onOpenNewTerminalInWorkbench?: () => void;
  /**
   * dock 视口报错时上抛 sessionId,由宿主按后端权威列表校验:会话确认
   * 消失(幽灵记录)则整表刷新,坏 tab 自动退场;仍存活的瞬时错误不动列表。
   */
  onSessionGhost?: (sessionId: string) => void;
  onInsertFileMention?: (path: string, kind: "file" | "dir") => void;
  onOpenFile?: (path: string, imagePaths?: string[], temporary?: boolean) => void;
  onInsertCodeReviewSkill?: () => void;
  onInsertCommitMention?: (commit: GitCommitContextPayload) => void;
  onInsertGitFileMention?: (file: GitFileContextPayload) => void;
  onInsertComposerSegments?: (segments: MentionComposerDraftSegment[]) => boolean;
  gitReviewFocusRequest?: GitReviewFocusRequest | null;
  onGitReviewFocusRequestHandled?: (nonce: number) => void;
  onClose?: () => void;
};

type RightDockTabsScrollbarState = {
  visible: boolean;
  thumbLeft: number;
  thumbWidth: number;
};

type RightDockTabsScrollbarDragState = {
  pointerId: number;
  startScrollLeft: number;
  startX: number;
};

const RIGHT_DOCK_TABS_SCROLLBAR_MIN_THUMB_WIDTH = 28;

// Stable fallbacks for optional array props: fresh `[]` defaults would defeat
// both the panel memo and the context useMemo below.
const NO_SSH_HOSTS: SshHostConfig[] = [];
const NO_ASSOCIATED_SSH_HOST_IDS: string[] = [];

function RightDockTabsScrollbar(props: { scrollRef: RefObject<HTMLDivElement | null> }) {
  const { scrollRef } = props;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<RightDockTabsScrollbarDragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [scrollbar, setScrollbar] = useState<RightDockTabsScrollbarState>({
    visible: false,
    thumbLeft: 0,
    thumbWidth: RIGHT_DOCK_TABS_SCROLLBAR_MIN_THUMB_WIDTH,
  });

  const updateScrollbar = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      setScrollbar((current) =>
        current.visible
          ? {
              visible: false,
              thumbLeft: 0,
              thumbWidth: RIGHT_DOCK_TABS_SCROLLBAR_MIN_THUMB_WIDTH,
            }
          : current,
      );
      return;
    }

    const maxScrollLeft = element.scrollWidth - element.clientWidth;
    if (maxScrollLeft <= 1 || element.clientWidth <= 0 || element.scrollWidth <= 0) {
      setScrollbar((current) =>
        current.visible
          ? {
              visible: false,
              thumbLeft: 0,
              thumbWidth: RIGHT_DOCK_TABS_SCROLLBAR_MIN_THUMB_WIDTH,
            }
          : current,
      );
      return;
    }

    const trackWidth = element.clientWidth;
    const thumbWidth = Math.min(
      trackWidth,
      Math.max(
        RIGHT_DOCK_TABS_SCROLLBAR_MIN_THUMB_WIDTH,
        (element.clientWidth / element.scrollWidth) * trackWidth,
      ),
    );
    const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
    const thumbLeft = maxScrollLeft > 0 ? (element.scrollLeft / maxScrollLeft) * maxThumbLeft : 0;
    const nextScrollbar = {
      visible: true,
      thumbLeft,
      thumbWidth,
    };

    setScrollbar((current) => {
      if (
        current.visible === nextScrollbar.visible &&
        Math.abs(current.thumbLeft - nextScrollbar.thumbLeft) < 0.5 &&
        Math.abs(current.thumbWidth - nextScrollbar.thumbWidth) < 0.5
      ) {
        return current;
      }
      return nextScrollbar;
    });
  }, [scrollRef]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      updateScrollbar();
      return;
    }

    let animationFrame = 0;
    const scheduleUpdate = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(updateScrollbar);
    };

    scheduleUpdate();
    element.addEventListener("scroll", updateScrollbar, { passive: true });
    window.addEventListener("resize", scheduleUpdate);

    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(element);
    for (const child of Array.from(element.children)) {
      resizeObserver.observe(child);
    }

    const mutationObserver = new MutationObserver(scheduleUpdate);
    mutationObserver.observe(element, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      element.removeEventListener("scroll", updateScrollbar);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [scrollRef, updateScrollbar]);

  const scrollToThumbLeft = useCallback(
    (thumbLeft: number) => {
      const element = scrollRef.current;
      const track = trackRef.current;
      if (!element || !track) return;

      const maxScrollLeft = element.scrollWidth - element.clientWidth;
      const maxThumbLeft = Math.max(0, track.clientWidth - scrollbar.thumbWidth);
      if (maxScrollLeft <= 0 || maxThumbLeft <= 0) return;

      element.scrollLeft = (thumbLeft / maxThumbLeft) * maxScrollLeft;
    },
    [scrollRef, scrollbar.thumbWidth],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!scrollbar.visible || event.button !== 0) return;

      const element = scrollRef.current;
      const track = trackRef.current;
      if (!element || !track) return;

      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);

      const target = event.target;
      const isThumb =
        target instanceof HTMLElement &&
        target.closest(".project-tools-panel-tabs-scrollbar-thumb") !== null;

      if (!isThumb) {
        const rect = track.getBoundingClientRect();
        const maxThumbLeft = Math.max(0, track.clientWidth - scrollbar.thumbWidth);
        const nextThumbLeft = Math.min(
          maxThumbLeft,
          Math.max(0, event.clientX - rect.left - scrollbar.thumbWidth / 2),
        );
        scrollToThumbLeft(nextThumbLeft);
      }

      dragStateRef.current = {
        pointerId: event.pointerId,
        startScrollLeft: element.scrollLeft,
        startX: event.clientX,
      };
      setDragging(true);
      updateScrollbar();
    },
    [scrollRef, scrollToThumbLeft, scrollbar.thumbWidth, scrollbar.visible, updateScrollbar],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;

      const element = scrollRef.current;
      const track = trackRef.current;
      if (!element || !track) return;

      event.preventDefault();
      const maxScrollLeft = element.scrollWidth - element.clientWidth;
      const maxThumbLeft = Math.max(1, track.clientWidth - scrollbar.thumbWidth);
      const scrollDelta = ((event.clientX - dragState.startX) / maxThumbLeft) * maxScrollLeft;
      element.scrollLeft = Math.min(
        maxScrollLeft,
        Math.max(0, dragState.startScrollLeft + scrollDelta),
      );
    },
    [scrollRef, scrollbar.thumbWidth],
  );

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  }, []);

  return (
    <div
      ref={trackRef}
      aria-hidden={!scrollbar.visible}
      className={cn(
        "project-tools-panel-tabs-scrollbar relative h-4px basis-4px touch-none overflow-hidden",
        "rounded-full bg-[var(--project-tools-tabs-scrollbar-track,hsl(var(--muted)/0.42))] opacity-0",
        "transition-[background-color,opacity] duration-160 ease-default",
        "hover:bg-[var(--project-tools-tabs-scrollbar-track-hover,hsl(var(--muted)/0.5))] [&.project-tools-panel-tabs-scrollbar-dragging]:bg-[var(--project-tools-tabs-scrollbar-track-hover,hsl(var(--muted)/0.5))] [&:hover_.project-tools-panel-tabs-scrollbar-thumb]:bg-[var(--project-tools-tabs-scrollbar-thumb-hover,hsl(var(--muted-foreground)/0.36))] [&.project-tools-panel-tabs-scrollbar-dragging_.project-tools-panel-tabs-scrollbar-thumb]:bg-[var(--project-tools-tabs-scrollbar-thumb-hover,hsl(var(--muted-foreground)/0.36))] web:max-820:h-5px web:max-820:basis-5px",
        scrollbar.visible && "opacity-100 pointer-events-auto",
        dragging && "project-tools-panel-tabs-scrollbar-dragging",
      )}
      onPointerCancel={finishDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
    >
      <div
        className={cn(
          "project-tools-panel-tabs-scrollbar-thumb absolute inset-y-0 left-0 min-w-28px",
          "rounded-inherit bg-[var(--project-tools-tabs-scrollbar-thumb,hsl(var(--muted-foreground)/0.22))] shadow-[inset_0_0_0_var(--spacing-1px)_var(--project-tools-tabs-scrollbar-thumb-border,hsl(var(--background)/0.82))]",
          "transition-[background-color,box-shadow] duration-160 ease-default",
        )}
        style={{
          transform: `translateX(${scrollbar.thumbLeft}px)`,
          width: `${scrollbar.thumbWidth}px`,
        }}
      />
    </div>
  );
}

export const RightDockPanel = memo(function RightDockPanel(props: RightDockPanelProps) {
  const {
    isOpen,
    workspace,
    fontScale = 1,
    workspaceViewScope,
    projectPathKey,
    cwd,
    workspaceProject,
    workspaceProjectRootClient,
    workspaceRootRevision = 0,
    sessions: externalSessions,
    sessionsLoaded: externalSessionsLoaded,
    leasedSessionIds,
    leasedTools = NO_LEASED_RIGHT_DOCK_TOOLS,
    theme,
    disabledMessage,
    terminalDisabledMessage,
    projectState,
    fileTreeState,
    sshHosts = NO_SSH_HOSTS,
    associatedSshHostIds = NO_ASSOCIATED_SSH_HOST_IDS,
    client,
    gitClient,
    gitWriteEnabled = true,
    gitDisabledMessage,
    textGenerationClient,
    tunnelClient,
    tunnelEnabled = true,
    tunnelDisabledMessage,
    tunnelPublicBaseUrl,
    workspaceActivityClient,
    onProjectStateChange,
    onFileTreeStateChange,
    onSshProjectHostIdsChange,
    onOpenSshSession,
    onSessionsChange,
    onTerminalTabDragStart,
    onNewTerminalDragStart,
    onOpenTerminalInWorkbench,
    onToolDragStart,
    onOpenToolInWorkbench,
    onOpenNewTerminalInWorkbench,
    onSessionGhost,
    onInsertFileMention,
    onOpenFile,
    onInsertCodeReviewSkill,
    onInsertCommitMention,
    onInsertGitFileMention,
    onInsertComposerSegments,
    gitReviewFocusRequest,
    onGitReviewFocusRequestHandled,
    onClose,
  } = props;
  const { t, locale } = useLocale();
  const onActivateWorkspaceTool = workspace?.onActivateTool;
  const onOpenWorkspaceTree = workspace?.onOpenTree;
  const browserActive = workspace?.browserActive ?? false;
  const comparison = workspace?.comparison;
  const comparisonConversationId = workspace?.comparisonConversationId;
  const onComparisonChange = workspace?.onComparisonChange;
  const tabbed = Boolean(workspace);
  const visibleLeasedTools = useMemo(
    () => (tabbed ? new Set<RightDockLeasedToolKind>([...leasedTools, "fileTree"]) : leasedTools),
    [tabbed, leasedTools],
  );
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [fileHeaderTarget, setFileHeaderTarget] = useState<HTMLDivElement | null>(null);
  const previousViewScopeRef = useRef(workspaceViewScope);
  useLayoutEffect(() => {
    if (previousViewScopeRef.current === workspaceViewScope) return;
    previousViewScopeRef.current = workspaceViewScope;
    setCreateMenuOpen(false);
  }, [workspaceViewScope]);
  const selectedChangesPaths = useRef(new Map<string, string>());
  const getSelectedChangesPath = useCallback(
    (repo: string) =>
      selectedChangesPaths.current.get(JSON.stringify([workspaceViewScope, repo])) ?? "",
    [workspaceViewScope],
  );
  const onSelectChangesPath = useCallback(
    (repo: string, path: string) => {
      selectedChangesPaths.current.set(JSON.stringify([workspaceViewScope, repo]), path);
    },
    [workspaceViewScope],
  );
  const { externalRoots: visibleExternalFileTreeRoots, refreshExternalRoots } =
    useFileTreeExternalRoots({
      workspaceProject,
      workspaceProjectRootClient,
      workspaceRootRevision,
    });
  const projectReady = projectPathKey.trim() !== "" && cwd.trim() !== "" && !disabledMessage;
  const terminalReady = projectReady && !terminalDisabledMessage;
  const {
    activateTerminalSession,
    activeSession,
    clearPendingCloseSession,
    closeSession,
    closingSessionIds,
    createTerminal,
    creating,
    error,
    forgetTerminalSession,
    handleCloseRequest,
    handleInitialTerminalSnapshotConsumed,
    initialTerminalSnapshotsRef,
    loading,
    localSessions,
    pendingCloseSession,
    pendingCloseSessionId,
    reconcileSshSessions,
    rememberTerminalSnapshot,
    sessionsLoaded,
    shellOptions,
    sshSessions,
  } = useRightDockSessions({
    client,
    cwd,
    externalSessions,
    externalSessionsLoaded,
    leasedSessionIds,
    viewScope: workspaceViewScope,
    isOpen,
    onProjectStateChange,
    onSessionsChange,
    projectPathKey,
    projectState,
    terminalReady,
  });
  // Terminal stream errors are bucketed per session so one session's attach
  // failure or input backpressure never masks (or clears) another's; the
  // hook-level `error` stays reserved for list/create failures.
  const [terminalErrors, setTerminalErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const handleTerminalError = useCallback(
    (sessionId: string, message: string | null) => {
      setTerminalErrors((current) => {
        const existing = current.get(sessionId);
        if (message === null) {
          if (existing === undefined) return current;
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        }
        if (existing === message) return current;
        const next = new Map(current);
        next.set(sessionId, message);
        return next;
      });
      // attach 持续失败最常见的根因是幽灵会话(后端已丢、前端列表还在)。
      // 上抛给宿主做权威校验;瞬时错误在校验中会被识别为仍存活而不动列表。
      if (message) onSessionGhost?.(sessionId);
    },
    [onSessionGhost],
  );

  useEffect(() => {
    // Closed/forgotten sessions leave the live list; drop their error buckets.
    setTerminalErrors((current) => {
      if (current.size === 0) return current;
      const liveIds = new Set(localSessions.map((session) => session.id));
      let changed = false;
      const next = new Map<string, string>();
      for (const [sessionId, message] of current) {
        if (liveIds.has(sessionId)) {
          next.set(sessionId, message);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [localSessions]);

  const activeTerminalError = activeSession ? (terminalErrors.get(activeSession.id) ?? null) : null;

  const managedProcessState = useManagedProcesses();
  useEffect(() => {
    ensureManagedProcessInit().catch((error) => {
      console.error("managed process init failed", error);
    });
  }, []);
  // Visibility is part of the dock view. Closing snapshots the task ids;
  // a newly started task can bring the tab back without touching processes.
  const [localBackgroundTasks, setLocalBackgroundTasks] = useState<RightDockBackgroundTasksState>({
    opened: false,
    dismissedIds: [],
  });
  const scopedBackgroundTasks = Boolean(workspaceViewScope || projectPathKey);
  const backgroundTasksState = scopedBackgroundTasks
    ? projectState.backgroundTasks
    : localBackgroundTasks;
  const backgroundTasksVisible =
    backgroundTasksState.opened ||
    managedProcessState.processes.some(
      (process) => !backgroundTasksState.dismissedIds.includes(process.id),
    );
  const backgroundTasksRunning = managedProcessState.processes.filter(
    (process) => process.running,
  ).length;

  const tunnelAvailable = Boolean(tunnelClient);
  const {
    activateTab,
    canReorderTabs,
    closeToolTab,
    commitTabOrder,
    currentActiveTab,
    fileTreeInitialized,
    gitReviewInitialized,
    openSingletonTab,
    orderedProjectTabIds,
    orderedProjectTabs,
    setDraftTabOrder,
    sshTunnelInitialized,
    tunnelInitialized,
  } = useRightDockProjectTabs({
    backgroundTasksVisible,
    leasedTools: visibleLeasedTools,
    localSessions,
    onProjectStateChange,
    projectPathKey,
    projectState,
    sessionsLoaded,
    tunnelAvailable,
  });

  const handleCreate = useCallback(
    (shell?: string) => {
      onActivateWorkspaceTool?.();
      createTerminal(shell);
    },
    [createTerminal, onActivateWorkspaceTool],
  );

  const openBackgroundTasks = useCallback(() => {
    onActivateWorkspaceTool?.();
    if (scopedBackgroundTasks) {
      onProjectStateChange(openRightDockBackgroundTasksTabState);
      return;
    }
    // No project bucket: persisted writes (including tab activation) are
    // no-ops, so only the session-local visibility flips.
    setLocalBackgroundTasks({ opened: true, dismissedIds: [] });
  }, [onActivateWorkspaceTool, onProjectStateChange, scopedBackgroundTasks]);

  const closeBackgroundTasks = useCallback(() => {
    // Hide-only; the persisted activeTabId falls back at render time.
    const visibleIds = managedProcessState.processes.map((process) => process.id);
    if (scopedBackgroundTasks) {
      onProjectStateChange((current) => closeRightDockBackgroundTasksTabState(current, visibleIds));
      return;
    }
    setLocalBackgroundTasks({ opened: false, dismissedIds: visibleIds });
  }, [managedProcessState.processes, onProjectStateChange, scopedBackgroundTasks]);

  const {
    consumeSuppressedTabClick,
    draggingTabId,
    getTabDragProps,
    getTabDragStyle,
    renderTabDragHandle,
    tabsScrollRef,
  } = useRightDockTabReorder({
    canReorderTabs,
    onCommitTabOrder: commitTabOrder,
    onDraftTabOrderChange: setDraftTabOrder,
    orderedTabIds: orderedProjectTabIds,
    viewScope: workspaceViewScope ?? projectPathKey,
    reorderHint: t("projectTools.reorderTabHint"),
    reorderLabel: t("projectTools.reorderTab"),
  });

  useLayoutEffect(() => {
    if (!workspace?.activeTabId || !isOpen) return;
    const strip = tabsScrollRef.current;
    const active = strip?.querySelector<HTMLElement>('[data-workspace-tab-active="true"]');
    if (!active || !strip) return;
    const left = active.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (left + active.offsetWidth > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = left + active.offsetWidth - strip.clientWidth;
  }, [isOpen, tabsScrollRef, workspace?.activeTabId]);

  const handleTabsWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.deltaY === 0 ||
        Math.abs(event.deltaX) >= Math.abs(event.deltaY)
      ) {
        return;
      }

      const element = tabsScrollRef.current;
      if (!element) return;

      const maxScrollLeft = element.scrollWidth - element.clientWidth;
      if (maxScrollLeft <= 0) return;

      const deltaScale =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
      const nextScrollLeft = Math.min(
        maxScrollLeft,
        Math.max(0, element.scrollLeft + event.deltaY * deltaScale),
      );
      if (Math.abs(nextScrollLeft - element.scrollLeft) < 0.5) return;

      event.preventDefault();
      element.scrollLeft = nextScrollLeft;
    },
    [tabsScrollRef],
  );

  const showDisabledMessage = Boolean(
    disabledMessage && !tunnelAvailable && !tunnelInitialized && !sshTunnelInitialized,
  );
  const showRightDockChooser =
    !showDisabledMessage &&
    (projectReady || tunnelAvailable) &&
    currentActiveTab === "terminal" &&
    !activeSession;

  const startToolTab = useCallback(
    (kind: RightDockSingletonTabKind) => {
      if (leasedTools.has(kind)) return;
      if (rightDockTabRequiresProject(kind)) {
        if (!projectReady) return;
      } else if (!tunnelClient) {
        return;
      }
      if (kind === "fileTree" && onOpenWorkspaceTree) {
        if (browserActive) onActivateWorkspaceTool?.();
        onOpenWorkspaceTree();
        return;
      }
      onActivateWorkspaceTool?.();
      openSingletonTab(kind);
    },
    [
      browserActive,
      leasedTools,
      onActivateWorkspaceTool,
      onOpenWorkspaceTree,
      openSingletonTab,
      projectReady,
      tunnelClient,
    ],
  );

  const setFileTreeInitialized = useCallback(
    (initialized: boolean) => {
      if (!projectPathKey) return;
      if (initialized) {
        startToolTab("fileTree");
      } else {
        closeToolTab("fileTree");
      }
    },
    [closeToolTab, projectPathKey, startToolTab],
  );

  const revealPathInFileTree = useCallback(
    (path: string) => {
      const normalizedPath = path
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
      if (!projectReady) return;
      const selectedPath = normalizedPath.endsWith("/") ? dirname(normalizedPath) : normalizedPath;
      const expandedPaths = Array.from(
        new Set([...fileTreeState.expandedPaths, ...expandedPathsForFileTreePath(selectedPath)]),
      );
      startToolTab("fileTree");
      onFileTreeStateChange({
        query: "",
        selectedPath,
        expandedPaths,
        bumpRevision: true,
      });
    },
    [fileTreeState.expandedPaths, onFileTreeStateChange, projectReady, startToolTab],
  );

  const openExternal = useCallback((url: string) => {
    void openUrl(url);
  }, []);

  const openWorkspaceDiff = workspace?.onOpenDiff;
  const openWorkspaceReviewFile = useCallback(
    (path: string) => openWorkspaceDiff?.(path, true),
    [openWorkspaceDiff],
  );
  const toolContextValue = useMemo<RightDockToolContextValue>(
    () => ({
      viewScope: workspaceViewScope,
      projectPathKey,
      cwd,
      theme,
      clients: {
        terminal: client,
        git: gitClient,
        textGeneration: textGenerationClient,
        tunnel: tunnelClient,
        workspaceActivity: workspaceActivityClient,
      },
      capabilities: {
        projectReady,
        terminalReady,
        disabledMessage,
        terminalDisabledMessage,
        gitWriteEnabled,
        gitDisabledMessage,
        tunnelEnabled,
        tunnelDisabledMessage,
        tunnelPublicBaseUrl,
      },
      fileTree: {
        state: fileTreeState,
        initialized: Boolean(onOpenWorkspaceTree) || fileTreeInitialized,
        externalRoots: visibleExternalFileTreeRoots,
        refreshExternalRoots,
        onInitializedChange: setFileTreeInitialized,
        onStateChange: onFileTreeStateChange,
        onInsertFileMention,
        onOpenFile,
        onRevealInFileTree: revealPathInFileTree,
      },
      git: {
        workspaceReview:
          comparison && onComparisonChange
            ? {
                comparison,
                conversationId: comparisonConversationId,
                onComparisonChange,
                onOpenFile: openWorkspaceReviewFile,
              }
            : undefined,
        getSelectedChangesPath,
        onSelectChangesPath,
        onInsertCodeReviewSkill,
        onInsertCommitMention,
        onInsertGitFileMention,
        onInsertComposerSegments,
        focusRequest: gitReviewFocusRequest,
        onFocusRequestHandled: onGitReviewFocusRequestHandled,
      },
      ssh: {
        hosts: sshHosts,
        associatedHostIds: associatedSshHostIds,
        sessions: sshSessions,
        onOpenSession: onOpenSshSession,
        onAssociatedHostIdsChange: onSshProjectHostIdsChange,
        onSessionSnapshot: rememberTerminalSnapshot,
        onSessionClosed: forgetTerminalSession,
        onSessionsReconcile: reconcileSshSessions,
      },
      openExternal,
    }),
    [
      associatedSshHostIds,
      client,
      cwd,
      disabledMessage,
      visibleExternalFileTreeRoots,
      fileTreeInitialized,
      fileTreeState,
      forgetTerminalSession,
      gitClient,
      gitDisabledMessage,
      gitReviewFocusRequest,
      gitWriteEnabled,
      comparison,
      comparisonConversationId,
      onComparisonChange,
      openWorkspaceReviewFile,
      getSelectedChangesPath,
      onSelectChangesPath,
      onFileTreeStateChange,
      onGitReviewFocusRequestHandled,
      onInsertCodeReviewSkill,
      onInsertCommitMention,
      onInsertComposerSegments,
      onInsertFileMention,
      onInsertGitFileMention,
      onOpenWorkspaceTree,
      onOpenFile,
      onOpenSshSession,
      onSshProjectHostIdsChange,
      openExternal,
      projectPathKey,
      projectReady,
      reconcileSshSessions,
      rememberTerminalSnapshot,
      refreshExternalRoots,
      revealPathInFileTree,
      setFileTreeInitialized,
      sshHosts,
      sshSessions,
      terminalDisabledMessage,
      terminalReady,
      textGenerationClient,
      theme,
      workspaceViewScope,
      tunnelClient,
      tunnelDisabledMessage,
      tunnelEnabled,
      tunnelPublicBaseUrl,
      workspaceActivityClient,
    ],
  );

  const initializedTools = useMemo<Record<RightDockSingletonTabKind, boolean>>(
    () => ({
      fileTree: fileTreeInitialized,
      gitReview: gitReviewInitialized,
      tunnel: tunnelInitialized,
      sshTunnel: sshTunnelInitialized,
    }),
    [fileTreeInitialized, gitReviewInitialized, sshTunnelInitialized, tunnelInitialized],
  );

  return (
    <RightDockToolContext.Provider value={toolContextValue}>
      <aside
        aria-hidden={!isOpen}
        inert={!isOpen}
        data-app-frame-column="right-dock"
        data-state={isOpen ? "open" : "closed"}
        onKeyDown={
          workspace
            ? (event) => {
                if (event.defaultPrevented || event.altKey) return;
                const key = event.key.toLowerCase();
                if (key === "escape" && workspace.expanded && !event.ctrlKey && !event.metaKey) {
                  event.preventDefault();
                  workspace.onToggleExpanded();
                  return;
                }
                if (!event.ctrlKey && !event.metaKey) return;
                if (key === "w" && !event.shiftKey && workspace.activeTabId) {
                  event.preventDefault();
                  workspace.tabs.find((tab) => tab.id === workspace.activeTabId)?.onClose();
                } else if (key === "t" && event.shiftKey) {
                  event.preventDefault();
                  workspace.onReopenTab();
                } else if (key === "t" && workspace.onNewBrowser) {
                  event.preventDefault();
                  workspace.onNewBrowser();
                }
              }
            : undefined
        }
        className="project-tools-panel zone-font-scale flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
        style={{ "--zone-font-scale": fontScale } as CSSProperties}
      >
        <div className="project-tools-panel-inner flex size-full min-h-0 flex-col">
          <div
            className={cn(
              "desktop:hidden web:hidden web:max-820:block web:max-820:w-36px web:max-820:h-4px web:max-820:flex-none web:max-820:self-center web:max-820:mt-8px",
              "web:max-820:rounded-full web:max-820:bg-muted-foreground/24",
            )}
            aria-hidden="true"
          />

          <div
            data-right-workspace-chrome={workspace ? "" : undefined}
            className={cn(
              "flex shrink-0 items-center border-b border-border/60",
              workspace ? "h-12 gap-1 pl-2 pr-2" : "h-10 gap-2 pl-1 pr-2",
              "web:max-820:min-h-44px web:max-820:gap-6px",
            )}
          >
            <div
              data-right-workspace-tab-slot={workspace ? "" : undefined}
              className={cn("flex h-full min-w-0 flex-col justify-center", !workspace && "flex-1")}
              onWheel={handleTabsWheel}
            >
              {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: The label is present only on the desktop tablist. */}
              <div
                ref={tabsScrollRef}
                role={workspace ? "tablist" : undefined}
                aria-label={
                  workspace ? (locale === "zh-CN" ? "工作区标签" : "Workspace tabs") : undefined
                }
                className={cn(
                  "project-tools-panel-tabs flex h-full min-w-0 items-stretch overflow-x-auto overflow-y-hidden",
                  "overscroll-x-contain [scrollbar-width:none] [-ms-overflow-style:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden [&::-webkit-scrollbar]:size-0",
                )}
              >
                <RightDockTabStrip
                  key={tabbed ? workspaceViewScope : undefined}
                  tabs={orderedProjectTabs}
                  workspaceTabs={workspace?.tabs}
                  activeWorkspaceTabId={workspace?.activeTabId}
                  onMoveWorkspaceTab={workspace?.onMoveTab}
                  currentActiveTab={currentActiveTab}
                  backgroundTasksRunning={backgroundTasksRunning}
                  onCloseBackgroundTasks={closeBackgroundTasks}
                  activeSession={activeSession}
                  pendingCloseSessionId={pendingCloseSessionId}
                  closingSessionIds={closingSessionIds}
                  draggingTabId={draggingTabId}
                  renderTabDragHandle={renderTabDragHandle}
                  getTabDragProps={getTabDragProps}
                  getTabDragStyle={getTabDragStyle}
                  consumeSuppressedTabClick={consumeSuppressedTabClick}
                  onActivateTab={(id) => {
                    onActivateWorkspaceTool?.();
                    activateTab(id);
                  }}
                  onActivateTerminalSession={(session) => {
                    onActivateWorkspaceTool?.();
                    activateTerminalSession(session);
                  }}
                  onCloseToolTab={closeToolTab}
                  onCloseTerminalRequest={handleCloseRequest}
                  onTerminalTabDragStart={onTerminalTabDragStart}
                  onOpenTerminalInWorkbench={onOpenTerminalInWorkbench}
                  onToolTabDragStart={onToolDragStart}
                  onOpenToolInWorkbench={onOpenToolInWorkbench}
                />
              </div>
              {!workspace && <RightDockTabsScrollbar scrollRef={tabsScrollRef} />}
            </div>
            {workspace?.onNewBrowser && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={workspace.onNewBrowser}
                aria-label={locale === "zh-CN" ? "新建网页标签" : "New browser tab"}
                title={locale === "zh-CN" ? "新建网页标签" : "New browser tab"}
              >
                <Plus className="size-4" />
              </Button>
            )}
            <RightDockCreateMenu
              leasedTools={visibleLeasedTools}
              compact={Boolean(workspace?.onNewBrowser)}
              desktopWorkspace={Boolean(workspace)}
              open={createMenuOpen}
              onOpenChange={setCreateMenuOpen}
              shellOptions={shellOptions}
              terminalReady={terminalReady}
              terminalDisabledMessage={terminalDisabledMessage}
              projectReady={projectReady}
              tunnelAvailable={tunnelAvailable}
              creating={creating}
              onCreateTerminal={handleCreate}
              onOpenNewTerminalInWorkbench={onOpenNewTerminalInWorkbench}
              onStartTool={startToolTab}
              onOpenBackgroundTasks={openBackgroundTasks}
            />
            {workspace && (
              <>
                <span
                  className="min-w-0 flex-1"
                  data-right-workspace-tab-spacer=""
                  aria-hidden="true"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="max-md:hidden"
                  aria-pressed={workspace.expanded}
                  aria-label={locale === "zh-CN" ? "切换全宽" : "Toggle full width"}
                  title={locale === "zh-CN" ? "切换全宽" : "Toggle full width"}
                  onClick={workspace.onToggleExpanded}
                >
                  {workspace.expanded ? (
                    <Minimize2 className="size-4" />
                  ) : (
                    <Maximize2 className="size-4" />
                  )}
                </Button>
                {projectReady &&
                  !leasedTools.has("fileTree") &&
                  (!workspace.activeTabId || browserActive) && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-pressed={workspace.treeOpen && !browserActive}
                      aria-label={t("projectTools.fileTreeTitle")}
                      title={t("projectTools.fileTreeTitle")}
                      onClick={
                        browserActive ? () => startToolTab("fileTree") : workspace.onToggleTree
                      }
                    >
                      {workspace.treeOpen && !browserActive ? (
                        <PanelRightClose className="size-4" />
                      ) : (
                        <PanelRightOpen className="size-4" />
                      )}
                    </Button>
                  )}
              </>
            )}
            {onClose ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                title={t("projectTools.closePanel")}
                className="rounded-lg text-muted-foreground hover:text-foreground md:hidden web:max-820:inline-flex"
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>

          {pendingCloseSession ? (
            <div
              className={cn(
                "flex shrink-0 items-center gap-2",
                "border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive",
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {t("projectTools.closeRunningTerminal").replace(
                  "{title}",
                  formatTerminalSessionTitle(
                    pendingCloseSession.title,
                    t("projectTools.terminalTitle"),
                  ),
                )}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2.5 text-xs"
                onClick={clearPendingCloseSession}
              >
                {t("settings.cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="h-7 shrink-0 px-2.5 text-xs"
                disabled={closingSessionIds.has(pendingCloseSession.id)}
                onClick={() => closeSession(pendingCloseSession)}
              >
                {t("projectTools.close")}
              </Button>
            </div>
          ) : null}

          {workspace && <div ref={setFileHeaderTarget} className="z-10 shrink-0 empty:hidden" />}
          <div className="relative flex min-h-0 flex-1 overflow-hidden @container">
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {workspace?.renderContent(
                {
                  changes:
                    projectReady && !leasedTools.has("gitReview")
                      ? () => startToolTab("gitReview")
                      : undefined,
                  terminal: terminalReady ? () => handleCreate() : undefined,
                  files:
                    projectReady && !leasedTools.has("fileTree")
                      ? () => startToolTab("fileTree")
                      : undefined,
                  more: [
                    { label: t("projectTools.backgroundTasksTitle"), run: openBackgroundTasks },
                  ],
                },
                {
                  headerTarget: fileHeaderTarget,
                  tree:
                    projectReady && !leasedTools.has("fileTree")
                      ? { open: workspace.treeOpen, toggle: workspace.onToggleTree }
                      : undefined,
                },
              )}
              <div
                className={workspace?.activeTabId ? "hidden" : "flex min-h-0 flex-1 flex-col"}
                inert={Boolean(workspace?.activeTabId)}
              >
                {showDisabledMessage ? (
                  <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                    {disabledMessage}
                  </div>
                ) : showRightDockChooser ? (
                  <RightDockChooser
                    leasedTools={visibleLeasedTools}
                    terminalReady={terminalReady}
                    terminalDisabledMessage={terminalDisabledMessage}
                    disabledMessage={disabledMessage}
                    tunnelDisabledMessage={tunnelDisabledMessage}
                    projectReady={projectReady}
                    tunnelAvailable={tunnelAvailable}
                    creating={creating}
                    loading={loading}
                    error={error}
                    onCreateTerminal={handleCreate}
                    onStartTool={startToolTab}
                    onOpenBackgroundTasks={openBackgroundTasks}
                    onNewTerminalDragStart={onNewTerminalDragStart}
                    onToolDragStart={onToolDragStart}
                  />
                ) : (
                  <RightDockContent
                    isOpen={isOpen && !workspace?.activeTabId}
                    currentActiveTab={currentActiveTab}
                    initializedTools={initializedTools}
                    localSessions={localSessions}
                    activeSession={activeSession}
                    initialTerminalSnapshotsRef={initialTerminalSnapshotsRef}
                    error={activeTerminalError ?? error}
                    creating={creating}
                    loading={loading}
                    onTerminalError={handleTerminalError}
                    onInitialTerminalSnapshotConsumed={handleInitialTerminalSnapshotConsumed}
                    onCreateTerminal={handleCreate}
                    leasedTools={visibleLeasedTools}
                  />
                )}
              </div>
            </div>
            {workspace?.treeOpen &&
              !browserActive &&
              projectReady &&
              !leasedTools.has("fileTree") && (
                <WorkspaceNavigationSplit
                  width={workspace.treeWidth}
                  onWidthChange={workspace.onTreeWidthChange}
                  onClose={workspace.onToggleTree}
                >
                  <RightWorkspaceFileTree
                    key={workspaceViewScope}
                    active={isOpen}
                    groups={workspace.treeGroups}
                    onToggleGroup={workspace.onToggleTreeGroup}
                    comparison={workspace.comparison}
                    conversationId={comparisonConversationId}
                    onOpenReview={() => startToolTab("gitReview")}
                    onOpenDiff={workspace.onOpenDiff}
                  />
                </WorkspaceNavigationSplit>
              )}
          </div>
        </div>
      </aside>
    </RightDockToolContext.Provider>
  );
});
