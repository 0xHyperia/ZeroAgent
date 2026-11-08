type Request = (path: string, init?: RequestInit) => Promise<Response>;
type CaptureGuard = () => () => void;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function createCloudChatSourcesClient(request: Request, captureGuard: CaptureGuard) {
  async function get(id: string, signal?: AbortSignal) {
    const key = sourceID(id);
    const guard = captureGuard();
    const response = await request(`/api/web-chat/sources/${key}`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal,
    });
    guard();
    if (!response.ok) {
      await response.body?.cancel();
      guard();
      throw new CloudChatSourceError("来源链接读取失败。", response.status);
    }
    const max = 64 * 1024;
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
    const source = (
      payload as {
        source?: { id?: unknown; title?: unknown; url?: string; final_url?: string };
      } | null
    )?.source;
    if (source?.id !== key || typeof source.title !== "string" || source.title.length > 512)
      throw new Error("来源响应无效");
    const link = cloudSourceExternalURL(source.final_url || source.url || "");
    if (!link) throw new Error("来源链接无效");
    return { ...link, title: source.title };
  }
  return { get };
}
export type CloudChatSourcesClient = ReturnType<typeof createCloudChatSourcesClient>;

export function linkCloudSourceCitations(text: string): string {
  return text.replace(/【来源:([0-9a-f-]{36})】/gi, (raw, id: string) =>
    UUID.test(id) ? `[来源](cloud-sources/${id.toLowerCase()})` : raw,
  );
}
