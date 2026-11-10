import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale } from "../../i18n";
import type { GitCommitFile, GitRepositoryState, GitStatusEntry } from "../../lib/git/types";
import { hostAwareErrorMessage } from "../../lib/shared/hostErrors";
import { cn } from "../../lib/shared/utils";
import { useWorkspaceInvalidation } from "../../lib/workspace-activity/useWorkspaceInvalidation";
import { ChevronRight, List, Loader2, Search, X } from "../IconSet";
import { Input } from "../ui/input";
import { FileTreePanel, type FileTreeSectionRow } from "./file-tree";
import { FILE_TREE_ROW_HEIGHT } from "./file-tree/model";
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
  groups: { changes: boolean; files: boolean };
  comparison?: WorkspaceGitComparison;
  conversationId?: string;
  onToggleGroup: (group: "changes" | "files") => void;
  onOpenReview: () => void;
  onOpenDiff: (path: string, temporary?: boolean) => void;
};

type ChangeNode = {
  name: string;
  children: Map<string, ChangeNode>;
  file?: { status: string; absolutePath: string; relativePath: string };
};

function GitChangeIndicator({ status }: { status: string }) {
  const deleted = status === "D";
  const added = status === "A" || status === "U" || status === "C";
  return (
    <svg
      aria-hidden="true"
      data-workspace-file-decoration={status}
      className={cn(
        "size-5 shrink-0",
        deleted ? "text-rose-500" : added ? "text-emerald-500" : "text-sky-500",
      )}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    >
      <rect x="3.35" y="3.35" width="13.3" height="13.3" rx="3.2" />
      {deleted || added ? (
        <path d={added ? "M10 7v6M7 10h6" : "M7 10h6"} />
      ) : (
        <circle cx="10" cy="10" r="1.65" fill="currentColor" stroke="none" />
      )}
    </svg>
  );
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
  const fallback = (entry: GitStatusEntry) => ({ path: entry.path, status: statusLabel(entry) });
  for (const entry of entries ?? state.entries.map(fallback)) {
    const absolutePath = workspaceGitPathFromRoot(state.repoRoot, entry.path);
    if (!absolutePath) continue;
    const relativePath = workspaceGitRelativePath(cwd, absolutePath);
    if (!relativePath?.toLowerCase().includes(term)) continue;
    let children = tree;
    const parts = relativePath.split("/");
    for (const [index, name] of parts.entries()) {
      let node = children.get(name);
      if (!node) {
        node = { name, children: new Map() };
        children.set(name, node);
      }
      if (index === parts.length - 1)
        node.file = { status: entry.status, absolutePath, relativePath };
      children = node.children;
    }
  }
  return tree;
}

function changeRows(
  changes: Map<string, ChangeNode>,
  selectedPath: string | null,
  collapsedDirectories: ReadonlySet<string>,
  onToggle: (path: string, expanded: boolean) => void,
  onOpen: (file: NonNullable<ChangeNode["file"]>, temporary?: boolean) => void,
) {
  const rows: FileTreeSectionRow[] = [];
  const visit = (nodes: Map<string, ChangeNode>, parent: string, depth: number) => {
    const sorted = [...nodes.values()].sort(
      (a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name),
    );
    for (const node of sorted) {
      const file = node.file;
      const relativePath = parent ? `${parent}/${node.name}` : node.name;
      const expanded = !collapsedDirectories.has(relativePath);
      rows.push({
        type: "section",
        key: `\0changed:${relativePath}`,
        level: depth + 1,
        content: (
          <FileTreeRow
            path={relativePath}
            name={node.name}
            kind={file ? "file" : "dir"}
            hidden={false}
            depth={depth}
            expanded={expanded}
            selected={selectedPath === relativePath}
            loading={false}
            title={relativePath}
            onToggle={onToggle}
            onSelect={() => {}}
            onOpen={(_, temporary) => file && onOpen(file, temporary)}
            transientFiles
            sectioned
            decoration={file && <GitChangeIndicator status={file.status} />}
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
  groups,
  comparison,
  conversationId,
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
    cwd: string;
    comparison?: WorkspaceGitComparison;
    conversationId?: string;
    state: GitRepositoryState | null;
    entries?: GitCommitFile[];
    error?: string;
  }>();
  const refresh = () => setVersion((current) => current + 1);

  useWorkspaceInvalidation({
    client: canReadGit ? workspaceActivity : null,
    workdir: cwd,
    active,
    onInvalidate: ({ fs, git: changed }) => {
      if (fs || changed) refresh();
    },
  });

  useEffect(() => {
    void version;
    void turnRevision;
    if (!canReadGit || !active || !git) return;
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
            entries =
              diff?.changes ??
              diff?.files?.map((path) => ({ path, status: "M", kind: "modified" })) ??
              [];
          }
          if (!disposed)
            setStatus({
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
  }, [active, canReadGit, comparison, conversationId, cwd, git, locale, t, turnRevision, version]);

  const currentStatus =
    canReadGit &&
    status?.cwd === cwd &&
    status.comparison === comparison &&
    status.conversationId === conversationId
      ? status
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
    content: (
      <button
        type="button"
        role="treeitem"
        aria-level={1}
        aria-expanded={expanded}
        data-workspace-tree-section={section}
        className={cn(
          "flex w-full items-center gap-[5px] rounded-md px-[3px] text-left text-foreground hover:bg-muted",
          section === "files" && showChanges && "border-t border-border",
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
        {section === "changes" && !expanded && changes.size > 0 && (
          <span aria-hidden="true" className="mr-1 size-1.5 shrink-0 rounded-full bg-sky-500/65" />
        )}
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
          selectedSection === "changes" ? fileTree.state.selectedPath : null,
          collapsedDirectories,
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
            onClick={refresh}
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
  changeSectionRows.push(sectionRow("files", filesOpen));

  return (
    <aside
      aria-label={t("projectTools.fileTreeTitle")}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background text-[13px]"
    >
      <div className="relative m-1.5 shrink-0">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
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
      {showChanges && (
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
          active={active && filesOpen}
          workspaceSections={{
            rows: changeSectionRows,
            filesExpanded: filesOpen,
            filesSelected: selectedSection === "files",
            onSelectFile: selectFileSection,
          }}
        />
      </div>
    </aside>
  );
}
