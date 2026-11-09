import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useLocale } from "../../i18n";
import type {
  GitBranchesResponse,
  GitClient,
  GitCommitSummary,
  GitDiffResponse,
} from "../../lib/git/types";
import { hostAwareErrorMessage } from "../../lib/shared/hostErrors";
import type { WorkspaceActivityClient } from "../../lib/workspace-activity/types";
import { useWorkspaceInvalidation } from "../../lib/workspace-activity/useWorkspaceInvalidation";
import { ChevronDown, ChevronRight, Columns2, List, Loader2 } from "../IconSet";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { DiffContent } from "./git-review/DiffView";
import type { RightDockGitContext } from "./RightDockContext";
import {
  isWorkspaceGitBaseBranch,
  loadWorkspaceGitComparison,
  type WorkspaceGitComparison,
  workspaceGitCommit,
  workspaceGitPathFromRoot,
  workspaceGitRelativePath,
} from "./workspaceGitPaths";
import {
  useWorkspaceGitPresentation,
  useWorkspaceGitTurnRevision,
} from "./workspaceGitReviewState";

const comparisons = ["branch", "working_tree", "unstaged", "staged"] as const;

function comparisonName(locale: string, comparison: WorkspaceGitComparison) {
  if (isWorkspaceGitBaseBranch(comparison)) comparison = "branch";
  if (locale === "zh-CN") {
    switch (comparison) {
      case "branch":
        return "当前分支";
      case "last-turn":
        return "上一轮";
      case "working_tree":
        return "未提交";
      case "unstaged":
        return "未暂存";
      case "staged":
        return "已暂存";
      default:
        return "提交";
    }
  }
  switch (comparison) {
    case "branch":
      return "This branch";
    case "last-turn":
      return "Last turn";
    case "working_tree":
      return "Uncommitted";
    case "unstaged":
      return "Unstaged";
    case "staged":
      return "Staged";
    default:
      return "Commit";
  }
}

type ComparisonMenuProps = {
  client: GitClient;
  workdir: string;
  comparison: WorkspaceGitComparison;
  conversationId?: string;
  onComparisonChange: (comparison: WorkspaceGitComparison) => void;
};

