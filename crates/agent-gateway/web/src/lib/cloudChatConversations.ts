import type { ConversationSearchAdapter } from "@liveagent/ui/components/chat/ConversationSearchDialog";
import { type CloudChatMessage, parseCloudChatHistoryMessage } from "./cloudChatHistory";

export type CloudConversation = {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
  pinned: boolean;
  archived: boolean;
  management_version: number;
};
export type CloudConversationScope = "active" | "unassigned" | "archived" | "pinned" | "all";
export type CloudConversationSearchMatch = {
  conversation: CloudConversation;
  message_id?: string;
  role?: "user" | "assistant";
  excerpt: string;
  match: "title" | "message";
  created_at: string;
};
export type CloudConversationBranches = {
  source: null | {
    conversation_id: string;
    message_id: string;
    title: string;
    available: boolean;
  };
  children: {
    conversation: CloudConversation;
    source_message_id: string;
  }[];
  hasMore: boolean;
  nextCursor: string;
};
type Request = (path: string, init?: RequestInit) => Promise<Response>;
type PageOptions = { cursor?: string; limit?: number; signal?: AbortSignal };
type ScopeOptions = PageOptions & { scope?: CloudConversationScope };
const ROOT = "/api/web-chat/conversations";
const SCOPES = new Set(["active", "unassigned", "archived", "pinned", "all"]);
function invalid(): never {
  throw new Error("会话响应无效，请重新读取。");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid();
  return value;
}
function date(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value)))
    invalid();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) invalid();
  return value;
}
export function parseCloudConversation(value: unknown): CloudConversation {
  const item = object(value);
  if (
    typeof item.pinned !== "boolean" ||
    typeof item.archived !== "boolean" ||
    !Number.isSafeInteger(item.management_version) ||
    (item.management_version as number) < 0
  )
    invalid();
  return {
    id: id(item.id),
    title: text(item.title, 2048),
    model: text(item.model, 512),
    created_at: date(item.created_at),
    updated_at: date(item.updated_at),
    pinned: item.pinned,
    archived: item.archived,
    management_version: item.management_version as number,
  };
}
function pagination(data: Record<string, unknown>, cursor?: string) {
  if (
    typeof data.has_more !== "boolean" ||
    typeof data.next_cursor !== "string" ||
    data.next_cursor.length > 4096 ||
    data.has_more !== Boolean(data.next_cursor) ||
    (data.next_cursor && data.next_cursor === cursor)
  )
    invalid();
  return { hasMore: data.has_more, nextCursor: data.next_cursor };
}
function query(
  options: ScopeOptions,
  defaultLimit: number,
  max: number,
  defaultScope?: CloudConversationScope,
) {
  const limit = options.limit ?? defaultLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > max || (options.cursor?.length ?? 0) > 4096)
    throw new Error("会话分页参数无效");
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.cursor) params.set("cursor", options.cursor);
  const scope = options.scope ?? defaultScope;
  if (scope) {
    if (!SCOPES.has(scope)) invalid();
    params.set("scope", scope);
  }
  return { params, limit };
}
export class CloudConversationError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "账户会话已过期，请重新登录。"
        : status === 404
          ? "对话不存在或已不可访问。"
          : status === 409
            ? "对话已在另一处更新，请刷新后重试。"
            : "暂时无法处理对话，请重试。",
    );
    this.name = "CloudConversationError";
  }
}

