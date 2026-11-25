import { parseDynamicMcpToolName } from "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils";
import type { McpServerLabels } from "@liveagent/ui/components/chat/assistant-bubble/McpServerLabelsContext";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createKBrainClient } from "./client";
import { subscribeKBrainMcpSettingsSaved } from "./mcp";
import { getKBrainRuntimeConnection, subscribeKBrainRuntimeConnection } from "./runtimeConnection";

const emptyLabels = new Map<string, string>();

function readLabels(response: unknown): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  const tools = (response as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return labels;
  for (const value of tools) {
    const tool = value as { name?: unknown; serverLabel?: unknown; serverId?: unknown } | null;
    if (!tool || typeof tool.name !== "string") continue;
    if (!tool.name.startsWith("mcp__")) continue;
    const serverKey = parseDynamicMcpToolName(tool.name)?.serverId;
    const label = [tool.serverLabel, tool.serverId].find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0 && value.trim() !== serverKey,
    );
    if (serverKey && label && !labels.has(serverKey))
      labels.set(serverKey, label.trim().slice(0, 140));
  }
  return labels;
}

export function useMcpServerLabels(account: string, active: boolean): McpServerLabels {
  const connection = useSyncExternalStore(
    subscribeKBrainRuntimeConnection,
    getKBrainRuntimeConnection,
  );
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeKBrainMcpSettingsSaved(() => setRevision((value) => value + 1)), []);
  const scope = useMemo(
    () => ({ account, active, connection, revision }),
    [account, active, connection, revision],
  );
  const liveScope = useRef<typeof scope | null>(scope);
  liveScope.current = scope;
  useEffect(() => {
    liveScope.current = scope;
    return () => {
      if (liveScope.current === scope) liveScope.current = null;
    };
  }, [scope]);
  const [snapshot, setSnapshot] = useState<{
    scope: typeof scope;
    labels: ReadonlyMap<string, string>;
  }>();
  const lastRequest = useRef<typeof scope | null>(null);
  const request = useCallback(() => {
    if (!scope.active || !scope.connection?.managedLocal || lastRequest.current === scope) return;
    lastRequest.current = scope;
    void createKBrainClient()
      .discoverMcpTools()
      .then(
        (response) => {
          if (liveScope.current === scope && getKBrainRuntimeConnection() === scope.connection) {
            setSnapshot({ scope, labels: readLabels(response) });
          }
        },
        () => {},
      );
  }, [scope]);
  const labels = snapshot?.scope === scope ? snapshot.labels : emptyLabels;
  return useMemo(() => ({ labels, request }), [labels, request]);
}
