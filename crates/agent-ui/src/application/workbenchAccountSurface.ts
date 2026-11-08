import type { MentionComposerSkillMention } from "../components/chat/MentionComposerModel";

/** The active desktop shell lends the account view its canvas and sidebar. */
export type WorkbenchAccountDestination = "library" | "customize" | "chat";

export type WorkbenchAccountLayout = {
  sidebarTarget: HTMLElement | null;
  sidebarOpen: boolean;
  sidebarPreview: boolean;
  onSidebarOpenChange: (open: boolean) => void;
  onPinSidebar: () => void;
  onClose: () => void;
  onUseDeviceSkill?: (skill: MentionComposerSkillMention) => void;
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
  openDestination: (
    destination: Exclude<WorkbenchAccountDestination, "chat">,
    href?: string,
  ) => void;
  close: (afterClose?: () => void) => void;
};

export function createWorkbenchAccountNavigation(
  open: (href: string) => WorkbenchAccountDestination,
  readDestinationHref: (destination: Exclude<WorkbenchAccountDestination, "chat">) => string,
) {
  let destination: WorkbenchAccountDestination | null = null;
  let navigationGuard: ((navigate: () => void) => void) | undefined;
  const listeners = new Set<() => void>();
  const update = (next: WorkbenchAccountDestination | null) => {
    if (destination === next) return;
    destination = next;
    for (const listener of listeners) listener();
  };
  const request = (navigate: () => void) => {
    const guard = navigationGuard;
    if (!destination || !guard) return navigate();
    guard(() => {
      if (navigationGuard === guard) navigate();
    });
  };
  return {
    getDestination: () => destination,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (href: string) => request(() => update(open(href))),
    openDestination(next: Exclude<WorkbenchAccountDestination, "chat">, href?: string) {
      request(() => update(open(href ?? readDestinationHref(next))));
    },
    close: (afterClose?: () => void) =>
      request(() => {
        update(null);
        afterClose?.();
      }),
    registerNavigationGuard(guard: NonNullable<typeof navigationGuard>) {
      navigationGuard = guard;
      return () => {
        if (navigationGuard === guard) navigationGuard = undefined;
      };
    },
    followRoute(next: WorkbenchAccountDestination) {
      if (destination) update(next);
    },
  };
}
