import type { CloudChatArtifactVersion } from "./cloudChatArtifacts";
import type { CloudChatDraft } from "./cloudChatDrafts";
import type { CloudChatFile } from "./cloudChatFiles";
import {
  type CloudChatModelParameters,
  type CloudChatReasoningEffort,
  cloudChatReasoningEffort,
  parseCloudChatModelParameters,
} from "./cloudChatModelParameters";
import { parseCloudPendingComposer } from "./cloudChatQueue";

/** Private editor state, never an execution request or a source of credentials. */
export type CloudChatSavedDraft = {
  version: 1;
  draft: CloudChatDraft;
  modelSelection?: {
    model: string;
    providerKeyId?: number;
    reasoningEffort?: CloudChatReasoningEffort;
    modelParameters?: CloudChatModelParameters;
  };
};
export type CloudSavedDraftSnapshot = {
  scope: string;
  version: string;
  draft: CloudChatSavedDraft | null;
  updated_at?: string;
  last_operation_id?: string;
  applied_version?: string;
  replayed?: boolean;
};
export type CloudSavedDraftOperation = {
  expected_version: string;
  client_operation_id: string;
};
type Request = (path: string, init?: RequestInit) => Promise<Response>;
export const CLOUD_SAVED_DRAFT_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_VERSION = 9223372036854775807n;
const FILE_STATES = new Set([
  "uploading",
  "uploaded",
  "processing",
  "ready",
  "vision_ready",
  "failed",
  "deleting",
  "deleted",
]);
const ARTIFACT_STATES = new Set(["staging", "ready", "failed", "unknown", "deleting", "deleted"]);
function invalid(): never {
  throw new Error("草稿内容无效，当前输入已保留。");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid();
  return value;
}
export function cloudSavedDraftScope(value: string): string {
  return value === "" || value === "blank" ? "blank" : uuid(value);
}
function version(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > MAX_VERSION
  )
    invalid();
  return value;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== "string" || value.length > max) invalid();
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) invalid();
  return Number(value);
}
function date(value: unknown): string {
  const result = text(value, 40);
  if (!Number.isFinite(Date.parse(result))) invalid();
  return result;
}
function resourceBase(input: Record<string, unknown>) {
  const sha256 = text(input.sha256, 64);
  if (!/^[0-9a-f]{64}$/.test(sha256)) invalid();
  return {
    id: uuid(input.id),
    conversation_id: input.conversation_id === "" ? "" : uuid(input.conversation_id),
    name: text(input.name, 255),
    mime: text(input.mime, 128),
    size: integer(input.size, CLOUD_SAVED_DRAFT_BYTES),
    sha256,
    version: integer(input.version),
    created_at: date(input.created_at),
    updated_at: date(input.updated_at),
    ...(input.error_code === undefined ? {} : { error_code: text(input.error_code, 128) }),
  };
}
function file(value: unknown): CloudChatFile {
  const input = object(value);
  if (!FILE_STATES.has(String(input.state))) invalid();
  for (const key of ["parse_truncated", "workspace_loadable"])
    if (input[key] !== undefined && typeof input[key] !== "boolean") invalid();
  return {
    ...resourceBase(input),
    state: input.state as CloudChatFile["state"],
    text_bytes: integer(input.text_bytes, 2 * 1024 * 1024),
    ...(input.processing_stage === undefined
      ? {}
      : { processing_stage: text(input.processing_stage, 128) }),
    ...(input.parse_truncated === undefined
      ? {}
      : { parse_truncated: input.parse_truncated as boolean }),
    ...(input.workspace_loadable === undefined
      ? {}
      : { workspace_loadable: input.workspace_loadable as boolean }),
    ...(input.uploaded_at === undefined ? {} : { uploaded_at: date(input.uploaded_at) }),
  };
}
function artifact(value: unknown): CloudChatArtifactVersion {
  const input = object(value);
  if (!ARTIFACT_STATES.has(String(input.state))) invalid();
  return {
    ...resourceBase(input),
    family_id: uuid(input.family_id),
    source_run_id: uuid(input.source_run_id),
    number: integer(input.number),
    state: input.state as CloudChatArtifactVersion["state"],
    // Download links are resolved afresh through the authenticated resource client.
  };
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 100) invalid();
  return value.map(parse);
}
export function parseCloudChatSavedDraft(value: unknown): CloudChatSavedDraft {
  const input = object(value);
  const source = object(input.draft);
  if (
    input.version !== 1 ||
    !["chat", "work"].includes(String(source.presentation)) ||
    typeof source.researchEnabled !== "boolean"
  )
    invalid();
  const result: CloudChatSavedDraft = {
    version: 1,
    draft: {
      composer:
        source.composer === null
          ? null
          : parseCloudPendingComposer(source.composer, CLOUD_SAVED_DRAFT_BYTES),
      files: list(source.files, file),
      artifacts: list(source.artifacts, artifact),
      presentation: source.presentation as "chat" | "work",
      researchEnabled: source.researchEnabled,
      ...(source.projectId === undefined ? {} : { projectId: uuid(source.projectId) }),
    },
  };
  if (input.modelSelection !== undefined) {
    const model = object(input.modelSelection);
    result.modelSelection = {
      model: text(model.model, 512),
      ...(model.providerKeyId === undefined ? {} : { providerKeyId: integer(model.providerKeyId) }),
      ...(model.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: cloudChatReasoningEffort(text(model.reasoningEffort, 32)) }),
      ...(model.modelParameters === undefined
        ? {}
        : { modelParameters: parseCloudChatModelParameters(model.modelParameters) }),
    };
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > CLOUD_SAVED_DRAFT_BYTES)
    throw new CloudSavedDraftError(413);
  return result;
}
export function cloudSavedDraftEqual(
  left: CloudChatSavedDraft | null,
  right: CloudChatSavedDraft | null,
) {
  // PostgreSQL JSONB reorders object keys; editor and server field order is not content.
  const ordered = (_key: string, value: unknown): unknown =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
        )
      : value;
  return JSON.stringify(left, ordered) === JSON.stringify(right, ordered);
}
export function parseCloudSavedDraftSnapshot(value: unknown): CloudSavedDraftSnapshot {
  const input = object(value);
  if (input.replayed !== undefined && typeof input.replayed !== "boolean") invalid();
  return {
    scope: cloudSavedDraftScope(text(input.scope, 36)),
    version: version(input.version),
    draft: input.draft === null ? null : parseCloudChatSavedDraft(input.draft),
    ...(input.updated_at === undefined ? {} : { updated_at: date(input.updated_at) }),
    ...(input.last_operation_id === undefined
      ? {}
      : { last_operation_id: uuid(input.last_operation_id) }),
    ...(input.applied_version === undefined
      ? {}
      : { applied_version: version(input.applied_version) }),
    ...(input.replayed === undefined ? {} : { replayed: input.replayed as boolean }),
  };
}
export class CloudSavedDraftError extends Error {
  constructor(readonly status: number) {
    super(
      status === 409
        ? "草稿已在另一处修改，请选择保留的内容。"
        : status === 413
          ? "草稿容量已达上限，当前输入已保留。"
          : status === 401
            ? "登录状态已过期，当前输入尚未同步。"
            : status === 404
              ? "该对话已不可访问，当前输入尚未同步。"
              : "草稿暂时无法同步，当前输入已保留。",
    );
    this.name = "CloudSavedDraftError";
  }
}
export class CloudSavedDraftUnconfirmedError extends Error {
  constructor() {
    super("草稿保存结果尚未确认，重试将核对同一次保存。");
    this.name = "CloudSavedDraftUnconfirmedError";
  }
}

