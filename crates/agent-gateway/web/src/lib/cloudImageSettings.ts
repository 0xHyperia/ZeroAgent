import { accountFetch, captureAccountRequestGuard } from "./accountRequest";

export type CloudImageSettings = { provider_key_id: number; model: string; version: number };
export async function cloudImageSettings(
  update?: { expected_version: number; provider_key_id: number; model: string },
  signal?: AbortSignal,
): Promise<CloudImageSettings> {
  const guard = captureAccountRequestGuard();
  const response = await accountFetch("/api/web-chat/image-settings", {
    method: update ? "PUT" : "GET",
    signal,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(update ? { body: JSON.stringify(update) } : {}),
  });
  const invalidResponse = update
    ? "保存结果尚未确认，请刷新图像设置后核对。"
    : "暂时无法读取图像设置，请刷新后重试。";
  let result: CloudImageSettings & { error?: { message?: string }; message?: string };
  try {
    result = await response.json();
  } catch (cause) {
    guard();
    if (signal?.aborted) throw cause;
    throw new Error(invalidResponse);
  }
  guard();
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error(invalidResponse);
  if (!response.ok)
    throw new Error(result.error?.message ?? result.message ?? "读取图像设置失败，请重试。");
  if (
    !Number.isSafeInteger(result.provider_key_id) ||
    result.provider_key_id < 0 ||
    !Number.isSafeInteger(result.version) ||
    result.version < 0 ||
    typeof result.model !== "string"
  )
    throw new Error(invalidResponse);
  return result;
}
