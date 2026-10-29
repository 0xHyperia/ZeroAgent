export type CloudChatFile = {
  id: string;
  conversation_id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  state:
    | "uploading"
    | "uploaded"
    | "processing"
    | "ready"
    | "vision_ready"
    | "failed"
    | "deleting"
    | "deleted";
  processing_stage?: string;
  parse_truncated?: boolean;
  workspace_loadable?: boolean;
  text_bytes: number;
  error_code?: string;
  version: number;
  created_at: string;
  updated_at: string;
  uploaded_at?: string;
};

export type CloudFileReference = {
  type: "file_reference";
  file_id: string;
  name?: string;
  mime?: string;
  size?: number;
};
export type CloudFileSource = {
  file_id: string;
  name: string;
  sha256: string;
  total_lines: number;
  from_line: number;
  to_line: number;
  lines: { line: number; text: string }[];
};

type Request = (path: string, init?: RequestInit) => Promise<Response>;
type CaptureGuard = () => () => void;
export const CLOUD_FILE_MAX_BYTES = 32 * 1024 * 1024;
export const CLOUD_FILE_CONTEXT_BYTES = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set([
  "uploading",
  "uploaded",
  "processing",
  "ready",
  "vision_ready",
  "failed",
  "deleting",
  "deleted",
]);

export class CloudChatFileError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudChatFileError";
  }
}

export class CloudFileUploadUnconfirmedError extends Error {
  constructor() {
    super("上传结果尚未确认，请刷新文件库核对后再试。");
    this.name = "CloudFileUploadUnconfirmedError";
  }
}

function fileID(id: string) {
  if (!UUID.test(id)) throw new Error("文件标识无效");
  return id.toLowerCase();
}

function parseFile(value: unknown): CloudChatFile {
  if (!value || typeof value !== "object") throw new Error("文件响应无效");
  const file = value as CloudChatFile;
  if (
    !UUID.test(file.id) ||
    (file.conversation_id !== "" && !UUID.test(file.conversation_id)) ||
    typeof file.name !== "string" ||
    !file.name ||
    file.name.length > 255 ||
    typeof file.mime !== "string" ||
    !STATES.has(file.state) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > CLOUD_FILE_MAX_BYTES ||
    !Number.isSafeInteger(file.version) ||
    file.version < 1 ||
    !Number.isSafeInteger(file.text_bytes) ||
    file.text_bytes < 0 ||
    file.text_bytes > 2 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(file.sha256) ||
    typeof file.created_at !== "string" ||
    typeof file.updated_at !== "string" ||
    (file.parse_truncated !== undefined && typeof file.parse_truncated !== "boolean") ||
    (file.workspace_loadable !== undefined && typeof file.workspace_loadable !== "boolean")
  ) {
    throw new Error("文件响应无效");
  }
  return file;
}

async function boundedBytes(
  response: Response,
  max: number,
  guard: () => void,
): Promise<Uint8Array[]> {
  guard();
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(max))) {
    await response.body?.cancel();
    throw new Error("文件响应超过大小限制");
  }
  if (!response.body) return [];
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      guard();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) throw new Error("文件响应超过大小限制");
      chunks.push(next.value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throw cause;
  } finally {
    reader.releaseLock();
  }
  guard();
  return chunks;
}

async function readJSON(response: Response, guard: () => void): Promise<Record<string, unknown>> {
  const chunks = await boundedBytes(response, 2 * 1024 * 1024, guard);
  const decoder = new TextDecoder();
  const text =
    chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
  guard();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("文件服务响应无效");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("文件服务响应无效");
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: "文件名或格式不受支持，请检查后重试。",
      401: "账户会话已过期，请重新登录。",
      403: "无权执行文件操作。",
      404: "文件不存在或已删除。",
      409: "文件状态已变化或存储空间已满，请刷新文件库。",
      413: "文件超过当前大小限制。",
      429: "文件服务繁忙，请稍后重试。",
      502: "文件完整性校验失败，请重新检查原件。",
      503: "文件存储尚未配置或暂时不可用。",
    };
    throw new CloudChatFileError(
      messages[response.status] ?? `文件操作失败 (HTTP ${response.status})`,
      response.status,
    );
  }
  guard();
  return data as Record<string, unknown>;
}

