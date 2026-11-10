import { type Ref, useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "../../i18n";
import type { GitCommitFile, GitDiffResponse, GitRepositoryState } from "../../lib/git/types";
import { hostAwareErrorMessage } from "../../lib/shared/hostErrors";
import { cn } from "../../lib/shared/utils";
import { useWorkspaceInvalidation } from "../../lib/workspace-activity/useWorkspaceInvalidation";
import { ChevronRight, List, Loader2, Search, X } from "../IconSet";
import { Input } from "../ui/input";
import { FileTreePanel, type FileTreeSectionRow } from "./file-tree";
import { compareWorkspaceReviewPaths, FILE_TREE_ROW_HEIGHT } from "./file-tree/model";
import { FileTreeRow } from "./file-tree/Row";
import { statusLabel } from "./git-review/model";
import { useRightDockToolContext } from "./RightDockContext";
import {
  loadWorkspaceGitComparison,
  type WorkspaceGitComparison,
  workspaceGitPathFromRoot,
  workspaceGitRelativePath,
} from "./workspaceGitPaths";
import { useWorkspaceGitTurnRevision } from "./workspaceGitReviewState";

type Props = {
  active: boolean;
  reviewOnly?: boolean;
  filterInputRef?: Ref<HTMLInputElement>;
  groups: { changes: boolean; files: boolean };
  comparison?: WorkspaceGitComparison;
  conversationId?: string;
  activeReviewPath?: string;
  reviewRepository?: GitRepositoryState | null;
  reviewDiff?: GitDiffResponse;
  reviewLoading?: boolean;
  reviewError?: string;
  onRetryReview?: () => void;
  onToggleGroup: (group: "changes" | "files") => void;
  onOpenReview: () => void;
  onOpenDiff: (path: string, temporary?: boolean) => void;
};

type ChangeNode = {
  name: string;
  children: Map<string, ChangeNode>;
  file?: GitCommitFile & { absolutePath: string; relativePath: string };
};

function changeTone(file: NonNullable<ChangeNode["file"]>) {
  const status = file.status.charAt(0);
  if (file.kind === "deleted" || status === "D") return "deleted";
  if (
    file.kind === "added" ||
    file.kind === "untracked" ||
    file.kind === "copied" ||
    status === "A" ||
    status === "C"
  )
    return "added";
  return "modified";
}

function GitChangeIndicator({
  status,
  tone,
}: {
  status: string;
  tone: ReturnType<typeof changeTone>;
}) {
  return (
    <svg
      aria-hidden="true"
      data-workspace-file-decoration={status}
      className="za-workspace-tree-change-indicator size-5 shrink-0"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    >
      <rect x="3.35" y="3.35" width="13.3" height="13.3" rx="3.2" />
      {tone !== "modified" ? (
        <path d={tone === "added" ? "M10 6.4v7.2M6.4 10h7.2" : "M6.4 10h7.2"} />
      ) : (
        <circle cx="10" cy="10" r="1.65" fill="currentColor" stroke="none" />
      )}
    </svg>
  );
}

function GitDirectoryIndicator() {
  return (
    <span
      aria-hidden="true"
      className="za-workspace-tree-change-indicator flex w-5 shrink-0 justify-center"
    >
      <span className="size-1.5 rounded-full bg-current opacity-50" />
    </span>
  );
}

function comparisonFiles(diff: GitDiffResponse | null | undefined) {
  return diff?.changes ?? diff?.files?.map((path) => ({ path, status: "M", kind: "modified" }));
}

function changedFilesTree(
  state: GitRepositoryState | null,
  entries: readonly GitCommitFile[] | undefined,
  cwd: string,
  query: string,
) {
  const tree = new Map<string, ChangeNode>();
  if (!state || state.status !== "ready") return tree;
  const term = query.trim().toLowerCase();
  const files =
    entries ??
    state.entries.map((entry) => ({
      path: entry.path,
      status: statusLabel(entry),
      kind: entry.kind,
    }));
  for (const entry of files) {
    const absolutePath = workspaceGitPathFromRoot(state.repoRoot, entry.path);
    if (!absolutePath) continue;
    const relativePath = workspaceGitRelativePath(cwd, absolutePath);
    if (!relativePath?.toLowerCase().includes(term)) continue;
    let children = tree;
    const parts = relativePath.split("/");
    for (const [index, name] of parts.entries()) {
      const isFile = index === parts.length - 1;
      const key = isFile ? name : `${name}/`;
      let node = children.get(key);
      if (!node) {
        node = { name, children: new Map() };
        children.set(key, node);
      }
      if (isFile) node.file = { ...entry, absolutePath, relativePath };
      children = node.children;
    }
  }
  return tree;
}

function changeRows(
  changes: Map<string, ChangeNode>,
  selectedPath: string | null,
  collapsedDirectories: ReadonlySet<string>,
  formatNumber: Intl.NumberFormat,
  onToggle: (path: string, expanded: boolean) => void,
  onOpen: (file: NonNullable<ChangeNode["file"]>, temporary?: boolean) => void,
) {
  const rows: FileTreeSectionRow[] = [];
  const visit = (nodes: Map<string, ChangeNode>, parent: string, depth: number) => {
    const sorted = [...nodes.values()].sort(
      (a, b) =>
        Number(Boolean(a.file)) - Number(Boolean(b.file)) ||
        compareWorkspaceReviewPaths(a.name, b.name),
    );
    for (const node of sorted) {
      const file = node.file;
      const relativePath = parent ? `${parent}/${node.name}` : node.name;
      const expanded = !collapsedDirectories.has(relativePath);
      const tone = file ? changeTone(file) : "directory";
      const additions = file?.additions ?? 0;
      const deletions = file?.deletions ?? 0;
      rows.push({
        type: "section",
        key: `\0changed:${relativePath}${file ? "" : "/"}`,
        level: depth + 1,
        stickyFolder: !file && expanded,
        content: (
          <FileTreeRow
            path={relativePath}
            name={node.name}
            kind={file ? "file" : "dir"}
            hidden={false}
            depth={depth}
            expanded={expanded}
            selected={Boolean(file) && selectedPath === relativePath}
            loading={false}
            title={relativePath}
            onToggle={onToggle}
            onSelect={() => {}}
            onOpen={(_, temporary) => file && onOpen(file, temporary)}
            transientFiles
            sectioned
            changeTone={tone}
            decoration={
              file && tone !== "directory" ? (
                <>
                  {(additions > 0 || deletions > 0) && (
                    <span dir="ltr" className="za-workspace-tree-change-counts">
                      {additions > 0 && (
                        <span data-added="">+{formatNumber.format(additions)}</span>
                      )}
                      {deletions > 0 && (
                        <span data-deleted="">-{formatNumber.format(deletions)}</span>
                      )}
                    </span>
                  )}
                  <GitChangeIndicator status={file.status} tone={tone} />
                </>
              ) : (
                <GitDirectoryIndicator />
              )
            }
          />
        ),
      });
      if (!file && expanded) visit(node.children, relativePath, depth + 1);
    }
  };
  visit(changes, "", 1);
  return rows;
}

export function RightWorkspaceFileTree({
  active,
  reviewOnly = false,
  filterInputRef,
  groups,
  comparison,
  conversationId,
  activeReviewPath,
  reviewRepository,
  reviewDiff,
  reviewLoading,
  reviewError,
  onRetryReview,
  onToggleGroup,
  onOpenReview,
  onOpenDiff,
}: Props) {
  const { t, locale } = useLocale();
  const { cwd, fileTree, clients, capabilities } = useRightDockToolContext();
  const { git, workspaceActivity } = clients;
  const canReadGit = Boolean(
    git && cwd && capabilities.projectReady && !capabilities.gitDisabledMessage,
  );
  const { changes: changesOpen, files: filesOpen } = groups;
  const shareReviewDiff = reviewOnly && reviewRepository !== undefined;
  const formatNumber = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const [version, setVersion] = useState(0);
  const [selectedSection, setSelectedSection] = useState<"changes" | "files">("changes");
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const selectFileSection = useCallback(() => setSelectedSection("files"), []);
  const turnRevision = useWorkspaceGitTurnRevision(
    comparison === "last-turn" ? conversationId : undefined,
  );
  const [status, setStatus] = useState<{
    client: typeof git;
    cwd: string;
    comparison?: WorkspaceGitComparison;
    conversationId?: string;
    state: GitRepositoryState | null;
    entries?: GitCommitFile[];
    error?: string;
  }>();
  const refresh = () => setVersion((current) => current + 1);

  useWorkspaceInvalidation({
    client: canReadGit && !shareReviewDiff ? workspaceActivity : null,
    workdir: cwd,
    active,
    onInvalidate: ({ fs, git: changed }) => {
      if (fs || changed) refresh();
    },
  });

  useEffect(() => {
    void version;
    void turnRevision;
    if (!canReadGit || !active || !git || shareReviewDiff) return;
    let disposed = false;
    // Coalesce worktree activity during a sequence of filesystem writes.
    const timer = window.setTimeout(() => {
      void git
        .status(cwd)
        .then(async (state) => {
          if (disposed) return;
          let entries: GitCommitFile[] | undefined;
          if (comparison && state.status === "ready") {
            const diff = await loadWorkspaceGitComparison(
              git,
              state,
              cwd,
              comparison,
              undefined,
              conversationId,
            );
            entries = comparisonFiles(diff) ?? [];
          }
          if (!disposed)
            setStatus({
              client: git,
              cwd,
              comparison,
              conversationId,
              state,
              entries,
              error: state.error || undefined,
            });
        })
        .catch((error: unknown) => {
          if (!disposed)
            setStatus({
              client: git,
              cwd,
              comparison,
              conversationId,
              state: null,
              error:
                comparison === "last-turn"
                  ? locale === "zh-CN"
                    ? "上一轮没有可用的工作区快照。"
                    : "The last turn has no complete workspace snapshot."
                  : hostAwareErrorMessage(error, t("projectTools.runtimeUnsupported")),
            });
        });
    }, 100);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [
    active,
    canReadGit,
    comparison,
    conversationId,
    cwd,
    git,
    locale,
    shareReviewDiff,
    t,
    turnRevision,
    version,
  ]);

  const ownStatus =
    canReadGit &&
    status?.client === git &&
    status?.cwd === cwd &&
    status.comparison === comparison &&
    status.conversationId === conversationId
      ? status
      : null;
  const reviewEntries = useMemo(() => comparisonFiles(reviewDiff) ?? [], [reviewDiff]);
  const currentStatus = shareReviewDiff
    ? reviewLoading && !reviewDiff
      ? null
      : { state: reviewRepository ?? null, entries: reviewEntries, error: reviewError }
    : ownStatus;
  const activeReviewAbsolutePath =
    reviewRepository && activeReviewPath
      ? workspaceGitPathFromRoot(reviewRepository.repoRoot, activeReviewPath)
      : null;
  const selectedPath = activeReviewAbsolutePath
    ? workspaceGitRelativePath(cwd, activeReviewAbsolutePath)
    : selectedSection === "changes"
      ? fileTree.state.selectedPath
      : null;
  const query = fileTree.state.query;
  const changes = useMemo(
    () => changedFilesTree(currentStatus?.state ?? null, currentStatus?.entries, cwd, query),
    [currentStatus?.entries, currentStatus?.state, cwd, query],
  );
  const labels =
    locale === "zh-CN"
      ? {
          filter: "筛选文件",
          clear: "清除文件筛选",
          review: "所有更改",
          changed: "已更改的文件",
          all: "所有文件",
        }
      : {
          filter: "Filter files",
          clear: "Clear file filter",
          review: "All changes",
          changed: "Changed files",
          all: "All files",
        };
  const showChanges = canReadGit && currentStatus?.state?.status !== "not_repo";
  const sectionRow = (section: "changes" | "files", expanded: boolean): FileTreeSectionRow => ({
    type: "section",
    key: `\0section:${section}`,
    level: 1,
    stickyFolder: expanded,
    content: (
      <button
        type="button"
        role="treeitem"
        aria-level={1}
        aria-expanded={expanded}
        data-workspace-tree-section={section}
        data-workspace-change-tone={section === "changes" ? "directory" : undefined}
        className={cn(
          "flex w-full items-center gap-[5px] rounded-md px-[3px] text-left text-foreground hover:bg-muted",
        )}
        style={{ height: FILE_TREE_ROW_HEIGHT }}
        onClick={() => onToggleGroup(section)}
      >
        <ChevronRight
          className={cn("size-4 shrink-0 text-muted-foreground", expanded && "rotate-90")}
        />
        <span className="min-w-0 flex-1 truncate">
          {section === "changes" ? labels.changed : labels.all}
        </span>
        {section === "changes" && changes.size > 0 && <GitDirectoryIndicator />}
      </button>
    ),
  });
  const changeSectionRows: FileTreeSectionRow[] = [];
  if (showChanges) {
    changeSectionRows.push(sectionRow("changes", changesOpen));
    if (changesOpen && currentStatus && !currentStatus.error && changes.size > 0) {
      changeSectionRows.push(
        ...changeRows(
          changes,
          selectedPath,
          collapsedDirectories,
          formatNumber,
          (path, expanded) =>
            setCollapsedDirectories((current) => {
              const next = new Set(current);
              if (expanded) next.add(path);
              else next.delete(path);
              return next;
            }),
          (file, temporary = false) => {
            setSelectedSection("changes");
            fileTree.onStateChange({ selectedPath: file.relativePath });
            onOpenDiff(file.absolutePath, temporary);
          },
        ),
      );
    } else if (changesOpen) {
      changeSectionRows.push({
        type: "section",
        key: "\0changed-notice",
        level: currentStatus?.error ? 2 : undefined,
        content: !currentStatus ? (
          <div role="status" className="px-5 py-1 text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            <span className="sr-only">{t("projectTools.loading")}</span>
          </div>
        ) : currentStatus.error ? (
          <button
            type="button"
            role="treeitem"
            aria-level={2}
            className="px-5 py-1 text-left text-destructive hover:underline"
            title={t("projectTools.fileTree.refresh")}
            onClick={shareReviewDiff ? onRetryReview : refresh}
          >
            {currentStatus.error}
          </button>
        ) : (
          <div className="px-5 py-1 text-muted-foreground">
            {t(
              query.trim()
                ? "projectTools.fileTree.noMatches"
                : "projectTools.gitReview.noLocalChanges",
            )}
          </div>
        ),
      });
    }
  }
  if (!reviewOnly) changeSectionRows.push(sectionRow("files", filesOpen));

  return (
    <aside
      aria-label={t("projectTools.fileTreeTitle")}
      data-workspace-review-tree={reviewOnly || undefined}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background text-[13px]"
    >
      <div className="relative m-1.5 shrink-0">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={filterInputRef}
          aria-label={labels.filter}
          placeholder={`${labels.filter}…`}
          value={query}
          className="h-7 rounded-full pl-8 pr-7 text-xs placeholder:text-xs"
          onChange={(event) => fileTree.onStateChange({ query: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !query) return;
            event.preventDefault();
            event.stopPropagation();
            fileTree.onStateChange({ query: "" });
          }}
        />
        {query && (
          <button
            type="button"
            aria-label={labels.clear}
            className="absolute inset-y-0 right-1 flex w-6 items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={() => fileTree.onStateChange({ query: "" })}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {showChanges && !reviewOnly && (
        <button
          type="button"
          className="mx-1 flex h-7 shrink-0 items-center gap-[5px] rounded-md px-[3px] text-left hover:bg-muted"
          onClick={onOpenReview}
        >
          <List className="size-4 shrink-0" />
          {labels.review}
        </button>
      )}
      <div className="min-h-0 flex-1">
        <FileTreePanel
          active={active && !reviewOnly && filesOpen}
          workspaceSections={{
            rows: changeSectionRows,
            filesExpanded: !reviewOnly && filesOpen,
            filesSelected: selectedSection === "files",
            onSelectFile: selectFileSection,
          }}
        />
      </div>
    </aside>
  );
}
