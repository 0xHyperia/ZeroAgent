export type CloudChatSource = {
  id: string;
  run_id: string;
  conversation_id: string;
  kind: "search_snippet" | "page";
  url: string;
  final_url?: string;
  title: string;
  snippet?: string;
  sha256: string;
  body_sha256?: string;
  observed_at: string;
  truncated: boolean;
  text_bytes: number;
  line_count: number;
  version: number;
  created_at: string;
};
export type CloudChatSourceExcerpt = {
  source_id: string;
  kind: "page";
  title: string;
  final_url: string;
  sha256: string;
  observed_at: string;
  truncated: boolean;
  total_lines: number;
  from_line: number;
  to_line: number;
  lines: { line: number; text: string }[];
};

type Request = (path: string, init?: RequestInit) => Promise<Response>;
type CaptureGuard = () => () => void;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

export class CloudChatSourceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudChatSourceError";
  }
}
function sourceID(value: string) {
  if (!UUID.test(value)) throw new Error("来源标识无效");
  return value.toLowerCase();
}

// This only prepares an explicit browser link. It does not fetch, resolve DNS,
// embed a page or authorize server egress; the Go fetch boundary owns SSRF checks.
export function cloudSourceExternalURL(value: string): { href: string; host: string } | null {
  try {
    if (
      typeof value !== "string" ||
      value.length > 4096 ||
      value !== value.trim() ||
      value.includes("\\") ||
      Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return null;
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.hostname
    )
      return null;
    return { href: url.href, host: url.host };
  } catch {
    return null;
  }
}

function parseSource(value: unknown): CloudChatSource {
  if (!value || typeof value !== "object") throw new Error("来源响应无效");
  const source = value as CloudChatSource;
  if (
    !UUID.test(source.id) ||
    !UUID.test(source.run_id) ||
    !UUID.test(source.conversation_id) ||
    !["search_snippet", "page"].includes(source.kind) ||
    !cloudSourceExternalURL(source.url) ||
    typeof source.title !== "string" ||
    source.title.length > 512 ||
    (source.snippet !== undefined &&
      (typeof source.snippet !== "string" || source.snippet.length > 4096)) ||
    !HASH.test(source.sha256) ||
    typeof source.observed_at !== "string" ||
    typeof source.created_at !== "string" ||
    typeof source.truncated !== "boolean" ||
    !Number.isSafeInteger(source.version) ||
    source.version < 1 ||
    !Number.isSafeInteger(source.text_bytes) ||
    source.text_bytes < 0 ||
    source.text_bytes > 1024 * 1024 ||
    !Number.isSafeInteger(source.line_count) ||
    source.line_count < 0 ||
    source.line_count > 10000 ||
    (source.kind === "search_snippet" &&
      (source.text_bytes !== 0 ||
        source.line_count !== 0 ||
        !!source.final_url ||
        !!source.body_sha256)) ||
    (source.kind === "page" &&
      (!source.final_url ||
        !cloudSourceExternalURL(source.final_url) ||
        !source.body_sha256 ||
        !HASH.test(source.body_sha256) ||
        source.line_count < 1 ||
        source.text_bytes < 1))
  )
    throw new Error("来源响应无效");
  return source;
}

