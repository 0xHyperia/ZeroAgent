import {
  Blend,
  Brain,
  Cable,
  CalendarDays,
  Clock3,
  ImageIcon,
  NavigationChat,
  NavigationChatFilled,
  NavigationDevices,
  NavigationLibrary,
  NavigationLibraryFilled,
  Package,
} from "../components/IconSet";
import {
  normalizeSidebarShortcuts,
  SIDEBAR_SHORTCUTS,
  type SidebarShortcuts,
} from "../lib/settings/sidebarShortcuts";
import type { ApplicationRailItem } from "./ApplicationRail";
import type { ApplicationViewId } from "./ApplicationView";

const featureIcons = {
  skills: Package,
  mcp: Cable,
  cron: Clock3,
  planning: CalendarDays,
  "image-studio": ImageIcon,
  memory: Brain,
};
const primaryIcons = {
  chat: NavigationChat,
  library: NavigationLibrary,
  devices: NavigationDevices,
  customize: Blend,
};
const activeIcons = { chat: NavigationChatFilled, library: NavigationLibraryFilled };
export type WorkbenchNavigationId = ApplicationViewId | "library" | "devices" | "customize";

/** One definition feeds rail and sidebar; visibility preferences never grant capabilities. */
export function getWorkbenchFeatureNavigation(shortcuts?: SidebarShortcuts) {
  const visible = normalizeSidebarShortcuts(shortcuts);
  return SIDEBAR_SHORTCUTS.filter(({ id }) => visible[id]).map((item) => ({
    ...item,
    view: `${item.id}-hub` as ApplicationViewId,
    icon: featureIcons[item.id],
  }));
}

export const DEVICE_WORKBENCH_NAVIGATION: readonly ApplicationViewId[] = [
  "chat",
  ...getWorkbenchFeatureNavigation().map(({ view }) => view),
];

export function createWorkbenchNavigationItem(
  id: WorkbenchNavigationId,
  label: string,
  onSelect: () => void,
): ApplicationRailItem {
  if (id === "chat" || id === "library" || id === "devices" || id === "customize") {
    const Icon = primaryIcons[id];
    const ActiveIcon = id === "chat" || id === "library" ? activeIcons[id] : undefined;
    return {
      id,
      label,
      onSelect,
      icon: <Icon className="size-5" aria-hidden="true" />,
      activeIcon: ActiveIcon ? <ActiveIcon className="size-5" aria-hidden="true" /> : undefined,
    };
  }
  const resource = SIDEBAR_SHORTCUTS.find((item) => id === `${item.id}-hub`);
  if (!resource) throw new Error(`Unknown workbench navigation: ${id}`);
  const Icon = featureIcons[resource.id];
  return { id, label, onSelect, icon: <Icon className="size-5" aria-hidden="true" /> };
}
