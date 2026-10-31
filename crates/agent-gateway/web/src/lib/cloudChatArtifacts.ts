import { previewImageDimensions } from "@liveagent/ui/components/resource-preview/previewImageDimensions";
import { createCloudChatSitesClient } from "./cloudChatSites";

export type CloudChatArtifactVersion = {
  id: string;
  family_id: string;
  number: number;
  conversation_id: string;
  source_run_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  state: "staging" | "ready" | "failed" | "unknown" | "deleting" | "deleted";
  error_code?: string;
  version: number;
  created_at: string;
  updated_at: string;
  download_url?: string;
};
export type CloudArtifactReference = {
  type: "artifact_reference";
  version_id: string;
  name?: string;
  mime?: string;
  size?: number;
  family_id?: string;
  number?: number;
  sha256?: string;
};
type Request = (path: string, init?: RequestInit) => Promise<Response>;
type CaptureGuard = () => () => void;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(["staging", "ready", "failed", "unknown", "deleting", "deleted"]);
export const CLOUD_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
export const CLOUD_ARTIFACT_TEXT_BYTES = 512 * 1024;
export const CLOUD_ARTIFACT_IMAGE_BYTES = 8 * 1024 * 1024;
export class CloudChatArtifactError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudChatArtifactError";
  }
}
function id(value: string) {
  if (!UUID.test(value)) throw new Error("成果标识无效");
  return value.toLowerCase();
}
function versionPath(value: string) {
  return `/api/web-chat/artifacts/versions/${id(value)}`;
}
function parseVersion(value: unknown): CloudChatArtifactVersion {
  if (!value || typeof value !== "object") throw new Error("成果响应无效");
  const version = value as CloudChatArtifactVersion;
  if (
    !UUID.test(version.id) ||
    !UUID.test(version.family_id) ||
    !UUID.test(version.conversation_id) ||
    !UUID.test(version.source_run_id) ||
    !Number.isSafeInteger(version.number) ||
    version.number < 1 ||
    version.number > 100 ||
    !Number.isSafeInteger(version.version) ||
    version.version < 1 ||
    !STATES.has(version.state) ||
    typeof version.name !== "string" ||
    !version.name ||
    version.name.length > 255 ||
    /[/\\]/.test(version.name) ||
    typeof version.mime !== "string" ||
    !version.mime ||
    version.mime.length > 128 ||
    !Number.isSafeInteger(version.size) ||
    version.size < 0 ||
    version.size > CLOUD_ARTIFACT_MAX_BYTES ||
    !/^[0-9a-f]{64}$/.test(version.sha256) ||
    typeof version.created_at !== "string" ||
    typeof version.updated_at !== "string" ||
    (version.state === "ready" && version.download_url !== `${versionPath(version.id)}/download`) ||
    (version.state !== "ready" && version.download_url)
  )
    throw new Error("成果响应无效");
  return version;
}

async function readBytes(response: Response, maximum: number, guard: () => void) {
  guard();
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maximum))) {
    await response.body?.cancel();
    throw new Error("成果响应超过大小限制");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return { chunks, size };
  try {
    for (;;) {
      const next = await reader.read();
      guard();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new Error("成果响应超过大小限制");
      chunks.push(next.value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throw cause;
  } finally {
    reader.releaseLock();
  }
  guard();
  return { chunks, size };
}
async function readJSON(response: Response, guard: () => void) {
  const { chunks } = await readBytes(response, 2 * 1024 * 1024, guard);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let payload: unknown;
  try {
    payload = JSON.parse(
      chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode(),
    );
  } catch {
    throw new Error("成果响应无效");
  }
  guard();
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("成果响应无效");
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: "成果请求无效。",
      401: "账户会话已过期，请重新登录。",
      404: "成果不存在或已删除。",
      409: "正式版本尚未保存完成，请刷新状态。",
      413: "成果超过当前存储限制。",
      503: "成果存储尚未配置或暂时不可用。",
    };
    throw new CloudChatArtifactError(
      messages[response.status] ?? `成果操作失败 (HTTP ${response.status})`,
      response.status,
    );
  }
  return payload as Record<string, unknown>;
}

