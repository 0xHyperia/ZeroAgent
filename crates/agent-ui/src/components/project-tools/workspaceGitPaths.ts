import type { GitClient, GitDiffOptions, GitRepositoryState } from "../../lib/git/types";

export type WorkspaceGitComparison =
  | "working_tree"
  | "last-turn"
  | "branch"
  | `branch:${string}`
  | "staged"
  | "unstaged"
  | `commit:${string}`;

export const WORKSPACE_GIT_TURN_REVIEW_EVENT = "zeroagent:workspace-git-turn-review";

export function workspaceGitCommit(comparison: WorkspaceGitComparison) {
  return /^commit:([a-f0-9]{7,64})$/i.exec(comparison)?.[1] ?? null;
}

export function isWorkspaceGitBaseBranch(
  comparison: WorkspaceGitComparison,
): comparison is `branch:${string}` {
  return comparison.startsWith("branch:");
}

/** Both the review canvas and its companion tree use the same repository pathspec. */
export function loadWorkspaceGitComparison(
  client: GitClient,
  repository: GitRepositoryState,
  workdir: string,
  comparison: WorkspaceGitComparison,
  path?: string,
  conversationId?: string,
  options?: GitDiffOptions,
) {
  const absolute = path && workspaceGitPathFromRoot(workdir, path);
  if (path && (!absolute || !workspaceGitRelativePath(workdir, absolute))) return null;
  const filter = workspaceGitRelativePath(repository.repoRoot, absolute || workdir);
  if (path && !filter) return null;
  const diffOptions: [GitDiffOptions] | [] = options ? [options] : [];
  if (comparison === "last-turn")
    return conversationId && client.lastTurnDiff
      ? client.lastTurnDiff(
          workdir,
          conversationId,
          path ? (filter ?? undefined) : undefined,
          ...diffOptions,
        )
      : null;
  const commit = workspaceGitCommit(comparison);
  if (commit) return client.commitDiff(workdir, commit, filter ?? undefined, ...diffOptions);
  if (isWorkspaceGitBaseBranch(comparison))
    return client.diff(workdir, comparison, filter ?? undefined, ...diffOptions);
  switch (comparison) {
    case "working_tree":
    case "branch":
    case "staged":
    case "unstaged":
      return client.diff(workdir, comparison, filter ?? undefined, ...diffOptions);
    default:
      return null;
  }
}

function isWindowsPath(path: string) {
  return /^[a-z]:[/\\]/i.test(path) || /^(?:\\\\|\/\/)/.test(path);
}

function normalizeAbsolutePath(path: string, windows: boolean) {
  return (windows ? path.replace(/\\/g, "/") : path).replace(/\/+$/, "");
}

function validRelativePath(path: string) {
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function workspaceGitRelativePath(root: string, path: string): string | null {
  if (!root || !path) return null;
  const windows = isWindowsPath(root);
  const parent = normalizeAbsolutePath(root, windows);
  const input = normalizeAbsolutePath(path, windows);
  const compare = (value: string) => (windows ? value.toLowerCase() : value);
  if (!compare(input).startsWith(`${compare(parent)}/`)) return null;
  const relative = input.slice(parent.length + 1);
  return validRelativePath(relative) ? relative : null;
}

export function workspaceGitPathFromRoot(root: string, path: string): string | null {
  if (!root || !path) return null;
  const windows = isWindowsPath(root);
  const input = windows ? path.replace(/\\/g, "/") : path;
  if (input.startsWith("/") || (windows && isWindowsPath(input))) return input;
  const relative = input.replace(/^\.\//, "");
  return validRelativePath(relative) ? `${normalizeAbsolutePath(root, windows)}/${relative}` : null;
}
