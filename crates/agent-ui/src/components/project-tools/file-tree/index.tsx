// Right-dock file tree panel: virtualized tree over the useFileTreeData
// layer, reading its wiring from the right-dock tool context.
//
// Shared implementation owned by @liveagent/ui. Host-specific icons, settings
// and backend capabilities resolve through the current application's contracts.

import type {
  RightDockFileTreeState,
  RightDockFileTreeStatePatch,
  WorkspaceProject,
} from "@liveagent/app/lib/settings";
import {
  Check,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "@liveagent/ui/components/IconSet";
import type { WorkspaceProjectRootClient } from "@liveagent/ui/contracts/workspaceProjectRoots";
import { useLocale } from "@liveagent/ui/i18n/index";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  finishWorkspacePathDrag,
  writeWorkspacePathDragPayload,
} from "../../../lib/chat/workspacePathDrag";
import { hostAwareErrorMessage } from "../../../lib/shared/hostErrors";
import { cn } from "../../../lib/shared/utils";
import type { WorkspaceActivityClient } from "../../../lib/workspace-activity/types";
import { getFileTypeIcon } from "../../chat/fileTypeIcons";
import { Button, RefreshButton } from "../../ui/button";
import { useConfirmDialog } from "../../ui/confirm-dialog";
import { Input } from "../../ui/input";
import { isWorkspaceImagePath } from "../../workspace-editor/workspaceImagePreview";
import { useRightDockToolContext } from "../RightDockContext";
import { FileTreeContextMenu } from "./ContextMenu";
import {
  addExpandedPaths,
  ancestorDirsOfPath,
  basename,
  dirname,
  FILE_TREE_HAS_OS_INTEGRATION,
  FILE_TREE_ROW_HEIGHT,
  type FileTreeEntry,
  type FileTreeExternalRoot,
  type FileTreeKind,
  type FileTreeRowModel,
  flattenFileTreeRows,
  flattenFileTreeSearchRows,
  indexStickyTreeRows,
  ROOT_PATH,
  remapExpandedPathsForRename,
  removeExpandedPath,
  removeExpandedSubtree,
} from "./model";
import { FileTreeErrorRow, FileTreeRow } from "./Row";
import { useFileTreeData } from "./useFileTreeData";
import { useFileTreeExternalRoots } from "./useFileTreeExternalRoots";

const FILE_TREE_QUERY_SYNC_DEBOUNCE_MS = 180;
const NO_EXTERNAL_FILE_TREE_ROOTS: readonly FileTreeExternalRoot[] = [];

type PendingAction = "file" | "folder" | "rename" | null;

type ContextMenuState = {
  x: number;
  y: number;
  path: string;
};

export type FileTreeSectionRow = {
  type: "section";
  key: string;
  content: ReactNode;
  level?: number;
  stickyFolder?: boolean;
};

type VisibleFileTreeRow =
  | FileTreeRowModel
  | FileTreeSectionRow
  | { type: "search"; key: string; entry: FileTreeEntry; depth: number; expanded: boolean };

function treeRowLevel(row: VisibleFileTreeRow) {
  if (row.type === "section") return row.level;
  return row.type === "error" ? undefined : row.depth + 1;
}

const NO_COLLAPSED_SEARCH_DIRECTORIES: ReadonlySet<string> = new Set();

type WorkspaceFileTreeSections = {
  rows: readonly FileTreeSectionRow[];
  filesExpanded: boolean;
  filesSelected: boolean;
  onSelectFile: () => void;
};

export function FileTreePanel(props: {
  active: boolean;
  workspaceSections?: WorkspaceFileTreeSections;
}) {
  const context = useRightDockToolContext();
  return (
    <FileTreeSurface
      active={props.active}
      workspaceSections={props.workspaceSections}
      projectPathKey={context.projectPathKey}
      cwd={context.cwd}
      state={context.fileTree.state}
      initialized={
        props.workspaceSections ? context.capabilities.projectReady : context.fileTree.initialized
      }
      externalRoots={context.fileTree.externalRoots}
      workspaceActivityClient={context.clients.workspaceActivity ?? null}
      onInitializedChange={context.fileTree.onInitializedChange}
      onRefreshExternalRoots={context.fileTree.refreshExternalRoots}
      onStateChange={context.fileTree.onStateChange}
      onInsertFileMention={context.fileTree.onInsertFileMention}
      onOpenFile={context.fileTree.onOpenFile}
    />
  );
}

