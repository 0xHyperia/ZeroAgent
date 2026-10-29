import {
  type CloudChatModelParameters,
  type CloudChatReasoningEffort,
  parseCloudChatModelParameters,
} from "./cloudChatModelParameters";
import { type CloudChatPublicResearch, parseCloudChatPublicResearch } from "./cloudChatResearch";

export type CloudChatRunState =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type CloudChatRun = {
  id: string;
  conversation_id: string;
  client_request_id: string;
  model: string;
  state: CloudChatRunState;
  user_message_id: string;
  assistant_message_id: string;
  output: string;
  usage?: unknown;
  error_code?: string;
  last_seq: string;
  created_at?: string;
  updated_at?: string;
  active_tools?: CloudChatActiveTool[];
  model_parameters?: CloudChatModelParameters;
  public_research?: CloudChatPublicResearch;
};

export type CloudChatActiveTool = {
  tool_id: string;
  name: string;
  state: "prepared" | "executing" | "succeeded" | "failed" | "cancelled" | "unknown";
  status: string;
};
const PUBLIC_TOOLS = new Set([
  "execute_code",
  "execute_command",
  "read_file",
  "write_file",
  "publish_artifact",
  "web_search",
  "fetch_page",
  "read_source",
  "read_history",
  "load_uploaded_file",
  "extract_archive",
]);
function activeTool(value: unknown): CloudChatActiveTool {
  if (
    !record(value) ||
    typeof value.tool_id !== "string" ||
    !value.tool_id ||
    value.tool_id.length > 128 ||
    typeof value.name !== "string" ||
    !PUBLIC_TOOLS.has(value.name) ||
    !["prepared", "executing", "succeeded", "failed", "cancelled", "unknown"].includes(
      String(value.state),
    ) ||
    typeof value.status !== "string" ||
    value.status.length > 200
  )
    throw new Error("任务进度响应无效");
  return {
    tool_id: value.tool_id,
    name: value.name,
    state: value.state as CloudChatActiveTool["state"],
    status: value.status,
  };
}

export type CloudChatRunRequest = {
  conversation_id: string;
  client_request_id: string;
  model: string;
  content: unknown;
  reasoning_effort?: CloudChatReasoningEffort;
  model_parameters?: CloudChatModelParameters;
  provider_key_id?: number;
  public_research?: CloudChatPublicResearch;
};

export type CloudChatRunEvent = {
  run_id: string;
  seq: string;
  type: string;
  data?: { delta?: string; state?: CloudChatRunState; error_code?: string; usage?: unknown };
};

