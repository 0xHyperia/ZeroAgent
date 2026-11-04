import type { MentionComposerDraft } from "@liveagent/ui/components/chat/MentionComposer";
import {
  cloudChatReasoningEffort,
  parseCloudChatModelParameters,
} from "./cloudChatModelParameters";
import { parseCloudChatPublicResearch } from "./cloudChatResearch";
import { type CloudChatRun, type CloudChatRunRequest, parseCloudChatRun } from "./cloudChatRuns";

export type CloudChatPendingInput = Omit<
  CloudChatRunRequest,
  "conversation_id" | "client_request_id"
> & {
  client_item_id: string;
  composer?: MentionComposerDraft;
  presentation: "chat" | "work";
};
export type CloudChatPendingItem = CloudChatPendingInput & {
  version: string;
  created_at: string;
  updated_at: string;
};
export type CloudChatPendingQueue = {
  conversation_id: string;
  version: string;
  items: CloudChatPendingItem[];
};
type Request = (path: string, init?: RequestInit) => Promise<Response>;
type CaptureGuard = () => () => void;
export const CLOUD_PENDING_MAX_ITEMS = 20;
const ITEM_BYTES = 4 * 1024 * 1024;
const QUEUE_BYTES = 16 * 1024 * 1024 + 64 * 1024;
const RUN_BYTES = 32 * 1024 * 1024;
const MAX_VERSION = 9223372036854775807n;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
function invalid(): never {
  throw new Error("尚未发送列表响应无效，请刷新后重试。");
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)
  )
    invalid();
  return value.toLowerCase();
}
function version(value: unknown, zero = false): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > MAX_VERSION ||
    (!zero && value === "0")
  )
    invalid();
  return value;
}
function textFields(value: unknown, names: string[]): value is Record<string, unknown> {
  return record(value) && names.every((name) => typeof value[name] === "string");
}
function numericFields(value: Record<string, unknown>, names: string[]) {
  return names.every((name) => Number.isSafeInteger(value[name]) && Number(value[name]) >= 0);
}
function validPaste(value: unknown) {
  return (
    textFields(value, ["id", "label", "text", "preview"]) &&
    numericFields(value, ["charCount", "lineCount"])
  );
}
/** Validate persisted editor data before giving it to the shared contenteditable. */
export function parseCloudPendingComposer(
  value: unknown,
  maximumBytes = 1024 * 1024,
): MentionComposerDraft {
  if (
    !textFields(value, ["text", "textWithoutLargePastes"]) ||
    typeof value.isEmpty !== "boolean" ||
    !Array.isArray(value.segments) ||
    value.segments.length > 4096
  )
    invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes)
    throw new RangeError("编辑器内容超过保存限制。");
  for (const name of [
    "largePastes",
    "skillMentions",
    "appMentions",
    "commitMentions",
    "gitFileMentions",
    "codeMentions",
  ])
    if (!Array.isArray(value[name])) invalid();
  if (value.conversationMentions !== undefined && !Array.isArray(value.conversationMentions))
    invalid();
  for (const part of value.segments) {
    if (!record(part)) invalid();
    switch (part.type) {
      case "text":
        if (typeof part.text !== "string") invalid();
        break;
      case "largePaste":
        if (!validPaste(part.paste)) invalid();
        break;
      case "fileMention":
        if (
          !textFields(part.reference, ["path", "kind"]) ||
          !["file", "dir"].includes(String(part.reference.kind))
        )
          invalid();
        break;
      case "skillMention":
        if (!textFields(part.skill, ["name", "description", "skillFile", "baseDir"])) invalid();
        if (
          part.skill.displayName !== undefined &&
          (typeof part.skill.displayName !== "string" || part.skill.displayName.length > 160)
        )
          invalid();
        break;
      case "appMention":
        if (!textFields(part.app, ["name", "path"])) invalid();
        break;
      case "commitMention":
        if (
          !textFields(part.commit, [
            "sha",
            "shortSha",
            "subject",
            "body",
            "authorName",
            "authorEmail",
            "authorDate",
            "stat",
            "remoteName",
            "remoteUrl",
          ]) ||
          !numericFields(part.commit, ["fileCount", "filesChanged", "insertions", "deletions"])
        )
          invalid();
        break;
      case "gitFileMention":
        if (
          !textFields(part.file, [
            "path",
            "status",
            "commitSha",
            "shortSha",
            "refName",
            "remoteName",
            "remoteUrl",
          ])
        )
          invalid();
        break;
      case "conversationMention":
        if (!textFields(part.conversation, ["id", "title"])) invalid();
        break;
      case "codeMention":
        if (
          !textFields(part.reference, ["path"]) ||
          !numericFields(part.reference, ["startLine", "endLine"]) ||
          Number(part.reference.startLine) < 1 ||
          Number(part.reference.endLine) < Number(part.reference.startLine)
        )
          invalid();
        break;
      default:
        invalid();
    }
  }
  const draft = structuredClone(value) as MentionComposerDraft;
  // Segments are authoritative; never restore unchecked mirror arrays into the editor.
  draft.largePastes = [];
  draft.skillMentions = [];
  draft.appMentions = [];
  draft.commitMentions = [];
  draft.gitFileMentions = [];
  draft.codeMentions = [];
  if (draft.conversationMentions !== undefined) draft.conversationMentions = [];
  for (const segment of draft.segments) {
    switch (segment.type) {
      case "largePaste":
        draft.largePastes.push(segment.paste);
        break;
      case "skillMention":
        draft.skillMentions.push(segment.skill);
        break;
      case "appMention":
        draft.appMentions.push(segment.app);
        break;
      case "commitMention":
        draft.commitMentions.push(segment.commit);
        break;
      case "gitFileMention":
        draft.gitFileMentions.push(segment.file);
        break;
      case "codeMention":
        draft.codeMentions.push(segment.reference);
        break;
      case "conversationMention":
        draft.conversationMentions ??= [];
        draft.conversationMentions.push(segment.conversation);
        break;
    }
  }
  return draft;
}

