import { useSyncExternalStore } from "react";

/** Presentation-only bridge: the owning workbench retains navigation and account state. */
export type WorkbenchNavigationPortal = {
  getSnapshot: () => HTMLElement | null;
  subscribe: (listener: () => void) => () => void;
  requestLeave: () => boolean;
};

export function createWorkbenchNavigationPortal(requestLeave: () => boolean) {
  let target: HTMLElement | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => target,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requestLeave,
    setTarget(next: HTMLElement | null) {
      if (target === next) return;
      target = next;
      for (const listener of listeners) listener();
    },
  };
}

const noTarget = () => null;
const noSubscribe = () => () => {};

export function useWorkbenchNavigationTarget(portal?: WorkbenchNavigationPortal) {
  return useSyncExternalStore(
    portal?.subscribe ?? noSubscribe,
    portal?.getSnapshot ?? noTarget,
    noTarget,
  );
}
