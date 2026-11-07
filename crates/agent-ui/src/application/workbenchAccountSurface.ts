/** The active desktop shell lends the account view its canvas and sidebar. */
export type WorkbenchAccountDestination = "library" | "customize" | "chat";

export type WorkbenchAccountLayout = {
  sidebarTarget: HTMLElement | null;
  sidebarOpen: boolean;
  sidebarPreview: boolean;
  onSidebarOpenChange: (open: boolean) => void;
  onPinSidebar: () => void;
  onClose: () => void;
};

export type WorkbenchAccountSurface = {
  target: HTMLElement;
  layout: WorkbenchAccountLayout;
  openTasks?: () => void;
};

export type WorkbenchAccountNavigation = {
  getDestination: () => WorkbenchAccountDestination | null;
  subscribe: (listener: () => void) => () => void;
  open: (href: string) => void;
  close: () => void;
};

export function createWorkbenchAccountNavigation(
  open: (href: string) => WorkbenchAccountDestination,
) {
  let destination: WorkbenchAccountDestination | null = null;
  const listeners = new Set<() => void>();
  const update = (next: WorkbenchAccountDestination | null) => {
    if (destination === next) return;
    destination = next;
    for (const listener of listeners) listener();
  };
  return {
    getDestination: () => destination,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (href: string) => update(open(href)),
    close: () => update(null),
    followRoute(next: WorkbenchAccountDestination) {
      if (destination) update(next);
    },
  };
}