function WorkspaceGitBranchOptions({
  client,
  workdir,
  comparison,
  onComparisonChange,
}: ComparisonMenuProps) {
  const { t, locale } = useLocale();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{
    workdir: string;
    response?: GitBranchesResponse;
    error?: string;
  }>();
  useEffect(() => {
    if (!open) return;
    let active = true;
    void client.branches(workdir).then(
      (response) => {
        if (active) setResult({ workdir, response });
      },
      (error: unknown) => {
        if (active)
          setResult({
            workdir,
            error: hostAwareErrorMessage(error, t("projectTools.runtimeUnsupported")),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client, open, t, workdir]);
  const current = result?.workdir === workdir ? result : undefined;
  const branches = current?.response?.branches.filter(
    (branch) => !branch.current && !/^refs\/remotes\/[^/]+\/HEAD$/.test(branch.fullName),
  );
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger className="flex items-center gap-2">
        {zh ? "分支比较" : "Branch comparison"}
        <ChevronRight className="ml-auto size-3.5" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 min-w-48 overflow-y-auto">
        <DropdownMenuRadioGroup value={comparison}>
          <DropdownMenuRadioItem value="branch" onSelect={() => onComparisonChange("branch")}>
            {zh ? "默认基线" : "Default base"}
          </DropdownMenuRadioItem>
          {current?.response?.state.head && (
            <DropdownMenuItem disabled>
              {zh ? "当前分支" : "Current branch"} · {current.response.state.head}
            </DropdownMenuItem>
          )}
          {branches?.map((branch) => (
            <DropdownMenuRadioItem
              key={branch.fullName}
              value={`branch:${branch.fullName}`}
              onSelect={() => onComparisonChange(`branch:${branch.fullName}`)}
            >
              <span className="max-w-56 truncate" title={branch.name}>
                {branch.name}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {!current && (
          <DropdownMenuItem disabled>
            <Loader2 className="mr-2 size-3.5 animate-spin" />
            {t("projectTools.loading")}
          </DropdownMenuItem>
        )}
        {current?.error && <DropdownMenuItem disabled>{current.error}</DropdownMenuItem>}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function WorkspaceGitComparisonMenu({
  client,
  workdir,
  comparison,
  conversationId,
  onComparisonChange,
}: ComparisonMenuProps) {
  const { locale, t } = useLocale();
  const zh = locale === "zh-CN";
  const [commitsOpen, setCommitsOpen] = useState(false);
  const [commits, setCommits] = useState<{
    workdir: string;
    rows: GitCommitSummary[];
    error?: string;
  }>();
  const current = commits?.workdir === workdir ? commits : null;
  useEffect(() => {
    if (!commitsOpen) return;
    let active = true;
    void client.log(workdir, { limit: 32 }).then(
      (log) => {
        if (active) setCommits({ workdir, rows: log.commits });
      },
      (error: unknown) => {
        if (active)
          setCommits({
            workdir,
            rows: [],
            error: hostAwareErrorMessage(error, t("projectTools.runtimeUnsupported")),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [client, commitsOpen, t, workdir]);

  const sha = workspaceGitCommit(comparison);
  const baseBranch = isWorkspaceGitBaseBranch(comparison)
    ? comparison.slice("branch:".length).replace(/^refs\/(?:heads|remotes)\//, "")
    : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        title={sha ?? baseBranch ?? undefined}
        aria-label={zh ? "比较范围" : "Comparison source"}
        className="flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium hover:bg-muted focus-visible:outline-ring"
      >
        {comparisonName(locale, comparison)}
        {sha && (
          <span className="font-mono font-normal text-muted-foreground">{sha.slice(0, 7)}</span>
        )}
        {baseBranch && (
          <span className="max-w-24 truncate font-normal text-muted-foreground">{baseBranch}</span>
        )}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuRadioGroup value={baseBranch ? "branch" : comparison}>
          {conversationId && client.lastTurnDiff && (
            <DropdownMenuRadioItem
              value="last-turn"
              onSelect={() => onComparisonChange("last-turn")}
            >
              {comparisonName(locale, "last-turn")}
            </DropdownMenuRadioItem>
          )}
          {comparisons.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              onSelect={() =>
                onComparisonChange(option === "branch" && baseBranch ? comparison : option)
              }
            >
              {comparisonName(locale, option)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <WorkspaceGitBranchOptions
          client={client}
          workdir={workdir}
          comparison={comparison}
          onComparisonChange={onComparisonChange}
        />
        <DropdownMenuSub open={commitsOpen} onOpenChange={setCommitsOpen}>
          <DropdownMenuSubTrigger className="flex items-center gap-2">
            {zh ? "提交记录" : "Commits"}
            <ChevronRight className="ml-auto size-3.5" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">
            {!current ? (
              <DropdownMenuItem disabled>
                <Loader2 className="mr-2 size-3.5 animate-spin" />
                {t("projectTools.loading")}
              </DropdownMenuItem>
            ) : current.rows.length === 0 ? (
              <DropdownMenuItem disabled>
                {current.error ?? (zh ? "没有提交" : "No commits")}
              </DropdownMenuItem>
            ) : (
              current.rows.map((commit) => (
                <DropdownMenuItem
                  key={commit.sha}
                  title={commit.subject}
                  className="gap-2"
                  onSelect={() => onComparisonChange(`commit:${commit.sha}`)}
                >
                  <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {commit.shortSha || commit.sha.slice(0, 7)}
                  </span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type Props = {
  active: boolean;
  workdir: string;
  path?: string;
  client: GitClient;
  comparison?: WorkspaceGitComparison;
  conversationId?: string;
  onComparisonChange?: (comparison: WorkspaceGitComparison) => void;
  hideComparisonMenu?: boolean;
  toolbarActions?: ReactNode;
  onOpenFile?: (path: string) => void;
  workspaceActivityClient?: WorkspaceActivityClient;
  onInsertComposerSegments?: RightDockGitContext["onInsertComposerSegments"];
};

type DiffLoadResult = { diff?: GitDiffResponse; error?: string; repoRoot?: string };

function diffLineCounts(patch: string) {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    if (line.startsWith("@@ ")) inHunk = true;
    if (!inHunk) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

export function WorkspaceFileDiff({
  active,
  workdir,
  path,
  client,
  comparison,
  conversationId,
  onComparisonChange,
  hideComparisonMenu,
  toolbarActions,
  onOpenFile,
  workspaceActivityClient,
  onInsertComposerSegments,
}: Props) {
  const { t, locale } = useLocale();
  const zh = locale === "zh-CN";
  const [localComparison, setLocalComparison] = useState<WorkspaceGitComparison>("working_tree");
  const selectedComparison = comparison ?? localComparison;
  const [{ layout, wrapLines }, setPresentation] = useWorkspaceGitPresentation();
  const turnRevision = useWorkspaceGitTurnRevision(
    selectedComparison === "last-turn" ? conversationId : undefined,
  );
  const [version, setVersion] = useState(0);
  const scope = JSON.stringify([workdir, path, selectedComparison, conversationId, turnRevision]);
  const [result, setResult] = useState<DiffLoadResult & { scope: string; version: number }>();
  const selected = result?.scope === scope ? result : null;
  const loading = active && selected?.version !== version;
  const refresh = () => setVersion((previous) => previous + 1);
  const unsupported = t("git.branchSelector.runtimeUnsupported");
  const unavailable = zh
    ? "当前范围没有可用的 Git 差异。"
    : "No Git diff is available for this scope.";
  const turnUnavailable = zh
    ? "上一轮没有可用的工作区快照。"
    : "The last turn has no complete workspace snapshot.";

  useWorkspaceInvalidation({
    client: active ? workspaceActivityClient : null,
    workdir,
    active,
    onInvalidate: ({ fs, git }) => {
      if (fs || git) refresh();
    },
  });

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const publish = (value: DiffLoadResult) => {
      if (!disposed) setResult({ ...value, scope, version });
    };
    const timer = window.setTimeout(() => {
      void (async () => {
        if (path) {
          const absolutePath = workspaceGitPathFromRoot(workdir, path);
          if (!absolutePath || !workspaceGitRelativePath(workdir, absolutePath)) {
            publish({ error: unavailable });
            return;
          }
        }
        const repository = await client.status(workdir);
        if (disposed) return;
        if (repository.status !== "ready") {
          publish({ error: repository.error || unavailable });
          return;
        }
        const diff = await loadWorkspaceGitComparison(
          client,
          repository,
          workdir,
          selectedComparison,
          path,
          conversationId,
        );
        publish(diff ? { diff, repoRoot: repository.repoRoot } : { error: unavailable });
      })().catch((error: unknown) =>
        publish({
          error:
            selectedComparison === "last-turn"
              ? turnUnavailable
              : hostAwareErrorMessage(error, unsupported),
        }),
      );
    }, 100);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [
    active,
    client,
    conversationId,
    path,
    scope,
    selectedComparison,
    turnUnavailable,
    unavailable,
    unsupported,
    version,
    workdir,
  ]);

  const patch = selected?.diff?.patch;
  const { additions, deletions } = useMemo(() => diffLineCounts(patch ?? ""), [patch]);
  const openPath =
    onOpenFile && selected?.repoRoot
      ? (file: string) => {
          if (!selected.repoRoot) return;
          const absolute = workspaceGitPathFromRoot(selected.repoRoot, file);
          if (absolute && workspaceGitRelativePath(workdir, absolute)) onOpenFile(absolute);
        }
      : undefined;

  return (
    <section
      aria-label={t("projectTools.gitReviewTitle")}
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      <div className="flex h-10 min-w-0 shrink-0 items-center gap-1 border-b border-border/70 px-2">
        {!hideComparisonMenu && (
          <WorkspaceGitComparisonMenu
            client={client}
            workdir={workdir}
            comparison={selectedComparison}
            conversationId={conversationId}
            onComparisonChange={onComparisonChange ?? setLocalComparison}
          />
        )}
        {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        {(additions > 0 || deletions > 0) && (
          <span className="flex items-center gap-1 font-mono text-[11px]">
            <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
            <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
          </span>
        )}
        <span className="flex-1" />
        {toolbarActions}
        <DropdownMenu>
          <DropdownMenuTrigger
            type="button"
            aria-label={zh ? "差异显示方式" : "Diff layout"}
            className="flex h-7 items-center gap-1 rounded-lg px-2 text-muted-foreground hover:bg-muted focus-visible:outline-ring"
          >
            {layout === "split" ? <Columns2 className="size-4" /> : <List className="size-4" />}
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={layout}>
              <DropdownMenuRadioItem
                value="unified"
                onSelect={() => setPresentation({ layout: "unified" })}
              >
                {zh ? "统一视图" : "Unified"}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                value="split"
                onSelect={() => setPresentation({ layout: "split" })}
              >
                {zh ? "并排视图" : "Split"}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={wrapLines}
              onCheckedChange={(next) => setPresentation({ wrapLines: next })}
            >
              {zh ? "自动换行" : "Wrap lines"}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {selected?.error && (
        <div
          role="alert"
          className="m-2 flex shrink-0 items-center gap-2 rounded-md border border-destructive/20 px-3 py-1.5 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1 break-words">{selected.error}</span>
          <Button size="sm" variant="ghost" onClick={refresh}>
            {t("projectTools.fileTree.refresh")}
          </Button>
        </div>
      )}
      {!selected?.error && (
        <DiffContent
          title={comparisonName(locale, selectedComparison)}
          diff={selected?.diff}
          loading={loading}
          showStat={false}
          layout={layout}
          wrapLines={wrapLines}
          onOpenFile={openPath}
          onInsertComposerSegments={onInsertComposerSegments}
        />
      )}
    </section>
  );
}
