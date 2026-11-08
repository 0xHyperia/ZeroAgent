import type {
  ConversationOpenOptions,
  ConversationOpenState,
} from "@liveagent/ui/lib/sidebar/openController";
import { type CloudChatRoute, cloudChatRouteHref, readCloudChatRoute } from "@/lib/cloudChatRoute";
import { desktopStorageKey } from "@/lib/desktopRemoteHost";

const SELECTED_CONVERSATION_STORAGE_KEY = "liveagent.gateway.selectedConversation.v3";

type StoredConversationSelections = Record<string, string>;

export type GatewayHistoryOpenAttempt = {
  conversationId: string;
  options?: ConversationOpenOptions;
  isCurrent: () => boolean;
};

export function failedVisibleGatewayHistoryOpen(
  state: ConversationOpenState,
  visibleId: string,
  attempt?: GatewayHistoryOpenAttempt,
) {
  if (
    state.phase === "failed" &&
    state.conversationId === visibleId &&
    attempt?.conversationId === visibleId &&
    attempt.options?.source !== "search"
  )
    return attempt;
}

function selectionStorageKey(ownerId: number) {
  return desktopStorageKey(`${SELECTED_CONVERSATION_STORAGE_KEY}:account:${ownerId}`);
}

function normalizeAgentId(agentId: string): string {
  return agentId.trim();
}

function readSelections(ownerId: number): StoredConversationSelections {
  const selections: StoredConversationSelections = Object.create(null);
  try {
    const raw = window.sessionStorage.getItem(selectionStorageKey(ownerId));
    if (!raw) return selections;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return selections;
    for (const [agentId, conversationId] of Object.entries(parsed)) {
      if (typeof conversationId !== "string" || !conversationId.trim()) continue;
      const normalizedAgentId = normalizeAgentId(agentId);
      if (normalizedAgentId) selections[normalizedAgentId] = conversationId.trim();
    }
  } catch {
    // A missing or unusable session store leaves the authenticated workbench usable.
  }
  return selections;
}

function writeSelections(selections: StoredConversationSelections, ownerId: number): void {
  try {
    window.sessionStorage.setItem(selectionStorageKey(ownerId), JSON.stringify(selections));
  } catch {
    // Session storage is an optional enhancement; private browsing may disable writes.
  }
}

export function loadGatewayConversationSelection(agentId: string, ownerId: number): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  return normalizedAgentId ? (readSelections(ownerId)[normalizedAgentId] ?? "") : "";
}

export type GatewayConversationRestoreIdentity = {
  conversationId: string;
  historyConversationId?: string | null;
  historySessionId?: string | null;
  sidebarSessionId?: string | null;
};

/** Prefer backend identity; durable relay mappings also resolve active conversation aliases. */
export function resolveGatewayConversationRestoreTarget(
  identity: GatewayConversationRestoreIdentity,
): string {
  const conversationId = identity.conversationId.trim();
  const historyConversationId = identity.historyConversationId?.trim() ?? "";
  const historySessionId = identity.historySessionId?.trim() ?? "";
  if (historySessionId && (!historyConversationId || historyConversationId === conversationId)) {
    return historySessionId;
  }
  return identity.sidebarSessionId?.trim() || conversationId;
}

export function resolveGatewayConversationLanding({
  route,
  activeDeviceId,
  savedConversationId,
}: {
  route: CloudChatRoute;
  activeDeviceId: string | undefined;
  savedConversationId: string;
}) {
  if (route.page === "chat" && route.deviceId !== undefined) {
    if (!activeDeviceId || route.deviceId !== activeDeviceId) return null;
    return { conversationId: route.id, explicit: true };
  }
  return { conversationId: savedConversationId, explicit: false };
}

export function gatewayDeviceTaskChatReturnHref({
  url,
  deviceId,
  requestedId,
  visibleConversation,
  restoredHere,
  recentConversationId,
}: {
  url: URL;
  deviceId: string;
  requestedId?: string;
  visibleConversation?: GatewayConversationRestoreIdentity;
  restoredHere: boolean;
  recentConversationId: string;
}) {
  const route = readCloudChatRoute(url);
  if (!deviceId || route.page !== "tasks" || !route.deviceView || route.target !== deviceId)
    return undefined;
  const remembered = restoredHere ? "" : recentConversationId;
  const displayed = visibleConversation
    ? resolveGatewayConversationRestoreTarget(visibleConversation)
    : remembered;
  const target = requestedId ?? displayed;
  const id = /^[a-z0-9_-]{1,128}$/i.test(target) ? target : "";
  return cloudChatRouteHref({ page: "chat", deviceId, id }, url);
}

export function saveGatewayConversationSelection(
  agentId: string,
  conversationId: string,
  ownerId: number,
): void {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedConversationId = conversationId.trim();
  if (!normalizedAgentId || !normalizedConversationId) return;
  writeSelections(
    { ...readSelections(ownerId), [normalizedAgentId]: normalizedConversationId },
    ownerId,
  );
}

export function clearGatewayConversationSelection(agentId: string, ownerId: number): void {
  const normalizedAgentId = normalizeAgentId(agentId);
  if (!normalizedAgentId) return;
  const selections = readSelections(ownerId);
  if (!(normalizedAgentId in selections)) return;
  delete selections[normalizedAgentId];
  writeSelections(selections, ownerId);
}
