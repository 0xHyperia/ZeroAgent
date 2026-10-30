import { useNavigationPreview } from "@liveagent/ui/application/useNavigationPreview";
import type { CloudSidebarDestination } from "./CloudContextSidebar";

const destinations: readonly CloudSidebarDestination[] = ["chat", "library", "devices"];
export function useCloudSidebarPreview(
  enabled: boolean,
  owner: string | number,
  {
    pinnedOpen = false,
    destination = "chat",
  }: { pinnedOpen?: boolean; destination?: CloudSidebarDestination } = {},
) {
  return useNavigationPreview(enabled, owner, { pinnedOpen, destination, destinations });
}
