import type { WorkspaceGitComparison } from "@liveagent/ui/components/project-tools/workspaceGitPaths";
import type { WorkspaceCodeEditorOpenRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceCodeEditorOverlay";
import type { WorkspaceFilePreviewOpenRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceFilePreviewOverlay";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BrowserHistorySnapshot } from "./workspaceBrowserHistory";
import {
  type DesktopWorkspaceCheckpointScope,
  readDesktopWorkspaceCheckpoint,
  saveDesktopWorkspaceCheckpoint,
  workspaceFileTabId,
} from "./workspaceTabsCheckpoint";

export { workspaceFileTabId } from "./workspaceTabsCheckpoint";

export type WorkspaceFileMode = "preview" | "source" | "diff";
export type WorkspaceFileRequest = Omit<
  WorkspaceCodeEditorOpenRequest & WorkspaceFilePreviewOpenRequest,
  "id"
>;

type FileTab = {
  kind: "file";
  id: string;
  request: WorkspaceFileRequest & { id: number };
  mode: WorkspaceFileMode;
  openedModes: readonly WorkspaceFileMode[];
  closeRequestId: number;
  dirty: boolean;
  temporary: boolean;
};

type BrowserTab = {
  kind: "browser";
  id: string;
  url: string;
  title: string;
  faviconDataUrl?: string;
  customTitle?: string;
  reloadToken?: number;
  history?: BrowserHistorySnapshot;
};

export type DesktopWorkspaceTab = FileTab | BrowserTab;
export type DesktopWorkspaceView = {
  tabs: readonly DesktopWorkspaceTab[];
  activeId: string | null;
  treeOpen: boolean;
  treeGroups: { changes: boolean; files: boolean };
  treeWidth: number;
  comparison: WorkspaceGitComparison;
  expanded: boolean;
  closed: readonly DesktopWorkspaceTab[];
};

const EMPTY_VIEW: DesktopWorkspaceView = {
  tabs: [],
  activeId: null,
  treeOpen: false,
  treeGroups: { changes: true, files: true },
  treeWidth: 250,
  comparison: "working_tree",
  expanded: false,
  closed: [],
};

type Views = ReadonlyMap<string, DesktopWorkspaceView>;
const EMPTY_VIEWS: Views = new Map();

type WorkspacePersistence = {
  projectPathKey: string;
  workdir: string;
  open: boolean;
  setOpen(open: boolean): void;
};

export function useWorkspaceTabs(
  owner: string,
  scope: string,
  reveal: () => void,
  persistence?: WorkspacePersistence,
) {
  const account = useMemo(() => Symbol(owner), [owner]);
  const [store, setStore] = useState({ account, views: EMPTY_VIEWS });
  const views = store.account === account ? store.views : EMPTY_VIEWS;
  const { projectPathKey, workdir, open, setOpen } = persistence ?? {};
  const checkpointScope = useMemo(
    () =>
      projectPathKey !== undefined && workdir !== undefined
        ? { owner, scope, projectPathKey, workdir }
        : null,
    [owner, scope, projectPathKey, workdir],
  );
  const restored = useMemo(
    () => checkpointScope && readDesktopWorkspaceCheckpoint(checkpointScope),
    [checkpointScope],
  );
  const storedView = views.get(scope);
  const view = storedView ?? restored?.view ?? EMPTY_VIEW;
  const visited = useRef({ account, scopes: new Set<string>() });
  const restoringOpen = useRef<{ scope: string; open: boolean } | null>(null);
  const checkpoints = useRef({
    account,
    routes: new Map<
      string,
      { context: DesktopWorkspaceCheckpointScope; view: DesktopWorkspaceView; open: boolean }
    >(),
  });
  const current = useRef({ account, scope });
  current.current = { account, scope };
  const sequence = useRef(0);

  useEffect(() => {
    setStore((previous) =>
      previous.account === account ? previous : { account, views: EMPTY_VIEWS },
    );
  }, [account]);

  const updateView = useCallback(
    (update: (view: DesktopWorkspaceView) => DesktopWorkspaceView, targetScope = scope) => {
      setStore((previous) => {
        if (current.current.account !== account) return previous;
        const before = previous.account === account ? previous.views : EMPTY_VIEWS;
        const existing =
          before.get(targetScope) ?? (targetScope === scope ? restored?.view : null) ?? EMPTY_VIEW;
        const next = update(existing);
        return next === existing
          ? previous
          : { account, views: new Map(before).set(targetScope, next) };
      });
    },
    [account, restored, scope],
  );

  useLayoutEffect(() => {
    if (!checkpointScope) return;
    if (visited.current.account !== account) {
      visited.current = { account, scopes: new Set() };
      restoringOpen.current = null;
    }
    if (visited.current.scopes.has(scope)) return;
    visited.current.scopes.add(scope);
    if (storedView || !restored) return;
    setStore((previous) => {
      const before = previous.account === account ? previous.views : EMPTY_VIEWS;
      return before.has(scope)
        ? previous
        : { account, views: new Map(before).set(scope, restored.view) };
    });
    if (open !== restored.open) {
      restoringOpen.current = { scope, open: restored.open };
      setOpen?.(restored.open);
    }
  }, [account, checkpointScope, open, restored, scope, setOpen, storedView]);

  useEffect(() => {
    if (checkpoints.current.account !== account)
      checkpoints.current = { account, routes: new Map() };
    const { routes } = checkpoints.current;
    for (const [target, saved] of routes) {
      if (target === scope) continue;
      const view = views.get(target);
      if (view && view !== saved.view) {
        saveDesktopWorkspaceCheckpoint(saved.context, view, saved.open);
        saved.view = view;
      }
    }
    if (!checkpointScope || !storedView || open === undefined) return;
    const pending = restoringOpen.current;
    if (pending?.scope === scope) {
      if (pending.open !== open) return;
      restoringOpen.current = null;
    }
    saveDesktopWorkspaceCheckpoint(checkpointScope, storedView, open);
    routes.set(scope, { context: checkpointScope, view: storedView, open });
  }, [account, checkpointScope, open, scope, storedView, views]);

  const openFile = useCallback(
    (request: WorkspaceFileRequest, mode: WorkspaceFileMode, temporary = false) => {
      if (current.current.account !== account || current.current.scope !== scope) return;
      const id = workspaceFileTabId(request);
      const next = { ...request, id: ++sequence.current };
      reveal();
      updateView((state) => {
        const existing = state.tabs.find((tab) => tab.id === id);
        if (existing?.kind === "file") {
          return {
            ...state,
            activeId: id,
            tabs: state.tabs.map((tab) =>
              tab === existing
                ? {
                    ...existing,
                    temporary: existing.temporary && temporary,
                    request: next.line
                      ? {
                          ...existing.request,
                          line: next.line,
                          endLine: next.endLine,
                          column: next.column,
                          id: next.id,
                        }
                      : existing.request,
                    mode,
                    openedModes: existing.openedModes.includes(mode)
                      ? existing.openedModes
                      : [...existing.openedModes, mode],
                  }
                : tab,
            ),
          };
        }
        const tab: FileTab = {
          kind: "file",
          id,
          request: next,
          mode,
          openedModes: [mode],
          closeRequestId: 0,
          dirty: false,
          temporary,
        };
        const preview = temporary
          ? state.tabs.findIndex((item) => item.kind === "file" && item.temporary && !item.dirty)
          : -1;
        const tabs = [...state.tabs];
        tabs.splice(preview === -1 ? tabs.length : preview, preview === -1 ? 0 : 1, tab);
        return { ...state, activeId: id, tabs };
      });
    },
    [account, reveal, scope, updateView],
  );

  const openBrowser = useCallback(
    (
      url = "",
      afterId?: string,
      foreground = true,
      targetScope = scope,
      history?: BrowserHistorySnapshot,
    ) => {
      if (current.current.account !== account || current.current.scope !== scope) return;
      const id = `browser:${createUuid()}`;
      if (foreground && targetScope === scope) reveal();
      updateView((state) => {
        const tabs = [...state.tabs];
        const index = tabs.findIndex((tab) => tab.id === afterId);
        if (targetScope !== scope && index < 0) return state;
        tabs.splice(index < 0 ? tabs.length : index + 1, 0, {
          kind: "browser",
          id,
          url,
          title: "",
          history,
        });
        return { ...state, tabs, activeId: foreground ? id : state.activeId };
      }, targetScope);
    },
    [account, reveal, scope, updateView],
  );

  return useMemo(() => {
    function updateBrowser(
      id: string,
      patch: Partial<
        Pick<
          BrowserTab,
          "url" | "title" | "faviconDataUrl" | "customTitle" | "reloadToken" | "history"
        >
      >,
      targetScope: string,
    ) {
      updateView((state) => {
        const tab = state.tabs.find((item) => item.id === id);
        if (
          tab?.kind !== "browser" ||
          Object.entries(patch).every(([key, value]) => tab[key as keyof BrowserTab] === value)
        )
          return state;
        return {
          ...state,
          tabs: state.tabs.map((item) => (item === tab ? { ...tab, ...patch } : item)),
        };
      }, targetScope);
    }

    function close(id: string, targetScope = scope) {
      updateView((state) => {
        const index = state.tabs.findIndex((tab) => tab.id === id);
        if (index === -1) return state;
        const tabs = state.tabs.filter((tab) => tab.id !== id);
        const activeId =
          state.activeId === id ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null) : state.activeId;
        return {
          ...state,
          tabs,
          activeId,
          closed: [state.tabs[index], ...state.closed].slice(0, 12),
        };
      }, targetScope);
    }

    return {
      view,
      views,
      openFile,
      openBrowser,
      updateBrowser,
      close,
      reopen: () =>
        updateView((state) => {
          const [tab, ...closed] = state.closed;
          if (!tab) return state;
          const restored =
            tab.kind === "file"
              ? { ...tab, closeRequestId: 0, dirty: false, temporary: false }
              : tab;
          const tabs = state.tabs.some((existing) => existing.id === tab.id)
            ? state.tabs
            : [...state.tabs, restored];
          return { ...state, tabs, activeId: tab.id, closed };
        }),
      move: (id: string, target: string) =>
        updateView((state) => {
          const from = state.tabs.findIndex((tab) => tab.id === id);
          const to = state.tabs.findIndex((tab) => tab.id === target);
          if (from < 0 || to < 0 || from === to) return state;
          const tabs = [...state.tabs];
          const [tab] = tabs.splice(from, 1);
          tabs.splice(to, 0, tab);
          return { ...state, tabs };
        }),
      setFileDirty: (id: string, dirty: boolean, targetScope: string) =>
        updateView((state) => {
          const tab = state.tabs.find((entry) => entry.id === id);
          if (tab?.kind !== "file" || tab.dirty === dirty) return state;
          return {
            ...state,
            tabs: state.tabs.map((entry) =>
              entry === tab ? { ...tab, dirty, temporary: tab.temporary && !dirty } : entry,
            ),
          };
        }, targetScope),
      activate: (id: string | null) =>
        updateView((state) => (state.activeId === id ? state : { ...state, activeId: id })),
      keepFileOpen: (id: string) =>
        updateView((state) => {
          const tab = state.tabs.find((entry) => entry.id === id);
          if (tab?.kind !== "file" || !tab.temporary) return state;
          return {
            ...state,
            tabs: state.tabs.map((entry) => (entry === tab ? { ...tab, temporary: false } : entry)),
          };
        }),
      toggleTree: () => updateView((state) => ({ ...state, treeOpen: !state.treeOpen })),
      openTree: () =>
        updateView((state) => (state.treeOpen ? state : { ...state, treeOpen: true })),
      toggleTreeGroup: (group: "changes" | "files") =>
        updateView((state) => ({
          ...state,
          treeGroups: { ...state.treeGroups, [group]: !state.treeGroups[group] },
        })),
      setTreeWidth: (treeWidth: number) =>
        updateView((state) => (state.treeWidth === treeWidth ? state : { ...state, treeWidth })),
      setComparison: (comparison: WorkspaceGitComparison) =>
        updateView((state) => (state.comparison === comparison ? state : { ...state, comparison })),
      toggleExpanded: () => updateView((state) => ({ ...state, expanded: !state.expanded })),
      requestCloseFile: (id: string) => {
        const tab = view.tabs.find((entry) => entry.id === id);
        if (tab?.kind !== "file") return;
        if (!tab.dirty) {
          close(id);
          return;
        }
        const closeRequestId = ++sequence.current;
        updateView((state) => ({
          ...state,
          activeId: id,
          tabs: state.tabs.map((entry) =>
            entry.id === id && entry.kind === "file" ? { ...entry, closeRequestId } : entry,
          ),
        }));
      },
    };
  }, [openBrowser, openFile, scope, updateView, view, views]);
}
