import { accountFetch, captureAccountRequestGuard } from "./accountRequest";

export type CloudTitlePreferences = {
  enabled: boolean;
  provider_key_id: number;
  model: string;
  reasoning_effort: string;
  max_output_tokens: number;
  prompt: string;
};
export type CloudGenerationSettings = { title: CloudTitlePreferences; version: number };

export async function cloudGenerationSettings(
  update?: { expected_version: number; title: CloudTitlePreferences },
  signal?: AbortSignal,
): Promise<CloudGenerationSettings> {
  const guard = captureAccountRequestGuard();
  const response = await accountFetch("/api/web-chat/generation-settings", {
    method: update ? "PUT" : "GET",
    credentials: "include",
    signal,
    headers: { "Content-Type": "application/json" },
    ...(update ? { body: JSON.stringify(update) } : {}),
  });
  const result = await response.json();
  guard();
  if (!response.ok)
    throw new Error(result?.error?.message ?? result?.message ?? "生成设置暂不可用。");
  const title = result?.title;
  if (
    !Number.isSafeInteger(result?.version) ||
    result.version < 0 ||
    !title ||
    typeof title.enabled !== "boolean" ||
    !Number.isSafeInteger(title.provider_key_id) ||
    title.provider_key_id < 0 ||
    typeof title.model !== "string" ||
    typeof title.reasoning_effort !== "string" ||
    !Number.isSafeInteger(title.max_output_tokens) ||
    typeof title.prompt !== "string"
  )
    throw new Error("生成设置响应无效，请重新读取。");
  return result;
}
