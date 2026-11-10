import {
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
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
import { cachedRelativeTimeFormat } from "../../lib/shared/intlFormatters";
import type { WorkspaceActivityClient } from "../../lib/workspace-activity/types";
import { useWorkspaceInvalidation } from "../../lib/workspace-activity/useWorkspaceInvalidation";
import { Check, ChevronDown, ChevronRight, Info, Loader2 } from "../IconSet";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { LabelTooltip } from "../ui/label-tooltip";
import { TooltipButton } from "../ui/tooltip-button";
import { compareWorkspaceReviewPaths } from "./file-tree/model";
import { DiffContent } from "./git-review/DiffView";
import "./git-review/DiffView.css";
import {
  buildWorkspaceReviewRows,
  type PatchChunk,
  shouldPageWorkspaceReview,
} from "./git-review/model";
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
const uncommittedComparisons = ["working_tree", "unstaged", "staged"] as const;

function commitAge(date: string, locale: string) {
  const minutes = (Date.parse(date) - Date.now()) / 60_000;
  if (!Number.isFinite(minutes)) return null;
  const units = [
    [525_600, "year"],
    [43_800, "month"],
    [1_440, "day"],
    [60, "hour"],
    [1, "minute"],
  ] as const;
  const [divisor, unit] = units.find(([scale]) => Math.abs(minutes) >= scale) ?? [1, "minute"];
  return cachedRelativeTimeFormat(locale, "workspace-commit", { numeric: "always" }).format(
    Math.trunc(minutes / divisor),
    unit,
  );
}

function comparisonName(locale: string, comparison: WorkspaceGitComparison) {
  if (isWorkspaceGitBaseBranch(comparison)) comparison = "branch";
  if (locale === "zh-CN") {
    switch (comparison) {
      case "branch":
        return "分支";
      case "last-turn":
        return "上一轮";
      case "working_tree":
        return "未提交";
      case "unstaged":
        return "未暂存";
      case "staged":
        return "已暂存";
      default:
        return "已提交";
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
      return "Committed";
  }
}

type ComparisonMenuProps = {
  client: GitClient;
  workdir: string;
  comparison: WorkspaceGitComparison;
  conversationId?: string;
  onComparisonChange: (comparison: WorkspaceGitComparison) => void;
  summary?: ReactNode;
  repository?: GitRepositoryState;
  baseRef?: string;
  active?: boolean;
};

function WorkspaceGitBasePicker({
  client,
  workdir,
  comparison,
  onComparisonChange,
  repository,
  baseRef,
}: Pick<
  ComparisonMenuProps,
  "client" | "workdir" | "comparison" | "onComparisonChange" | "repository" | "baseRef"
>) {
  const { t, locale } = useLocale();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const [attempt, retry] = useState(0);
  const [result, setResult] = useState<{
    client: GitClient;
    workdir: string;
    attempt: number;
    response?: GitBranchesResponse;
    error?: string;
  }>();
  useEffect(() => {
    if (!open) return;
    let active = true;
    void client.branches(workdir).then(
      (response) => {
        if (active) setResult({ client, workdir, attempt, response });
      },
      (error: unknown) => {
        if (active)
          setResult({
            client,
            workdir,
            attempt,
            error: hostAwareErrorMessage(error, t("projectTools.runtimeUnsupported")),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, client, open, t, workdir]);
  const current =
    result?.client === client && result.workdir === workdir && result.attempt === attempt
      ? result
      : undefined;
  const branches = current?.response?.branches.filter(
    (branch) => !branch.current && !/^refs\/remotes\/[^/]+\/HEAD$/.test(branch.fullName),
  );
  const selectedRef = isWorkspaceGitBaseBranch(comparison)
    ? comparison.slice("branch:".length)
    : null;
  const selectedName = (selectedRef ?? baseRef)?.replace(/^refs\/(?:heads|remotes)\//, "");
  const targetLabel = selectedName || (zh ? "默认基线" : "Default base");
  const head = repository?.head || current?.response?.state.head;
  const label = zh ? "基线分支" : "Base branch";
  return (
    <div className="za-review-base">
      {head && (
        <span className="za-review-base-head">
          <span className="truncate">{head}</span>
          <span aria-hidden="true">→</span>
        </span>
      )}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <LabelTooltip
          label={label}
          description={targetLabel}
          side="bottom"
          render={
            <DropdownMenuTrigger
              type="button"
              aria-label={label}
              className="za-review-base-trigger"
            >
              <span className="truncate">{targetLabel}</span>
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
            </DropdownMenuTrigger>
          }
        />
        <DropdownMenuContent align="start" className="max-h-72 min-w-48">
          <DropdownMenuRadioGroup
            value={selectedRef ?? ""}
            onValueChange={(ref) => onComparisonChange(ref ? `branch:${ref}` : "branch")}
          >
            <DropdownMenuRadioItem value="" closeOnClick>
              {zh ? "默认基线" : "Default base"}
            </DropdownMenuRadioItem>
            {branches?.map((branch) => (
              <DropdownMenuRadioItem key={branch.fullName} value={branch.fullName} closeOnClick>
                <span className="max-w-56 truncate">{branch.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {!current && (
            <DropdownMenuItem disabled>
              <Loader2 className="mr-2 size-3.5 animate-spin" />
              {t("projectTools.loading")}
            </DropdownMenuItem>
          )}
          {current?.error && (
            <>
              <DropdownMenuLabel className="max-w-64 break-words text-muted-foreground">
                {current.error}
              </DropdownMenuLabel>
              <DropdownMenuItem closeOnClick={false} onSelect={() => retry((value) => value + 1)}>
                {zh ? "重试" : "Retry"}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function WorkspaceGitComparisonMenu({
  client,
  workdir,
  comparison,
  conversationId,
  onComparisonChange,
  summary,
  repository,
  baseRef,
  active = true,
}: ComparisonMenuProps) {
  const { locale, t } = useLocale();
  const zh = locale === "zh-CN";
  const [commitsOpen, setCommitsOpen] = useState(false);
  const [attempt, retry] = useState(0);
  const [commits, setCommits] = useState<{
    client: GitClient;
    workdir: string;
    attempt: number;
    rows: GitCommitSummary[];
    error?: string;
  }>();
  const current =
    commits?.client === client && commits.workdir === workdir && commits.attempt === attempt
      ? commits
      : null;
  useEffect(() => {
    if (!commitsOpen) return;
    let active = true;
    void client.log(workdir, { limit: 32 }).then(
      (log) => {
        if (active) setCommits({ client, workdir, attempt, rows: log.commits });
      },
      (error: unknown) => {
        if (active)
          setCommits({
            client,
            workdir,
            attempt,
            rows: [],
            error: hostAwareErrorMessage(error, t("projectTools.runtimeUnsupported")),
          });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, client, commitsOpen, t, workdir]);

  const sha = workspaceGitCommit(comparison);
  const branch = comparison === "branch" || isWorkspaceGitBaseBranch(comparison);
  const lastTurn = Boolean(conversationId && client.lastTurnDiff);
  const listedSubject = current?.rows.find((commit) => commit.sha === sha)?.subject;
  const [commit, setCommit] = useState<{
    client: GitClient;
    workdir: string;
    sha: string;
    subject: string;
  }>();
  const commitLabel =
    listedSubject ??
    (commit?.client === client && commit.workdir === workdir && commit.sha === sha
      ? commit.subject
      : undefined);
  useEffect(() => {
    if (!active || !sha || commitLabel !== undefined || !client.commitDetails) return;
    let disposed = false;
    void client.commitDetails(workdir, sha).then(
      ({ commit: details }) => {
        if (!disposed) setCommit({ client, workdir, sha, subject: details.subject });
      },
      () => {},
    );
    return () => {
      disposed = true;
    };
  }, [active, client, commitLabel, sha, workdir]);
  const comparisonLabel = comparisonName(locale, comparison);
  return (
    <div className="za-review-source">
      <div className="za-review-source-capsule">
        <DropdownMenu>
          <LabelTooltip
            label={zh ? "比较范围" : "Comparison source"}
            side="bottom"
            description={commitLabel ?? sha ?? comparisonLabel}
            render={
              <DropdownMenuTrigger
                type="button"
                aria-label={zh ? "比较范围" : "Comparison source"}
                className="za-review-comparison"
              >
                <span className="min-w-0 truncate">{comparisonLabel}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
            }
          />
          <DropdownMenuContent align="start" sideOffset={6} className="za-review-scope-menu">
            <DropdownMenuRadioGroup
              value={branch ? "branch" : comparison}
              onValueChange={(value) => {
                const next = comparisons.find((option) => option === value);
                if (next) onComparisonChange(next);
                if (value === "last-turn" && lastTurn) onComparisonChange(value);
              }}
            >
              {lastTurn && (
                <>
                  <DropdownMenuRadioItem value="last-turn" closeOnClick>
                    {comparisonName(locale, "last-turn")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {uncommittedComparisons.map((option) => (
                <DropdownMenuRadioItem key={option} value={option} closeOnClick>
                  {comparisonName(locale, option)}
                </DropdownMenuRadioItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuSub open={active && commitsOpen} onOpenChange={setCommitsOpen}>
                <DropdownMenuSubTrigger className="flex items-center gap-2" delay={200}>
                  {zh ? "已提交" : "Committed"}
                  <ChevronRight aria-hidden="true" className="ml-auto size-3.5" />
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="za-review-scope-menu za-review-commit-menu">
                  {!current ? (
                    <DropdownMenuItem disabled>
                      <Loader2 className="mr-2 size-3.5 animate-spin" />
                      {t("projectTools.loading")}
                    </DropdownMenuItem>
                  ) : current.error ? (
                    <>
                      <DropdownMenuLabel className="break-words text-muted-foreground">
                        {current.error}
                      </DropdownMenuLabel>
                      <DropdownMenuItem
                        closeOnClick={false}
                        onSelect={() => retry((value) => value + 1)}
                      >
                        {zh ? "重试" : "Retry"}
                      </DropdownMenuItem>
                    </>
                  ) : current.rows.length === 0 ? (
                    <DropdownMenuItem disabled>{zh ? "没有提交" : "No commits"}</DropdownMenuItem>
                  ) : (
                    current.rows.map((commit) => {
                      const selected = commit.sha === sha;
                      const time = commitAge(commit.authorDate, locale);
                      return (
                        <DropdownMenuItem
                          key={commit.sha}
                          aria-current={selected || undefined}
                          className="za-review-commit-row"
                          onSelect={() => onComparisonChange(`commit:${commit.sha}`)}
                        >
                          <span className="flex min-w-0 items-baseline gap-1">
                            <span className="truncate">{commit.subject || commit.shortSha}</span>
                            {time && (
                              <time dateTime={commit.authorDate} className="za-review-commit-time">
                                {time}
                              </time>
                            )}
                          </span>
                          <span className="ml-auto size-3.5 shrink-0" aria-hidden="true">
                            {selected && <Check className="size-full" />}
                          </span>
                        </DropdownMenuItem>
                      );
                    })
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuRadioItem value="branch" closeOnClick>
                {comparisonName(locale, "branch")}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {sha && (
          <span className="za-review-comparison-detail">{commitLabel || sha.slice(0, 7)}</span>
        )}
        {summary}
      </div>
      {branch && (
        <WorkspaceGitBasePicker
          client={client}
          workdir={workdir}
          comparison={comparison}
          onComparisonChange={onComparisonChange}
          repository={repository}
          baseRef={baseRef}
        />
      )}
    </div>
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
  tree?: NonNullable<RightDockGitContext["workspaceReview"]>["tree"];
  fileJumpRef?: NonNullable<RightDockGitContext["workspaceReview"]>["fileJumpRef"];
  headerTarget?: HTMLElement | null;
  onReviewStateChange?: NonNullable<RightDockGitContext["workspaceReview"]>["onStateChange"];
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
  tree,
  fileJumpRef,
  headerTarget,
  onReviewStateChange,
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
  const headerRef = useRef<HTMLDivElement>(null);
  const singleFile = Boolean(fileToolbar);
  const [viewport, setViewport] = useState({ wide: false, split: false });
  useLayoutEffect(() => {
    const element = reviewRef.current;
    if (!active || !element) return;
    const header = headerTarget ?? headerRef.current;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      const wide = (header?.getBoundingClientRect().width ?? width) >= 625;
      const split = width >= 800;
      setViewport((previous) =>
        previous.wide === wide && previous.split === split ? previous : { wide, split },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (header) observer.observe(header);
    return () => observer.disconnect();
  }, [active, headerTarget]);
  const scope = JSON.stringify([workdir, path, selectedComparison, conversationId, turnRevision]);
  const [result, setResult] = useState<
    DiffLoadResult & { client: GitClient; scope: string; version: number }
  >();
  const selected = result?.client === client && result.scope === scope ? result : null;
  const loading = active && selected?.version !== version;
  const refresh = useCallback(() => setVersion((previous) => previous + 1), []);
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
      if (!disposed) setResult({ ...value, client, scope, version });
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
          path ? undefined : { paginateLarge: true },
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
        { hideWhitespace: true, ...(!path && { paginateLarge: true }) },
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
  const totals = useMemo(
    () =>
      displayedDiff?.totals ??
      (displayedDiff && !displayedDiff.truncated && !displayedDiff.patchOmitted
        ? countReviewChanges(displayedDiff.patch ?? "")
        : undefined),
    [displayedDiff],
  );
  const paged =
    !path &&
    !singleFile &&
    shouldPageWorkspaceReview(
      displayedDiff,
      rows.length,
      (totals?.additions ?? 0) + (totals?.deletions ?? 0),
    );
  const orderedRows = useMemo(
    () => (paged ? [...rows].sort((a, b) => compareWorkspaceReviewPaths(a.label, b.label)) : rows),
    [paged, rows],
  );
  const [pageSelection, setPageSelection] = useState<{ scope: string; path: string }>();
  const activeRow =
    paged &&
    (orderedRows.find(
      (row) => pageSelection?.scope === scope && row.label === pageSelection.path,
    ) ??
      orderedRows[0]);
  const activePath = activeRow ? activeRow.label : undefined;
  const activeIndex = activeRow ? orderedRows.indexOf(activeRow) : -1;
  const resolveFilePath = useCallback(
    (file: string) => {
      if (!repository?.repoRoot) return null;
      const absolute = workspaceGitPathFromRoot(repository.repoRoot, file);
      return absolute && workspaceGitRelativePath(workdir, absolute) ? absolute : null;
    },
    [repository, workdir],
  );
  const [pageResult, setPageResult] = useState<{
    source: GitDiffResponse;
    path: string;
    diff?: GitDiffResponse;
    error?: string;
  }>();
  const [pageRetry, setPageRetry] = useState(0);
  useEffect(() => {
    void pageRetry;
    if (!active || loading || !activePath || !repository || !displayedDiff) return;
    let disposed = false;
    const source = displayedDiff;
    const publish = (data: { diff?: GitDiffResponse; error?: string }) => {
      if (!disposed) setPageResult({ source, path: activePath, ...data });
    };
    void (async () => {
      const absolutePath = resolveFilePath(activePath);
      const previousPath = source.changes?.find((file) => file.path === activePath)?.oldPath;
      const diff =
        absolutePath &&
        (await loadWorkspaceGitComparison(
          client,
          repository,
          workdir,
          selectedComparison,
          absolutePath,
          conversationId,
          {
            ...(filtered?.diff && { hideWhitespace: true }),
            ...(previousPath && { previousPath }),
          },
        ));
      if (!diff || (source.snapshotId && source.snapshotId !== diff.snapshotId)) {
        publish({ error: unavailable });
        return;
      }
      publish({ diff });
    })().catch((error: unknown) => publish({ error: hostAwareErrorMessage(error, unsupported) }));
    return () => {
      disposed = true;
    };
  }, [
    active,
    activePath,
    client,
    conversationId,
    displayedDiff,
    filtered?.diff,
    loading,
    pageRetry,
    repository,
    resolveFilePath,
    selectedComparison,
    unavailable,
    unsupported,
    workdir,
  ]);
  const currentPage =
    activePath && pageResult?.source === displayedDiff && pageResult?.path === activePath
      ? pageResult
      : undefined;
  const pageDiff = currentPage?.diff;
  const visibleRows = useMemo(() => {
    if (!paged) return rows;
    if (!activeRow || !pageDiff) return [];
    const detail = buildWorkspaceReviewRows(pageDiff, title).find(
      (row) => row.label === activeRow.label,
    );
    if (detail)
      return [
        {
          ...detail,
          key: activeRow.key,
          lineStats: activeRow.lineStats ?? detail.lineStats,
        },
      ];
    return [
      {
        ...activeRow,
        chunk: "",
        lineCount: 0,
        large: false,
        summary: activeRow.summary ?? ("unavailable" as const),
      },
    ];
  }, [activeRow, pageDiff, paged, rows, title]);
  useLayoutEffect(() => {
    if (!active || !onReviewStateChange) return;
    onReviewStateChange({
      repository: repository ?? null,
      diff: displayedDiff,
      loading,
      error: selected?.error,
      activePath,
      retry: refresh,
    });
  }, [
    active,
    activePath,
    displayedDiff,
    loading,
    onReviewStateChange,
    refresh,
    repository,
    selected?.error,
  ]);
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
      const original = paged ? item.chunk : (rawRows?.get(item.label) ?? item).chunk;
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
      paged,
      rawDiff,
      rawRows,
      resolveFilePath,
      selectedComparison,
      workdir,
    ],
  );
  const loadFileContents = useCallback(
    async (item: PatchChunk) => {
      if (
        !active ||
        !repository ||
        (paged ? pageDiff?.truncated : rawDiff?.truncated) ||
        item.large
      )
        return null;
      const original = paged ? item.chunk : (rawRows?.get(item.label) ?? item).chunk;
      const alreadyComplete = readReviewFileContents(original, false);
      if (alreadyComplete) return alreadyComplete;
      const absolutePath = resolveFilePath(item.label);
      if (!absolutePath || !supportsFullContext) return null;
      const previousPath = displayedDiff?.changes?.find(
        (change) => change.path === item.label,
      )?.oldPath;
      try {
        const fullDiff = await loadWorkspaceGitComparison(
          client,
          repository,
          workdir,
          selectedComparison,
          absolutePath,
          conversationId,
          {
            fullContext: true,
            ...(previousPath && { previousPath }),
          },
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
      displayedDiff?.changes,
      paged,
      pageDiff?.truncated,
      rawDiff?.truncated,
      rawRows,
      repository,
      resolveFilePath,
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
  const selectPage = (row: PatchChunk) => {
    setPageSelection({ scope, path: row.label });
    const viewport = reviewRef.current?.querySelector<HTMLElement>("[data-review-scroll-viewport]");
    if (viewport) viewport.scrollTop = 0;
  };
  const jumpToFile = (key: string, focus = true) => {
    if (paged) {
      const row = orderedRows.find((item) => item.key === key);
      if (row) selectPage(row);
      return;
    }
    setExpanded(key, true);
    window.requestAnimationFrame(() => {
      const row = [
        ...(reviewRef.current?.querySelectorAll<HTMLElement>("[data-workspace-review-file]") ?? []),
      ].find((element) => element.dataset.workspaceReviewFile === key);
      row?.scrollIntoView?.({ block: "start" });
      if (focus) row?.querySelector("button")?.focus({ preventScroll: true });
    });
  };
  useImperativeHandle(fileJumpRef, () => (path: string) => {
    if (!active) return;
    const relative = repository && workspaceGitRelativePath(repository.repoRoot, path);
    const row = rows.find(({ label }) => label === relative);
    if (row) jumpToFile(row.key, false);
  });
  const canCopyPatch =
    !loading &&
    !rawDiff?.truncated &&
    !rawDiff?.binaryFiles?.length &&
    selectedComparison !== "last-turn";
  const applyCommand =
    canCopyPatch && patch && !rows.some((row) => row.summary)
      ? buildReviewApplyCommand(patch)
      : null;
  const loadApplyCommand =
    canCopyPatch && rawDiff?.patchOmitted && repository
      ? async () => {
          const diff = await loadWorkspaceGitComparison(
            client,
            repository,
            workdir,
            selectedComparison,
            path,
            conversationId,
          );
          return diff && !diff.truncated && !diff.binaryFiles.length
            ? buildReviewApplyCommand(diff.patch)
            : null;
        }
      : undefined;
  const summary =
    totals && (totals.additions > 0 || totals.deletions > 0) ? (
      <span className="za-review-counts">
        <span className="text-emerald-600 dark:text-emerald-400">
          +{totals.additions.toLocaleString(locale)}
        </span>
        <span className="text-rose-600 dark:text-rose-400">
          -{totals.deletions.toLocaleString(locale)}
        </span>
      </span>
    ) : null;

  const toolbar = (
    <WorkspaceReviewToolbar
      presentation={presentation}
      onPresentationChange={setPresentation}
      supportsFullContext={supportsFullContext}
      supportsWhitespace={Boolean(client.supportsWhitespaceDiff)}
      rows={orderedRows}
      onJump={jumpToFile}
      expanded={allExpanded}
      onToggleExpanded={() => setFileExpansion({ scope, defaultOpen: !allExpanded, overrides: {} })}
      refreshing={loading}
      onRefresh={refresh}
      applyCommand={applyCommand}
      loadApplyCommand={loadApplyCommand}
      onOpenGitActions={onOpenGitActions}
      wide={viewport.wide}
      singleFile={singleFile}
      tree={tree}
    />
  );

  const header = (
    <div ref={headerRef} className="za-review-header-region">
      <div className="za-review-header">
        <WorkspaceGitComparisonMenu
          client={client}
          workdir={workdir}
          comparison={selectedComparison}
          conversationId={conversationId}
          onComparisonChange={onComparisonChange ?? setLocalComparison}
          summary={summary}
          active={active}
          repository={repository}
          baseRef={rawDiff?.baseRef}
        />
        {toolbar}
      </div>
      {paged && (
        <div className="za-review-page-region">
          <div className="za-review-page-banner">
            <span role="status" className="za-review-page-copy">
              <Info aria-hidden="true" className="size-4 shrink-0" />
              {t("projectTools.gitReview.largeDiffBanner")}
            </span>
            <div className="za-review-page-actions">
              {([-1, 1] as const).map((direction) => {
                const row = orderedRows[activeIndex + direction];
                const label = t(
                  direction < 0
                    ? "projectTools.gitReview.previousFile"
                    : "projectTools.gitReview.nextFile",
                );
                return (
                  <TooltipButton
                    key={direction}
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    tooltip={label}
                    aria-label={label}
                    disabled={!row}
                    onClick={() => row && selectPage(row)}
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={direction < 0 ? "size-4 rotate-180" : "size-4"}
                    />
                  </TooltipButton>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
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
      ) : headerTarget ? (
        active && createPortal(header, headerTarget)
      ) : (
        header
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
      {currentPage?.error && (
        <div role="alert" className="za-review-page-error">
          <span>{currentPage.error}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPageResult(undefined);
              setPageRetry((previous) => previous + 1);
            }}
          >
            {t("projectTools.fileTree.refresh")}
          </Button>
        </div>
      )}
      {!selected?.error && (
        <DiffContent
          title={title}
          diff={paged ? pageDiff : displayedDiff}
          loading={paged ? !currentPage : loading}
          showStat={false}
          layout={layout === "auto" ? "unified" : layout}
          wrapLines={wrapLines}
          onOpenFile={openPath}
          onInsertComposerSegments={onInsertComposerSegments}
          workspaceReview={{
            presentation,
            rows: visibleRows,
            allFiles: paged ? displayedDiff?.changes : undefined,
            fileNavigation: Boolean(fileToolbar),
            allowAutoSplit: !singleFile && viewport.split,
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