export function createCloudChatSourcesClient(request: Request, captureGuard: CaptureGuard) {
  async function json(path: string, init: RequestInit = {}) {
    const guard = captureGuard();
    const response = await request(path, {
      ...init,
      credentials: "include",
      headers: { Accept: "application/json", ...init.headers },
    });
    guard();
    const max = 4 * 1024 * 1024;
    const declared = response.headers.get("Content-Length");
    if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(max))) {
      await response.body?.cancel();
      throw new Error("来源响应过大");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("来源响应为空");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        guard();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > max) throw new Error("来源响应过大");
        chunks.push(next.value);
      }
    } catch (cause) {
      await reader.cancel().catch(() => undefined);
      throw cause;
    } finally {
      reader.releaseLock();
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let payload: unknown;
    try {
      payload = JSON.parse(
        chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode(),
      );
    } catch {
      throw new Error("来源响应无效");
    }
    guard();
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("来源响应无效");
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: "来源请求或行号无效。",
        401: "账户会话已过期，请重新登录。",
        404: "来源不存在或已删除。",
        409: "来源版本已变化，或此来源仅有搜索摘要。",
        413: "来源摘录超过当前大小限制。",
        503: "来源资料暂时不可用。",
      };
      throw new CloudChatSourceError(
        messages[response.status] ?? `来源请求失败 (HTTP ${response.status})`,
        response.status,
      );
    }
    return payload as Record<string, unknown>;
  }
  return {
    async list(options: { conversationId?: string; before?: string; signal?: AbortSignal } = {}) {
      const query = new URLSearchParams({ limit: "50" });
      if (options.conversationId) query.set("conversation_id", sourceID(options.conversationId));
      if (options.before) query.set("before", sourceID(options.before));
      const data = await json(`/api/web-chat/sources?${query}`, { signal: options.signal });
      if (
        !Array.isArray(data.sources) ||
        data.sources.length > 50 ||
        typeof data.next_cursor !== "string" ||
        (data.next_cursor && !UUID.test(data.next_cursor))
      )
        throw new Error("来源列表响应无效");
      return { sources: data.sources.map(parseSource), nextCursor: data.next_cursor as string };
    },
    async get(id: string, signal?: AbortSignal) {
      return parseSource((await json(`/api/web-chat/sources/${sourceID(id)}`, { signal })).source);
    },
    async excerpt(id: string, fromLine = 1, toLine = fromLine + 99, signal?: AbortSignal) {
      if (
        !Number.isSafeInteger(fromLine) ||
        fromLine < 1 ||
        !Number.isSafeInteger(toLine) ||
        toLine < fromLine ||
        toLine - fromLine >= 200
      )
        throw new Error("来源行号无效");
      const data = await json(
        `/api/web-chat/sources/${sourceID(id)}/content?from_line=${fromLine}&to_line=${toLine}`,
        { signal },
      );
      const excerpt = data as unknown as CloudChatSourceExcerpt;
      if (
        excerpt.source_id !== sourceID(id) ||
        excerpt.kind !== "page" ||
        !HASH.test(excerpt.sha256) ||
        !cloudSourceExternalURL(excerpt.final_url) ||
        !Number.isSafeInteger(excerpt.total_lines) ||
        excerpt.total_lines < 1 ||
        excerpt.total_lines > 10000 ||
        excerpt.from_line !== fromLine ||
        !Number.isSafeInteger(excerpt.to_line) ||
        excerpt.to_line > toLine ||
        excerpt.to_line > excerpt.total_lines ||
        !Array.isArray(excerpt.lines) ||
        excerpt.lines.length > 200 ||
        excerpt.lines.length !== excerpt.to_line - fromLine + 1 ||
        excerpt.lines.some(
          (line, index) => line.line !== fromLine + index || typeof line.text !== "string",
        )
      )
        throw new Error("来源摘录响应无效");
      return excerpt;
    },
    async remove(source: CloudChatSource, signal?: AbortSignal) {
      const data = await json(`/api/web-chat/sources/${sourceID(source.id)}`, {
        method: "DELETE",
        headers: { "If-Match": `"${source.version}"` },
        signal,
      });
      if (data.deleted !== true) throw new Error("来源删除结果尚未确认，请刷新核对。");
    },
  };
}
export type CloudChatSourcesClient = ReturnType<typeof createCloudChatSourcesClient>;

export function linkCloudSourceCitations(text: string): string {
  return text.replace(
    /【来源:([0-9a-f-]{36})(?::L([1-9]\d*)-L([1-9]\d*))?】/gi,
    (raw, id: string, first?: string, last?: string) => {
      if (!UUID.test(id)) return raw;
      if (first !== undefined && last !== undefined) {
        if (
          !Number.isSafeInteger(Number(first)) ||
          !Number.isSafeInteger(Number(last)) ||
          Number(last) < Number(first)
        )
          return raw;
        return `[来源 L${first}–L${last}](cloud-sources/${id.toLowerCase()}#L${first}-L${last})`;
      }
      return `[来源](cloud-sources/${id.toLowerCase()})`;
    },
  );
}