export function createCloudChatConversationsClient(
  request: Request,
  captureGuard: () => () => void,
) {
  async function read(
    path: string,
    init: RequestInit = {},
    maxBytes = 2 * 1024 * 1024 + 512 * 1024,
  ) {
    const accountGuard = captureGuard();
    const guard = () => {
      init.signal?.throwIfAborted();
      accountGuard();
    };
    guard();
    const response = await request(path, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    guard();
    if (!response.ok) {
      await response.body?.cancel();
      throw new CloudConversationError(response.status);
    }
    const declared = response.headers.get("Content-Length");
    if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maxBytes))) {
      await response.body?.cancel();
      throw new Error("会话响应超过大小限制");
    }
    const reader = response.body?.getReader();
    if (!reader) invalid();
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    init.signal?.addEventListener("abort", cancel, { once: true });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let body = "",
      bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        guard();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new Error("会话响应超过大小限制");
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      guard();
      try {
        return object(JSON.parse(body));
      } catch {
        return invalid();
      }
    } finally {
      init.signal?.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  return {
    async get(conversationId: string, signal?: AbortSignal) {
      const data = await read(`${ROOT}/${id(conversationId)}/metadata`, { signal });
      const conversation = parseCloudConversation(data.conversation);
      if (conversation.id !== conversationId) invalid();
      return conversation;
    },
    async list(options: ScopeOptions = {}) {
      const { params, limit } = query(options, 50, 100, "active");
      const data = await read(`${ROOT}/catalog?${params}`, { signal: options.signal });
      if (!Array.isArray(data.conversations) || data.conversations.length > limit) invalid();
      const conversations = data.conversations.map(parseCloudConversation);
      if (new Set(conversations.map((item) => item.id)).size !== conversations.length) invalid();
      return { conversations, ...pagination(data, options.cursor) };
    },
    async manage(
      conversation: Pick<CloudConversation, "id" | "management_version">,
      update: { pinned?: boolean; archived?: boolean },
      signal?: AbortSignal,
    ) {
      if (
        (!Object.hasOwn(update, "pinned") && !Object.hasOwn(update, "archived")) ||
        (update.pinned !== undefined && typeof update.pinned !== "boolean") ||
        (update.archived !== undefined && typeof update.archived !== "boolean") ||
        !Number.isSafeInteger(conversation.management_version) ||
        conversation.management_version < 0
      )
        invalid();
      const data = await read(`${ROOT}/${id(conversation.id)}/management`, {
        method: "PATCH",
        signal,
        body: JSON.stringify({
          expected_version: conversation.management_version,
          ...(update.pinned !== undefined ? { pinned: update.pinned } : {}),
          ...(update.archived !== undefined ? { archived: update.archived } : {}),
        }),
      });
      const result = parseCloudConversation(data.conversation);
      if (
        result.id !== conversation.id ||
        result.management_version < conversation.management_version
      )
        invalid();
      return result;
    },
    async search(search: string, options: ScopeOptions = {}) {
      const normalized = search.trim();
      if (!normalized || [...normalized].length > 200)
        throw new Error("请输入 1–200 个字符搜索对话");
      const { params, limit } = query(options, 20, 50, "all");
      params.set("q", normalized);
      const data = await read(`${ROOT}/search?${params}`, { signal: options.signal });
      if (!Array.isArray(data.items) || data.items.length > limit) invalid();
      const items = data.items.map((value) => {
        const item = object(value);
        if (item.match !== "title" && item.match !== "message") invalid();
        if (
          item.match === "message" &&
          (typeof item.message_id !== "string" ||
            !["user", "assistant"].includes(item.role as string))
        )
          invalid();
        return {
          conversation: parseCloudConversation(item.conversation),
          match: item.match,
          excerpt: text(item.excerpt, 1280),
          created_at: date(item.created_at),
          ...(item.message_id !== undefined ? { message_id: id(item.message_id) } : {}),
          ...(item.role !== undefined ? { role: item.role as "user" | "assistant" } : {}),
        } as CloudConversationSearchMatch;
      });
      return { items, ...pagination(data, options.cursor) };
    },
    async window(
      conversationId: string,
      messageId: string,
      options: { before?: number; after?: number; signal?: AbortSignal } = {},
    ) {
      const before = options.before ?? 20,
        after = options.after ?? 20;
      if (![before, after].every((n) => Number.isInteger(n) && n >= 0 && n <= 49)) invalid();
      const data = await read(
        `${ROOT}/${id(conversationId)}/messages/${id(messageId)}/window?before=${before}&after=${after}`,
        { signal: options.signal },
      );
      if (
        !Array.isArray(data.messages) ||
        data.messages.length > before + after + 1 ||
        data.anchor_id !== messageId ||
        typeof data.has_before !== "boolean" ||
        typeof data.has_after !== "boolean" ||
        typeof data.next_before_id !== "string" ||
        typeof data.next_after_id !== "string"
      )
        invalid();
      const messages = data.messages.map((value) =>
        parseCloudChatHistoryMessage(value, conversationId),
      );
      if (
        new Set(messages.map((item) => item.id)).size !== messages.length ||
        !messages.some((item) => item.id === messageId) ||
        (data.has_before && data.next_before_id !== messages[0]?.id) ||
        (data.has_after && data.next_after_id !== messages.at(-1)?.id)
      )
        invalid();
      return {
        messages: messages as CloudChatMessage[],
        anchorId: messageId,
        hasBefore: data.has_before,
        hasAfter: data.has_after,
        nextBeforeId: data.next_before_id,
        nextAfterId: data.next_after_id,
      };
    },
    async branches(
      conversationId: string,
      options: PageOptions = {},
    ): Promise<CloudConversationBranches> {
      const { params, limit } = query(options, 30, 100);
      const data = await read(`${ROOT}/${id(conversationId)}/branches?${params}`, {
        signal: options.signal,
      });
      if (!Array.isArray(data.children) || data.children.length > limit) invalid();
      let source: CloudConversationBranches["source"] = null;
      if (data.source !== null) {
        const item = object(data.source);
        if (typeof item.available !== "boolean") invalid();
        source = {
          conversation_id: id(item.conversation_id),
          message_id: id(item.message_id),
          title: text(item.title, 2048),
          available: item.available,
        };
      }
      const children = data.children.map((value) => {
        const item = object(value);
        return {
          conversation: parseCloudConversation(item.conversation),
          source_message_id: id(item.source_message_id),
        };
      });
      if (new Set(children.map((item) => item.conversation.id)).size !== children.length) invalid();
      return { source, children, ...pagination(data, options.cursor) };
    },
  };
}
export type CloudChatConversationsClient = ReturnType<typeof createCloudChatConversationsClient>;
export function createCloudConversationSearchAdapter(
  client: CloudChatConversationsClient,
  onSelectResult: ConversationSearchAdapter["onSelectResult"],
): ConversationSearchAdapter {
  return {
    onSelectResult,
    async search(query, options) {
      const page = await client.search(query, options);
      return {
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        items: page.items.map((item) => ({
          id: item.conversation.id,
          title: item.conversation.title,
          updatedAt: Date.parse(item.conversation.updated_at),
          archived: item.conversation.archived,
          matchType: item.match,
          messageId: item.message_id,
          searchPreview: item.excerpt,
        })),
      };
    },
  };
}