export type FileTreeSurfaceProps = {
  active: boolean;
  workspaceSections?: WorkspaceFileTreeSections;
  projectPathKey: string;
  cwd: string;
  state: RightDockFileTreeState;
  initialized?: boolean;
  externalRoots?: readonly FileTreeExternalRoot[];
  workspaceActivityClient?: WorkspaceActivityClient | null;
  onInitializedChange?: (initialized: boolean) => void;
  onRefreshExternalRoots?: () => Promise<void>;
  onStateChange: (patch: RightDockFileTreeStatePatch) => void;
  onInsertFileMention?: (path: string, kind: "file" | "dir") => void;
  onOpenFile?: (path: string, imagePaths?: string[], temporary?: boolean) => void;
};

export type FileTreePaneSurfaceProps = Omit<
  FileTreeSurfaceProps,
  "externalRoots" | "onRefreshExternalRoots"
> & {
  workspaceProject?: WorkspaceProject;
  workspaceProjectRootClient?: WorkspaceProjectRootClient;
  workspaceRootRevision?: number;
};

/**
 * Workbench pane host for the file tree. The Right Dock fetches external
 * (multi-root) grants itself and injects them through context; a pane has no
 * dock context, so this wrapper owns the same fetch and keeps both hosts
 * rendering identical roots.
 */
export function FileTreePaneSurface(props: FileTreePaneSurfaceProps) {
  const { workspaceProject, workspaceProjectRootClient, workspaceRootRevision, ...surfaceProps } =
    props;
  const { externalRoots, refreshExternalRoots } = useFileTreeExternalRoots({
    workspaceProject,
    workspaceProjectRootClient,
    workspaceRootRevision,
  });
  return (
    <FileTreeSurface
      {...surfaceProps}
      externalRoots={externalRoots}
      onRefreshExternalRoots={refreshExternalRoots}
    />
  );
}