function pendingInput(value: unknown): CloudChatPendingInput {
  if (
    !record(value) ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    value.model.length > 200 ||
    !["chat", "work"].includes(String(value.presentation))
  )
    invalid();
  if (typeof value.content !== "string" && !Array.isArray(value.content)) invalid();
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > ITEM_BYTES)
    throw new RangeError("排队消息超过保存限制。");
  if (
    value.provider_key_id !== undefined &&
    (!Number.isSafeInteger(value.provider_key_id) || Number(value.provider_key_id) < 0)
  )
    invalid();
  const input: CloudChatPendingInput = {
    client_item_id: uuid(value.client_item_id),
    content: structuredClone(value.content),
    model: value.model,
    model_parameters: parseCloudChatModelParameters(value.model_parameters ?? {}, {
      fromResponse: true,
    }),
    presentation: value.presentation as "chat" | "work",
  };
  if (value.reasoning_effort)
    input.reasoning_effort = cloudChatReasoningEffort(String(value.reasoning_effort));
  if (value.provider_key_id !== undefined) input.provider_key_id = Number(value.provider_key_id);
  if (value.public_research !== undefined && value.public_research !== null)
    input.public_research = parseCloudChatPublicResearch(value.public_research, true);
  if (value.composer !== undefined && value.composer !== null)
    input.composer = parseCloudPendingComposer(value.composer);
  return input;
}

export function parseCloudChatPendingQueue(
  value: unknown,
  conversationId: string,
): CloudChatPendingQueue {
  if (
    !record(value) ||
    uuid(value.conversation_id) !== uuid(conversationId) ||
    !Array.isArray(value.items) ||
    value.items.length > CLOUD_PENDING_MAX_ITEMS
  )
    invalid();
  const items = value.items.map((raw) => {
    if (
      !record(raw) ||
      typeof raw.created_at !== "string" ||
      typeof raw.updated_at !== "string" ||
      !Number.isFinite(Date.parse(raw.created_at)) ||
      !Number.isFinite(Date.parse(raw.updated_at))
    )
      invalid();
    return {
      ...pendingInput(raw),
      version: version(raw.version),
      created_at: raw.created_at,
      updated_at: raw.updated_at,
    };
  });
  if (new Set(items.map((item) => item.client_item_id)).size !== items.length) invalid();
  return { conversation_id: conversationId, version: version(value.version, true), items };
}

export class CloudChatQueueError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401
        ? "账户会话已过期，请重新登录。"
        : status === 400
          ? "这条消息的内容或参数无效，请检查后重试。"
          : status === 409
            ? "列表已在其他页面修改，请刷新后继续。"
            : status === 413
              ? "尚未发送列表已满或内容过大，请先移除部分内容。"
              : status === 429
                ? "账户正在处理的任务较多，这条消息仍保留在尚未发送列表。"
                : status === 404
                  ? "消息或对话已不存在，请刷新列表。"
                  : "暂时无法更新尚未发送列表，请重试。",
    );
  }
}

/** Preflight failures have no server side effect; malformed responses remain uncertain. */
function validateMutation<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof CloudChatQueueError) throw error;
    throw new CloudChatQueueError(error instanceof RangeError ? 413 : 400);
  }
}
export class CloudChatPendingSubmitUnknownError extends Error {
  constructor(
    readonly conversationId: string,
    readonly clientItemId: string,
  ) {
    super("发送结果尚未确认，请先核对原请求，不要重复发送。");
  }
}

