import { type CloudChatPresentation, parseCloudChatPresentation } from "./cloudChatPresentation";

export type CloudChatMessage = {
  id: string;
  conversation_id?: string;
  role: "user" | "assistant";
  content: unknown;
  created_at?: string;
  content_omitted?: boolean;
  content_bytes?: number;
  content_sha256?: string;
  presentation?: CloudChatPresentation;
  presentation_omitted?: boolean;
};
export type CloudChatHistoryPage = {
  messages: CloudChatMessage[];
  nextBeforeId: string;
  hasMore: boolean;
};
type Request = (path: string, init?: RequestInit) => Promise<Response>;
type CaptureGuard = () => () => void;
const LIST_BYTES = 2 * 1024 * 1024 + 512 * 1024;
const MESSAGE_BYTES = 32 * 1024 * 1024 + 64 * 1024;
function opaqueId(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error("消息标识无效");
  return encodeURIComponent(value);
}
export class CloudChatHistoryError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "账户会话已过期，请重新登录。"
        : status === 404
          ? "消息不存在或已不可访问。"
          : status === 413
            ? "这条消息超过单条查看上限，请导出对话或缩小资料后继续。"
            : "暂时无法读取对话消息，请重试。",
    );
  }
}
export function parseCloudChatHistoryMessage(
  value: unknown,
  conversationId: string,
): CloudChatMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("消息响应无效");
  const item = value as CloudChatMessage;
  opaqueId(item.id);
  if (
    !["user", "assistant"].includes(item.role) ||
    (item.conversation_id !== undefined && item.conversation_id !== conversationId) ||
    (item.content_omitted !== undefined && typeof item.content_omitted !== "boolean") ||
    (item.presentation_omitted !== undefined && typeof item.presentation_omitted !== "boolean") ||
    (item.content_bytes !== undefined &&
      (!Number.isSafeInteger(item.content_bytes) || item.content_bytes < 0)) ||
    (item.content_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(item.content_sha256))
  )
    throw new Error("消息响应无效");
  if (
    item.content_omitted
      ? item.content !== null || item.content_bytes === undefined || !item.content_sha256
      : typeof item.content !== "string" && !Array.isArray(item.content)
  )
    throw new Error("消息正文响应无效");
  if (item.presentation !== undefined && item.presentation !== null) {
    if (item.role !== "assistant" || item.presentation_omitted) throw new Error("消息过程响应无效");
    return { ...item, presentation: parseCloudChatPresentation(item.presentation) };
  }
  return { ...item, presentation: undefined };
}
async function json(response: Response, maximum: number, guard: () => void) {
  guard();
  if (!response.ok) {
    await response.body?.cancel();
    throw new CloudChatHistoryError(response.status);
  }
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maximum))) {
    await response.body?.cancel();
    throw new Error("消息响应超过大小限制");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("消息响应为空");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "",
    bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      guard();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) throw new Error("消息响应超过大小限制");
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    guard();
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("消息响应无效");
    return data as Record<string, unknown>;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function createCloudChatHistoryClient(request: Request, captureGuard: CaptureGuard) {
  async function read(path: string, max: number, signal?: AbortSignal) {
    const guard = captureGuard();
    const response = await request(path, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal,
    });
    guard();
    return json(response, max, guard);
  }
  return {
    async list(
      conversationId: string,
      options: { beforeId?: string; limit?: number; signal?: AbortSignal } = {},
    ): Promise<CloudChatHistoryPage> {
      const limit = options.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("消息分页大小无效");
      const query = new URLSearchParams({ limit: String(limit) });
      if (options.beforeId) {
        opaqueId(options.beforeId);
        query.set("before_id", options.beforeId);
      }
      const data = await read(
        `/api/web-chat/conversations/${opaqueId(conversationId)}/messages?${query}`,
        LIST_BYTES,
        options.signal,
      );
      if (
        !Array.isArray(data.messages) ||
        data.messages.length > limit ||
        typeof data.has_more !== "boolean" ||
        typeof data.next_before_id !== "string"
      )
        throw new Error("消息分页响应无效");
      const messages = data.messages.map((item) =>
        parseCloudChatHistoryMessage(item, conversationId),
      );
      if (
        new Set(messages.map((item) => item.id)).size !== messages.length ||
        data.has_more !== Boolean(data.next_before_id) ||
        (data.next_before_id &&
          (data.next_before_id !== messages[0]?.id || data.next_before_id === options.beforeId))
      )
        throw new Error("消息分页游标无效");
      return { messages, nextBeforeId: data.next_before_id, hasMore: data.has_more };
    },
    async get(conversationId: string, messageId: string, signal?: AbortSignal) {
      const data = await read(
        `/api/web-chat/conversations/${opaqueId(conversationId)}/messages/${opaqueId(messageId)}`,
        MESSAGE_BYTES,
        signal,
      );
      const item = parseCloudChatHistoryMessage(data.message, conversationId);
      if (item.id !== messageId || item.content_omitted || item.presentation_omitted)
        throw new Error("消息正文或过程尚未完整读取");
      return item;
    },
  };
}
export function mergeCloudChatHistory(
  current: CloudChatMessage[],
  incoming: CloudChatMessage[],
  older = false,
): CloudChatMessage[] {
  if (older) {
    const existing = new Set(current.map((item) => item.id));
    return [...incoming.filter((item) => !existing.has(item.id)), ...current];
  }
  const updates = new Map(incoming.map((item) => [item.id, item]));
  const merged = current.map((item) => {
    const next = updates.get(item.id);
    updates.delete(item.id);
    if (!next) return item;
    const merged =
      next.content_omitted && !item.content_omitted
        ? {
            ...next,
            content: item.content,
            content_omitted: item.content_omitted,
            content_bytes: item.content_bytes,
            content_sha256: item.content_sha256,
          }
        : next;
    // A bounded history page must not erase a process already loaded from a Run or full message.
    // Keep the omission marker so a partial live projection can still be refreshed explicitly.
    return !next.presentation && item.presentation
      ? { ...merged, presentation: item.presentation }
      : merged;
  });
  return [...merged, ...updates.values()];
}
export type CloudChatHistoryClient = ReturnType<typeof createCloudChatHistoryClient>;
