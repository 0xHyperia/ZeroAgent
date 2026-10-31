export type CloudSiteRelease = {
  id: string;
  site_id: string;
  sha256: string;
  created_at: string;
  manifest: {
    format: number;
    entry_point: string;
    expanded_bytes: number;
    entries: { path: string; size: number; sha256: string; mime: string }[];
  };
};
export type CloudSiteGrant = {
  id: string;
  site_id: string;
  release_id: string;
  mode: "private" | "share";
  version: number;
  created_at: string;
  expires_at: string;
  revoked_at?: string;
  url?: string;
};
export class CloudSiteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudSiteError";
  }
}
export class CloudSiteWriteUnconfirmedError extends Error {
  constructor() {
    super("站点操作结果尚未确认，请刷新核对后再操作。");
    this.name = "CloudSiteWriteUnconfirmedError";
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
function identity(value: string) {
  if (!UUID.test(value) || value === "00000000-0000-0000-0000-000000000000")
    throw new Error("站点标识无效。");
  return value;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function sitePath(value: string) {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[\\:%?#]/.test(value) &&
    Array.from(value).every((char) => {
      const code = char.charCodeAt(0);
      return (
        code >= 32 &&
        code !== 127 &&
        !(code >= 0x202a && code <= 0x202e) &&
        !(code >= 0x2066 && code <= 0x2069)
      );
    }) &&
    value.split("/").every((part) => part && !part.startsWith("."))
  );
}
function release(value: unknown, id: string): CloudSiteRelease {
  const r = value as CloudSiteRelease;
  if (
    !r ||
    r.id !== identity(id) ||
    !UUID.test(r.site_id) ||
    !SHA.test(r.sha256) ||
    !timestamp(r.created_at) ||
    r.manifest?.format !== 1 ||
    typeof r.manifest.entry_point !== "string" ||
    !sitePath(r.manifest.entry_point) ||
    !Array.isArray(r.manifest.entries) ||
    !r.manifest.entries.length ||
    r.manifest.entries.length > 2000 ||
    !Number.isSafeInteger(r.manifest.expanded_bytes) ||
    r.manifest.expanded_bytes < 0 ||
    r.manifest.expanded_bytes > 64 * 1024 * 1024
  )
    throw new Error("站点版本响应无效。");
  let total = 0;
  const paths = new Set<string>();
  for (const entry of r.manifest.entries) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !sitePath(entry.path) ||
      paths.has(entry.path.toLowerCase()) ||
      !SHA.test(entry.sha256) ||
      typeof entry.mime !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > 8 * 1024 * 1024
    )
      throw new Error("站点资源清单无效。");
    total += entry.size;
    paths.add(entry.path.toLowerCase());
  }
  if (
    total !== r.manifest.expanded_bytes ||
    !r.manifest.entries.some((entry) => entry.path === r.manifest.entry_point && entry.size > 0)
  )
    throw new Error("站点资源清单不完整。");
  return r;
}
function grant(
  value: unknown,
  expected: { releaseId?: string; siteId?: string; mode?: string; url?: boolean },
): CloudSiteGrant {
  const g = value as CloudSiteGrant;
  if (
    !g ||
    !UUID.test(g.id) ||
    !UUID.test(g.site_id) ||
    !UUID.test(g.release_id) ||
    !["private", "share"].includes(g.mode) ||
    !Number.isSafeInteger(g.version) ||
    g.version < 1 ||
    !timestamp(g.created_at) ||
    !timestamp(g.expires_at) ||
    Date.parse(g.expires_at) <= Date.parse(g.created_at) ||
    (g.revoked_at !== undefined && !timestamp(g.revoked_at)) ||
    (expected.releaseId && g.release_id !== expected.releaseId) ||
    (expected.siteId && g.site_id !== expected.siteId) ||
    (expected.mode && g.mode !== expected.mode)
  )
    throw new Error("站点授权响应无效。");
  if (g.url !== undefined || expected.url) {
    if (typeof g.url !== "string" || g.url.length > 2048 || g.revoked_at)
      throw new Error("站点访问地址无效。");
    const u = new URL(g.url),
      prefix = `${g.site_id.replaceAll("-", "")}.`;
    const local = u.hostname.endsWith(".localhost");
    if (
      (u.protocol !== "https:" && !(u.protocol === "http:" && local)) ||
      u.username ||
      u.password ||
      u.hash ||
      u.search ||
      !u.hostname.startsWith(prefix) ||
      !new RegExp(`^/v/${g.id.replaceAll("-", "")}\\.[A-Za-z0-9_-]{43}/`).test(u.pathname)
    )
      throw new Error("站点访问地址无效。");
  }
  return g;
}
export function createCloudChatSitesClient(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  captureGuard: () => () => void,
) {
  async function json(path: string, init: RequestInit = {}) {
    const guard = captureGuard();
    const response = await request(path, {
      ...init,
      credentials: "include",
      headers: { Accept: "application/json", ...init.headers },
    });
    guard();
    if (!response.ok) {
      await response.body?.cancel();
      throw new CloudSiteError(
        (
          {
            400: "站点包不完整或格式不受支持，需要包含 index.html 和本地资源。",
            401: "账户会话已过期，请重新登录。",
            403: "无权执行站点操作。",
            404: "站点版本不存在或已删除。",
            409: "站点或分享状态已变化，请刷新核对。",
            429: "操作较多，请稍后重试。",
            502: "站点原件校验失败，请重新保存成果。",
            503: "站点托管暂不可用。",
          } as Record<number, string>
        )[response.status] ?? "站点操作失败。",
        response.status,
      );
    }
    let body = "",
      size = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true }),
      reader = response.body?.getReader();
    try {
      if (reader)
        for (;;) {
          const part = await reader.read();
          guard();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 3 * 1024 * 1024) throw new Error("站点响应过大。");
          body += decoder.decode(part.value, { stream: true });
        }
    } catch (cause) {
      await reader?.cancel().catch(() => undefined);
      throw cause;
    } finally {
      reader?.releaseLock();
    }
    body += decoder.decode();
    guard();
    return JSON.parse(body);
  }
  async function write<T>(action: () => Promise<T>) {
    const guard = captureGuard();
    try {
      return await action();
    } catch (cause) {
      guard();
      if (cause instanceof CloudSiteError && cause.status < 500 && cause.status !== 408)
        throw cause;
      throw new CloudSiteWriteUnconfirmedError();
    }
  }
  const path = (id: string) => `/api/web-chat/sites/releases/${identity(id)}`;
  const post = (value: unknown, signal?: AbortSignal): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
    signal,
  });
  return {
    captureGuard,
    async enabled(signal?: AbortSignal): Promise<boolean> {
      const value = await json("/api/web-chat/sites/config", { signal });
      if (typeof value.enabled !== "boolean") throw new Error("站点配置响应无效。");
      return value.enabled;
    },
    async get(id: string, signal?: AbortSignal) {
      try {
        return release((await json(path(id), { signal })).release, id);
      } catch (cause) {
        if (cause instanceof CloudSiteError && cause.status === 404) return null;
        throw cause;
      }
    },
    register(id: string, signal?: AbortSignal) {
      return write(async () => release((await json(path(id), post({}, signal))).release, id));
    },
    preview(id: string, requestId: string, signal?: AbortSignal) {
      identity(requestId);
      return write(async () =>
        grant((await json(`${path(id)}/preview`, post({ request_id: requestId }, signal))).grant, {
          releaseId: id,
          mode: "private",
          url: true,
        }),
      );
    },
    share(id: string, requestId: string, days: number, signal?: AbortSignal) {
      identity(requestId);
      if (![1, 7, 30].includes(days)) throw new Error("分享有效期无效。");
      return write(async () =>
        grant(
          (
            await json(
              `${path(id)}/shares`,
              post({ request_id: requestId, expires_in_seconds: days * 86400 }, signal),
            )
          ).grant,
          { releaseId: id, mode: "share", url: true },
        ),
      );
    },
    async shares(siteId: string, signal?: AbortSignal): Promise<CloudSiteGrant[]> {
      const value = await json(`/api/web-chat/sites/families/${identity(siteId)}/shares`, {
        signal,
      });
      if (!Array.isArray(value.shares) || value.shares.length > 100)
        throw new Error("分享列表响应无效。");
      return value.shares.map((g: unknown) => grant(g, { siteId, mode: "share", url: true }));
    },
    revoke(value: CloudSiteGrant, signal?: AbortSignal) {
      const g = grant(value, {});
      return write(async () => {
        const result = grant(
          (
            await json(`/api/web-chat/sites/grants/${g.id}`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ version: g.version }),
              signal,
            })
          ).grant,
          { releaseId: g.release_id, siteId: g.site_id, mode: g.mode },
        );
        if (result.id !== g.id || !result.revoked_at || result.version !== g.version + 1)
          throw new Error("撤销响应无效。");
        return result;
      });
    },
  };
}
export type CloudChatSitesClient = ReturnType<typeof createCloudChatSitesClient>;
