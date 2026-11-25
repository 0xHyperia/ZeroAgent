import { onDemand } from "@liveagent/ui/components/OnDemand";
import { GatewaySessionEntry, GatewayStartupStatus } from "@/app/GatewaySessionEntry";

const GatewayWorkbench = onDemand(
  async () => (await import("@/app/GatewayApp")).GatewayWorkbench,
  <GatewayStartupStatus label="正在打开工作台" />,
);

export default function App() {
  return (
    <GatewaySessionEntry>
      {(session, historyShareToken) => (
        <GatewayWorkbench session={session} historyShareToken={historyShareToken} />
      )}
    </GatewaySessionEntry>
  );
}
