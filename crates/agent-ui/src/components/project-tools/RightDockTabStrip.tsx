import type { RightDockTabKind } from "@liveagent/app/lib/settings";
import { Check, Columns2, Cpu, GripVertical, Terminal, X } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/shared/utils";
import type { TerminalSession } from "../../lib/terminal/types";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  formatTerminalSessionTitle,
  type RightDockLeasedToolKind,
  type RightDockVisibleTab,
} from "./rightDockModel";
import { getRightDockToolDefinition, type RightDockSingletonTabKind } from "./rightDockRegistry";
import type { RightDockTabDragProps } from "./useRightDockTabReorder";

type RightDockTabStripProps = {
  tabs: RightDockVisibleTab[];
  currentActiveTab: RightDockTabKind;
  workspaceTabs?: readonly RightDockWorkspaceTab[];
  activeWorkspaceTabId?: string | null;
  onMoveWorkspaceTab?: (id: string, target: string) => void;
  backgroundTasksRunning: number;
  // Hide-only: clears the tab's session-local visibility and never touches
  // the processes themselves.
  onCloseBackgroundTasks: () => void;
  activeSession: TerminalSession | null;
  pendingCloseSessionId: string;
  closingSessionIds: ReadonlySet<string>;
  draggingTabId: string;
  renderTabDragHandle: (tabId: string, label: string) => ReactNode;
  getTabDragProps: (tabId: string) => RightDockTabDragProps;
  getTabDragStyle: (tabId: string) => CSSProperties | undefined;
  consumeSuppressedTabClick: (tabId: string) => boolean;
  onActivateTab: (tabId: string) => void;
  onActivateTerminalSession: (session: TerminalSession) => void;
  onCloseToolTab: (kind: RightDockSingletonTabKind) => void;
  onCloseTerminalRequest: (session: TerminalSession) => void;
  /**
   * Provided when terminal tabs can be dragged out of the dock (workbench
   * hosts). The grip and the tab body both arm the drag-out gesture; in-dock
   * reorder yields because the visible handle is the extract affordance.
   * Click activation is unaffected — the drag session suppresses the click
   * only after its movement threshold.
   */
  onTerminalTabDragStart?: (
    session: TerminalSession,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /**
   * Keyboard/pointer alternative to dragging a terminal tab out: docks the
   * session beside the focused workbench pane. Enables the tab context menu.
   */
  onOpenTerminalInWorkbench?: (session: TerminalSession) => void;
  /**
   * Provided when project tool tabs (file tree, git review, tunnel, SSH,
   * background tasks) can be dragged out into a workbench pane.
   */
  onToolTabDragStart?: (
    kind: RightDockLeasedToolKind,
    event: {
      pointerId: number;
      clientX: number;
      clientY: number;
      currentTarget?: EventTarget | null;
    },
  ) => void;
  /** Tab context-menu "open in split" for project tools. */
  onOpenToolInWorkbench?: (kind: RightDockLeasedToolKind) => void;
};

// One descriptor per tab regardless of kind, so every tab shares a single
// renderer: identical geometry, drag surface, and close-button behaviour.
type DockTabDescriptor = {
  id: string;
  label: string;
  icon: ReactNode;
  isActive: boolean;
  // undefined: no status dot; true: running (emerald); false: idle (muted).
  running?: boolean;
  isPendingClose?: boolean;
  closeLabel: string;
  closeTitle: string;
  closeIcon?: ReactNode;
  closeDisabled?: boolean;
  /** Context-menu entries; omitted when the host wires no workbench actions. */
  menuItems?: ReactNode;
  /** Overrides the default reorder pointer-down on the tab body (drag-out). */
  dragProps?: RightDockTabDragProps;
  onActivate: () => void;
  onClose: () => void;
  workspaceTab?: boolean;
  temporary?: boolean;
  onKeepOpen?: () => void;
};

export type RightDockWorkspaceTab = Pick<
  DockTabDescriptor,
  | "id"
  | "label"
  | "icon"
  | "running"
  | "menuItems"
  | "onActivate"
  | "onClose"
  | "temporary"
  | "onKeepOpen"
> & { dirty?: boolean };

// Rounded, inset tabs share the settings selection surface without a frame
// or underline. Drag positioning remains controlled by inline styles.
const TAB_BASE_CLASS =
  "group relative mx-0.5 flex h-8 max-w-48 shrink-0 select-none items-center self-center gap-1 rounded-md pl-6 pr-2 text-xs text-muted-foreground hover:bg-settings-tile-hover hover:text-foreground web:max-820:max-w-project-tools-panel-tab-max-w web:max-380:max-w-project-tools-panel-tab-max-w-2";

const CLOSE_BUTTON_CLASS =
  "relative z-10 ml-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

export function RightDockTabStrip(props: RightDockTabStripProps) {
  const {
    tabs,
    currentActiveTab,
    workspaceTabs,
    activeWorkspaceTabId,
    onMoveWorkspaceTab,
    backgroundTasksRunning,
    onCloseBackgroundTasks,
    activeSession,
    pendingCloseSessionId,
    closingSessionIds,
    draggingTabId,
    renderTabDragHandle,
    getTabDragProps,
    getTabDragStyle,
    consumeSuppressedTabClick,
    onActivateTab,
    onActivateTerminalSession,
    onCloseToolTab,
    onCloseTerminalRequest,
    onTerminalTabDragStart,
    onOpenTerminalInWorkbench,
    onToolTabDragStart,
    onOpenToolInWorkbench,
  } = props;
  const { t } = useLocale();
  const desktopWorkspace = workspaceTabs !== undefined;
  // One open menu at a time, keyed by tab id — the strip is a single row, so a
  // per-tab open flag would only add bookkeeping.
  const [menuTabId, setMenuTabId] = useState("");
  const workspaceDrag = useRef<string | null>(null);
  const closeFocus = useRef<{ id: string; strip: Element } | null>(null);
  useLayoutEffect(() => {
    const pending = closeFocus.current;
    if (!pending || workspaceTabs?.some((tab) => tab.id === pending.id)) return;
    closeFocus.current = null;
    if (document.activeElement !== document.body) return;
    const next = pending.strip.querySelector<HTMLButtonElement>(
      '[data-workspace-tab-trigger][aria-selected="true"]',
    );
    (
      next ??
      pending.strip
        .closest("[data-app-frame-column]")
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    )?.focus({ preventScroll: true });
  }, [workspaceTabs]);

  // Shared drag-out / menu wiring for every project tool tab; terminal tabs
  // carry a session and keep their own descriptor.
  const toolTabWorkbenchProps = (
    kind: RightDockLeasedToolKind,
  ): Pick<DockTabDescriptor, "menuItems" | "dragProps"> => ({
    menuItems: onOpenToolInWorkbench ? (
      <ContextMenuItem onSelect={() => onOpenToolInWorkbench(kind)} className="gap-2">
        <Columns2 className="size-3.5" />
        {t("workbench.openInSplit")}
      </ContextMenuItem>
    ) : undefined,
    dragProps: onToolTabDragStart
      ? {
          onPointerDown: (event) => {
            if (event.button !== 0 || event.pointerType === "touch") return;
            onToolTabDragStart(kind, {
              pointerId: event.pointerId,
              clientX: event.clientX,
              clientY: event.clientY,
              currentTarget: event.currentTarget,
            });
          },
        }
      : undefined,
  });

  const renderDockTab = (tab: DockTabDescriptor) => {
    const tabBody = (
      // biome-ignore lint/a11y/noStaticElementInteractions: The named tab button handles focus and activation. The surrounding row handles drag geometry only.
      <div
        key={tab.id}
        data-project-tools-tab-id={tab.id}
        data-workspace-tab-active={tab.workspaceTab && tab.isActive ? "true" : undefined}
        data-desktop-workspace-tab={desktopWorkspace ? "" : undefined}
        data-desktop-workspace-tab-selected={desktopWorkspace && tab.isActive ? "" : undefined}
        data-desktop-workspace-tab-preview={desktopWorkspace && tab.temporary ? "" : undefined}
        draggable={tab.workspaceTab && Boolean(onMoveWorkspaceTab)}
        className={cn(
          desktopWorkspace
            ? cn(
                "group relative flex h-8 shrink-0 select-none items-center self-center gap-1 rounded-lg pr-2 text-[13px]",
                tab.workspaceTab ? "pl-2.5" : "pl-6",
              )
            : TAB_BASE_CLASS,
          !desktopWorkspace &&
            tab.isActive &&
            "bg-settings-active text-foreground hover:bg-settings-active",
          tab.isPendingClose && "bg-destructive/10 text-destructive hover:bg-destructive/15",
          draggingTabId === tab.id && "z-10 cursor-grabbing opacity-80 ring-1 ring-ring",
        )}
        title={tab.label}
        onDoubleClick={tab.onKeepOpen}
        style={getTabDragStyle(tab.id)}
        {...(tab.workspaceTab ? undefined : (tab.dragProps ?? getTabDragProps(tab.id)))}
        onDragStart={
          tab.workspaceTab
            ? (event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-zeroagent-workspace-tab", tab.id);
                workspaceDrag.current = tab.id;
              }
            : undefined
        }
        onDragEnd={
          tab.workspaceTab
            ? () => {
                workspaceDrag.current = null;
              }
            : undefined
        }
        onDragOver={
          tab.workspaceTab
            ? (event) => {
                if (!workspaceDrag.current) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            : undefined
        }
        onDrop={
          tab.workspaceTab
            ? (event) => {
                const from = workspaceDrag.current;
                if (!from) return;
                event.preventDefault();
                event.stopPropagation();
                onMoveWorkspaceTab?.(from, tab.id);
                workspaceDrag.current = null;
              }
            : undefined
        }
      >
        <Button
          variant="ghost"
          type="button"
          aria-label={tab.label}
          role={desktopWorkspace ? "tab" : undefined}
          aria-pressed={desktopWorkspace ? undefined : tab.isActive}
          aria-selected={desktopWorkspace ? tab.isActive : undefined}
          tabIndex={desktopWorkspace && !tab.isActive ? -1 : undefined}
          data-workspace-tab-trigger=""
          aria-haspopup={tab.menuItems ? "menu" : undefined}
          className={cn(
            "absolute inset-0 z-0 h-full w-full rounded-md bg-transparent p-0 hover:bg-transparent",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          onClick={() => {
            if (consumeSuppressedTabClick(tab.id)) return;
            tab.onActivate();
          }}
          onMouseDown={(event) => {
            if (desktopWorkspace && event.button === 1) event.preventDefault();
          }}
          onAuxClick={(event) => {
            if (!desktopWorkspace || event.button !== 1 || tab.closeDisabled) return;
            event.preventDefault();
            const strip = event.currentTarget.closest(".project-tools-panel-tabs");
            if (strip && tab.workspaceTab) closeFocus.current = { id: tab.id, strip };
            tab.onClose();
          }}
          onKeyDown={(event) => {
            if (
              !desktopWorkspace ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey
            )
              return;
            const strip = event.currentTarget.closest(".project-tools-panel-tabs");
            if (event.key === "Delete" && !tab.closeDisabled) {
              event.preventDefault();
              if (strip && tab.workspaceTab) closeFocus.current = { id: tab.id, strip };
              tab.onClose();
              return;
            }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            const buttons = Array.from(
              strip?.querySelectorAll<HTMLButtonElement>("[data-workspace-tab-trigger]") ?? [],
            );
            const index = buttons.indexOf(event.currentTarget);
            const target =
              event.key === "Home"
                ? buttons[0]
                : event.key === "End"
                  ? buttons.at(-1)
                  : buttons[
                      (index + (event.key === "ArrowLeft" ? -1 : 1) + buttons.length) %
                        buttons.length
                    ];
            if (!target) return;
            event.preventDefault();
            target.focus();
            target.click();
          }}
        />
        {!tab.workspaceTab && (
          <span className="absolute left-0.5 top-1/2 z-10 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            {tab.dragProps ? (
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                data-project-tools-tab-action="drag"
                aria-label={t("workbench.dragPane")}
                title={t("workbench.dragPane")}
                className={cn(
                  "relative z-10 flex h-6 w-5 shrink-0 items-center justify-center",
                  "rounded text-muted-foreground/45 opacity-70 transition-[background-color,color,opacity]",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "cursor-grab touch-none",
                  "hover:bg-background/80 hover:text-foreground hover:opacity-100 focus-visible:bg-background focus-visible:text-foreground focus-visible:opacity-100 active:cursor-grabbing",
                )}
                onPointerDown={(event) => {
                  // The reorder handle sits above the tab body and used to
                  // stopPropagation into beginTabDrag, so grabbing the only
                  // visible grip never extracted the session onto the canvas.
                  event.stopPropagation();
                  tab.dragProps?.onPointerDown(event);
                }}
              >
                <GripVertical className="size-3.5" />
              </Button>
            ) : (
              renderTabDragHandle(tab.id, tab.label)
            )}
          </span>
        )}
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none relative z-10 flex h-full min-w-0 flex-1 items-center",
            "gap-1.5 text-left text-inherit",
          )}
        >
          {tab.icon}
          <span className={cn("min-w-0 truncate", tab.temporary && "italic")}>{tab.label}</span>
          {tab.running !== undefined ? (
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                tab.running ? "bg-emerald-500" : "bg-muted-foreground/50",
              )}
            />
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          data-project-tools-tab-action="close"
          aria-label={tab.closeLabel}
          title={tab.closeTitle}
          disabled={tab.closeDisabled}
          className={cn(
            CLOSE_BUTTON_CLASS,
            tab.isPendingClose
              ? "bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground md:opacity-100"
              : tab.workspaceTab && tab.isActive
                ? "opacity-100"
                : "md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100",
          )}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            const strip =
              tab.workspaceTab && event.currentTarget.closest(".project-tools-panel-tabs");
            if (strip) closeFocus.current = { id: tab.id, strip };
            consumeSuppressedTabClick(tab.id);
            tab.onClose();
          }}
        >
          {tab.closeIcon ?? <X className="size-3" />}
        </Button>
      </div>
    );

    if (!tab.menuItems) return tabBody;
    return (
      <ContextMenu
        key={tab.id}
        open={menuTabId === tab.id}
        onOpenChange={(open) => setMenuTabId(open ? tab.id : "")}
      >
        {/* biome-ignore lint/complexity/noUselessFragments: DropdownMenu keeps trigger and popup siblings under one provider child */}
        <>
          <ContextMenuTrigger render={tabBody} />
          <ContextMenuContent variant="soft" align="start" sideOffset={4} className="min-w-44">
            {tab.menuItems}
          </ContextMenuContent>
        </>
      </ContextMenu>
    );
  };

  return (
    <>
      {workspaceTabs?.map((tab) =>
        renderDockTab({
          ...tab,
          workspaceTab: true,
          isActive: activeWorkspaceTabId === tab.id,
          closeLabel: `${t("projectTools.close")} ${tab.label}`,
          closeTitle: `${t("projectTools.close")} ${tab.label}`,
          closeIcon: tab.dirty ? (
            <>
              <span className="size-1.5 rounded-full bg-current group-hover:hidden group-focus-within:hidden" />
              <X className="hidden size-3 group-hover:block group-focus-within:block" />
            </>
          ) : undefined,
        }),
      )}
      {tabs.map((tab) => {
        if (tab.kind === "backgroundTasks") {
          // Derived tab; closing only hides it (a newly started task or the
          // create menu brings it back).
          const label = t("projectTools.backgroundTasksTitle");
          const closeLabel = t("projectTools.bgTaskClosePanel");
          return renderDockTab({
            id: tab.id,
            label,
            icon: <Cpu className="size-3.5 shrink-0" />,
            isActive: !activeWorkspaceTabId && currentActiveTab === "backgroundTasks",
            running: backgroundTasksRunning > 0,
            closeLabel,
            closeTitle: closeLabel,
            ...toolTabWorkbenchProps("backgroundTasks"),
            onActivate: () => onActivateTab(tab.id),
            onClose: onCloseBackgroundTasks,
          });
        }
        if (tab.kind !== "terminal") {
          const definition = getRightDockToolDefinition(tab.kind);
          if (!definition) return null;
          const closeLabel = t(definition.closeKey);
          return renderDockTab({
            id: tab.id,
            label: t(definition.titleKey),
            icon: definition.icon("size-3.5 shrink-0"),
            isActive: !activeWorkspaceTabId && currentActiveTab === tab.kind,
            closeLabel,
            closeTitle: closeLabel,
            ...toolTabWorkbenchProps(tab.kind),
            onActivate: () => onActivateTab(tab.id),
            onClose: () => onCloseToolTab(tab.kind),
          });
        }

        const session = tab.session;
        const isPendingClose = pendingCloseSessionId === session.id;
        const sessionTitle = formatTerminalSessionTitle(
          session.title,
          t("projectTools.terminalTitle"),
        );
        // 拖入画板(租约)的会话不在 dock 列表里,这里的 tab 都可自由进入
        // 工作台;菜单是拖拽之外的键盘/指针等价入口。
        const menuItems = onOpenTerminalInWorkbench ? (
          <ContextMenuItem onSelect={() => onOpenTerminalInWorkbench(session)} className="gap-2">
            <Columns2 className="size-3.5" />
            {t("workbench.openInSplit")}
          </ContextMenuItem>
        ) : null;
        return renderDockTab({
          id: session.id,
          label: sessionTitle,
          icon: <Terminal className="size-3.5 shrink-0" />,
          isActive:
            !activeWorkspaceTabId &&
            currentActiveTab === "terminal" &&
            activeSession?.id === session.id,
          running: session.running,
          isPendingClose,
          menuItems,
          closeLabel: `${isPendingClose ? t("projectTools.confirmClose") : t("projectTools.close")} ${sessionTitle}`,
          closeTitle: isPendingClose
            ? t("projectTools.confirmCloseTerminal")
            : t("projectTools.closeTerminal"),
          closeIcon: isPendingClose ? <Check className="size-3" /> : <X className="size-3" />,
          closeDisabled: closingSessionIds.has(session.id),
          dragProps: onTerminalTabDragStart
            ? {
                onPointerDown: (event) => {
                  // Touch keeps panning the strip (same rule as tab reorder).
                  if (event.button !== 0 || event.pointerType === "touch") return;
                  onTerminalTabDragStart(session, {
                    pointerId: event.pointerId,
                    clientX: event.clientX,
                    clientY: event.clientY,
                    currentTarget: event.currentTarget,
                  });
                },
              }
            : undefined,
          onActivate: () => onActivateTerminalSession(session),
          onClose: () => onCloseTerminalRequest(session),
        });
      })}
    </>
  );
}
