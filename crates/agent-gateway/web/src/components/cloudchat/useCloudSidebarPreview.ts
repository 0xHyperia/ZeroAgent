import { useNavigationPreview } from "@liveagent/ui/application/useNavigationPreview";

export type CloudNavigationDestination = "chat" | "library" | "cron-hub" | "customize";

const destinations: readonly CloudNavigationDestination[] = [
  "chat",
  "library",
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
