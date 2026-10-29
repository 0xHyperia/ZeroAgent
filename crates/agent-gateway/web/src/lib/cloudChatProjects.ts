import type { CloudChatFile } from "./cloudChatFiles";

export type CloudProject = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  version: number;
  created_at: string;
  updated_at: string;
};
export type CloudProjectDraft = Pick<CloudProject, "name" | "description" | "instructions">;
export type CloudProjectConversation = {
  conversation_id: string;
  project_id: string;
  version: number;
  created_at: string;
  conversation?: {
    id: string;
    title: string;
    model: string;
    created_at: string;
    updated_at: string;
  };
};
export type CloudMemory = {
  id: string;
  content: string;
  enabled: boolean;
  version: number;
  created_at: string;
  updated_at: string;
};
export type CloudMemorySettings = { enabled: boolean; version: number; updated_at: string };
export type CloudWorkPage<T> = { items: T[]; next_before_id: string };
export type CloudAccountGuard = () => () => void;
type Request = (path: string, init?: RequestInit) => Promise<Response>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class CloudWorkError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudWorkError";
  }
}
export class CloudWorkUnconfirmedError extends Error {
  constructor() {
    super("创建结果尚未确认，请先刷新列表核对，避免重复创建。");
    this.name = "CloudWorkUnconfirmedError";
  }
}

function id(value: string) {
  if (!UUID.test(value)) throw new Error("资源标识无效");
  return value.toLowerCase();
}
function version(value: number, zero = false) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1))
    throw new Error("资源版本无效，请刷新后重试。");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("云端工作服务响应无效");
  return value as Record<string, unknown>;
}
function validText(value: unknown, max: number, required = false): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    new TextEncoder().encode(value).length <= max &&
    (!required || !!value.trim())
  );
}
function parseProject(value: unknown): CloudProject {
  const p = record(value);
  id(String(p.id));
  version(p.version as number);
  if (
    !validText(p.name, 200, true) ||
    !validText(p.description, 4096) ||
    !validText(p.instructions, 16384) ||
    typeof p.created_at !== "string" ||
    typeof p.updated_at !== "string"
  )
    throw new Error("项目响应无效");
  return p as CloudProject;
}
function parseMemory(value: unknown): CloudMemory {
  const m = record(value);
  id(String(m.id));
  version(m.version as number);
  if (
    !validText(m.content, 4096, true) ||
    typeof m.enabled !== "boolean" ||
    typeof m.created_at !== "string" ||
    typeof m.updated_at !== "string"
  )
    throw new Error("记忆响应无效");
  return m as CloudMemory;
}
function parseSettings(value: unknown): CloudMemorySettings {
  const s = record(value);
  version(s.version as number, true);
  if (typeof s.enabled !== "boolean" || typeof s.updated_at !== "string")
    throw new Error("记忆设置响应无效");
  return s as CloudMemorySettings;
}
function parseAssociation(value: unknown): CloudProjectConversation {
  const b = record(value);
  id(String(b.conversation_id));
  if (b.project_id !== "") id(String(b.project_id));
  version(b.version as number, true);
  if (typeof b.created_at !== "string") throw new Error("会话项目响应无效");
  return b as CloudProjectConversation;
}
function parseFile(value: unknown): CloudChatFile {
  const f = record(value);
  id(String(f.id));
  version(f.version as number);
  if (typeof f.name !== "string" || typeof f.state !== "string" || typeof f.size !== "number")
    throw new Error("项目资料响应无效");
  return f as CloudChatFile;
}

async function readJSON(response: Response, guard: () => void): Promise<unknown> {
  // Even escaped project instructions in a full 100-item page remain bounded.
  const max = 16 * 1024 * 1024;
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(max))) {
    await response.body?.cancel();
    throw new Error("云端响应过大，请减少每页条数。");
  }
  if (!response.body) throw new Error("云端工作服务响应为空");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      guard();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) throw new Error("云端响应过大");
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throw cause;
  } finally {
    reader.releaseLock();
  }
  guard();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("云端工作服务响应无效");
  }
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: "内容无效或过长，请检查后重试。",
      401: "账户会话已过期，请重新登录。",
      403: "无权执行此操作。",
      404: "资源已删除或不属于当前账户，请刷新列表。",
      409: "内容已在其他页面修改或达到数量限制。草稿已保留，请刷新后核对。",
      503: "云端存储暂时不可用，请稍后重试。",
    };
    throw new CloudWorkError(
      messages[response.status] ?? `云端操作失败 (HTTP ${response.status})`,
      response.status,
    );
  }
  guard();
  return data;
}

