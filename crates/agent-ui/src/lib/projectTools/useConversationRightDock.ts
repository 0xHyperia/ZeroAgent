import {
  normalizeRightDockProjectState,
  openRightDockToolTabState,
  type RightDockProjectState,
  type RightDockToolKind,
} from "@liveagent/app/lib/settings";
import { type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { getManagedProcessState } from "../managed-process/store";
import type { ProjectToolSurfaceKind } from "../workbench/types";
import { closeDockToolForPane } from "./releaseProjectToolFromDock";

type DockView = {
  open: boolean;
  toolsByProject: ReadonlyMap<string, RightDockProjectState>;
};

const EMPTY_PROJECT_STATE = normalizeRightDockProjectState({});
const EMPTY_VIEW: DockView = { open: false, toolsByProject: new Map() };
const EMPTY_VIEWS: ReadonlyMap<string, DockView> = new Map();

export function useConversationRightDock(owner: string, conversationId: string) {
  const [state, setState] = useState({ owner, views: EMPTY_VIEWS });
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const views = state.owner === owner ? state.views : EMPTY_VIEWS;
  const view = views.get(conversationId) ?? EMPTY_VIEW;

  useEffect(() => {
    setState((current) => (current.owner === owner ? current : { owner, views: EMPTY_VIEWS }));
  }, [owner]);

  const updateViews = useCallback(
    (update: (current: ReadonlyMap<string, DockView>) => ReadonlyMap<string, DockView>) => {
      setState((current) => {
        if (ownerRef.current !== owner) return current;
        const views = current.owner === owner ? current.views : EMPTY_VIEWS;
        const next = update(views);
        return next === views ? current : { owner, views: next };
      });
    },
    [owner],
  );

  const updateView = useCallback(
    (id: string, update: (current: DockView) => DockView) => {
      if (!id) return;
      updateViews((views) => {
        const current = views.get(id) ?? EMPTY_VIEW;
        const next = update(current);
        return next === current ? views : new Map(views).set(id, next);
      });
    },
    [updateViews],
  );

  const setRightDockOpen = useCallback(
    (action: SetStateAction<boolean>) => {
      updateView(conversationId, (current) => {
        const open = typeof action === "function" ? action(current.open) : action;
        return open === current.open ? current : { ...current, open };
      });
    },
    [conversationId, updateView],
  );

  const updateToolState = useCallback(
    (
      projectPathKey: string,
      update: (current: RightDockProjectState) => RightDockProjectState,
      targetConversationId = conversationId,
    ) => {
      updateView(targetConversationId, (view) => {
        const current = view.toolsByProject.get(projectPathKey) ?? EMPTY_PROJECT_STATE;
        const next = update(current);
        if (next === current) return view;
        return { ...view, toolsByProject: new Map(view.toolsByProject).set(projectPathKey, next) };
      });
    },
    [conversationId, updateView],
  );

  const openToolTab = useCallback(
    (projectPathKey: string, kind: RightDockToolKind, targetConversationId?: string) => {
      if (projectPathKey) {
        updateToolState(
          projectPathKey,
          (state) => openRightDockToolTabState(state, kind),
          targetConversationId,
        );
      }
    },
    [updateToolState],
  );

  const moveConversation = useCallback(
    (previousId: string, nextId: string) => {
      if (previousId === nextId) return;
      updateViews((views) => {
        const previous = views.get(previousId);
        if (!previous) return views;
        const next = new Map(views);
        next.delete(previousId);
        if (!next.has(nextId)) next.set(nextId, previous);
        return next;
      });
    },
    [updateViews],
  );

  const closeToolForPane = useCallback(
    (tool: ProjectToolSurfaceKind, projectPathKey: string) => {
      const visibleIds =
        tool === "backgroundTasks"
          ? getManagedProcessState().processes.map((process) => process.id)
          : [];
      updateToolState(projectPathKey, (current) => closeDockToolForPane(current, tool, visibleIds));
    },
    [updateToolState],
  );

  return {
    rightDockOpen: view.open,
    setRightDockOpen,
    getToolState: (projectPathKey: string) =>
      view.toolsByProject.get(projectPathKey) ?? EMPTY_PROJECT_STATE,
    updateToolState,
    openToolTab,
    closeToolForPane,
    moveConversation,
  };
}
