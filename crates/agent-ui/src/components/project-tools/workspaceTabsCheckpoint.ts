import {
  type WorkspaceGitComparison,
  workspaceGitPathFromRoot,
  workspaceGitRelativePath,
} from "@liveagent/ui/components/project-tools/workspaceGitPaths";
import { workspaceImageRelativePathForCopy } from "@liveagent/ui/components/workspace-editor/workspaceImageViewer";
import { resolveWorkbenchLayoutStorage } from "@liveagent/ui/lib/workbench/layoutStorage";
import type {
  DesktopWorkspaceTab,
  DesktopWorkspaceView,
  WorkspaceFileRequest,
} from "./useWorkspaceTabs";
import { type BrowserHistorySnapshot, parseBrowserHistory } from "./workspaceBrowserHistory";

const STORAGE_PREFIX = "zeroagent.desktopWorkspace.routes:";
const MAX_RECORDS = 40;
const MAX_TABS = 40;
const MAX_BYTES = 192 * 1024;

export type DesktopWorkspaceCheckpointScope = {
  owner: string;
  scope: string;
  projectPathKey: string;
  workdir: string;
};
type FileRoute = { kind: "file"; path: string; mode: "preview" | "source" | "diff" };
type BrowserRoute = {
  kind: "browser";
  id: string;
  history?: BrowserHistorySnapshot;
  customTitle?: string;
};
type Snapshot = Pick<
  DesktopWorkspaceView,
  "activeId" | "treeOpen" | "treeGroups" | "treeWidth" | "comparison" | "expanded"
