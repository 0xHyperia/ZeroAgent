import type { CloudChatReasoningEffort } from "./cloudChatModelParameters";

export type CloudChatToolState =
  | "prepared"
  | "executing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";
export type CloudChatPresentationState =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type CloudChatUsage = Partial<
  Record<
    "prompt_tokens" | "completion_tokens" | "total_tokens" | "input_tokens" | "output_tokens",
    number
  >
>;
/** Display identity only; opening still resolves the resource under the current account. */
export type CloudChatPresentationResource = {
  kind: "file" | "artifact" | "site" | "source" | "extension-draft";
  id: string;
  name: string;
  mime?: string;
  family_id?: string;
  version?: number;
  role: "input" | "output" | "source";
};
export type CloudChatPresentationBlock = {
  id: string;
  type: "text" | "reasoning" | "tool";
  round: number;
  text?: string;
  tool_id?: string;
  name?: string;
  state?: CloudChatToolState;
  status?: string;
  started_at?: string;
  completed_at?: string;
  resources?: CloudChatPresentationResource[];
};
export type CloudChatPresentationRound = {
  round: number;
  model?: string;
  usage?: CloudChatUsage;
  started_at?: string;
  completed_at?: string;
};
export type CloudChatPresentation = {
  version: 1;
  blocks: CloudChatPresentationBlock[];
  rounds?: CloudChatPresentationRound[];
  model?: string;
  reasoning_effort?: CloudChatReasoningEffort;
  state?: CloudChatPresentationState;
  usage?: CloudChatUsage;
  started_at?: string;
  completed_at?: string;
};