/** Inert reads/mutations only; no timers, subscriptions, automatic retry or dequeue. */
export function createCloudChatQueueClient(request: Request, captureGuard: CaptureGuard) {
  async function json(path: string, init: RequestInit = {}, maximum = QUEUE_BYTES) {
    const guard = captureGuard();
    guard();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await request(path, { ...init, credentials: "include", headers });
    try {
      guard();
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CloudChatQueueError(response.status);
    }
    const declared = response.headers.get("Content-Length");
    if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(maximum))) {
      await response.body?.cancel();
      invalid();
    }
    const reader = response.body?.getReader();
    if (!reader) invalid();
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    init.signal?.addEventListener("abort", cancel, { once: true });
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0,
      raw = "";
    try {
      for (;;) {
        guard();
        init.signal?.throwIfAborted();
        const part = await reader.read();
        guard();
        init.signal?.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maximum) invalid();
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
      const data: unknown = JSON.parse(raw);
      if (!record(data)) invalid();
      return data;
    } finally {
      init.signal?.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const path = (conversationId: string) =>
    `/api/web-chat/conversations/${uuid(conversationId)}/pending`;
  function mutate(
    conversationId: string,
    suffix: string,
    method: string,
    body: unknown,
    signal?: AbortSignal,
  ) {
    const endpoint = path(conversationId) + suffix;
    const encoded = JSON.stringify(body);
    return json(endpoint, {
      method,
      body: encoded,
      signal,
    }).then((data) => parseCloudChatPendingQueue(data.queue, conversationId));
  }
  return {
    async list(conversationId: string, signal?: AbortSignal) {
      return parseCloudChatPendingQueue(
        (await json(path(conversationId), { signal })).queue,
        conversationId,
      );
    },
    enqueue(
      conversationId: string,
      expectedVersion: string,
      item: CloudChatPendingInput,
      signal?: AbortSignal,
    ) {
      return validateMutation(() =>
        mutate(
          conversationId,
          "",
          "POST",
          { expected_version: version(expectedVersion, true), item: pendingInput(item) },
          signal,
        ),
      );
    },
    edit(
      conversationId: string,
      itemId: string,
      expectedVersion: string,
      item: CloudChatPendingInput,
      signal?: AbortSignal,
    ) {
      return validateMutation(() => {
        if (uuid(itemId) !== uuid(item.client_item_id)) invalid();
        return mutate(
          conversationId,
          `/${uuid(itemId)}`,
          "PATCH",
          { expected_version: version(expectedVersion), item: pendingInput(item) },
          signal,
        );
      });
    },
    remove(conversationId: string, itemId: string, expectedVersion: string, signal?: AbortSignal) {
      return validateMutation(() =>
        mutate(
          conversationId,
          `/${uuid(itemId)}`,
          "DELETE",
          { expected_version: version(expectedVersion) },
          signal,
        ),
      );
    },
    reorder(
      conversationId: string,
      expectedVersion: string,
      itemIds: string[],
      signal?: AbortSignal,
    ) {
      return validateMutation(() => {
        if (itemIds.length > CLOUD_PENDING_MAX_ITEMS || new Set(itemIds).size !== itemIds.length)
          invalid();
        return mutate(
          conversationId,
          "/reorder",
          "POST",
          { expected_version: version(expectedVersion, true), item_ids: itemIds.map(uuid) },
          signal,
        );
      });
    },
    async submit(
      conversationId: string,
      itemId: string,
      expectedVersion: string,
      signal?: AbortSignal,
    ): Promise<CloudChatRun> {
      const { endpoint, body } = validateMutation(() => ({
        endpoint: `${path(conversationId)}/${uuid(itemId)}/submit`,
        body: JSON.stringify({ expected_version: version(expectedVersion) }),
      }));
      try {
        const data = await json(endpoint, { method: "POST", body, signal }, RUN_BYTES);
        const run = parseCloudChatRun(data.run);
        if (run.conversation_id !== conversationId || run.client_request_id !== itemId) invalid();
        return run;
      } catch (error) {
        if (error instanceof CloudChatQueueError && error.status < 500) throw error;
        throw new CloudChatPendingSubmitUnknownError(conversationId, itemId);
      }
    },
    async findSubmitted(
      conversationId: string,
      itemId: string,
      signal?: AbortSignal,
    ): Promise<CloudChatRun | undefined> {
      const query = new URLSearchParams({
        conversation_id: uuid(conversationId),
        client_request_id: uuid(itemId),
      });
      const data = await json(`/api/web-chat/runs?${query}`, { signal }, RUN_BYTES);
      if (!Array.isArray(data.runs) || data.runs.length > 1) invalid();
      const run = data.runs.length ? parseCloudChatRun(data.runs[0]) : undefined;
      if (run && (run.conversation_id !== conversationId || run.client_request_id !== itemId))
        invalid();
      return run;
    },
  };
}