export function FileTreeSurface(props: FileTreeSurfaceProps) {
  const {
    active,
    workspaceSections,
    projectPathKey,
    cwd,
    state: syncState,
    initialized = true,
    externalRoots = NO_EXTERNAL_FILE_TREE_ROOTS,
    workspaceActivityClient,
    onInitializedChange,
    onRefreshExternalRoots,
    onStateChange,
    onInsertFileMention,
    onOpenFile,
  } = props;
  const { t } = useLocale();

  const integratedSearch = workspaceSections !== undefined;
  const onSelectWorkspaceFile = workspaceSections?.onSelectFile;
  const [localQuery, setQuery] = useState(syncState.query);
  const query = integratedSearch ? syncState.query : localQuery;
  const searchScope = `${projectPathKey}\0${query}`;
  const [searchExpansion, setSearchExpansion] = useState<{
    scope: string;
    collapsed: ReadonlySet<string>;
  }>();
  const collapsedSearchDirectories =
    searchExpansion?.scope === searchScope
      ? searchExpansion.collapsed
      : NO_COLLAPSED_SEARCH_DIRECTORIES;
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [pendingTargetPath, setPendingTargetPath] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [revealTarget, setRevealTarget] = useState<string | null>(null);
  const [keyboardTarget, setKeyboardTarget] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { confirm: requestConfirmDialog, dialog: confirmDialog } = useConfirmDialog();

  const {
    nodes,
    loadChildren,
    refreshVisible,
    ensureDirsLoaded,
    createEntry,
    renameEntry,
    deleteEntry,
    openWorkspacePath,
    isExternalPath,
    getDisplayPath,
    search,
  } = useFileTreeData({
    projectPathKey,
    cwd,
    externalRoots,
    active,
    initialized,
    workspaceActivityClient: workspaceActivityClient ?? null,
    expandedPaths: syncState.expandedPaths,
    query,
    showHidden: syncState.showHidden,
  });

  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const onStateChangeRef = useRef(onStateChange);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);
  const emitState = useCallback((patch: RightDockFileTreeStatePatch) => {
    onStateChangeRef.current(patch);
  }, []);

  // Expansion state has one source of truth: the persisted settings state.
  // `expandedRef` is updated both when a patch is emitted and when the
  // persisted state round-trips, so local toggles and sync operate on the
  // same value even mid-async-flow (no stale-closure overwrites).
  const expandedPaths = syncState.expandedPaths;
  const expandedSet = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const expandedRef = useRef(expandedPaths);
  useEffect(() => {
    expandedRef.current = expandedPaths;
  }, [expandedPaths]);

  const setExpanded = useCallback(
    (next: string[]) => {
      if (next === expandedRef.current) return;
      expandedRef.current = next;
      emitState({ expandedPaths: next });
    },
    [emitState],
  );

  const selectedNode = nodes[syncState.selectedPath] ?? nodes[ROOT_PATH];
  const selectedPath = selectedNode?.path ?? ROOT_PATH;
  const canMutate = initialized && Boolean(projectPathKey && cwd);

  const selectPath = useCallback(
    (path: string) => {
      onSelectWorkspaceFile?.();
      emitState({ selectedPath: path });
    },
    [emitState, onSelectWorkspaceFile],
  );

  const toggleDirectory = useCallback(
    (path: string, isExpanded: boolean) => {
      if (isExpanded) {
        setExpanded(removeExpandedPath(expandedRef.current, path));
      } else {
        setExpanded(addExpandedPaths(expandedRef.current, [path]));
        void loadChildren(path);
      }
    },
    [loadChildren, setExpanded],
  );

  // Local query <-> persisted query (both directions, debounced outbound).
  useEffect(() => {
    setQuery((current) => (current === syncState.query ? current : syncState.query));
  }, [syncState.query]);
  useEffect(() => {
    if (integratedSearch || !initialized || !projectPathKey || query === syncState.query) return;
    const timer = window.setTimeout(() => {
      emitState({ query });
    }, FILE_TREE_QUERY_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [emitState, initialized, integratedSearch, projectPathKey, query, syncState.query]);

  // Transient UI state never leaks across project switches.
  useEffect(() => {
    void projectPathKey;
    setContextMenu(null);
    setPendingAction(null);
    setPendingTargetPath(null);
    setDraftName("");
    setActionError(null);
    setRevealTarget(null);
  }, [projectPathKey]);

  // Reveal: expand + load the ancestor chain, then scroll the row into view.
  // The expansion merge reads `expandedRef` *after* the awaits so manual
  // expands that happened while loading are preserved (the old panel captured
  // a pre-await snapshot and overwrote them).
  const revealPath = useCallback(
    async (path: string, kind: FileTreeKind) => {
      const dirs =
        kind === "dir" && path ? [...ancestorDirsOfPath(path), path] : ancestorDirsOfPath(path);
      await ensureDirsLoaded(dirs);
      setExpanded(addExpandedPaths(expandedRef.current, dirs));
      selectPath(path);
      setRevealTarget(path);
    },
    [ensureDirsLoaded, selectPath, setExpanded],
  );

  // External reveal requests arrive as a bump of the persisted revision
  // nonce (state.revision) with selectedPath/expandedPaths already patched
  // by RightDockPanel.revealPathInFileTree.
  const lastRevisionRef = useRef(syncState.revision);
  useEffect(() => {
    const previous = lastRevisionRef.current;
    lastRevisionRef.current = syncState.revision;
    if (!initialized || !projectPathKey || previous === syncState.revision) return;
    const target = syncState.selectedPath;
    const kind = nodesRef.current[target]?.kind ?? "file";
    void revealPath(target, kind);
  }, [initialized, projectPathKey, revealPath, syncState.revision, syncState.selectedPath]);

  const fileRows = useMemo(
    () => flattenFileTreeRows(nodes, expandedSet, !integratedSearch),
    [expandedSet, integratedSearch, nodes],
  );
  const searchRows = useMemo(
    () => flattenFileTreeSearchRows(search.results, collapsedSearchDirectories),
    [collapsedSearchDirectories, search.results],
  );
  const searchNotice = useMemo(
    () =>
      search.loading ? (
        <span className="flex items-center gap-2 text-muted-foreground" role="status">
          <Loader2 className="size-3.5 animate-spin" />
          {t("projectTools.fileTree.searching")}
        </span>
      ) : search.error ? (
        <span className="text-destructive" role="alert">
          {search.error}
        </span>
      ) : search.results.length === 0 ? (
        <span className="text-muted-foreground">{t("projectTools.fileTree.noMatches")}</span>
      ) : null,
    [search.loading, search.error, search.results.length, t],
  );
  const searchTruncated = useMemo(
    () =>
      search.truncated &&
      !searchNotice && (
        <span className="text-muted-foreground">{t("projectTools.fileTree.resultsTruncated")}</span>
      ),
    [search.truncated, searchNotice, t],
  );
  const rows = useMemo<readonly VisibleFileTreeRow[]>(() => {
    if (!workspaceSections) return fileRows;
    const sectionRows: VisibleFileTreeRow[] = [...workspaceSections.rows];
    if (workspaceSections.filesExpanded) {
      if (!query.trim()) {
        sectionRows.push(...fileRows);
      } else if (searchNotice) {
        sectionRows.push({
          type: "section",
          key: "\0search-notice",
          content: <div className="px-5 py-1">{searchNotice}</div>,
        });
      } else {
        sectionRows.push(
          ...searchRows.map((row) => ({
            ...row,
            type: "search" as const,
            key: `\0search:${row.entry.path}`,
          })),
        );
        if (searchTruncated)
          sectionRows.push({
            type: "section",
            key: "\0search-truncated",
            content: <div className="px-5 py-1">{searchTruncated}</div>,
          });
      }
    }
    return sectionRows;
  }, [workspaceSections, query, fileRows, searchNotice, searchRows, searchTruncated]);

  const stickyIndex = useMemo(
    () =>
      workspaceSections
        ? indexStickyTreeRows(
            rows.map((row) => ({
              level: treeRowLevel(row),
              sticky:
                row.type === "section"
                  ? row.stickyFolder
                  : row.type === "search"
                    ? row.expanded
                    : row.type === "node" &&
                      nodes[row.path]?.kind === "dir" &&
                      expandedSet.has(row.path),
            })),
          )
        : null,
    [workspaceSections, rows, nodes, expandedSet],
  );

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: () => FILE_TREE_ROW_HEIGHT,
    overscan: 12,
    rangeExtractor: (range) => {
      const visible = defaultRangeExtractor(range);
      if (!stickyIndex) return visible;
      const extra: number[] = [];
      for (
        let index = stickyIndex.parents[range.startIndex];
        index !== undefined;
        index = stickyIndex.parents[index]
      ) {
        if (index < visible[0]) extra.push(index);
      }
      return [...extra.reverse(), ...visible];
    },
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    if (!keyboardTarget) return;
    const index = rows.findIndex((row) => row.key === keyboardTarget);
    if (index < 0) {
      setKeyboardTarget(null);
      return;
    }
    const item = scrollRef.current?.querySelector<HTMLElement>(
      `[data-index="${index}"] [role="treeitem"]`,
    );
    if (!item) return;
    item.focus({ preventScroll: true });
    setKeyboardTarget(null);
  }, [keyboardTarget, rows]);

  const onWorkspaceTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target || target.getAttribute("role") !== "treeitem") return;
    const expanded = target.getAttribute("aria-expanded");
    if (
      (event.key === "ArrowRight" && expanded === "false") ||
      (event.key === "ArrowLeft" && expanded === "true")
    ) {
      event.preventDefault();
      target.click();
      return;
    }
    const index = Number(target.closest<HTMLElement>("[data-index]")?.dataset.index);
    const current = rows[index];
    if (
      !current ||
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    )
      return;
    event.preventDefault();
    if (event.key === "ArrowRight" && expanded !== "true") return;
    const step =
      event.key === "ArrowDown" || event.key === "Home" || event.key === "ArrowRight" ? 1 : -1;
    const currentLevel = treeRowLevel(current) ?? 1;
    let next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : index + step;
    while (next >= 0 && next < rows.length) {
      const row = rows[next];
      const level = treeRowLevel(row);
      if (event.key === "ArrowRight" && level !== undefined && level <= currentLevel) return;
      if (level !== undefined && (event.key !== "ArrowLeft" || level < currentLevel)) {
        rowVirtualizer.scrollToIndex(next, { align: "auto" });
        setKeyboardTarget(row.key);
        return;
      }
      next += step;
    }
  };

  useEffect(() => {
    if (!revealTarget) return;
    const index = rows.findIndex((row) => row.type === "node" && row.path === revealTarget);
    if (index < 0) return;
    rowVirtualizer.scrollToIndex(index, { align: "center" });
    setRevealTarget(null);
  }, [revealTarget, rowVirtualizer, rows]);

  const getSiblingImagePaths = useCallback((targetPath: string) => {
    if (!isWorkspaceImagePath(targetPath)) return [];
    const currentNodes = nodesRef.current;
    const parentNode = currentNodes[dirname(targetPath)];
    const siblingPaths =
      parentNode?.children.filter((childPath) => {
        const child = currentNodes[childPath];
        return child?.kind === "file" && isWorkspaceImagePath(childPath);
      }) ?? [];
    return siblingPaths.includes(targetPath) ? siblingPaths : [targetPath];
  }, []);

  const onOpenFileRef = useRef(onOpenFile);
  useEffect(() => {
    onOpenFileRef.current = onOpenFile;
  }, [onOpenFile]);
  const handleOpenFile = useCallback(
    (path: string, temporary = false) => {
      if (isExternalPath(path)) {
        if (!FILE_TREE_HAS_OS_INTEGRATION) return;
        setActionError(null);
        void openWorkspacePath(path, "open").catch((error: unknown) => {
          setActionError(hostAwareErrorMessage(error, t("projectTools.runtimeUnsupported")));
        });
        return;
      }
      onOpenFileRef.current?.(path, getSiblingImagePaths(path), temporary);
    },
    [getSiblingImagePaths, isExternalPath, openWorkspacePath, t],
  );

  const onInsertFileMentionRef = useRef(onInsertFileMention);
  useEffect(() => {
    onInsertFileMentionRef.current = onInsertFileMention;
  }, [onInsertFileMention]);
  const handleInsertMention = useCallback(
    (path: string) => {
      const node = nodesRef.current[path];
      if (!path || !node || isExternalPath(path)) return;
      onInsertFileMentionRef.current?.(path, node.kind);
    },
    [isExternalPath],
  );

  const handleWorkspacePathDragStart = useCallback(
    (event: ReactDragEvent, path: string, kind: FileTreeKind) => {
      const node = nodesRef.current[path];
      // External roots live outside the project cwd, so they have no
      // project-relative payload; the payload validator would reject their
      // sentinel prefix anyway, but refuse the drag explicitly.
      if (!node || !path || isExternalPath(path)) {
        event.preventDefault();
        return;
      }
      if (
        !writeWorkspacePathDragPayload(event.dataTransfer, {
          kind: "workspacePath",
          projectPathKey,
          cwd,
          relativePath: path,
          entryKind: kind,
          label: node.name,
        })
      ) {
        event.preventDefault();
      }
    },
    [cwd, isExternalPath, projectPathKey],
  );

  const openContextMenu = useCallback(
    (event: ReactMouseEvent, path: string) => {
      event.preventDefault();
      event.stopPropagation();
      const targetPath = nodesRef.current[path] ? path : ROOT_PATH;
      selectPath(targetPath);
      const rect = panelRef.current?.getBoundingClientRect();
      setContextMenu({
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
        path: targetPath,
      });
    },
    [selectPath],
  );

  const startAction = useCallback(
    (action: Exclude<PendingAction, null>, targetPath: string) => {
      const currentNodes = nodesRef.current;
      const targetNode = currentNodes[targetPath] ?? currentNodes[ROOT_PATH];
      const normalizedTargetPath = targetNode?.path ?? ROOT_PATH;
      if (action === "rename" && !normalizedTargetPath) return;
      selectPath(normalizedTargetPath);
      setPendingTargetPath(normalizedTargetPath);
      setPendingAction(action);
      setActionError(null);
      setDraftName(action === "rename" ? basename(normalizedTargetPath) : "");
    },
    [selectPath],
  );

  const finishAction = useCallback(async () => {
    if (!pendingAction || busyAction) return;
    const name = draftName.trim();
    if (!name) {
      setActionError(t("projectTools.fileTree.nameRequired"));
      return;
    }
    setBusyAction(true);
    setActionError(null);
    try {
      const currentNodes = nodesRef.current;
      const targetPath = pendingTargetPath ?? selectedPath;
      const targetNode = currentNodes[targetPath] ?? currentNodes[ROOT_PATH];
      const targetDir =
        targetNode?.kind === "dir" ? targetNode.path : dirname(targetNode?.path ?? targetPath);
      if (pendingAction === "file") {
        const nextPath = await createEntry("file", targetDir, name);
        setExpanded(addExpandedPaths(expandedRef.current, [targetDir]));
        selectPath(nextPath);
      } else if (pendingAction === "folder") {
        const nextPath = await createEntry("dir", targetDir, name);
        setExpanded(addExpandedPaths(expandedRef.current, [targetDir, nextPath]));
        selectPath(nextPath);
      } else if (pendingAction === "rename" && targetPath) {
        const nextPath = await renameEntry(targetPath, name);
        setExpanded(remapExpandedPathsForRename(expandedRef.current, targetPath, nextPath));
        selectPath(nextPath);
      }
      setPendingAction(null);
      setPendingTargetPath(null);
      setDraftName("");
    } catch (error) {
      setActionError(hostAwareErrorMessage(error, t("projectTools.runtimeUnsupported")));
    } finally {
      setBusyAction(false);
    }
  }, [
    busyAction,
    createEntry,
    draftName,
    pendingAction,
    pendingTargetPath,
    renameEntry,
    selectPath,
    selectedPath,
    setExpanded,
    t,
  ]);

  const deletePath = useCallback(
    async (targetPath: string) => {
      if (!targetPath || busyAction) return;
      const confirmed = await requestConfirmDialog({
        title: t("projectTools.fileTree.deleteConfirm").replace("{path}", targetPath),
        subtitle: t("projectTools.fileTree.deleteConfirmDescription"),
        description: (
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "flex size-9 shrink-0 items-center justify-center",
                "rounded-xl border border-destructive/25 bg-destructive/10 text-destructive",
              )}
            >
              <Trash2 className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">
                {basename(targetPath)}
              </div>
              <p className="mt-1.5 break-all text-xs leading-5 text-muted-foreground">
                {targetPath}
              </p>
            </div>
          </div>
        ),
        confirmLabel: t("projectTools.fileTree.delete"),
        cancelLabel: t("settings.cancel"),
        closeLabel: t("projectTools.fileTree.deleteConfirmClose"),
      });
      if (!confirmed) return;
      setBusyAction(true);
      setActionError(null);
      try {
        await deleteEntry(targetPath);
        setExpanded(removeExpandedSubtree(expandedRef.current, targetPath));
        selectPath(dirname(targetPath));
      } catch (error) {
        setActionError(hostAwareErrorMessage(error, t("projectTools.runtimeUnsupported")));
      } finally {
        setBusyAction(false);
      }
    },
    [busyAction, deleteEntry, requestConfirmDialog, selectPath, setExpanded, t],
  );

  const handleOpenExternal = useCallback(
    (path: string) => {
      setActionError(null);
      void openWorkspacePath(path, "open").catch((error: unknown) => {
        setActionError(hostAwareErrorMessage(error, t("projectTools.runtimeUnsupported")));
      });
    },
    [openWorkspacePath, t],
  );

  const handleOpenContainingDirectory = useCallback(
    (path: string) => {
      setActionError(null);
      void openWorkspacePath(path, "reveal").catch((error: unknown) => {
        setActionError(hostAwareErrorMessage(error, t("projectTools.runtimeUnsupported")));
      });
    },
    [openWorkspacePath, t],
  );

  const handleMenuRefresh = useCallback(
    (path: string, kind: FileTreeKind) => {
      void loadChildren(kind === "dir" ? path : dirname(path), { force: true });
    },
    [loadChildren],
  );

  const actionPlaceholder = useMemo(() => {
    if (pendingAction === "file") return t("projectTools.fileTree.newFilePlaceholder");
    if (pendingAction === "folder") return t("projectTools.fileTree.newFolderPlaceholder");
    if (pendingAction === "rename") return t("projectTools.fileTree.renamePlaceholder");
    return "";
  }, [pendingAction, t]);

  if (!initialized) {
    return (
      <div
        className={cn(
          "flex h-full min-h-0 flex-col items-center justify-center gap-4 px-6",
          "text-center",
        )}
      >
        <div className="flex size-12 items-center justify-center rounded-xl bg-muted/80">
          <FolderOpen className="size-6 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-1">
          <div className="text-sm font-medium text-foreground">{t("projectTools.newFileTree")}</div>
          <div className="text-xs text-muted-foreground">
            {t("projectTools.fileTreeDescription")}
          </div>
        </div>
        <Button
          size="sm"
          onClick={() => {
            onInitializedChange?.(true);
            void loadChildren(ROOT_PATH, { force: true });
          }}
        >
          {t("projectTools.newFileTree")}
        </Button>
      </div>
    );
  }

  const contextNode = contextMenu ? (nodes[contextMenu.path] ?? nodes[ROOT_PATH]) : null;
  const renderSearchEntry = (entry: FileTreeEntry) => {
    const TypeIcon = getFileTypeIcon(entry.path, entry.kind);
    return (
      <button
        key={`${entry.kind}:${entry.path}`}
        type="button"
        draggable
        className={cn(
          "flex w-full select-none items-center gap-1.5 rounded-md px-2",
          "text-left text-xs leading-5 text-muted-foreground hover:bg-muted hover:text-foreground",
          entry.hidden && "opacity-60 hover:opacity-80",
        )}
        style={{ minHeight: FILE_TREE_ROW_HEIGHT }}
        title={entry.path}
        onClick={() => void revealPath(entry.path, entry.kind)}
        onDragStart={(event) => handleWorkspacePathDragStart(event, entry.path, entry.kind)}
        onDragEnd={finishWorkspacePathDrag}
      >
        <TypeIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{entry.path}</span>
      </button>
    );
  };

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 select-none flex-col">
      {!integratedSearch && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t("projectTools.fileTree.searchPlaceholder")}
              className="h-8 pl-7 text-xs placeholder:text-xs"
            />
          </div>
          <RefreshButton
            aria-busy={Object.values(nodes).some((node) => node.loading)}
            variant="ghost"
            size="icon-sm"
            className="rounded-lg"
            title={t("projectTools.fileTree.refresh")}
            onClick={() => {
              void onRefreshExternalRoots?.();
              refreshVisible();
            }}
          >
            <RefreshCw data-refresh-icon className="size-4" />
          </RefreshButton>
        </div>
      )}

      {pendingAction ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
          <Input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void finishAction();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setPendingAction(null);
                setPendingTargetPath(null);
                setActionError(null);
              }
            }}
            placeholder={actionPlaceholder}
            className="h-8 text-xs placeholder:text-xs"
          />
          <Button
            size="icon-sm"
            variant="ghost"
            className="rounded-lg"
            disabled={busyAction}
            onClick={() => void finishAction()}
          >
            {busyAction ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            className="rounded-lg"
            onClick={() => {
              setPendingAction(null);
              setPendingTargetPath(null);
            }}
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <div className="shrink-0 border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {actionError}
        </div>
      ) : null}

      {!integratedSearch && query.trim() ? (
        <div className="project-file-tree-panel-scroll max-h-40 shrink-0 overflow-auto border-b border-border/60 p-2 web:pb-[max(var(--spacing-16px),env(safe-area-inset-bottom))] web:[scroll-padding-bottom:max(var(--spacing-16px),env(safe-area-inset-bottom))]">
          {searchNotice ? (
            <div className="px-2 py-1 text-xs">{searchNotice}</div>
          ) : (
            search.results.map(renderSearchEntry)
          )}
          {searchTruncated && <div className="px-2 pt-1 text-xs">{searchTruncated}</div>}
        </div>
      ) : null}

      <div
        role="tree"
        aria-label={integratedSearch ? t("projectTools.fileTreeTitle") : undefined}
        data-workspace-tree-scroll={integratedSearch ? "" : undefined}
        ref={scrollRef}
        className={cn(
          "project-file-tree-panel-scroll min-h-0 flex-1 select-none overflow-auto p-2 web:pb-[max(var(--spacing-16px),env(safe-area-inset-bottom))] web:[scroll-padding-bottom:max(var(--spacing-16px),env(safe-area-inset-bottom))]",
          integratedSearch && "isolate p-1",
        )}
        onKeyDown={integratedSearch ? onWorkspaceTreeKeyDown : undefined}
        onContextMenu={(event) => {
          if (integratedSearch && event.target instanceof Element) {
            const row = event.target.closest<HTMLElement>('[role="treeitem"]');
            if (row) {
              if (row.dataset.workspaceTreeSection === "files") openContextMenu(event, ROOT_PATH);
              return;
            }
          }
          openContextMenu(event, selectedPath || ROOT_PATH);
        }}
      >
        <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            let content: ReactNode;
            if (row.type === "error") {
              content = <FileTreeErrorRow depth={row.depth} message={row.message} />;
            } else if (row.type === "section") {
              content = row.content;
            } else if (row.type === "search") {
              const { entry } = row;
              content = (
                <FileTreeRow
                  path={entry.path}
                  name={basename(entry.path)}
                  kind={entry.kind}
                  hidden={entry.hidden}
                  depth={row.depth}
                  expanded={row.expanded}
                  selected={Boolean(
                    workspaceSections?.filesSelected && syncState.selectedPath === entry.path,
                  )}
                  loading={false}
                  title={entry.path}
                  onToggle={(path, expanded) =>
                    setSearchExpansion((current) => {
                      const collapsed = new Set(
                        current?.scope === searchScope ? current.collapsed : undefined,
                      );
                      if (expanded) collapsed.add(path);
                      else collapsed.delete(path);
                      return { scope: searchScope, collapsed };
                    })
                  }
                  onSelect={entry.kind === "file" ? selectPath : () => {}}
                  onOpen={handleOpenFile}
                  transientFiles
                  sectioned
                  onDragStart={handleWorkspacePathDragStart}
                  onDragEnd={finishWorkspacePathDrag}
                />
              );
            } else {
              const node = nodes[row.path];
              if (!node) return null;
              content = (
                <FileTreeRow
                  path={node.path}
                  name={node.name}
                  kind={node.kind}
                  hidden={node.hidden}
                  depth={row.depth}
                  expanded={expandedSet.has(row.path)}
                  selected={
                    (!workspaceSections || workspaceSections.filesSelected) &&
                    selectedPath === row.path
                  }
                  loading={node.loading}
                  title={getDisplayPath(row.path)}
                  onToggle={toggleDirectory}
                  onSelect={selectPath}
                  onOpen={handleOpenFile}
                  transientFiles={integratedSearch}
                  sectioned={integratedSearch}
                  onContextMenu={openContextMenu}
                  onDragStart={handleWorkspacePathDragStart}
                  onDragEnd={finishWorkspacePathDrag}
                />
              );
            }
            const endIndex = stickyIndex?.ends[virtualRow.index];
            const inset = (stickyIndex?.depths[virtualRow.index] ?? 0) * FILE_TREE_ROW_HEIGHT;
            const sticky =
              endIndex !== undefined &&
              endIndex > virtualRow.index + 1 &&
              inset + 2 * FILE_TREE_ROW_HEIGHT <= (rowVirtualizer.scrollRect?.height ?? Infinity);
            const subtreeEnd = sticky
              ? (rowVirtualizer.measurementsCache?.[endIndex]?.start ??
                rowVirtualizer.getTotalSize())
              : undefined;
            // Keep the original row inside its subtree's physical range. Sticky positioning
            // follows the scroll container on the compositor, independently of React renders.
            return (
              <div
                key={row.key}
                className="pointer-events-none absolute left-0 w-full"
                style={{
                  top: virtualRow.start,
                  height: subtreeEnd === undefined ? undefined : subtreeEnd - virtualRow.start,
                  zIndex: sticky ? 100 - inset / FILE_TREE_ROW_HEIGHT : undefined,
                }}
              >
                <div
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  data-workspace-tree-sticky-folder={sticky ? "" : undefined}
                  className={
                    sticky ? "pointer-events-auto sticky bg-background" : "pointer-events-auto"
                  }
                  style={sticky ? { top: inset } : undefined}
                >
                  {content}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {contextMenu && contextNode ? (
        <FileTreeContextMenu
          key={`${contextMenu.path}:${contextMenu.x}:${contextMenu.y}`}
          anchor={{ x: contextMenu.x, y: contextMenu.y }}
          containerRef={panelRef}
          path={contextNode.path}
          displayPath={
            isExternalPath(contextNode.path) ? getDisplayPath(contextNode.path) : undefined
          }
          kind={contextNode.kind}
          canMutate={canMutate && !isExternalPath(contextNode.path)}
          canOpenFile={Boolean(onOpenFile) && !isExternalPath(contextNode.path)}
          canInsertMention={Boolean(onInsertFileMention) && !isExternalPath(contextNode.path)}
          showHidden={syncState.showHidden}
          onClose={() => setContextMenu(null)}
          onOpenFile={handleOpenFile}
          onOpenExternal={handleOpenExternal}
          onOpenContainingDirectory={handleOpenContainingDirectory}
          onStartAction={startAction}
          onDelete={(path) => void deletePath(path)}
          onInsertMention={handleInsertMention}
          onRefresh={handleMenuRefresh}
          onToggleHidden={() => emitState({ showHidden: !syncState.showHidden })}
          onActionError={setActionError}
        />
      ) : null}

      {confirmDialog}
    </div>
  );
}
