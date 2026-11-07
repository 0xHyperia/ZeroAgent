import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import type {
  WorkbenchAccountNavigation,
  WorkbenchAccountSurface,
} from "./workbenchAccountSurface";

const noDestination = () => null;
const noSubscription = () => () => undefined;

export function useWorkbenchAccountDestination(navigation?: WorkbenchAccountNavigation) {
  return useSyncExternalStore(
    navigation?.subscribe ?? noSubscription,
    navigation?.getDestination ?? noDestination,
  );
}

export function useWorkbenchAccountSurface({
  bind,
  enabled,
  sidebarVisible,
  sidebarOpen,
  sidebarPreview,
  setSidebarOpen,
  dismissPreview,
  close,
  openTasks,
}: {
  bind?: (surface: WorkbenchAccountSurface | null) => void;
  enabled: boolean;
  sidebarVisible: boolean;
  sidebarOpen: boolean;
  sidebarPreview: boolean;
  setSidebarOpen: (open: boolean) => void;
  dismissPreview: () => void;
  close?: () => void;
  openTasks?: () => void;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [sidebarTarget, setSidebarTarget] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!enabled || !bind || !target || !close) return;
    bind({
      target,
      openTasks,
      layout: {
        sidebarTarget: sidebarVisible ? sidebarTarget : null,
        sidebarOpen,
        sidebarPreview,
        onSidebarOpenChange: setSidebarOpen,
        onPinSidebar() {
          dismissPreview();
          setSidebarOpen(true);
        },
        onClose: close,
      },
    });
  }, [
    bind,
    enabled,
    target,
    sidebarTarget,
    sidebarVisible,
    sidebarOpen,
    sidebarPreview,
    setSidebarOpen,
    dismissPreview,
    close,
    openTasks,
  ]);
  useLayoutEffect(() => {
    if (enabled && bind) return () => bind(null);
  }, [bind, enabled]);
  return { setTarget, setSidebarTarget };
}