export const CLOUD_CHAT_PRESENTATION_MAX_BYTES = 16 * 1024 * 1024;
export const CLOUD_CHAT_PRESENTATION_MAX_BLOCKS = 512;
export const CLOUD_CHAT_REASONING_MAX_BYTES = 1024 * 1024;
export const CLOUD_CHAT_PUBLIC_TOOLS = new Set([
  "read_skill",
  "prepare_extension",
  "generate_image",
  "execute_code",
  "execute_command",
  "read_file",
  "write_file",
  "publish_artifact",
  "publish_site",
  "web_search",
  "fetch_page",
  "read_source",
  "read_history",
  "load_uploaded_file",
  "extract_archive",
]);
const TOOL_STATES = new Set<CloudChatToolState>([
  "prepared",
  "executing",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
const TERMINAL_TOOL_STATES = new Set(["succeeded", "failed", "cancelled"]);
const RUN_STATES = new Set<CloudChatPresentationState>([
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const REASONING = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const USAGE_FIELDS = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
] as const;
const encoder = new TextEncoder();
type Budget = { bytes: number; reasoning: Map<number, number> };
// Projection values are immutable: only a changed block is copied for a token delta.
// Cache its validated budget so a long answer is not re-encoded on every token.
const budgets = new WeakMap<CloudChatPresentation, Budget>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never {
  throw new Error("对话过程响应无效");
}
function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}
function jsonBytes(value: unknown): number {
  return bytes(JSON.stringify(value));
}
function roundNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1024) invalid();
  return value as number;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9:_-]{1,160}$/.test(value)) invalid();
  return value;
}
function contentBlockID(id: string, type: "text" | "reasoning", round: number): boolean {
  const base = `${type}:${round}`;
  if (id === base) return true;
  if (!id.startsWith(`${base}:`)) return false;
  const segment = id.slice(base.length + 1);
  return (
    /^[1-9]\d*$/.test(segment) && Number.isSafeInteger(Number(segment)) && Number(segment) >= 2
  );
}
function optionalText(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) invalid();
  return value;
}
function time(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid();
  return value;
}
function times(value: Record<string, unknown>) {
  const started_at = time(value.started_at),
    completed_at = time(value.completed_at);
  return {
    ...(started_at !== undefined ? { started_at } : {}),
    ...(completed_at !== undefined ? { completed_at } : {}),
  };
}
export function parseCloudChatUsage(value: unknown): CloudChatUsage {
  if (!record(value)) invalid();
  const parsed: CloudChatUsage = {};
  for (const key of USAGE_FIELDS) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0) invalid();
    parsed[key] = value[key] as number;
  }
  return parsed;
}
function parseRound(value: unknown): CloudChatPresentationRound {
  if (!record(value)) invalid();
  const model = optionalText(value.model, 512);
  return {
    round: roundNumber(value.round),
    ...(model !== undefined ? { model } : {}),
    ...(value.usage !== undefined && value.usage !== null
      ? { usage: parseCloudChatUsage(value.usage) }
      : {}),
    ...times(value),
  };
}
export function parseCloudChatPresentationResources(
  value: unknown,
): CloudChatPresentationResource[] {
  if (!Array.isArray(value) || value.length > 16) invalid();
  const seen = new Set<string>();
  const hasControl = (text: string) =>
    [...text].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    });
  const uuid = (input: unknown): string => {
    if (
      typeof input !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input)
    )
      invalid();
    return input;
  };
  return value.map((input) => {
    if (
      !record(input) ||
      !["file", "artifact", "site", "source", "extension-draft"].includes(String(input.kind)) ||
      !["input", "output", "source"].includes(String(input.role))
    )
      invalid();
    const id = uuid(input.id);
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      [...input.name].length > 240 ||
      hasControl(input.name)
    )
      invalid();
    const identity = `${input.kind}:${input.role}:${id}`;
    if (seen.has(identity)) invalid();
    seen.add(identity);
    const mime = optionalText(input.mime, 128);
    if (mime !== undefined && (!mime || hasControl(mime))) invalid();
    if (
      input.version !== undefined &&
      (!Number.isSafeInteger(input.version) || Number(input.version) < 1)
    )
      invalid();
    return {
      kind: input.kind as CloudChatPresentationResource["kind"],
      id,
      name: input.name,
      role: input.role as CloudChatPresentationResource["role"],
      ...(mime === undefined ? {} : { mime }),
      ...(input.family_id === undefined ? {} : { family_id: uuid(input.family_id) }),
      ...(input.version === undefined ? {} : { version: input.version as number }),
    };
  });
}
function parseBlock(value: unknown): CloudChatPresentationBlock {
  if (!record(value)) invalid();
  const id = identifier(value.id),
    round = roundNumber(value.round);
  if (value.type === "text" || value.type === "reasoning") {
    if (typeof value.text !== "string" || value.text.length > CLOUD_CHAT_PRESENTATION_MAX_BYTES)
      invalid();
    if (
      !contentBlockID(id, value.type, round) &&
      !(id === "legacy:text" && value.type === "text" && round === 0)
    )
      invalid();
    return { id, type: value.type, round, text: value.text, ...times(value) };
  }
  if (value.type !== "tool") invalid();
  const tool_id = identifier(value.tool_id);
  if (
    tool_id.length > 128 ||
    id !== `tool:${tool_id}` ||
    typeof value.name !== "string" ||
    !CLOUD_CHAT_PUBLIC_TOOLS.has(value.name) ||
    !TOOL_STATES.has(value.state as CloudChatToolState) ||
    typeof value.status !== "string" ||
    value.status.length > 200
  )
    invalid();
  return {
    id,
    type: "tool",
    round,
    tool_id,
    name: value.name,
    state: value.state as CloudChatToolState,
    status: value.status,
    ...(value.resources === undefined
      ? {}
      : { resources: parseCloudChatPresentationResources(value.resources) }),
    ...times(value),
  };
}
function remember(value: CloudChatPresentation, budget: Budget): CloudChatPresentation {
  if (
    value.blocks.length > CLOUD_CHAT_PRESENTATION_MAX_BLOCKS ||
    budget.bytes > CLOUD_CHAT_PRESENTATION_MAX_BYTES
  )
    throw new Error("对话过程超过显示上限");
  for (const size of budget.reasoning.values()) {
    if (size > CLOUD_CHAT_REASONING_MAX_BYTES) throw new Error("思考内容超过显示上限");
  }
  budgets.set(value, budget);
  return value;
}