> & {
  open: boolean;
  tabs: (FileRoute | BrowserRoute)[];
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function workspaceFileTabId(request: WorkspaceFileRequest) {
  const root = request.workdir.replace(/\\/g, "/");
  const windowsPath = /^[a-z]:\//i.test(root) || root.startsWith("//");
  const path = workspaceImageRelativePathForCopy(root, request.path)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  return `file:${JSON.stringify([request.projectPathKey, windowsPath ? path.toLowerCase() : path])}`;
}

function relativeFilePath(workdir: string, value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return null;
  const path = workspaceGitPathFromRoot(workdir, value);
  const relative = path && workspaceGitRelativePath(workdir, path);
  if (relative && /^[a-z]:|^\\\\|^\/\//i.test(workdir) && /[:\\]/.test(relative)) return null;
  return relative;
}

function storedComparison(value: unknown): WorkspaceGitComparison {
  if (value === "staged" || value === "unstaged" || value === "branch" || value === "last-turn")
    return value;
  if (
    typeof value === "string" &&
    value.length <= 512 &&
    /^branch:refs\/(?:heads|remotes)\/.+$/.test(value)
  ) {
    // The native Git command validates the actual ref before using it.
    return value as `branch:${string}`;
  }
  return typeof value === "string" && /^commit:[a-f0-9]{7,64}$/i.test(value)
    ? (value as `commit:${string}`)
    : "working_tree";
}

function readRoutes(raw: string | null): Record<string, unknown> {
  if (!raw || raw.length > MAX_BYTES) return {};
  return record(JSON.parse(raw)) ?? {};
}

export function readDesktopWorkspaceCheckpoint(context: DesktopWorkspaceCheckpointScope) {
  try {
    const storage = resolveWorkbenchLayoutStorage();
    const routes = readRoutes(storage?.getItem(STORAGE_PREFIX + context.owner) ?? null);
    const saved = record(routes[context.scope]);
    if (!saved || !Array.isArray(saved.tabs)) return null;
    const tabs: DesktopWorkspaceTab[] = [];
    const ids = new Set<string>();
    for (const entry of saved.tabs.slice(0, MAX_TABS)) {
      const route = record(entry);
      if (!route) continue;
      let tab: DesktopWorkspaceTab;
      if (route.kind === "file") {
        const path = relativeFilePath(context.workdir, route.path);
        if (!path || !context.projectPathKey) continue;
        const mode = route.mode === "source" || route.mode === "diff" ? route.mode : "preview";
        const request = {
          id: 0,
          projectPathKey: context.projectPathKey,
          workdir: context.workdir,
          path,
        };
        tab = {
          kind: "file",
          id: workspaceFileTabId(request),
          request,
          mode,
          openedModes: [mode],
          closeRequestId: 0,
          dirty: false,
          temporary: false,
        };
      } else if (route.kind === "browser") {
        const history = parseBrowserHistory(route.history) ?? undefined;
        if (
          (route.history !== undefined && !history) ||
          typeof route.id !== "string" ||
          !/^browser:[a-f0-9-]{36}$/i.test(route.id)
        )
          continue;
        const customTitle =
          typeof route.customTitle === "string" ? route.customTitle.slice(0, 120) : undefined;
        const url = history?.index == null ? "" : history.entries[history.index];
        tab = { kind: "browser", id: route.id, url, title: "", customTitle, history };
      } else {
        continue;
      }
      if (!ids.has(tab.id)) tabs.push(tab);
      ids.add(tab.id);
    }
    const groups = record(saved.treeGroups);
    const treeOpen = saved.treeOpen === true;
    const view: DesktopWorkspaceView = {
      tabs,
      activeId:
        typeof saved.activeId === "string" && ids.has(saved.activeId)
          ? saved.activeId
          : (tabs.at(-1)?.id ?? null),
      treeOpen,
      treeGroups: { changes: groups?.changes !== false, files: groups?.files !== false },
      treeWidth:
        typeof saved.treeWidth === "number" && Number.isFinite(saved.treeWidth)
          ? Math.min(1500, Math.max(200, saved.treeWidth))
          : 250,
      comparison: storedComparison(saved.comparison),
      expanded: saved.expanded === true,
      closed: [],
    };
    return { view, open: saved.open === true && (tabs.length > 0 || treeOpen) };
  } catch {
    return null;
  }
}

export function saveDesktopWorkspaceCheckpoint(
  context: DesktopWorkspaceCheckpointScope,
  view: DesktopWorkspaceView,
  open: boolean,
) {
  const tabs: Snapshot["tabs"] = [];
  let activeId: string | null = null;
  for (const tab of view.tabs) {
    if (tabs.length === MAX_TABS) break;
    if (tab.kind === "file") {
      if (
        tab.temporary ||
        tab.request.remote ||
        tab.request.projectPathKey !== context.projectPathKey
      )
        continue;
      const path = relativeFilePath(context.workdir, tab.request.path);
      if (!path) continue;
      tabs.push({ kind: "file", path, mode: tab.mode });
    } else {
      const history = parseBrowserHistory(tab.history);
      if (tab.url && !history?.entries.length) continue;
      const resume = history?.index == null ? "" : history.entries[history.index];
      tabs.push({
        kind: "browser",
        id: tab.id,
        history: history
          ? { entries: history.entries, index: resume === tab.url ? history.index : null }
          : undefined,
        customTitle: tab.customTitle?.slice(0, 120),
      });
    }
    if (tab.id === view.activeId) activeId = tab.id;
  }
  const { treeOpen, treeGroups, treeWidth, comparison, expanded } = view;
  const snapshot: Snapshot = {
    tabs,
    activeId,
    treeOpen,
    treeGroups,
    treeWidth,
    comparison,
    expanded,
    open,
  };
  try {
    const storage = resolveWorkbenchLayoutStorage();
    if (!storage) return;
    const key = STORAGE_PREFIX + context.owner;
    const routes = readRoutes(storage.getItem(key));
    if (JSON.stringify(routes[context.scope]) === JSON.stringify(snapshot)) return;
    delete routes[context.scope];
    const entries = [...Object.entries(routes).slice(1 - MAX_RECORDS), [context.scope, snapshot]];
    let raw = JSON.stringify(Object.fromEntries(entries));
    while (raw.length > MAX_BYTES && entries.length > 1) {
      entries.shift();
      raw = JSON.stringify(Object.fromEntries(entries));
    }
    if (raw.length <= MAX_BYTES) storage.setItem(key, raw);
  } catch {
    // A disabled or full storage area leaves the in-memory workbench usable.
  }
}