// Capture the account guard before fetch and retain it through body parsing and
// the immediate caller's use. No upload retry: an unknown POST may already own
// a durable original, which the account library can reconcile.
export function createCloudChatFilesClient(request: Request, captureGuard: CaptureGuard) {
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
  return {
    async upload(file: File, conversationId = "", signal?: AbortSignal) {
      if (file.size > CLOUD_FILE_MAX_BYTES)
        throw new CloudChatFileError("文件超过当前 32 MiB 大小限制。", 413);
      const data = new FormData();
      if (conversationId) data.set("conversation_id", fileID(conversationId));
      data.set("file", file);
      try {
        return parseFile(
          (await json("/api/web-chat/files", { method: "POST", body: data, signal })).file,
        );
      } catch (cause) {
        if (
          signal?.aborted ||
          cause instanceof CloudChatFileError ||
          (cause instanceof Error && /Account changed/.test(cause.message))
        )
          throw cause;
        throw new CloudFileUploadUnconfirmedError();
      }
    },
    async list(options: { conversationId?: string; before?: string; signal?: AbortSignal } = {}) {
      const query = new URLSearchParams({ limit: "50" });
      if (options.conversationId) query.set("conversation_id", fileID(options.conversationId));
      if (options.before) query.set("before", fileID(options.before));
      const data = await json(`/api/web-chat/files?${query}`, { signal: options.signal });
      if (
        !Array.isArray(data.files) ||
        data.files.length > 50 ||
        typeof data.next_cursor !== "string" ||
        (data.next_cursor && !UUID.test(data.next_cursor))
      )
        throw new Error("文件列表响应无效");
      return { files: data.files.map(parseFile), nextCursor: data.next_cursor as string };
    },
    async get(id: string, signal?: AbortSignal) {
      return parseFile((await json(`/api/web-chat/files/${fileID(id)}`, { signal })).file);
    },
    async remove(file: CloudChatFile, signal?: AbortSignal) {
      return parseFile(
        (
          await json(`/api/web-chat/files/${fileID(file.id)}`, {
            method: "DELETE",
            headers: { "If-Match": `"${file.version}"` },
            signal,
          })
        ).file,
      );
    },
    async source(id: string, fromLine = 1, toLine = fromLine + 99, signal?: AbortSignal) {
      if (
        !Number.isSafeInteger(fromLine) ||
        !Number.isSafeInteger(toLine) ||
        fromLine < 1 ||
        toLine < fromLine ||
        toLine - fromLine >= 200
      )
        throw new Error("引用行号无效");
      const data = await json(
        `/api/web-chat/files/${fileID(id)}/content?from_line=${fromLine}&to_line=${toLine}`,
        { signal },
      );
      const source = data as CloudFileSource;
      if (
        source.file_id !== fileID(id) ||
        !Array.isArray(source.lines) ||
        source.lines.length > 200 ||
        !Number.isSafeInteger(source.total_lines) ||
        source.total_lines < 1 ||
        source.from_line !== fromLine ||
        !Number.isSafeInteger(source.to_line) ||
        source.to_line > toLine ||
        source.to_line > source.total_lines ||
        source.lines.length !== source.to_line - source.from_line + 1 ||
        source.lines.some(
          (line, index) => line.line !== fromLine + index || typeof line.text !== "string",
        )
      )
        throw new Error("引用原文响应无效");
      return source;
    },
    async download(file: CloudChatFile, signal?: AbortSignal) {
      const guard = captureGuard();
      const response = await request(`/api/web-chat/files/${fileID(file.id)}/download`, {
        credentials: "include",
        headers: { Accept: "application/octet-stream" },
        signal,
      });
      guard();
      if (!response.ok) await readJSON(response, guard);
      const chunks = await boundedBytes(response, CLOUD_FILE_MAX_BYTES, guard);
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      if (size !== file.size) throw new Error("原件下载不完整，请重试。");
      guard();
      return { blob: new Blob(chunks as BlobPart[], { type: "application/octet-stream" }), guard };
    },
  };
}