/** Public, display-only data. Credentials, raw tool arguments and results are never retained. */
export function parseCloudChatPresentation(value: unknown): CloudChatPresentation {
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.blocks) ||
    value.blocks.length > CLOUD_CHAT_PRESENTATION_MAX_BLOCKS
  )
    invalid();
  const blocks = value.blocks.map(parseBlock);
  if (new Set(blocks.map((block) => block.id)).size !== blocks.length) invalid();
  let rounds: CloudChatPresentationRound[] | undefined;
  if (value.rounds !== undefined) {
    if (!Array.isArray(value.rounds) || value.rounds.length > CLOUD_CHAT_PRESENTATION_MAX_BLOCKS)
      invalid();
    rounds = value.rounds.map(parseRound);
    if (new Set(rounds.map((item) => item.round)).size !== rounds.length) invalid();
  }
  const model = optionalText(value.model, 512);
  if (value.reasoning_effort !== undefined && !REASONING.has(value.reasoning_effort as string))
    invalid();
  if (value.state !== undefined && !RUN_STATES.has(value.state as CloudChatPresentationState))
    invalid();
  const parsed: CloudChatPresentation = {
    version: 1,
    blocks,
    ...(rounds !== undefined ? { rounds } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(value.reasoning_effort !== undefined
      ? { reasoning_effort: value.reasoning_effort as CloudChatReasoningEffort }
      : {}),
    ...(value.state !== undefined ? { state: value.state as CloudChatPresentationState } : {}),
    ...(value.usage !== undefined && value.usage !== null
      ? { usage: parseCloudChatUsage(value.usage) }
      : {}),
    ...times(value),
  };
  const reasoning = new Map<number, number>();
  for (const block of blocks) {
    if (block.type === "reasoning")
      reasoning.set(block.round, (reasoning.get(block.round) ?? 0) + bytes(block.text ?? ""));
  }
  return remember(parsed, { bytes: jsonBytes(parsed), reasoning });
}

function metadata(value: CloudChatPresentation) {
  const { blocks: _blocks, ...rest } = value;
  return rest;
}
function appendBytes(previous: string, delta: string, json = false): number {
  let count = json ? jsonBytes(delta) - 2 : bytes(delta);
  // Network chunks may split a surrogate pair. Joined text has one four-byte code point.
  const end = previous.charCodeAt(previous.length - 1),
    start = delta.charCodeAt(0);
  if (end >= 0xd800 && end <= 0xdbff && start >= 0xdc00 && start <= 0xdfff) count -= json ? 8 : 2;
  return count;
}

