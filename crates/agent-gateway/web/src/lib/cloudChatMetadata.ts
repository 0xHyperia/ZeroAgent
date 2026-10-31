import { type CloudChatRunState, cloudChatSequence } from "./cloudChatRuns";

export type CloudChatConversation = {
  id: string;
  title: string;
  model: string;
  created_at?: string;
  updated_at: string;
  pinned?: boolean;
  archived?: boolean;
  management_version?: number;
};
export type CloudChatRunHead = {
  id: string;
  conversation_id: string;
  client_request_id: string;
  model: string;
  state: CloudChatRunState;
  user_message_id: string;
  assistant_message_id: string;
  error_code?: string;
  last_seq: string;
  created_at?: string;
  updated_at?: string;
};
type Request = (path: string, init?: RequestInit) => Promise<Response>;
type CaptureGuard = () => () => void;
const STATES = new Set([
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error("会话或任务标识无效");
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new Error("会话元数据响应无效");
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result))) throw new Error("会话时间响应无效");
  return result;
}
function conversation(value: unknown): CloudChatConversation {
  if (!record(value)) throw new Error("会话列表响应无效");
  if (
    (value.pinned !== undefined && typeof value.pinned !== "boolean") ||
    (value.archived !== undefined && typeof value.archived !== "boolean") ||
    (value.management_version !== undefined &&
      (!Number.isSafeInteger(value.management_version) || (value.management_version as number) < 0))
  )
    throw new Error("会话管理状态无效");
  return {
    id: identifier(value.id),
    title: text(value.title, 4096),
    model: text(value.model, 512),
    updated_at: timestamp(value.updated_at),
    ...(value.created_at !== undefined ? { created_at: timestamp(value.created_at) } : {}),
    ...(value.pinned !== undefined ? { pinned: value.pinned as boolean } : {}),
    ...(value.archived !== undefined ? { archived: value.archived as boolean } : {}),
    ...(value.management_version !== undefined
      ? { management_version: value.management_version as number }
      : {}),
  };
}
export class CloudChatMetadataError extends Error {
  constructor(readonly status: number) {
    super(status === 401 ? "账户会话已过期，请重新登录。" : "暂时无法读取会话或任务状态，请重试。");
  }
}
async function boundedJSON(response: Response, max: number, guard: () => void) {
  guard();
  if (!response.ok) {
    await response.body?.cancel();
    throw new CloudChatMetadataError(response.status);
  }
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(max))) {
    await response.body?.cancel();
    throw new Error("会话元数据响应过大");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("会话元数据响应为空");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "",
    bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      guard();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > max) throw new Error("会话元数据响应过大");
      body += decoder.decode(next.value, { stream: true });
    }
    body += decoder.decode();
    guard();
    const data: unknown = JSON.parse(body);
    if (!record(data)) throw new Error("会话元数据响应无效");
    return data;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function createCloudChatMetadataClient(request: Request, captureGuard: CaptureGuard) {
  async function get(path: string, maximum: number, signal?: AbortSignal) {
    const guard = captureGuard();
    const response = await request(path, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal,
    });
    return boundedJSON(response, maximum, guard);
  }
  return {
    async listConversations(
      options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
    ) {
      const limit = options.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("会话分页大小无效");
      const query = new URLSearchParams({ limit: String(limit) });
      if (options.cursor) {
        if (
          options.cursor.length > 2048 ||
          [...options.cursor].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
        )
          throw new Error("会话分页游标无效");
        query.set("cursor", options.cursor);
      }
      const data = await get(
        `/api/web-chat/conversations/page?${query}`,
        512 * 1024,
        options.signal,
      );
      if (
        !Array.isArray(data.conversations) ||
        data.conversations.length > limit ||
        typeof data.has_more !== "boolean" ||
        typeof data.next_cursor !== "string" ||
        data.next_cursor.length > 2048 ||
        data.has_more !== !!data.next_cursor ||
        (data.next_cursor && data.next_cursor === options.cursor)
      )
        throw new Error("会话分页响应无效");
      const conversations = data.conversations.map(conversation);
      if (new Set(conversations.map((item) => item.id)).size !== conversations.length)
        throw new Error("会话分页包含重复标识");
      return { conversations, hasMore: data.has_more, nextCursor: data.next_cursor };
    },
    async findTurnRun(
      conversationId: string,
      userMessageId: string,
      signal?: AbortSignal,
    ): Promise<CloudChatRunHead | null> {
      const query = new URLSearchParams({
        conversation_id: identifier(conversationId),
        user_message_id: identifier(userMessageId),
      });
      const data = await get(`/api/web-chat/runs?${query}`, 16 * 1024, signal);
      if (data.output_included !== false || !Array.isArray(data.runs) || data.runs.length > 1)
        throw new Error("任务状态摘要响应无效");
      if (!data.runs.length) return null;
      const value = data.runs[0];
      if (
        !record(value) ||
        value.conversation_id !== conversationId ||
        value.user_message_id !== userMessageId ||
        !STATES.has(String(value.state))
      )
        throw new Error("任务状态摘要身份无效");
      return {
        id: identifier(value.id),
        conversation_id: conversationId,
        client_request_id: identifier(value.client_request_id),
        model: text(value.model, 512),
        state: value.state as CloudChatRunState,
        user_message_id: userMessageId,
        assistant_message_id: identifier(value.assistant_message_id),
        last_seq: cloudChatSequence(value.last_seq),
        ...(value.error_code !== undefined ? { error_code: text(value.error_code, 128) } : {}),
        ...(value.created_at !== undefined ? { created_at: timestamp(value.created_at) } : {}),
        ...(value.updated_at !== undefined ? { updated_at: timestamp(value.updated_at) } : {}),
      };
    },
  };
}
export function mergeCloudChatConversations(
  current: CloudChatConversation[],
  incoming: CloudChatConversation[],
) {
  const unique = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) unique.set(item.id, item);
  return [...unique.values()].sort(
    (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id.localeCompare(a.id),
  );
}
