import type {
  AssistantDeliverable,
  AssistantResource,
} from "@liveagent/ui/lib/chat/assistantResources";
import { sliceStreamingMarkdownTail } from "@liveagent/ui/lib/chat/streamingRenderPolicy";
import type { GatewayTranscriptRound } from "./chatUi";
import type { CloudChatMessage } from "./cloudChatHistory";
import { cloudMessageText, cloudMessageTextPage } from "./cloudChatMessagePreview";
import type {
  CloudChatPresentation,
  CloudChatPresentationResource,
  CloudChatUsage,
} from "./cloudChatPresentation";

const resourceUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const resourceRoutes = {
  file: "cloud-files",
  artifact: "cloud-artifacts",
  site: "cloud-sites",
  source: "cloud-sources",
} as const;
function sharedResource(resource: CloudChatPresentationResource): AssistantResource | undefined {
  // The host resolves this immutable identity with its authenticated resource API.
  // Never turn model-supplied URLs, paths or tool arguments into a navigation target.
  if (
    !resourceUUID.test(resource.id) ||
    !Object.hasOwn(resourceRoutes, resource.kind) ||
    typeof resource.name !== "string" ||
    !resource.name.trim()
  )
    return undefined;
  return {
    id: resource.id,
    kind: resource.kind,
    name: resource.name,
    role: resource.role,
    mime: resource.mime,
    version: resource.version,
    link: { path: `${resourceRoutes[resource.kind]}/${resource.id}`, source: "relative" },
  };
}

/** Saved output receipts stay visible even when a later model round fails. */
export function cloudChatAssistantDeliverables(message: CloudChatMessage): AssistantDeliverable[] {
  const items = new Map<string, AssistantDeliverable>();
  for (const block of message.presentation?.blocks ?? []) {
    if (block.type !== "tool") continue;
    for (const resource of block.resources ?? []) {
      if (resource.role !== "output" || (resource.kind !== "artifact" && resource.kind !== "site"))
        continue;
      const safe = sharedResource(resource);
      if (!safe) continue;
      const item: AssistantDeliverable = {
        ...safe,
        kind: resource.kind,
        role: "output",
        status: block.state === "succeeded" ? "saved" : "unconfirmed",
      };
      const key = `${item.kind}:${item.id}`;
      if (items.get(key)?.status !== "saved") items.set(key, item);
    }
  }
  return [...items.values()];
}

/** Safe input/source navigation for the paged process reader as well as tool rows. */
export function cloudChatProcessResources(
  presentation?: CloudChatPresentation,
): AssistantResource[] {
  const items = new Map<string, AssistantResource>();
  for (const block of presentation?.blocks ?? []) {
    if (block.type !== "tool") continue;
    for (const resource of block.resources ?? []) {
      if (resource.role !== "input" && resource.role !== "source") continue;
      const safe = sharedResource(resource);
      if (safe) items.set(`${safe.kind}:${safe.id}:${safe.version ?? ""}`, safe);
    }
  }
  return [...items.values()];
}

function toolLabel(name?: string, fallback?: string) {
  const labels: Record<string, string> = {
    read_file: "读取文件",
    load_uploaded_file: "读取上传资料",
    write_file: "写入文件",
    execute_code: "运行代码",
    execute_command: "执行命令",
    extract_archive: "解压资料",
    web_search: "搜索网页",
    fetch_page: "读取网页",
    read_source: "查看来源",
    read_history: "查阅对话",
    publish_artifact: "保存成果",
    publish_site: "创建站点",
  };
  return labels[name ?? ""] ?? fallback ?? "工具任务";
}

