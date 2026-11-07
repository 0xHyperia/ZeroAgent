import { useNavigationPreview } from "@liveagent/ui/application/useNavigationPreview";
import type { CloudSidebarDestination } from "./CloudContextSidebar";

export type CloudNavigationDestination = CloudSidebarDestination | "cron-hub" | "customize";

const destinations: readonly CloudNavigationDestination[] = [
  "chat",
  "library",
  "devices",
  "cron-hub",
  "customize",
];
export function useCloudSidebarPreview(
  enabled: boolean,
  owner: string | number,
  {
    pinnedOpen = false,
    destination = "chat",
  }: { pinnedOpen?: boolean; destination?: CloudNavigationDestination } = {},
) {
  return useNavigationPreview(enabled, owner, { pinnedOpen, destination, destinations });
}
