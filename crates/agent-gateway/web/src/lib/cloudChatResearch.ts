export type CloudChatPublicResearch = { topic: string };
export const CLOUD_PUBLIC_RESEARCH_TOPIC_BYTES = 8 * 1024;

export function parseCloudChatPublicResearch(
  value: unknown,
  fromResponse = false,
): CloudChatPublicResearch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("公开检索授权无效");
  const item = value as Record<string, unknown>;
  if (
    (!fromResponse && Object.keys(item).some((key) => key !== "topic")) ||
    typeof item.topic !== "string"
  )
    throw new Error("公开检索授权无效");
  const topic = item.topic.trim();
  if (
    !topic ||
    topic.length > CLOUD_PUBLIC_RESEARCH_TOPIC_BYTES ||
    topic.includes("\0") ||
    new TextEncoder().encode(topic).byteLength > CLOUD_PUBLIC_RESEARCH_TOPIC_BYTES
  )
    throw new Error("请填写要公开检索的主题，长度不能超过 8 KiB。");
  return { topic };
}

export function initialCloudResearchTopic(text: string): string {
  try {
    return parseCloudChatPublicResearch({ topic: text }).topic;
  } catch {
    return "";
  }
}
