import { useEffect, useMemo, useState } from "react";
import { useLocale } from "../../i18n";
import type { GitCommitFile, GitRepositoryState, GitStatusEntry } from "../../lib/git/types";
import { hostAwareErrorMessage } from "../../lib/shared/hostErrors";
import { cn } from "../../lib/shared/utils";
import { useWorkspaceInvalidation } from "../../lib/workspace-activity/useWorkspaceInvalidation";
import { getFileTypeIcon } from "../chat/fileTypeIcons";
import { ChevronRight, List, Loader2, Search, X } from "../IconSet";
import { Input } from "../ui/input";
import { FileTreePanel } from "./file-tree";
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

function ChangeRows({
  nodes,
  selectedPath,
  onSelect,
}: {
  nodes: Map<string, ChangeNode>;
  selectedPath: string;
  onSelect: (file: NonNullable<ChangeNode["file"]>, temporary: boolean) => void;
}) {
  const sorted = [...nodes.values()].sort(
    (a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name),
  );
  return sorted.map((node) => {
    const file = node.file;
    const Icon = getFileTypeIcon(node.name, file ? "file" : "dir");
    if (file) {
      const selected = selectedPath === file.relativePath;
      return (
        <button
          key={node.name}
          type="button"
          aria-current={selected || undefined}
          title={file.relativePath}
          className={cn(
            "flex h-6 w-full min-w-0 items-center gap-1.5 rounded px-2 pl-5 text-left hover:bg-muted focus-visible:outline-ring",
            selected && "bg-muted text-foreground",
          )}
          onClick={(event) => {
            if (event.detail < 2) onSelect(file, event.detail === 1);
          }}
          onDoubleClick={() => onSelect(file, false)}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          <span
            aria-hidden="true"
            data-workspace-file-decoration={file.status}
            className={cn(
              "mr-0.5 size-2 shrink-0 rounded-sm border border-current",
              file.status === "D"
                ? "text-rose-500"
                : file.status === "A" || file.status === "U" || file.status === "C"
                  ? "text-emerald-500"
                  : "text-sky-500",
            )}
          />
        </button>
      );
    }
    return (
      <details key={node.name} className="group/change-dir" open>
        <summary className="flex h-6 cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 hover:bg-muted [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3 shrink-0 group-open/change-dir:rotate-90" />
          <Icon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{node.name}</span>
        </summary>
        <div className="ml-3 border-l border-border/60">
          <ChangeRows nodes={node.children} selectedPath={selectedPath} onSelect={onSelect} />
        </div>
      </details>
    );
  });
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
  const disclosureClass =
    "flex h-7 w-full shrink-0 items-center gap-1.5 rounded-md px-1.5 text-left text-muted-foreground hover:bg-muted hover:text-foreground";

  return (
    <aside
      aria-label={t("projectTools.fileTreeTitle")}
      className="flex h-full min-h-0 min-w-0 flex-col bg-background px-1.5 text-xs"
    >
      <div className="relative my-1.5 shrink-0">
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
      {canReadGit && currentStatus?.state?.status !== "not_repo" && (
        <>
          <button
            type="button"
            className="flex h-7 shrink-0 items-center gap-2 rounded-md px-1.5 text-left hover:bg-muted"
            onClick={onOpenReview}
          >
            <List className="size-3.5 shrink-0" />
            {labels.review}
          </button>
          <button
            type="button"
            aria-expanded={changesOpen}
            className={disclosureClass}
            onClick={() => onToggleGroup("changes")}
          >
            <ChevronRight className={cn("size-3 shrink-0", changesOpen && "rotate-90")} />
            {labels.changed}
          </button>
          <div
            hidden={!changesOpen}
            className={cn("min-h-0 overflow-auto", filesOpen ? "max-h-[44%] shrink-0" : "flex-1")}
          >
            {!currentStatus ? (
              <div role="status" className="px-5 py-1 text-muted-foreground">
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                <span className="sr-only">{t("projectTools.loading")}</span>
              </div>
            ) : currentStatus.error ? (
              <button
                type="button"
                className="px-5 py-1 text-left text-destructive hover:underline"
                title={t("projectTools.fileTree.refresh")}
                onClick={refresh}
              >
                {currentStatus.error}
              </button>
            ) : changes.size ? (
              <ChangeRows
                nodes={changes}
                selectedPath={fileTree.state.selectedPath}
                onSelect={(file, temporary) => {
                  fileTree.onStateChange({ selectedPath: file.relativePath });
                  onOpenDiff(file.absolutePath, temporary);
                }}
              />
            ) : (
              <div className="px-5 py-1 text-muted-foreground">
                {t(
                  query.trim()
                    ? "projectTools.fileTree.noMatches"
                    : "projectTools.gitReview.noLocalChanges",
                )}
              </div>
            )}
          </div>
        </>
      )}
      <button
        type="button"
        aria-expanded={filesOpen}
        className={disclosureClass}
        onClick={() => onToggleGroup("files")}
      >
        <ChevronRight className={cn("size-3 shrink-0", filesOpen && "rotate-90")} />
        {labels.all}
      </button>
      <div hidden={!filesOpen} className="min-h-0 flex-1">
        <FileTreePanel active={active && filesOpen} integratedSearch />
      </div>
    </aside>
  );
}