export function createCloudChatProjectsClient(request: Request, captureGuard: CloudAccountGuard) {
  async function json(path: string, method = "GET", body?: unknown, create = false) {
    const guard = captureGuard();
    try {
      const response = await request(`/api/web-chat${path}`, {
        method,
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      guard();
      if (response.status === 204 && response.ok) return undefined;
      return await readJSON(response, guard);
    } catch (cause) {
      guard();
      if (
        create &&
        (!(cause instanceof CloudWorkError) || cause.status >= 500 || cause.status === 408)
      )
        throw new CloudWorkUnconfirmedError();
      throw cause;
    }
  }
  async function page<T>(
    path: string,
    parse: (value: unknown) => T,
    before = "",
  ): Promise<CloudWorkPage<T>> {
    const query = new URLSearchParams({ limit: "50" });
    if (before) query.set("before_id", id(before));
    const data = record(await json(`${path}?${query}`));
    if (
      !Array.isArray(data.items) ||
      data.items.length > 50 ||
      typeof data.next_before_id !== "string" ||
      (data.next_before_id && !UUID.test(data.next_before_id))
    )
      throw new Error("云端列表响应无效");
    return { items: data.items.map(parse), next_before_id: data.next_before_id };
  }
  function draft(value: CloudProjectDraft) {
    if (
      !validText(value.name, 200, true) ||
      !validText(value.description, 4096) ||
      !validText(value.instructions, 16384)
    )
      throw new CloudWorkError("项目名称、说明或指令为空或过长，请检查后保存。", 400);
    return {
      name: value.name.trim(),
      description: value.description,
      instructions: value.instructions,
    };
  }
  async function create<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
    const guard = captureGuard();
    try {
      const result = parse(await json(path, "POST", body, true));
      guard();
      return result;
    } catch (cause) {
      guard();
      if (cause instanceof CloudWorkError || cause instanceof CloudWorkUnconfirmedError)
        throw cause;
      throw new CloudWorkUnconfirmedError();
    }
  }
  return {
    listProjects: (before = "") => page("/projects", parseProject, before),
    async getProject(projectId: string) {
      return parseProject(await json(`/projects/${id(projectId)}`));
    },
    async createProject(value: CloudProjectDraft) {
      return create("/projects", draft(value), parseProject);
    },
    async updateProject(project: CloudProject, value: CloudProjectDraft) {
      return parseProject(
        await json(`/projects/${id(project.id)}`, "PUT", {
          ...draft(value),
          expected_version: version(project.version),
        }),
      );
    },
    removeProject: (project: CloudProject) =>
      json(`/projects/${id(project.id)}`, "DELETE", { expected_version: version(project.version) }),
    async getAssociation(conversationId: string) {
      return parseAssociation(await json(`/conversations/${id(conversationId)}/project`));
    },
    async setAssociation(conversationId: string, projectId: string, expectedVersion: number) {
      return parseAssociation(
        await json(`/conversations/${id(conversationId)}/project`, "PUT", {
          project_id: projectId ? id(projectId) : "",
          expected_version: version(expectedVersion, true),
        }),
      );
    },
    listConversations: (projectId: string, before = "") =>
      page(`/projects/${id(projectId)}/conversations`, parseAssociation, before),
    listFiles: (projectId: string, before = "") =>
      page(`/projects/${id(projectId)}/files`, parseFile, before),
    async setFile(project: CloudProject, fileId: string, attached: boolean) {
      return parseProject(
        await json(`/projects/${id(project.id)}/files/${id(fileId)}`, attached ? "PUT" : "DELETE", {
          expected_version: version(project.version),
        }),
      );
    },
    listMemories: (before = "") => page("/memories", parseMemory, before),
    async createMemory(content: string, enabled = true) {
      if (!validText(content, 4096, true))
        throw new CloudWorkError("记忆内容为空或过长，请精简后保存。", 400);
      return create("/memories", { content, enabled }, parseMemory);
    },
    async updateMemory(memory: CloudMemory, content: string, enabled: boolean) {
      if (!validText(content, 4096, true))
        throw new CloudWorkError("记忆内容为空或过长，请精简后保存。", 400);
      return parseMemory(
        await json(`/memories/${id(memory.id)}`, "PUT", {
          content,
          enabled,
          expected_version: version(memory.version),
        }),
      );
    },
    removeMemory: (memory: CloudMemory) =>
      json(`/memories/${id(memory.id)}`, "DELETE", { expected_version: version(memory.version) }),
    async getMemorySettings() {
      return parseSettings(await json("/memory-settings"));
    },
    async setMemorySettings(settings: CloudMemorySettings, enabled: boolean) {
      return parseSettings(
        await json("/memory-settings", "PUT", {
          enabled,
          expected_version: version(settings.version, true),
        }),
      );
    },
  };
}
export type CloudChatProjectsClient = ReturnType<typeof createCloudChatProjectsClient>;
