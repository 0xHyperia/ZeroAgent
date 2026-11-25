import { hasFrozenCapability } from "@liveagent/ui/lib/kbrain/health";
import {
  KBRAIN_MCP_TOOL_SERVER_IDS_CAPABILITY,
  KBRAIN_MCP_TOOL_VISIBILITY_CAPABILITY,
} from "@liveagent/ui/lib/mcp/toolCall";
import type { McpServerRuntimeStatus, McpStatusAdapter } from "@liveagent/ui/lib/resourceHost";
import { createKBrainClient } from "../lib/kbrain/client";
import {
  kbrainMcpStatuses,
  kbrainMcpToolSummaries,
  reconnectKBrainMcp,
  subscribeKBrainMcpSettingsSaved,
} from "../lib/kbrain/mcp";
import {
  getKBrainRuntimeConnection,
  subscribeKBrainRuntimeConnection,
} from "../lib/kbrain/runtimeConnection";

async function readStatuses(reconnect = false): Promise<McpServerRuntimeStatus[]> {
  const connection = getKBrainRuntimeConnection();
  const client = createKBrainClient(connection ?? undefined);
  const statuses = reconnect
    ? await reconnectKBrainMcp(client)
    : kbrainMcpStatuses(await client.getMcpSettings());
  if (getKBrainRuntimeConnection() !== connection) return [];
  if (!statuses.length || statuses.some(({ status }) => status === "connecting")) return statuses;

  try {
    const health = await client.getHealth();
    if (getKBrainRuntimeConnection() !== connection) return [];
    if (!hasFrozenCapability(health, KBRAIN_MCP_TOOL_SERVER_IDS_CAPABILITY)) return statuses;
    const bodies = await Promise.all([
      client.discoverMcpTools(),
      ...(hasFrozenCapability(health, KBRAIN_MCP_TOOL_VISIBILITY_CAPABILITY)
        ? [client.discoverMcpTools({ audience: "app" })]
        : []),
    ]);
    if (getKBrainRuntimeConnection() !== connection) return [];
    const summaries = kbrainMcpToolSummaries(bodies);
    return statuses.map((status) => ({ ...status, ...summaries.get(status.id) }));
  } catch {
    return getKBrainRuntimeConnection() === connection ? statuses : [];
  }
}

/** MCP Hub status and reconnect, read from K-brain's /v1/mcp. */
export const kbrainMcpStatusAdapter: McpStatusAdapter = {
  statuses: () => readStatuses(),
  reconnect: () => readStatuses(true),
  subscribe: (listener) => {
    const unsubscribeSettings = subscribeKBrainMcpSettingsSaved(listener);
    const unsubscribeConnection = subscribeKBrainRuntimeConnection(listener);
    return () => {
      unsubscribeSettings();
      unsubscribeConnection();
    };
  },
  supportsServerNames: async () => {
    const connection = getKBrainRuntimeConnection();
    const health = await createKBrainClient(connection ?? undefined)
      .getHealth()
      .catch(() => null);
    return Boolean(
      health &&
        getKBrainRuntimeConnection() === connection &&
        hasFrozenCapability(health, KBRAIN_MCP_TOOL_SERVER_IDS_CAPABILITY),
    );
  },
};