function timestamp(value?: string) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function duration(start?: string, end?: string) {
  const from = timestamp(start),
    to = timestamp(end);
  return from !== undefined && to !== undefined && to >= from ? to - from : undefined;
}
export function cloudChatMessageTimestamp(message: CloudChatMessage) {
  return timestamp(message.presentation?.completed_at ?? message.created_at);
}
function tokenUsage(
  usage?: CloudChatUsage,
): NonNullable<GatewayTranscriptRound["meta"]>["tokenUsage"] {
  if (!usage || !Object.keys(usage).length) return undefined;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  const totalTokens =
    usage.total_tokens ??
    (input !== undefined && output !== undefined && Number.isSafeInteger(input + output)
      ? input + output
      : undefined);
  return { input, output, totalTokens };
}

/** Shared transcript projection only: no cloud authority or executable arguments. */
export function cloudChatAssistantRounds(
  message: CloudChatMessage,
  options: {
    live: boolean;
    fallbackText: string;
    mapText: (text: string) => string;
    processVisible?: boolean;
  },
): GatewayTranscriptRound[] {
  const presentation =
    !message.content_omitted && !message.presentation_omitted ? message.presentation : undefined;
  const fallback = (includeProcessLink = false): GatewayTranscriptRound[] => [
    {
      key: `${message.id}:round:1`,
      round: 1,
      runningToolCallIds: [],
      blocks: [
        ...(options.fallbackText
          ? [{ kind: "text" as const, id: `${message.id}:text`, text: options.fallbackText }]
          : []),
        ...(includeProcessLink && presentation?.blocks.length
          ? [
              {
                kind: "text" as const,
                id: `${message.id}:process-link`,
                text: `[查看完整工作过程](cloud-messages/${message.id})`,
              },
            ]
          : []),
      ],
      ...(message.presentation && !message.presentation_omitted
        ? {
            meta: {
              model: message.presentation.model,
              reasoningEffort: message.presentation.reasoning_effort,
              tokenUsage: tokenUsage(message.presentation.usage),
              outcome: message.presentation.state,
              stopReason: options.live ? undefined : message.presentation.state || "stop",
              durationMs: duration(
                message.presentation.started_at,
                message.presentation.completed_at,
              ),
            },
          }
        : {}),
    },
  ];
  if (
    !presentation ||
    options.processVisible === false ||
    cloudMessageText(message.content).length > 4096
  )
    return fallback();
  // Output is the canonical copy/edit contract. A legacy resumed or incomplete
  // projection must never replace it with only the newly streamed suffix.
  const textBlocks = presentation.blocks.filter((block) => block.type === "text");
  const textParts = textBlocks.map((block) => block.text ?? "");
  const projectedText = textParts.join("");
  const canonicalText = cloudMessageText(message.content);
  // Persisted paragraph bodies can use one explicit blank line between projection
  // text blocks. Accept exactly that representation, never normalized/trimmed text
  // or a suffix that could silently replace canonical output after resume.
  const paragraphSeparated =
    canonicalText !== projectedText && canonicalText === textParts.join("\n\n");
  if (canonicalText !== projectedText && !paragraphSeparated) return fallback(true);
  const paragraphStart = textBlocks[0]?.id;
  const numbers = [
    ...new Set([
      ...presentation.blocks.map((block) => block.round),
      ...(presentation.rounds ?? []).map((round) => round.round),
    ]),
  ].sort((left, right) => left - right);
  if (!numbers.length) numbers.push(0);
  const trailingBlock = presentation.blocks.at(-1);
  const liveReasoning =
    options.live && trailingBlock?.type === "reasoning" && !trailingBlock.completed_at
      ? trailingBlock
      : undefined;
  const liveReasoningBudget = Math.min(4096, liveReasoning?.text?.length ?? 0);
  let reasoningBudget = 8192 - liveReasoningBudget;
  const reasoningChars = presentation.blocks.reduce(
    (sum, block) => sum + (block.type === "reasoning" ? (block.text?.length ?? 0) : 0),
    0,
  );
  let reasoningNotice = false;
  return numbers.map((number, index) => {
    const last = index === numbers.length - 1;
    const metadata = presentation.rounds?.find((round) => round.round === number);
    const blocks: GatewayTranscriptRound["blocks"] = [];
    const runningToolCallIds: string[] = [];
    const source = presentation.blocks.filter((block) => block.round === number);
    for (const block of source) {
      if (block.type === "text") {
        blocks.push({
          kind: "text",
          id: `${message.id}:${block.id}`,
          text: options.mapText(
            (paragraphSeparated && block.id !== paragraphStart ? "\n\n" : "") + (block.text ?? ""),
          ),
        });
      } else if (block.type === "reasoning" && block.text && liveReasoning?.id === block.id) {
        const excerpt = sliceStreamingMarkdownTail(block.text, liveReasoningBudget);
        blocks.push({
          kind: "thinking",
          id: `${message.id}:${block.id}`,
          text:
            (block.text.length > liveReasoningBudget ? "正在显示最新思考片段。\n\n" : "") +
            excerpt +
            (reasoningChars > 8192 ? `\n\n[查看完整工作过程](cloud-messages/${message.id})` : ""),
        });
      } else if (block.type === "reasoning" && block.text && reasoningBudget > 0) {
        const preview = cloudMessageTextPage(block.text, 0, reasoningBudget);
        reasoningBudget -= preview.text.length;
        const notice = !reasoningNotice && reasoningChars > 8192;
        if (notice) reasoningNotice = true;
        blocks.push({
          kind: "thinking",
          id: `${message.id}:${block.id}`,
          text:
            preview.text + (notice ? `\n\n[查看完整工作过程](cloud-messages/${message.id})` : ""),
          durationMs: duration(block.started_at, block.completed_at),
        });
      } else if (block.type === "tool") {
        const state = block.state ?? "unknown";
        if (options.live && (state === "prepared" || state === "executing"))
          runningToolCallIds.push(block.id);
        blocks.push({
          kind: "tool",
          item: {
            toolCall: { type: "toolCall", id: block.id, name: block.name ?? "", arguments: {} },
            publicStatus: {
              label: toolLabel(block.name, block.status),
              state,
              durationMs: duration(block.started_at, block.completed_at),
              ...(block.resources?.length
                ? {
                    resources: block.resources
                      .filter((resource) => resource.role === "input" || resource.role === "source")
                      .map(sharedResource)
                      .filter((resource): resource is AssistantResource => Boolean(resource)),
                  }
                : {}),
            },
          },
        });
      }
    }
    const lastBlock = source.at(-1);
    return {
      key: `${message.id}:round:${number}`,
      round: number + 1,
      blocks,
      runningToolCallIds,
      thinkingOpen: Boolean(
        options.live && last && lastBlock?.type === "reasoning" && !lastBlock.completed_at,
      ),
      meta: {
        model: metadata?.model ?? presentation.model,
        reasoningEffort: presentation.reasoning_effort,
        tokenUsage: tokenUsage(
          metadata?.usage ??
            (last && !presentation.rounds?.some((round) => round.usage)
              ? presentation.usage
              : undefined),
        ),
        stopReason: options.live ? undefined : last ? presentation.state || "stop" : "toolUse",
        outcome: last ? presentation.state : undefined,
        durationMs: duration(
          metadata?.started_at ?? presentation.started_at,
          metadata?.completed_at ?? (last ? presentation.completed_at : undefined),
        ),
      },
    };
  });
}

/** Plain-text process reader/export; the reader pages this, never the raw JSON. */
export function cloudChatProcessText(presentation?: CloudChatPresentation) {
  const states = {
    prepared: "等待执行",
    executing: "执行中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
    unknown: "结果待确认",
  };
  return (
    presentation?.blocks
      .map((block) =>
        block.type === "tool"
          ? `[${block.round + 1}] ${toolLabel(block.name, block.status)} · ${states[block.state ?? "unknown"]}`
          : `[${block.round + 1}] ${block.type === "reasoning" ? "思考" : "正文"}\n${block.text ?? ""}`,
      )
      .join("\n\n") ?? ""
  );
}
