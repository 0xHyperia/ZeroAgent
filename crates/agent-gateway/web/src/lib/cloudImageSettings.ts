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
  const result = await response.json();
  guard();
  if (!response.ok)
    throw new Error(result.error?.message ?? result.message ?? "读取图像设置失败，请重试。");
  if (
    !Number.isSafeInteger(result.provider_key_id) ||
    result.provider_key_id < 0 ||
    !Number.isSafeInteger(result.version) ||
    result.version < 0 ||
    typeof result.model !== "string"
  )
    throw new Error("图像设置响应无效");
  return result;
}
