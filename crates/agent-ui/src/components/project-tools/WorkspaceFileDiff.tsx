import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import type {
  GitBranchesResponse,
  GitClient,
  GitCommitSummary,
  GitDiffResponse,
  GitRepositoryState,
} from "../../lib/git/types";
import { hostAwareErrorMessage } from "../../lib/shared/hostErrors";
import type { WorkspaceActivityClient } from "../../lib/workspace-activity/types";
import { useWorkspaceInvalidation } from "../../lib/workspace-activity/useWorkspaceInvalidation";
import { ChevronDown, ChevronRight, Loader2 } from "../IconSet";
import { Button } from "../ui/button";
import {
  DropdownMenu,
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
import { LabelTooltip } from "../ui/label-tooltip";
import { DiffContent } from "./git-review/DiffView";
import "./git-review/DiffView.css";
import { buildWorkspaceReviewRows, type PatchChunk } from "./git-review/model";
import { WorkspaceDiffNavigation } from "./git-review/WorkspaceDiffNavigation";
import { WorkspaceReviewToolbar } from "./git-review/WorkspaceReviewToolbar";
import {
  buildReviewApplyCommand,
  countReviewChanges,
  readReviewFileContents,
  sameReviewFileRevision,
} from "./git-review/workspaceReviewDiff";
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
  summary?: ReactNode;
  capsule?: boolean;
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
  summary,
  capsule,
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
  const comparisonLabel = comparisonName(locale, comparison);
  return (
    <DropdownMenu>
      <LabelTooltip
        label={zh ? "比较范围" : "Comparison source"}
        side="bottom"
        description={sha ?? baseBranch ?? comparisonLabel}
        render={
          <DropdownMenuTrigger
            type="button"
            aria-label={zh ? "比较范围" : "Comparison source"}
            className={
              capsule || summary
                ? "za-review-comparison"
                : "flex h-7 min-w-0 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium hover:bg-muted focus-visible:outline-ring"
            }
          >
            <span className="min-w-0 truncate">{comparisonLabel}</span>
            {sha && (
              <span className="za-review-comparison-detail font-mono font-normal text-muted-foreground">
                {sha.slice(0, 7)}
              </span>
            )}
            {baseBranch && (
              <span className="za-review-comparison-detail max-w-24 truncate font-normal text-muted-foreground">
                {baseBranch}
              </span>
            )}
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            {summary}
          </DropdownMenuTrigger>
        }
      />
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
  fileToolbar?: { navigation: HTMLElement | null; actions: HTMLElement | null };
  onOpenGitActions?: () => void;
  onOpenFile?: (path: string) => void;
  workspaceActivityClient?: WorkspaceActivityClient;
  onInsertComposerSegments?: RightDockGitContext["onInsertComposerSegments"];
};

type DiffLoadResult = { diff?: GitDiffResponse; error?: string; repository?: GitRepositoryState };

export function WorkspaceFileDiff({
  active,
  workdir,
  path,
  client,
  comparison,
  conversationId,
  onComparisonChange,
  fileToolbar,
  onOpenGitActions,
  onOpenFile,
  workspaceActivityClient,
  onInsertComposerSegments,
}: Props) {
  const { t, locale } = useLocale();
  const zh = locale === "zh-CN";
  const [localComparison, setLocalComparison] = useState<WorkspaceGitComparison>("working_tree");
  const selectedComparison = comparison ?? localComparison;
  const [presentation, setPresentation] = useWorkspaceGitPresentation();
  const { layout, wrapLines } = presentation;
  const turnRevision = useWorkspaceGitTurnRevision(
    selectedComparison === "last-turn" ? conversationId : undefined,
  );
  const [version, setVersion] = useState(0);
  const [fileExpansion, setFileExpansion] = useState<{
    scope: string;
    defaultOpen: boolean;
    overrides: Record<string, boolean>;
  }>();
  const reviewRef = useRef<HTMLElement>(null);
  const [viewport, setViewport] = useState<"compact" | "toolbar" | "split">("compact");
  useLayoutEffect(() => {
    const element = reviewRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      setViewport(width >= 800 ? "split" : width >= 625 ? "toolbar" : "compact");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
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
        publish(diff ? { diff, repository } : { error: unavailable });
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

  const rawDiff = selected?.diff;
  const patch = rawDiff?.patch;
  const repository = selected?.repository;
  const hideWhitespace = presentation.hideWhitespace && Boolean(client.supportsWhitespaceDiff);
  const [whitespaceResult, setWhitespaceResult] = useState<{
    raw: GitDiffResponse;
    diff: GitDiffResponse | null;
  }>();
  useEffect(() => {
    if (!active || !hideWhitespace || !rawDiff || !repository) return;
    let disposed = false;
    const publish = (diff: GitDiffResponse | null) => {
      if (disposed) return;
      const sameSnapshot = !rawDiff.snapshotId || rawDiff.snapshotId === diff?.snapshotId;
      setWhitespaceResult({ raw: rawDiff, diff: sameSnapshot ? diff : null });
    };
    void Promise.resolve(
      loadWorkspaceGitComparison(
        client,
        repository,
        workdir,
        selectedComparison,
        path,
        conversationId,
        { hideWhitespace: true },
      ),
    ).then(publish, () => publish(null));
    return () => {
      disposed = true;
    };
  }, [
    active,
    client,
    conversationId,
    hideWhitespace,
    path,
    rawDiff,
    repository,
    selectedComparison,
    workdir,
  ]);
  const filtered = hideWhitespace && whitespaceResult?.raw === rawDiff ? whitespaceResult : null;
  const displayedDiff = filtered?.diff ?? rawDiff;
  const title = comparisonName(locale, selectedComparison);
  const rows = useMemo(
    () => buildWorkspaceReviewRows(displayedDiff, title),
    [displayedDiff, title],
  );
  const rawRows = useMemo(
    () =>
      displayedDiff === rawDiff
        ? null
        : new Map(buildWorkspaceReviewRows(rawDiff, title).map((row) => [row.label, row])),
    [displayedDiff, rawDiff, title],
  );
  const { additions, deletions } = useMemo(
    () => countReviewChanges(displayedDiff?.patch ?? ""),
    [displayedDiff?.patch],
  );
  const resolveFilePath = useCallback(
    (file: string) => {
      if (!repository?.repoRoot) return null;
      const absolute = workspaceGitPathFromRoot(repository.repoRoot, file);
      return absolute && workspaceGitRelativePath(workdir, absolute) ? absolute : null;
    },
    [repository, workdir],
  );
  const openPath =
    onOpenFile && repository
      ? (file: string) => {
          const absolute = resolveFilePath(file);
          if (absolute) onOpenFile(absolute);
        }
      : undefined;
  const supportsFullContext = Boolean(client.supportsFullDiffContext);
  const loadBinaryPreview = useCallback(
    (item: PatchChunk) => {
      const diff = rawDiff;
      if (!active || !client.readDiffPreview || !diff || !resolveFilePath(item.label))
        return Promise.resolve(null);
      if (selectedComparison === "last-turn" && (!conversationId || !diff.snapshotId))
        return Promise.resolve(null);
      const original = (rawRows?.get(item.label) ?? item).chunk;
      const expectedPatch = /^index [a-f0-9]+\.\.[a-f0-9]+(?: \d+)?$/m.test(original)
        ? original
        : diff.changes?.find((change) => change.path === item.label)?.previewIndex;
      if (selectedComparison !== "last-turn" && !expectedPatch) return Promise.resolve(null);
      return client.readDiffPreview({
        workdir,
        comparison: selectedComparison,
        path: item.label,
        expectedPatch,
        conversationId,
        snapshotId: diff.snapshotId,
      });
    },
    [
      active,
      client,
      conversationId,
      rawDiff,
      rawRows,
      resolveFilePath,
      selectedComparison,
      workdir,
    ],
  );
  const loadFileContents = useCallback(
    async (item: PatchChunk) => {
      if (!active || !repository || selected?.diff?.truncated || item.large) return null;
      const original = (rawRows?.get(item.label) ?? item).chunk;
      const alreadyComplete = readReviewFileContents(original, false);
      if (alreadyComplete) return alreadyComplete;
      const absolutePath = resolveFilePath(item.label);
      if (!absolutePath || !supportsFullContext) return null;
      try {
        const fullDiff = await loadWorkspaceGitComparison(
          client,
          repository,
          workdir,
          selectedComparison,
          absolutePath,
          conversationId,
          { fullContext: true },
        );
        if (!fullDiff || fullDiff.truncated || !sameReviewFileRevision(original, fullDiff.patch))
          return null;
        return readReviewFileContents(fullDiff.patch, true);
      } catch {
        return null;
      }
    },
    [
      active,
      client,
      conversationId,
      rawRows,
      repository,
      resolveFilePath,
      selected?.diff?.truncated,
      selectedComparison,
      supportsFullContext,
      workdir,
    ],
  );
  const currentExpansion = fileExpansion?.scope === scope ? fileExpansion : undefined;
  const defaultOpen = currentExpansion?.defaultOpen ?? true;
  const isExpanded = (key: string) => currentExpansion?.overrides[key] ?? defaultOpen;
  const allExpanded =
    defaultOpen && !Object.values(currentExpansion?.overrides ?? {}).includes(false);
  const setExpanded = (key: string, open: boolean) => {
    setFileExpansion((previous) => ({
      scope,
      defaultOpen,
      overrides: { ...(previous?.scope === scope ? previous.overrides : {}), [key]: open },
    }));
  };
  const jumpToFile = (key: string) => {
    setExpanded(key, true);
    window.requestAnimationFrame(() => {
      const row = [
        ...(reviewRef.current?.querySelectorAll<HTMLElement>("[data-workspace-review-file]") ?? []),
      ].find((element) => element.dataset.workspaceReviewFile === key);
      row?.scrollIntoView?.({ block: "start" });
      row?.querySelector("button")?.focus({ preventScroll: true });
    });
  };
  const applyCommand =
    patch &&
    !loading &&
    !selected?.diff?.truncated &&
    !selected?.diff?.binaryFiles?.length &&
    !rows.some((row) => row.summary) &&
    selectedComparison !== "last-turn"
      ? buildReviewApplyCommand(patch)
      : null;
  const summary =
    additions > 0 || deletions > 0 ? (
      <span className="za-review-counts">
        <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
        <span className="text-rose-600 dark:text-rose-400">−{deletions}</span>
      </span>
    ) : null;

  const toolbar = (
    <WorkspaceReviewToolbar
      presentation={presentation}
      onPresentationChange={setPresentation}
      supportsFullContext={supportsFullContext}
      supportsWhitespace={Boolean(client.supportsWhitespaceDiff)}
      rows={rows}
      onJump={jumpToFile}
      expanded={allExpanded}
      onToggleExpanded={() => setFileExpansion({ scope, defaultOpen: !allExpanded, overrides: {} })}
      refreshing={loading}
      onRefresh={refresh}
      applyCommand={applyCommand}
      onOpenGitActions={onOpenGitActions}
      wide={viewport !== "compact"}
      singleFile={Boolean(fileToolbar)}
    />
  );

  return (
    <section
      ref={reviewRef}
      aria-label={t("projectTools.workspaceChangesTitle")}
      className="za-workspace-review flex h-full min-h-0 min-w-0 flex-col"
    >
      {fileToolbar ? (
        <>
          {fileToolbar.navigation &&
            createPortal(<WorkspaceDiffNavigation root={reviewRef} />, fileToolbar.navigation)}
          {fileToolbar.actions && createPortal(toolbar, fileToolbar.actions)}
        </>
      ) : (
        <div className="za-review-header">
          <WorkspaceGitComparisonMenu
            client={client}
            workdir={workdir}
            comparison={selectedComparison}
            conversationId={conversationId}
            onComparisonChange={onComparisonChange ?? setLocalComparison}
            summary={summary}
          />
          {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          <span className="flex-1" />
          {toolbar}
        </div>
      )}
      {filtered && !filtered.diff && (
        <p role="status" className="za-review-file-status">
          {zh
            ? "无法隐藏空白变化，已显示原始差异。"
            : "Could not hide whitespace changes. Showing the original diff."}
        </p>
      )}
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
          title={title}
          diff={displayedDiff}
          loading={loading}
          showStat={false}
          layout={layout === "auto" ? "unified" : layout}
          wrapLines={wrapLines}
          onOpenFile={openPath}
          onInsertComposerSegments={onInsertComposerSegments}
          workspaceReview={{
            presentation,
            rows,
            fileNavigation: Boolean(fileToolbar),
            allowAutoSplit: viewport === "split",
            isExpanded,
            onToggleFile: (key) => setExpanded(key, !isExpanded(key)),
            loadFileContents,
            loadBinaryPreview: active && client.readDiffPreview ? loadBinaryPreview : undefined,
          }}
        />
      )}
    </section>
  );
}