/** The caller validates run identity and the event sequence before applying this projection. */
export function reduceCloudChatPresentation(
  current: CloudChatPresentation | undefined,
  eventType: string,
  data: Record<string, unknown>,
  seed: {
    output?: string;
    model?: string;
    reasoning_effort?: CloudChatReasoningEffort;
    state?: CloudChatPresentationState;
    created_at?: string;
  } = {},
): CloudChatPresentation | undefined {
  const delta = eventType === "message.delta" || eventType === "reasoning.delta";
  const tool = eventType.startsWith("tool.");
  const model = eventType === "model.started" || eventType === "model.completed";
  const lifecycle = eventType.startsWith("run.");
  if (!delta && !tool && !model && !lifecycle) return current;
  // Older persisted runs have no structured projection; their Output contract remains intact.
  if ((delta || tool) && data.block_id === undefined && data.round === undefined) return current;
  if (lifecycle && !current) return current;
  const previous = current
    ? budgets.has(current)
      ? current
      : parseCloudChatPresentation(current)
    : parseCloudChatPresentation({
        version: 1,
        blocks: seed.output
          ? [
              {
                id: "legacy:text",
                type: "text",
                round: 0,
                text: seed.output,
                started_at: seed.created_at,
              },
            ]
          : [],
        model: seed.model,
        reasoning_effort: seed.reasoning_effort,
        state: seed.state,
        started_at: seed.created_at,
      });
  const budget = budgets.get(previous);
  if (!budget) invalid();
  let next: CloudChatPresentation = previous;
  let size = budget.bytes;
  let reasoning = budget.reasoning;
  if (delta || tool) {
    const id = identifier(data.block_id),
      round = roundNumber(data.round);
    const index = previous.blocks.findIndex((block) => block.id === id);
    const old = index < 0 ? undefined : previous.blocks[index];
    let block: CloudChatPresentationBlock;
    if (delta) {
      const type = eventType === "message.delta" ? "text" : "reasoning";
      if (
        typeof data.delta !== "string" ||
        data.delta.length > CLOUD_CHAT_PRESENTATION_MAX_BYTES ||
        !contentBlockID(id, type, round) ||
        (old && (old.type !== type || old.round !== round))
      )
        invalid();
      const before = old?.text ?? "";
      block = { ...old, id, type, round, text: before + data.delta, ...times(data) };
      if (old?.started_at) block.started_at = old.started_at;
      size += old
        ? jsonBytes({ ...block, text: "" }) -
          jsonBytes({ ...old, text: "" }) +
          appendBytes(before, data.delta, true)
        : jsonBytes(block) + (previous.blocks.length ? 1 : 0);
      if (type === "reasoning") {
        reasoning = new Map(reasoning);
        reasoning.set(round, (reasoning.get(round) ?? 0) + appendBytes(before, data.delta));
      }
    } else {
      block = parseBlock({ ...data, id, type: "tool" });
      if (
        old &&
        (old.type !== "tool" ||
          old.round !== round ||
          old.name !== block.name ||
          old.tool_id !== block.tool_id)
      )
        invalid();
      if (
        old &&
        ((old.state === "executing" && block.state === "prepared") ||
          (TERMINAL_TOOL_STATES.has(old.state ?? "") &&
            !TERMINAL_TOOL_STATES.has(block.state ?? "")))
      )
        return current;
      block = { ...old, ...block, ...(old?.started_at ? { started_at: old.started_at } : {}) };
      size +=
        jsonBytes(block) - (old ? jsonBytes(old) : 0) + (!old && previous.blocks.length ? 1 : 0);
    }
    const blocks = [...previous.blocks];
    if (index < 0) blocks.push(block);
    else blocks[index] = block;
    // A new stage closes preceding model content; its duration excludes later work.
    if (index < 0 && block.started_at) {
      for (let offset = 0; offset < blocks.length - 1; offset++) {
        const previousBlock = blocks[offset];
        if (previousBlock.type === "tool" || previousBlock.completed_at) continue;
        const completed = { ...previousBlock, completed_at: block.started_at };
        size += jsonBytes({ ...completed, text: "" }) - jsonBytes({ ...previousBlock, text: "" });
        blocks[offset] = completed;
      }
    }
    next = { ...previous, blocks };
  } else if (model) {
    const item = parseRound(data);
    const rounds = [...(previous.rounds ?? [])];
    const index = rounds.findIndex((round) => round.round === item.round);
    const old = rounds[index];
    if (old?.model && item.model && old.model !== item.model) invalid();
    const updated = { ...old, ...item, ...(old?.started_at ? { started_at: old.started_at } : {}) };
    if (index < 0) rounds.push(updated);
    else rounds[index] = updated;
    if (rounds.length > CLOUD_CHAT_PRESENTATION_MAX_BLOCKS) invalid();
    next = { ...previous, rounds };
    if (eventType === "model.completed" && item.completed_at) {
      next.blocks = previous.blocks.map((block) => {
        if (block.type === "tool" || block.round !== item.round || block.completed_at) return block;
        const completed = { ...block, completed_at: item.completed_at };
        size += jsonBytes({ ...completed, text: "" }) - jsonBytes({ ...block, text: "" });
        return completed;
      });
    }
  } else if (lifecycle) {
    const state = eventType === "run.started" ? "running" : eventType.slice(4);
    next = {
      ...previous,
      ...(RUN_STATES.has(state as CloudChatPresentationState)
        ? { state: state as CloudChatPresentationState }
        : {}),
      ...(data.usage !== undefined && data.usage !== null
        ? { usage: parseCloudChatUsage(data.usage) }
        : {}),
      ...times(data),
    };
    if (previous.started_at) next.started_at = previous.started_at;
    if (["completed", "failed", "cancelled", "interrupted"].includes(state) && next.completed_at) {
      next.blocks = previous.blocks.map((block) => {
        if (block.completed_at) return block;
        const completed = {
          ...block,
          completed_at: next.completed_at,
          ...(block.type === "tool" ? { state: "unknown" as const, status: "结果待确认" } : {}),
        };
        size += jsonBytes({ ...completed, text: "" }) - jsonBytes({ ...block, text: "" });
        return completed;
      });
      if (previous.rounds)
        next.rounds = previous.rounds.map((round) =>
          round.completed_at ? round : { ...round, completed_at: next.completed_at },
        );
    }
  }
  size += jsonBytes(metadata(next)) - jsonBytes(metadata(previous));
  return remember(next, { bytes: size, reasoning });
}