export function createCloudChatSavedDraftsClient(request: Request, captureGuard: () => () => void) {
  async function exchange(
    scope: string,
    method: "GET" | "PUT" | "DELETE",
    body?: string,
    signal?: AbortSignal,
  ) {
    scope = cloudSavedDraftScope(scope);
    const requireOwner = captureGuard();
    const guard = () => {
      requireOwner();
      signal?.throwIfAborted();
    };
    guard();
    try {
      const response = await request(`/api/web-chat/drafts/${scope}`, {
        method,
        credentials: "include",
        cache: "no-store",
        signal,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body } : {}),
      });
      guard();
      if (!response.ok) {
        await response.body?.cancel();
        if (method !== "GET" && response.status >= 500) throw new CloudSavedDraftUnconfirmedError();
        throw new CloudSavedDraftError(response.status);
      }
      const maximum = CLOUD_SAVED_DRAFT_BYTES + 64 * 1024;
      const declared = response.headers.get("Content-Length");
      if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maximum))) {
        await response.body?.cancel();
        invalid();
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          for (;;) {
            const next = await reader.read();
            guard();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > maximum) invalid();
            chunks.push(next.value);
          }
        } catch (cause) {
          await reader.cancel().catch(() => undefined);
          throw cause;
        } finally {
          reader.releaseLock();
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        invalid();
      }
      const result = parseCloudSavedDraftSnapshot(data);
      if (result.scope !== scope || (method !== "GET" && !result.applied_version)) invalid();
      guard();
      return result;
    } catch (cause) {
      // An account/abort fence takes priority over retry and never becomes a new-owner action.
      guard();
      if (method !== "GET" && !(cause instanceof CloudSavedDraftError))
        throw new CloudSavedDraftUnconfirmedError();
      if (cause instanceof CloudSavedDraftError) throw cause;
      throw new CloudSavedDraftError(0);
    }
  }
  function operation(value: CloudSavedDraftOperation) {
    return {
      expected_version: version(value.expected_version),
      client_operation_id: uuid(value.client_operation_id),
    };
  }
  return {
    get(scope: string, signal?: AbortSignal) {
      return exchange(scope, "GET", undefined, signal);
    },
    put(
      scope: string,
      draft: CloudChatSavedDraft,
      precondition: CloudSavedDraftOperation,
      signal?: AbortSignal,
    ) {
      return exchange(
        scope,
        "PUT",
        JSON.stringify({ ...operation(precondition), draft: parseCloudChatSavedDraft(draft) }),
        signal,
      );
    },
    remove(scope: string, precondition: CloudSavedDraftOperation, signal?: AbortSignal) {
      return exchange(scope, "DELETE", JSON.stringify(operation(precondition)), signal);
    },
  };
}
export type CloudChatSavedDraftsClient = ReturnType<typeof createCloudChatSavedDraftsClient>;