export type CloudChatFilesClient = ReturnType<typeof createCloudChatFilesClient>;

export function cloudFileCanReference(file: CloudChatFile) {
  if (file.state === "vision_ready")
    return (
      ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mime) &&
      file.size <= 8 * 1024 * 1024 &&
      file.text_bytes === 0 &&
      !!file.uploaded_at
    );
  if (
    file.workspace_loadable &&
    file.uploaded_at &&
    ["uploaded", "processing", "failed", "ready"].includes(file.state)
  )
    return true;
  return file.state === "ready" && file.text_bytes <= CLOUD_FILE_CONTEXT_BYTES;
}

export function cloudFileStatus(file: CloudChatFile): string {
  if (file.state === "vision_ready") return "图片已就绪，可引用";
  if (
    file.mime === "application/zip" &&
    file.processing_stage === "workspace_only" &&
    file.state === "uploaded"
  )
    return file.workspace_loadable && file.uploaded_at
      ? "原件可在隔离沙箱读取或解压"
      : "ZIP 原件已保存，隔离沙箱暂不可用";
  if (
    file.workspace_loadable &&
    file.uploaded_at &&
    (file.state !== "ready" || file.text_bytes > CLOUD_FILE_CONTEXT_BYTES)
  )
    return "原件可在隔离沙箱读取";
  if (file.state === "ready")
    return file.text_bytes > CLOUD_FILE_CONTEXT_BYTES
      ? "原文已提取，请拆分后引用"
      : file.parse_truncated
        ? "已提取部分内容，可引用"
        : "可引用";
  if (file.state === "uploading") return "正在保存原件";
  if (file.state === "processing") return "正在解析";
  if (file.state === "uploaded") return "原件已保存，等待隔离解析";
  if (file.state === "failed")
    return file.error_code === "unsupported_text_encoding"
      ? "文本编码不支持，原件已保留"
      : file.uploaded_at
        ? "解析失败，原件已保留"
        : "原件尚未通过校验";
  if (file.state === "deleting") return "删除待重试";
  return "已删除";
}

export function cloudFileReferences(content: unknown): CloudFileReference[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): CloudFileReference[] => {
    if (
      !part ||
      typeof part !== "object" ||
      part.type !== "file_reference" ||
      typeof part.file_id !== "string" ||
      !UUID.test(part.file_id)
    )
      return [];
    return [
      {
        type: "file_reference",
        file_id: part.file_id,
        ...(typeof part.name === "string" && part.name.length <= 255 ? { name: part.name } : {}),
        ...(typeof part.mime === "string" && part.mime.length <= 255 ? { mime: part.mime } : {}),
        ...(Number.isSafeInteger(part.size) && part.size >= 0 && part.size <= CLOUD_FILE_MAX_BYTES
          ? { size: part.size }
          : {}),
      },
    ];
  });
}

export function linkCloudFileCitations(text: string): string {
  return text.replace(
    /【文件:([0-9a-f-]{36}):L([1-9]\d*)-L([1-9]\d*)】/gi,
    (raw, id: string, from: string, to: string) => {
      if (
        !UUID.test(id) ||
        !Number.isSafeInteger(Number(from)) ||
        !Number.isSafeInteger(Number(to)) ||
        Number(to) < Number(from)
      )
        return raw;
      return `[原文 L${from}–L${to}](cloud-files/${id.toLowerCase()}#L${from}-L${to})`;
    },
  );
}
