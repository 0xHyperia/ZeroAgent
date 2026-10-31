import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  FolderOpen,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  SquarePen,
  Trash2,
} from "@liveagent/ui/components/IconSet";
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { useEffect, useRef, useState } from "react";
import type {
  CloudAccountGuard,
  CloudChatProjectsClient,
  CloudProject,
} from "@/lib/cloudChatProjects";

import { CloudProjectCreateDialog } from "./CloudProjectCreateDialog";

export type CloudChatResource = "files" | "artifacts" | "sources" | "projects" | "memory";

export function CloudChatHeaderActions(props: {
  title: string;
  disabled: boolean;
  deleteDisabled: boolean;
  moveDisabled: boolean;
  pinned: boolean;
  archived: boolean;
  projectId?: string;
  projectsClient: CloudChatProjectsClient;
  captureGuard: CloudAccountGuard;
  onRename: () => void;
  onTogglePinned: () => void;
  onToggleArchived: () => void;
  onDelete: () => Promise<void>;
  onError: (message: string) => void;
  onMoveToProject: (project: CloudProject | null) => Promise<void>;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [cursor, setCursor] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mounted = useRef(true);
  const listEpoch = useRef(0);
  const actionPending = useRef(false);
  const restoreMenuFocus = useRef(true);
  const { confirm, dialog } = useConfirmDialog();
  const { projectsClient, captureGuard } = props;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      listEpoch.current++;
    };
  }, []);
  // Each opening reads current projects; late pages cannot replace another opening.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly invalidates this page.
  useEffect(() => {
    const epoch = ++listEpoch.current;
    if (!moveOpen) return;
    const guard = captureGuard();
    setLoading(true);
    setError("");
    setProjects([]);
    setCursor("");
    void projectsClient
      .listProjects()
      .then((page) => {
        guard();
        if (mounted.current && listEpoch.current === epoch) {
          setProjects(page.items);
          setCursor(page.next_before_id);
        }
      })
      .catch(() => {
        try {
          guard();
          if (mounted.current && listEpoch.current === epoch) setError("项目加载失败");
        } catch {
          /* Retired account or conversation. */
        }
      })
      .finally(() => {
        if (mounted.current && listEpoch.current === epoch) setLoading(false);
      });
    return () => {
      listEpoch.current++;
    };
  }, [moveOpen, projectsClient, captureGuard, retry]);
  async function loadMore() {
    if (loading || !cursor) return;
    const epoch = listEpoch.current;
    const guard = captureGuard();
    setLoading(true);
    setError("");
    try {
      const page = await projectsClient.listProjects(cursor);
      guard();
      if (!mounted.current || listEpoch.current !== epoch) return;
      setProjects((old) => [
        ...old,
        ...page.items.filter((item) => !old.some((p) => p.id === item.id)),
      ]);
      setCursor(page.next_before_id);
    } catch {
      try {
        guard();
        if (mounted.current && listEpoch.current === epoch) setError("项目加载失败");
      } catch {
        /* Retired account or conversation. */
      }
    } finally {
      if (mounted.current && listEpoch.current === epoch) setLoading(false);
    }
  }
  async function move(project: CloudProject | null) {
    if (actionPending.current || props.disabled || props.moveDisabled) return;
    const guard = captureGuard();
    actionPending.current = true;
    setMoving(true);
    try {
      guard();
      await props.onMoveToProject(project);
      guard();
    } catch (cause) {
      try {
        guard();
        if (mounted.current)
          props.onError(cause instanceof Error ? cause.message : "移动失败，请重试。");
      } catch {
        /* Retired account or conversation. */
      }
    } finally {
      actionPending.current = false;
      if (mounted.current) setMoving(false);
    }
  }
  async function remove() {
    if (props.disabled || props.deleteDisabled || actionPending.current) return;
    const guard = captureGuard();
    const accepted = await confirm({
      title: "删除对话？",
      description: "删除后无法恢复。资料空间中的原文件和成果会保留。",
      subtitle: props.title,
      confirmLabel: "删除",
      cancelLabel: "取消",
      preferCancel: true,
    });
    if (!accepted || !mounted.current) return;
    actionPending.current = true;
    setDeleting(true);
    try {
      guard();
      await props.onDelete();
    } catch (cause) {
      try {
        guard();
        if (mounted.current)
          props.onError(cause instanceof Error ? cause.message : "删除失败，请重试。");
      } catch {
        /* Retired account or conversation. */
      }
    } finally {
      actionPending.current = false;
      if (mounted.current) setDeleting(false);
    }
  }
  return (
    <div className="flex shrink-0 items-center gap-1" data-cloud-chat-actions="">
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            restoreMenuFocus.current = true;
          }
        }}
      >
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" />}
          aria-label="对话选项"
          disabled={deleting}
          title="对话选项"
          className="rounded-lg text-muted-foreground hover:text-foreground"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          variant="soft"
          className="w-56"
          finalFocus={() => restoreMenuFocus.current}
        >
          <DropdownMenuItem
            disabled={props.disabled}
            onClick={() => {
              restoreMenuFocus.current = false;
              props.onRename();
            }}
            className="gap-2.5"
          >
            <SquarePen className="size-4" />
            重命名
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled}
            onClick={props.onTogglePinned}
            className="gap-2.5"
          >
            {props.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            {props.pinned ? "取消置顶" : "置顶"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={props.disabled}
            onClick={props.onToggleArchived}
            className="gap-2.5"
          >
            {props.archived ? (
              <ArchiveRestore className="size-4" />
            ) : (
              <Archive className="size-4" />
            )}
            {props.archived ? "取消归档" : "归档"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={props.disabled || props.deleteDisabled}
            onClick={() => {
              restoreMenuFocus.current = false;
              void remove();
            }}
            className="gap-2.5 text-destructive data-[highlighted]:text-destructive"
          >
            <Trash2 className="size-4" />
            删除
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub open={moveOpen} onOpenChange={setMoveOpen}>
            <DropdownMenuSubTrigger
              disabled={props.disabled || props.moveDisabled || moving}
              className="gap-2.5"
            >
              <FolderOpen className="size-4" />
              <span className="flex-1">{moving ? "正在移动…" : "移至项目"}</span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56 max-w-[calc(100vw-2rem)]" side="left">
              <DropdownMenuItem
                className="gap-2.5"
                onClick={() => {
                  restoreMenuFocus.current = false;
                  setCreateOpen(true);
                }}
              >
                <Plus className="size-4" />
                新建项目
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {projects.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  className="gap-2.5"
                  disabled={project.id === props.projectId}
                  onClick={() => void move(project)}
                >
                  <FolderOpen className="size-4 shrink-0" />
                  <span className="truncate flex-1">{project.name}</span>
                  {project.id === props.projectId ? <Check className="size-4" /> : null}
                </DropdownMenuItem>
              ))}
              {loading ? (
                <div role="status" className="px-2.5 py-2 text-xs text-muted-foreground">
                  正在加载项目…
                </div>
              ) : null}
              {!loading && !error && !projects.length ? (
                <div className="px-2.5 py-2 text-xs text-muted-foreground">还没有项目</div>
              ) : null}
              {error ? (
                <DropdownMenuItem
                  closeOnClick={false}
                  onClick={() => (cursor ? void loadMore() : setRetry((old) => old + 1))}
                >
                  加载失败，重试
                </DropdownMenuItem>
              ) : null}
              {cursor && !error ? (
                <DropdownMenuItem
                  disabled={loading}
                  closeOnClick={false}
                  onClick={() => void loadMore()}
                >
                  加载更多项目
                </DropdownMenuItem>
              ) : null}
              {props.projectId ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => void move(null)}>移出项目</DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
      <CloudProjectCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        client={projectsClient}
        captureGuard={captureGuard}
        disabled={props.disabled || props.moveDisabled}
        moveAfterCreate
        onCreated={props.onMoveToProject}
      />
    </div>
  );
}