type CloudChatFetch = (path: string, init?: RequestInit) => Promise<Response>;
type ConnectionState = "connecting" | "connected" | "reconnecting";
const RUN_STATES = new Set<CloudChatRunState>([
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const TERMINAL_STATES = new Set<CloudChatRunState>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;
const MAX_EVENT_CHARS = MAX_OUTPUT_CHARS * 2 + 64 * 1024;

export class CloudChatRunRequestError extends Error {
  readonly reason?: string;
  constructor(
    public readonly status: number,
    reason?: string,
  ) {
    const modelMessages: Record<string, string> = {
      model_request_format_unsupported: "云端对话当前使用 Chat Completions，请检查模型设置。",
      model_token_limits_invalid: "上下文窗口或最大输出无效，请检查模型设置。",
      model_cache_mode_unsupported: "云端支持自动或不发送缓存提示，请调整手动缓存模式。",
      model_input_modalities_invalid: "模型输入设置无效，请选择文本或文本与图片。",
      model_input_modality_unsupported: "所选模型仅允许文本，请开启图片输入或移除图片。",
      model_time_zone_invalid: "时区偏好无效，请检查设备的时区设置后重试。",
      model_locale_invalid: "语言偏好无效，请检查设备语言设置后重试。",
      public_research_topic_invalid: "请确认公开检索主题，长度不能超过 8 KiB。",
    };
    const modelMessage =
      reason && Object.hasOwn(modelMessages, reason) ? modelMessages[reason] : undefined;
    super(
      (status === 429 && reason === "cloud_stream_limit"
        ? "打开的实时页面已达上限，请关闭其他窗口后重试；任务会继续运行。"
        : undefined) ||
        (status === 400 && modelMessage) ||
        (status === 401
          ? "登录已失效，请重新登录"
          : status === 403
            ? "没有操作该任务的权限"
            : status === 404
              ? "任务不存在或已不可访问"
              : status === 409
                ? "会话中已有任务，或重试的提交内容不一致，请刷新后重试"
                : status === 429
                  ? "请求过于频繁，请稍后重试"
                  : `任务请求失败 (HTTP ${status})`),
    );
    this.name = "CloudChatRunRequestError";
    this.reason =
      reason &&
      (Object.hasOwn(modelMessages, reason) ||
        ["account_queue_full", "cloud_stream_limit"].includes(reason))
        ? reason
        : undefined;
  }
}

export class CloudChatAccountQueueFullError extends CloudChatRunRequestError {
  constructor() {
    super(429, "account_queue_full");
    this.name = "CloudChatAccountQueueFullError";
    this.message = "当前账户排队任务已达上限，这条消息尚未发送。请等待已有任务完成或取消后再试。";
  }
}

async function cloudRequestError(
  response: Response,
  admission = false,
): Promise<CloudChatRunRequestError> {
  if (![400, 429].includes(response.status) || !response.body)
    return new CloudChatRunRequestError(response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0,
    reason: string | undefined;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16 * 1024) break;
      chunks.push(next.value);
    }
    if (size <= 16 * 1024) {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const data = JSON.parse(
        chunks.map((part) => decoder.decode(part, { stream: true })).join("") + decoder.decode(),
      );
      if (record(data) && typeof data.reason === "string") reason = data.reason;
    }
  } catch {
    // Only known reason codes become UI copy; upstream/error bodies never do.
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return admission && response.status === 429 && reason === "account_queue_full"
    ? new CloudChatAccountQueueFullError()
    : new CloudChatRunRequestError(response.status, reason);
}

export class CloudChatSubmissionUnknownError extends Error {
  constructor() {
    super("提交结果尚未确认。请重试核对原任务，不会重复创建任务。");
    this.name = "CloudChatSubmissionUnknownError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function cloudChatSequence(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,79})$/.test(value)) {
    throw new Error("任务事件水位无效");
  }
  return value;
}

export function parseCloudChatRun(value: unknown): CloudChatRun {
  if (!record(value)) throw new Error("任务响应无效");
  for (const field of [
    "id",
    "conversation_id",
    "client_request_id",
    "user_message_id",
    "assistant_message_id",
  ]) {
    if (typeof value[field] !== "string" || !value[field]) throw new Error("任务响应缺少标识");
  }
  if (
    !RUN_STATES.has(value.state as CloudChatRunState) ||
    typeof value.output !== "string" ||
    value.output.length > MAX_OUTPUT_CHARS ||
    typeof value.model !== "string"
  ) {
    throw new Error("任务响应状态无效");
  }
  cloudChatSequence(value.last_seq);
  const parsed = {
    ...value,
    ...(value.public_research !== undefined
      ? { public_research: parseCloudChatPublicResearch(value.public_research, true) }
      : {}),
    ...(value.model_parameters !== undefined
      ? {
          model_parameters: parseCloudChatModelParameters(value.model_parameters, {
            fromResponse: true,
          }),
        }
      : {}),
  };
  if (value.active_tools !== undefined) {
    if (!Array.isArray(value.active_tools) || value.active_tools.length > 8)
      throw new Error("任务进度响应无效");
    return { ...parsed, active_tools: value.active_tools.map(activeTool) } as CloudChatRun;
  }
  return parsed as CloudChatRun;
}

export function isCloudChatRunTerminal(run: Pick<CloudChatRun, "state">): boolean {
  return TERMINAL_STATES.has(run.state);
}

export function reduceCloudChatRunEvent(run: CloudChatRun, value: unknown): CloudChatRun {
  if (!record(value) || value.run_id !== run.id || typeof value.type !== "string") {
    throw new Error("任务事件身份无效");
  }
  const seq = cloudChatSequence(value.seq);
  if (BigInt(seq) <= BigInt(run.last_seq)) return run;
  if (BigInt(seq) !== BigInt(run.last_seq) + 1n) throw new Error("任务事件需要重新同步");
  const event = value as CloudChatRunEvent;
  const data = record(event.data) ? event.data : {};
  let output = run.output;
  if (event.type === "message.delta") {
    if (typeof data.delta !== "string") throw new Error("任务输出事件无效");
    output += data.delta;
    if (output.length > MAX_OUTPUT_CHARS) throw new Error("任务输出超过显示上限");
  }
  let tools = run.active_tools ?? [];
  if (event.type.startsWith("tool.")) {
    const tool = activeTool(data);
    const previous = tools.find((item) => item.tool_id === tool.tool_id);
    if (!(tool.state === "prepared" && previous?.state === "executing")) {
      tools = tools.filter((item) => item.tool_id !== tool.tool_id);
      if (["prepared", "executing", "unknown"].includes(tool.state))
        tools = [...tools, tool].slice(-8);
    }
  }
  const state = event.type.startsWith("run.")
    ? event.type.slice(4)
    : event.type.startsWith("tool.")
      ? undefined
      : data.state;
  // Public events use run.started, while persisted state is running.
  const nextState = state === "started" ? "running" : state;
  return {
    ...run,
    last_seq: seq,
    output,
    active_tools: TERMINAL_STATES.has(nextState as CloudChatRunState) ? [] : tools,
    state: RUN_STATES.has(nextState as CloudChatRunState)
      ? (nextState as CloudChatRunState)
      : run.state,
    ...(typeof data.error_code === "string" ? { error_code: data.error_code } : {}),
    ...(data.usage !== undefined ? { usage: data.usage } : {}),
  };
}

export function cloudChatRunToolStatus(run: CloudChatRun): string | null {
  if (run.state !== "running" && run.state !== "queued") return null;
  const tools = run.active_tools ?? [];
  return (
    (
      tools.find((tool) => tool.state === "unknown") ??
      tools.find((tool) => tool.state === "executing") ??
      tools[0]
    )?.status ?? null
  );
}

export function cloudChatRunStatusText(
  run: Pick<CloudChatRun, "state" | "error_code">,
): string | null {
  switch (run.state) {
    case "queued":
      return "任务已保存，等待开始";
    case "running":
      return "正在生成";
    case "cancelling":
      return "正在停止任务";
    case "cancelled":
      return "任务已停止，已生成的内容已保留";
    case "interrupted":
      if (run.error_code === "cloud_cancellation_outcome_unknown")
        return "任务已停止推进，但远端执行结果或工作区结束状态尚未确认；内容已保留，请勿直接重试可能已执行的操作。";
      if (run.error_code === "model_output_limit")
        return "本次回答达到模型输出上限，已保留内容，可继续追问。";
      return "任务已中断，已生成的内容已保留；未自动重复执行";
    case "failed":
      if (run.error_code === "cloud_research_authorization_required")
        return "联网研究授权已失效或当前已进入私有分析阶段，请重新确认公开主题后发起新任务。";
      if (run.error_code === "cloud_research_unavailable")
        return "当前联网研究服务不可用，请关闭联网后继续，或联系管理员。";
      if (run.error_code === "cloud_research_source_unavailable")
        return "本任务的来源资料已不可用，已停止使用，请重新检索后继续。";
      if (run.error_code === "cloud_research_budget_exceeded")
        return "当前搜索额度已用完，请稍后重试，或关闭联网继续。";
      if (run.error_code === "model_context_window_exceeded")
        return "本次对话超过所选模型的上下文窗口，请调整模型参数或在新对话继续。";
      if (run.error_code === "model_input_modality_unsupported")
        return "所选模型当前仅允许文本，请开启图片输入或移除图片后重试。";
      if (run.error_code === "file_unavailable") return "附件尚未就绪或已删除，请检查文件后重试。";
      if (run.error_code === "file_context_limit" || run.error_code === "context_limit")
        return "本次资料超过可处理长度，请拆分文件或在新对话继续。";
      if (run.error_code === "project_context_changed")
        return "项目资料或归属刚刚发生变化，请核对后重试。";
      if (
        run.error_code === "project_context_unavailable" ||
        run.error_code === "memory_context_unavailable"
      )
        return "暂时无法读取项目或记忆，本次未开始生成，请稍后重试。";
      return run.error_code === "authorization_revoked" ||
        run.error_code === "authorization_expired" ||
        run.error_code === "session_expired"
        ? "任务授权已失效，请重新登录后继续"
        : "任务未能完成，已生成的内容已保留";
    default:
      return null;
  }
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function permanent(cause: unknown): boolean {
  return (
    cause instanceof CloudChatAccountQueueFullError ||
    (cause instanceof CloudChatRunRequestError &&
      cause.status >= 400 &&
      cause.status < 500 &&
      cause.status !== 429) ||
    (cause instanceof Error && cause.message.startsWith("Account changed"))
  );
}

export function waitForCloudChatRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    aborted(signal);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readEvents(
  response: Response,
  signal: AbortSignal,
  onFrame: (event: string, data: string) => boolean | undefined,
): Promise<void> {
  if (!response.ok) throw new CloudChatRunRequestError(response.status);
  if (!response.body || !response.headers.get("Content-Type")?.includes("text/event-stream")) {
    throw new Error("任务事件流无效");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      aborted(signal);
      const { value, done } = await reader.read();
      aborted(signal);
      buffer += decoder.decode(value, { stream: !done });
      // CRLF may be split across network chunks; normalize only complete frame boundaries.
      let match = /\r?\n\r?\n/.exec(buffer);
      while (match) {
        const frame = buffer.slice(0, match.index);
        if (frame.length > MAX_EVENT_CHARS) throw new Error("任务事件超过显示上限");
        buffer = buffer.slice(match.index + match[0].length);
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trimStart();
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length > 0 && onFrame(event, data.join("\n")) === false) return;
        match = /\r?\n\r?\n/.exec(buffer);
      }
      if (buffer.length > MAX_EVENT_CHARS) throw new Error("任务事件超过显示上限");
      if (done) break;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createCloudChatRunsClient(request: CloudChatFetch) {
  async function json(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    if (init?.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await request(path, { ...init, credentials: "include", headers });
    if (!response.ok)
      throw await cloudRequestError(
        response,
        path === "/api/web-chat/runs" && init?.method === "POST",
      );
    const data: unknown = await response.json();
    if (!record(data)) throw new Error("任务响应无效");
    return data;
  }

  async function getRun(id: string, signal?: AbortSignal): Promise<CloudChatRun> {
    const data = await json(`/api/web-chat/runs/${encodeURIComponent(id)}`, { signal });
    const run = parseCloudChatRun(data.run);
    if (run.id !== id) throw new Error("任务响应身份无效");
    return run;
  }

  async function listRuns(
    conversationId: string,
    activeOnly = false,
    signal?: AbortSignal,
    clientRequestId?: string,
  ): Promise<CloudChatRun[]> {
    const query = new URLSearchParams({ conversation_id: conversationId });
    if (activeOnly) query.set("active", "true");
    if (clientRequestId) query.set("client_request_id", clientRequestId);
    const data = await json(`/api/web-chat/runs?${query}`, { signal });
    if (!Array.isArray(data.runs)) throw new Error("任务列表响应无效");
    return data.runs.map(parseCloudChatRun).filter((run) => run.conversation_id === conversationId);
  }

  async function createRun(
    input: CloudChatRunRequest,
    signal?: AbortSignal,
  ): Promise<CloudChatRun> {
    // A failed response is not evidence that POST was rejected. Reuse the exact request ID/body.
    const body = JSON.stringify({
      ...input,
      ...(input.public_research !== undefined
        ? { public_research: parseCloudChatPublicResearch(input.public_research) }
        : {}),
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      aborted(signal);
      try {
        const data = await json("/api/web-chat/runs", { method: "POST", body, signal });
        const run = parseCloudChatRun(data.run);
        if (
          run.client_request_id !== input.client_request_id ||
          run.conversation_id !== input.conversation_id
        ) {
          throw new Error("任务提交回执身份无效");
        }
        return run;
      } catch (cause) {
        aborted(signal);
        if (permanent(cause)) throw cause;
        try {
          const known = (
            await listRuns(input.conversation_id, false, signal, input.client_request_id)
          ).find((run) => run.client_request_id === input.client_request_id);
          if (known) return known;
        } catch (lookupError) {
          aborted(signal);
          if (permanent(lookupError)) throw lookupError;
        }
      }
    }
    throw new CloudChatSubmissionUnknownError();
  }

  async function cancelRun(id: string, signal?: AbortSignal): Promise<CloudChatRun> {
    const data = await json(`/api/web-chat/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      signal,
    });
    const run = parseCloudChatRun(data.run);
    if (run.id !== id) throw new Error("任务停止回执身份无效");
    return run;
  }

  async function watchRun(
    initial: CloudChatRun,
    options: {
      signal: AbortSignal;
      onRun: (run: CloudChatRun) => void;
      onConnection?: (state: ConnectionState) => void;
      onRecoverableError?: (cause: CloudChatRunRequestError) => void;
      retry?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    },
  ): Promise<CloudChatRun> {
    const { signal } = options;
    const retry = options.retry ?? waitForCloudChatRetry;
    let run = initial;
    let failures = 0;
    const update = (next: CloudChatRun) => {
      aborted(signal);
      if (next.id !== initial.id || next.conversation_id !== initial.conversation_id) {
        throw new Error("任务恢复身份无效");
      }
      if (BigInt(next.last_seq) < BigInt(run.last_seq)) return;
      run = next;
      options.onRun(run);
    };
    update(run);
    while (!isCloudChatRunTerminal(run)) {
      aborted(signal);
      options.onConnection?.(failures > 0 ? "reconnecting" : "connecting");
      try {
        const response = await request(
          `/api/web-chat/runs/${encodeURIComponent(run.id)}/events?after_seq=${run.last_seq}`,
          { credentials: "include", headers: { Accept: "text/event-stream" }, signal },
        );
        aborted(signal);
        if (!response.ok) throw await cloudRequestError(response);
        options.onConnection?.("connected");
        await readEvents(response, signal, (event, data) => {
          const value: unknown = JSON.parse(data);
          if (event === "snapshot") {
            if (!record(value)) throw new Error("任务快照无效");
            update(parseCloudChatRun(value.run));
          } else if (event === "cloud_run") {
            update(reduceCloudChatRunEvent(run, value));
          }
          failures = 0;
          return !isCloudChatRunTerminal(run);
        });
      } catch (cause) {
        aborted(signal);
        if (permanent(cause)) throw cause;
        if (cause instanceof CloudChatRunRequestError) options.onRecoverableError?.(cause);
        failures++;
      }
      if (isCloudChatRunTerminal(run)) break;
      try {
        update(await getRun(run.id, signal));
      } catch (cause) {
        aborted(signal);
        if (permanent(cause)) throw cause;
        failures++;
      }
      if (!isCloudChatRunTerminal(run)) {
        options.onConnection?.("reconnecting");
        await retry(Math.min(500 * 2 ** Math.min(failures, 4), 8000), signal);
      }
    }
    return run;
  }

  return { createRun, getRun, listRuns, cancelRun, watchRun };
}