export function createCloudChatArtifactsClient(request: Request, captureGuard: CaptureGuard) {
  async function json(path: string, init: RequestInit = {}) {
    const guard = captureGuard();
    const response = await request(path, {
      ...init,
      credentials: "include",
      headers: { Accept: "application/json", ...init.headers },
    });
    guard();
    return readJSON(response, guard);
  }
  async function binary(version: CloudChatArtifactVersion, maximum: number, signal?: AbortSignal) {
    const checked = parseVersion(version);
    if (checked.state !== "ready") throw new CloudChatArtifactError("正式版本尚未保存完成。", 409);
    if (checked.size > maximum)
      throw new CloudChatArtifactError("成果超过当前文本查看大小，请下载原件。", 413);
    const guard = captureGuard();
    const response = await request(`${versionPath(checked.id)}/download`, {
      credentials: "include",
      headers: { Accept: "application/octet-stream" },
      signal,
    });
    guard();
    if (!response.ok) await readJSON(response, guard);
    const result = await readBytes(response, maximum, guard);
    if (result.size !== checked.size) throw new Error("成果下载不完整，请重试。");
    guard();
    return { ...result, guard };
  }
  return {
    sites: createCloudChatSitesClient(request, captureGuard),
    async list(
      options: {
        conversationId?: string;
        familyId?: string;
        before?: string;
        limit?: number;
        signal?: AbortSignal;
      } = {},
    ) {
      const limit = options.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("成果分页大小无效");
      const query = new URLSearchParams({ limit: String(limit) }),
        conversationId = options.conversationId ? id(options.conversationId) : undefined,
        familyId = options.familyId ? id(options.familyId) : undefined,
        before = options.before ? id(options.before) : undefined;
      if (conversationId) query.set("conversation_id", conversationId);
      if (familyId) query.set("family_id", familyId);
      if (before) query.set("before", before);
      const data = await json(`/api/web-chat/artifacts?${query}`, { signal: options.signal });
      if (
        !Array.isArray(data.versions) ||
        data.versions.length > limit ||
        typeof data.next_cursor !== "string" ||
        (data.next_cursor && !UUID.test(data.next_cursor))
      )
        throw new Error("成果列表响应无效");
      const versions = data.versions.map(parseVersion);
      if (
        versions.some(
          (version) =>
            (conversationId && version.conversation_id !== conversationId) ||
            (familyId && version.family_id !== familyId),
        )
      )
        throw new Error("成果列表范围不一致");
      if (
        new Set(versions.map((version) => version.id)).size !== versions.length ||
        (data.next_cursor &&
          (versions.length !== limit ||
            versions.at(-1)?.id !== data.next_cursor ||
            data.next_cursor === before))
      )
        throw new Error("成果分页响应无效");
      return { versions, nextCursor: data.next_cursor };
    },
    async get(versionId: string, signal?: AbortSignal) {
      const version = parseVersion((await json(versionPath(versionId), { signal })).version);
      if (version.id !== id(versionId)) throw new Error("成果版本响应不一致");
      return version;
    },
    async download(version: CloudChatArtifactVersion, signal?: AbortSignal) {
      const result = await binary(version, CLOUD_ARTIFACT_MAX_BYTES, signal);
      result.guard();
      return {
        blob: new Blob(result.chunks as BlobPart[], { type: "application/octet-stream" }),
        filename: version.name,
        guard: result.guard,
      };
    },
    async text(version: CloudChatArtifactVersion, signal?: AbortSignal) {
      if (!cloudArtifactCanViewText(version))
        throw new CloudChatArtifactError("此版本暂不支持文本查看，请下载原件。", 409);
      const result = await binary(version, CLOUD_ARTIFACT_TEXT_BYTES, signal),
        decoder = new TextDecoder("utf-8", { fatal: true });
      let text: string;
      try {
        text =
          result.chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
          decoder.decode();
      } catch {
        throw new Error("成果不是有效 UTF-8 文本，请下载原件。");
      }
      if (text.includes("\u0000")) throw new Error("成果包含二进制数据，请下载原件。");
      result.guard();
      return { text, guard: result.guard };
    },
    async image(version: CloudChatArtifactVersion, signal?: AbortSignal) {
      if (!cloudArtifactCanPreviewImage(version))
        throw new CloudChatArtifactError("此版本暂不支持图片预览，请下载原件。", 409);
      const result = await binary(version, CLOUD_ARTIFACT_IMAGE_BYTES, signal);
      const bytes = new Uint8Array(result.size);
      let offset = 0;
      for (const chunk of result.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const dimensions = cloudArtifactImageDimensions(bytes, version.mime);
      result.guard();
      return {
        blob: new Blob(result.chunks as BlobPart[], { type: version.mime }),
        guard: result.guard,
        ...dimensions,
      };
    },
    async removeFamily(familyId: string, signal?: AbortSignal) {
      const data = await json(`/api/web-chat/artifacts/${id(familyId)}`, {
        method: "DELETE",
        signal,
      });
      if (data.family_id !== id(familyId) || !["deleted", "deleting"].includes(String(data.state)))
        throw new Error("成果删除结果尚未确认，请刷新核对。");
      return { familyId: data.family_id as string, state: data.state as "deleted" | "deleting" };
    },
  };
}
export type CloudChatArtifactsClient = ReturnType<typeof createCloudChatArtifactsClient>;

export function cloudArtifactCanViewText(version: CloudChatArtifactVersion) {
  return (
    version.state === "ready" &&
    version.size <= CLOUD_ARTIFACT_TEXT_BYTES &&
    (version.mime.startsWith("text/") ||
      ["application/json", "application/xml", "application/xhtml+xml", "image/svg+xml"].includes(
        version.mime,
      ) ||
      /\.(html?|svg|txt|md|csv|json|xml|js|css|py|ipynb|yaml|yml)$/i.test(version.name))
  );
}
export function cloudArtifactCanPreviewImage(version: CloudChatArtifactVersion) {
  return (
    version.state === "ready" &&
    ["image/png", "image/jpeg"].includes(version.mime) &&
    version.size > 0 &&
    version.size <= CLOUD_ARTIFACT_IMAGE_BYTES
  );
}
export function cloudArtifactImageDimensions(bytes: Uint8Array, mime: string) {
  return previewImageDimensions(bytes, mime);
}
export function cloudArtifactStatus(version: CloudChatArtifactVersion) {
  return {
    ready: "正式版本已就绪",
    staging: "正在保存正式版本",
    unknown: "保存结果待核对",
    failed: "保存失败",
    deleting: "正在删除",
    deleted: "已删除",
  }[version.state];
}
export function cloudArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
export function cloudArtifactVersionURI(version: CloudChatArtifactVersion): string {
  const checked = parseVersion(version);
  if (checked.state !== "ready") throw new CloudChatArtifactError("正式版本尚未保存完成。", 409);
  return `zeroagent://artifact-version/${id(checked.id)}`;
}
export function cloudArtifactReferences(content: unknown): CloudArtifactReference[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): CloudArtifactReference[] => {
    if (
      !part ||
      typeof part !== "object" ||
      part.type !== "artifact_reference" ||
      typeof part.version_id !== "string" ||
      !UUID.test(part.version_id)
    )
      return [];
    return [
      {
        type: "artifact_reference",
        version_id: part.version_id.toLowerCase(),
        ...(typeof part.name === "string" && part.name && part.name.length <= 255
          ? { name: part.name }
          : {}),
        ...(typeof part.mime === "string" && part.mime.length <= 128 ? { mime: part.mime } : {}),
        ...(Number.isSafeInteger(part.size) &&
        part.size >= 0 &&
        part.size <= CLOUD_ARTIFACT_MAX_BYTES
          ? { size: part.size }
          : {}),
        ...(typeof part.family_id === "string" && UUID.test(part.family_id)
          ? { family_id: part.family_id.toLowerCase() }
          : {}),
        ...(Number.isSafeInteger(part.number) && part.number >= 1 && part.number <= 100
          ? { number: part.number }
          : {}),
        ...(typeof part.sha256 === "string" && /^[0-9a-f]{64}$/.test(part.sha256)
          ? { sha256: part.sha256 }
          : {}),
      },
    ];
  });
}
export function cloudArtifactVersionFromLink(path: string): string | null {
  const match =
    /^(?:cloud-artifacts\/|\/api\/web-chat\/artifacts\/versions\/)([0-9a-f-]{36})(?:\/download)?$/i.exec(
      path,
    );
  return match && UUID.test(match[1]) ? match[1].toLowerCase() : null;
}
export function linkCloudArtifactCitations(text: string): string {
  return text.replace(/【成果:([0-9a-f-]{36})】/gi, (raw, versionId: string) =>
    UUID.test(versionId) ? `[成果](cloud-artifacts/${versionId.toLowerCase()})` : raw,
  );
}
