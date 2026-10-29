export type CloudChatModelLimitSetting = {
  provider_key_id: number;
  model: string;
  mode: "platform" | "custom";
  context_window: number;
  max_output_tokens: number;
  version: number;
  updated_at: string;
};
export type CloudChatModelLimitUpdate = Pick<
  CloudChatModelLimitSetting,
  "mode" | "context_window" | "max_output_tokens"
> & { expected_version: number };
type Request = (path: string, init?: RequestInit) => Promise<Response>;
type CaptureGuard = () => () => void;
export function validateCloudChatModelLimitUpdate(input: CloudChatModelLimitUpdate) {
  if (
    !Number.isSafeInteger(input.expected_version) ||
    input.expected_version < 0 ||
    (input.mode !== "platform" && input.mode !== "custom")
  )
    throw new Error("模型参数设置无效。");
  if (input.mode === "platform" && input.context_window === 0 && input.max_output_tokens === 0)
    return input;
  if (
    !Number.isSafeInteger(input.context_window) ||
    input.context_window < 1024 ||
    input.context_window > 2_000_000 ||
    !Number.isSafeInteger(input.max_output_tokens) ||
    input.max_output_tokens < 128 ||
    input.max_output_tokens > 1_000_000 ||
    input.max_output_tokens >= input.context_window
  )
    throw new Error("上下文窗口须为 1024–2000000，最大输出须为 128–1000000 且小于上下文窗口。");
  return input;
}
export class CloudChatModelLimitsError extends Error {
  constructor(
    readonly status: number,
    readonly reason = "",
  ) {
    super(
      status === 401
        ? "账户会话已过期，请重新登录。"
        : reason === "cloud_model_limits_changed"
          ? "此模型设置已在其他页面或设备更新。请重新读取后再保存。"
          : reason === "cloud_model_limits_quota"
            ? "账户已保存的模型设置已达上限。"
            : status === 403 || status === 404
              ? "当前账户无法使用这个模型分组。"
              : "暂时无法读取或保存账户模型参数，请重试。",
    );
  }
}
export function createCloudChatModelLimitsClient(request: Request, captureGuard: CaptureGuard) {
  function path(providerKeyId: number, model: string) {
    if (
      !Number.isSafeInteger(providerKeyId) ||
      providerKeyId <= 0 ||
      !model ||
      model.trim() !== model ||
      new TextEncoder().encode(model).length > 512
    )
      throw new Error("模型分组或模型名称无效。");
    return `/api/web-chat/model-limits?${new URLSearchParams({ provider_key_id: String(providerKeyId), model })}`;
  }
  async function read(url: string, init: RequestInit, providerKeyId: number, model: string) {
    const guard = captureGuard();
    const response = await request(url, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    guard();
    const reader = response.body?.getReader();
    if (!reader) throw new Error("账户模型参数响应为空。");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "",
      bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        guard();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 16 * 1024) throw new Error("账户模型参数响应过大。");
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      guard();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("账户模型参数响应无效。");
    }
    if (!response.ok)
      throw new CloudChatModelLimitsError(
        response.status,
        data?.reason === "cloud_model_limits_changed" || data?.reason === "cloud_model_limits_quota"
          ? data.reason
          : "",
      );
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("账户模型参数响应无效。");
    if (data.setting === null) return null;
    const item = data.setting as CloudChatModelLimitSetting;
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      item.provider_key_id !== providerKeyId ||
      item.model !== model ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1 ||
      typeof item.updated_at !== "string" ||
      item.updated_at.length > 64 ||
      !Number.isFinite(Date.parse(item.updated_at))
    )
      throw new Error("账户模型参数响应身份无效。");
    validateCloudChatModelLimitUpdate({
      expected_version: item.version,
      mode: item.mode,
      context_window: item.context_window,
      max_output_tokens: item.max_output_tokens,
    });
    return {
      provider_key_id: providerKeyId,
      model,
      mode: item.mode,
      context_window: item.context_window,
      max_output_tokens: item.max_output_tokens,
      version: item.version,
      updated_at: item.updated_at,
    };
  }
  return {
    get(providerKeyId: number, model: string, signal?: AbortSignal) {
      return read(path(providerKeyId, model), { signal }, providerKeyId, model);
    },
    async save(
      providerKeyId: number,
      model: string,
      input: CloudChatModelLimitUpdate,
      signal?: AbortSignal,
    ) {
      validateCloudChatModelLimitUpdate(input);
      const saved = await read(
        path(providerKeyId, model),
        {
          method: "PUT",
          body: JSON.stringify({
            expected_version: input.expected_version,
            mode: input.mode,
            context_window: input.context_window,
            max_output_tokens: input.max_output_tokens,
          }),
          signal,
        },
        providerKeyId,
        model,
      );
      if (!saved) throw new Error("保存后的模型参数缺失。");
      return saved;
    },
  };
}
export type CloudChatModelLimitsClient = ReturnType<typeof createCloudChatModelLimitsClient>;
