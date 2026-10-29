export type CloudSpaceLocation = {
  category: "all" | "documents" | "images" | "uploads" | "outputs";
  scope: "all" | "starred" | "trash";
  folder: string;
};
export const CLOUD_SPACE_HOME: CloudSpaceLocation = { category: "all", scope: "all", folder: "" };
export type CloudSpaceItem = {
  id: string;
  kind: "file" | "artifact" | "folder";
  target_id: string;
  name: string;
  folder_id: string;
  starred: boolean;
  trashed: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  mime: string;
  size: number;
  state: string;
  conversation_id: string;
  versions: number;
};
export type CloudSpaceUsage = {
  used_bytes: number;
  limit_bytes: number;
  file_bytes: number;
  artifact_bytes: number;
  file_limit_bytes: number;
  artifact_limit_bytes: number;
  file_count: number;
  artifact_version_count: number;
  trash_bytes: number;
};
export type CloudSpacePage = {
  items: CloudSpaceItem[];
  total: number;
  next_offset: number;
  usage: CloudSpaceUsage;
  folders: CloudSpaceItem[];
  pinned: CloudSpaceItem[];
};
export class CloudSpaceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudSpaceError";
  }
}
export class CloudSpaceSaveUnconfirmedError extends Error {
  constructor() {
    super("保存结果尚未确认，请刷新资料空间核对后再操作。");
    this.name = "CloudSpaceSaveUnconfirmedError";
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseItem(value: unknown): CloudSpaceItem {
  const item = value as CloudSpaceItem;
  if (
    !item ||
    !UUID.test(item.id) ||
    !UUID.test(item.target_id) ||
    !["file", "artifact", "folder"].includes(item.kind) ||
    typeof item.name !== "string" ||
    !item.name ||
    new TextEncoder().encode(item.name).length > 255 ||
    typeof item.folder_id !== "string" ||
    (item.folder_id !== "" && !UUID.test(item.folder_id)) ||
    typeof item.starred !== "boolean" ||
    typeof item.trashed !== "boolean" ||
    !Number.isSafeInteger(item.version) ||
    item.version < 0 ||
    !Number.isSafeInteger(item.size) ||
    item.size < 0 ||
    typeof item.mime !== "string" ||
    typeof item.state !== "string" ||
    typeof item.updated_at !== "string" ||
    typeof item.created_at !== "string"
  )
    throw new Error("资料空间响应无效");
  return item;
}
export function createCloudSpaceClient(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  captureGuard: () => () => void,
) {
  async function json(path: string, init: RequestInit = {}) {
    const guard = captureGuard();
    let response: Response;
    try {
      response = await request(path, {
        ...init,
        credentials: "include",
        headers: { Accept: "application/json", ...init.headers },
      });
    } catch (cause) {
      guard();
      if (init.method === "PUT" && !init.signal?.aborted)
        throw new Error("保存结果尚未确认，请刷新资料空间核对后再操作。");
      throw cause;
    }
    guard();
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let bytes = 0,
      body = "";
    try {
      if (reader)
        for (;;) {
          const chunk = await reader.read();
          guard();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2 * 1024 * 1024) throw new Error("资料空间响应过大");
          body += decoder.decode(chunk.value, { stream: true });
        }
    } catch (cause) {
      await reader?.cancel().catch(() => undefined);
      throw cause;
    } finally {
      reader?.releaseLock();
    }
    body += decoder.decode();
    guard();
    if (!response.ok)
      throw new CloudSpaceError(
        (
          {
            401: "账户会话已过期，请重新登录。",
            404: "资料或文件夹已不存在。",
            409: "资料已变更，或文件夹仍有内容。请刷新后重试。",
            400: "资料名称或操作无效。",
            503: "资料空间暂时不可用，请稍后重试。",
          } as Record<number, string>
        )[response.status] ?? "资料空间操作失败，请重试。",
        response.status,
      );
    return JSON.parse(body);
  }
  return {
    async list(
      location: CloudSpaceLocation = CLOUD_SPACE_HOME,
      query = "",
      sort = "updated",
      offset = 0,
      signal?: AbortSignal,
    ): Promise<CloudSpacePage> {
      const params = new URLSearchParams({
        category: location.category,
        scope: location.scope,
        folder: location.folder,
        q: query,
        sort,
        offset: String(offset),
      });
      const data = await json(`/api/web-chat/space?${params}`, { signal });
      if (
        !Array.isArray(data.items) ||
        data.items.length > 50 ||
        !Array.isArray(data.folders) ||
        data.folders.length > 100 ||
        !Array.isArray(data.pinned) ||
        data.pinned.length > 6 ||
        !Number.isSafeInteger(data.total) ||
        data.total < 0 ||
        !Number.isSafeInteger(data.next_offset) ||
        data.next_offset < -1 ||
        !data.usage ||
        [
          "used_bytes",
          "limit_bytes",
          "file_bytes",
          "artifact_bytes",
          "file_limit_bytes",
          "artifact_limit_bytes",
          "file_count",
          "artifact_version_count",
          "trash_bytes",
        ].some((key) => !Number.isSafeInteger(data.usage[key]) || data.usage[key] < 0) ||
        !Number.isSafeInteger(data.usage.limit_bytes) ||
        data.usage.limit_bytes <= 0
      )
        throw new Error("资料空间响应无效");
      return {
        ...data,
        items: data.items.map(parseItem),
        folders: data.folders.map(parseItem),
        pinned: data.pinned.map(parseItem),
      };
    },
    async update(
      item: Pick<
        CloudSpaceItem,
        "id" | "kind" | "name" | "folder_id" | "starred" | "trashed" | "version"
      >,
      changes: Partial<Pick<CloudSpaceItem, "name" | "folder_id" | "starred" | "trashed">>,
      signal?: AbortSignal,
    ) {
      if (!UUID.test(item.id)) throw new Error("资料标识无效");
      const next = { ...item, ...changes };
      try {
        const saved = await json(`/api/web-chat/space/${item.kind}/${item.id}`, {
          method: "PUT",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: next.name,
            folder_id: next.folder_id,
            starred: next.starred,
            trashed: next.trashed,
            version: next.version,
          }),
        });
        if (saved.id !== item.id || saved.kind !== item.kind || saved.version !== item.version + 1)
          throw new Error("Invalid space mutation result");
        return saved;
      } catch (cause) {
        if (
          cause instanceof CloudSpaceError ||
          signal?.aborted ||
          (cause instanceof Error && /Account changed/.test(cause.message))
        )
          throw cause;
        throw new CloudSpaceSaveUnconfirmedError();
      }
    },
  };
}
export type CloudSpaceClient = ReturnType<typeof createCloudSpaceClient>;
export function cloudSpaceTitle(location: CloudSpaceLocation) {
  if (location.scope === "trash") return "回收站";
  if (location.scope === "starred") return "收藏";
  return {
    all: "全部资料",
    documents: "文档与文件",
    images: "图像",
    uploads: "我的上传",
    outputs: "工作产出",
  }[location.category];
}
export function cloudSpaceSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
