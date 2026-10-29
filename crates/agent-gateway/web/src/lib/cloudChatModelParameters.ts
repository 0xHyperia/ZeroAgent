import type { AppSettings, ReasoningLevel } from "@/lib/settings";
import type { CloudChatModelLimitSetting } from "./cloudChatModelLimits";

export type CloudChatReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type CloudChatModelParameters = {
  request_format?: "openai-completions";
  context_window?: number;
  max_output_tokens?: number;
  input_modalities?: ["text"] | ["text", "image"];
  provider_cache_mode?: "auto" | "none";
  model_cache_mode?: "auto" | "none";
  time_zone?: string;
  locale?: string;
};
const REASONING = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CACHE = new Set(["auto", "none"]);
const LOCALE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const TIME_ZONE = /^[A-Za-z0-9_+./-]{1,128}$/;
export const CLOUD_CHAT_REASONING_OPTIONS: ReasoningLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
export function cloudChatReasoningEffort(value: string): CloudChatReasoningEffort {
  if (value === "off") return "none";
  if (!REASONING.has(value)) throw new Error("当前推理强度不受云端对话支持，请重新选择。");
  return value as CloudChatReasoningEffort;
}
export function cloudChatReasoningLevel(value: string): ReasoningLevel {
  return cloudChatReasoningEffort(value) === "none" ? "off" : (value as ReasoningLevel);
}
export function parseCloudChatModelParameters(
  value: unknown,
  options: { fromResponse?: boolean } = {},
): CloudChatModelParameters {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("云端模型参数无效");
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "request_format",
    "context_window",
    "max_output_tokens",
    "input_modalities",
    "provider_cache_mode",
    "model_cache_mode",
    "time_zone",
    "locale",
  ]);
  if (
    (!options.fromResponse && Object.keys(input).some((key) => !allowed.has(key))) ||
    (input.request_format !== undefined && input.request_format !== "openai-completions")
  )
    throw new Error("云端对话当前使用 Chat Completions，请检查模型参数。");
  for (const [key, min, max] of [
    ["context_window", 1024, 2_000_000],
    ["max_output_tokens", 128, 1_000_000],
  ] as const) {
    const number = input[key];
    if (
      number !== undefined &&
      (!Number.isSafeInteger(number) ||
        (number !== 0 && ((number as number) < min || (number as number) > max)))
    )
      throw new Error("上下文窗口或最大输出超出云端支持范围，请检查模型设置。");
  }
  if (
    typeof input.context_window === "number" &&
    input.context_window > 0 &&
    typeof input.max_output_tokens === "number" &&
    input.max_output_tokens >= input.context_window
  )
    throw new Error("最大输出必须小于上下文窗口。");
  for (const key of ["provider_cache_mode", "model_cache_mode"] as const)
    if (input[key] !== undefined && !CACHE.has(String(input[key])))
      throw new Error("云端对话支持自动或不发送缓存提示，请在模型设置中调整手动缓存模式。");
  if (
    input.input_modalities !== undefined &&
    JSON.stringify(input.input_modalities) !== '["text"]' &&
    JSON.stringify(input.input_modalities) !== '["text","image"]'
  )
    throw new Error("云端模型输入仅支持文本或文本与图片。");
  if (
    input.time_zone !== undefined &&
    (typeof input.time_zone !== "string" ||
      input.time_zone === "Local" ||
      (input.time_zone !== "" && !TIME_ZONE.test(input.time_zone)))
  )
    throw new Error("云端时区偏好无效。");
  if (
    input.locale !== undefined &&
    (typeof input.locale !== "string" ||
      input.locale.length > 64 ||
      (input.locale !== "" && !LOCALE.test(input.locale)))
  )
    throw new Error("云端语言偏好无效。");
  return {
    ...(input.request_format ? { request_format: "openai-completions" as const } : {}),
    ...(input.context_window !== undefined
      ? { context_window: input.context_window as number }
      : {}),
    ...(input.max_output_tokens !== undefined
      ? { max_output_tokens: input.max_output_tokens as number }
      : {}),
    ...(input.input_modalities
      ? {
          input_modalities: [...(input.input_modalities as ["text"] | ["text", "image"])] as
            | ["text"]
            | ["text", "image"],
        }
      : {}),
    ...(input.provider_cache_mode
      ? { provider_cache_mode: input.provider_cache_mode as "auto" | "none" }
      : {}),
    ...(input.model_cache_mode
      ? { model_cache_mode: input.model_cache_mode as "auto" | "none" }
      : {}),
    ...(input.time_zone !== undefined ? { time_zone: input.time_zone as string } : {}),
    ...(input.locale !== undefined ? { locale: input.locale as string } : {}),
  };
}
export function buildCloudChatModelParameters(
  settings: Pick<AppSettings, "customProviders">,
  providerId: string,
  modelId: string,
  preferences?: Pick<CloudChatModelParameters, "time_zone" | "locale">,
  limits?: CloudChatModelLimitSetting | null,
): CloudChatModelParameters {
  const provider = settings.customProviders?.find((item) => item.id === providerId);
  const model = provider?.models.find((item) => item.id === modelId);
  const providerCache =
    provider?.promptCacheHintMode ?? (provider?.promptCachingEnabled === false ? "none" : "auto");
  const modelCache = model?.promptCacheHintMode;
  if (!CACHE.has(modelCache ?? providerCache))
    throw new Error("当前模型使用云端暂不支持的手动缓存提示，请在模型设置中选择自动或不发送提示。");
  return parseCloudChatModelParameters({
    request_format: "openai-completions",
    ...(limits?.mode === "platform"
      ? {}
      : {
          ...((limits?.context_window ?? model?.contextWindow) !== undefined
            ? { context_window: limits?.context_window ?? model?.contextWindow }
            : {}),
          ...((limits?.max_output_tokens ?? model?.maxOutputToken) !== undefined
            ? { max_output_tokens: limits?.max_output_tokens ?? model?.maxOutputToken }
            : {}),
        }),
    ...(model?.inputModalities ? { input_modalities: [...model.inputModalities] } : {}),
    ...(CACHE.has(providerCache) ? { provider_cache_mode: providerCache } : {}),
    ...(modelCache ? { model_cache_mode: modelCache } : {}),
    ...preferences,
  });
}

export function cloudChatClientPreferences(
  source: { timeZone: () => string | undefined; locale: () => string | undefined } = {
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: () => (typeof navigator === "undefined" ? undefined : navigator.language),
  },
): Pick<CloudChatModelParameters, "time_zone" | "locale"> {
  let time_zone = "UTC",
    locale = "und";
  try {
    const zone = source.timeZone();
    if (zone && zone !== "Local" && TIME_ZONE.test(zone)) time_zone = zone;
  } catch {
    /* preference unavailable; the server remains the clock authority */
  }
  try {
    const language = source.locale();
    if (language && language.length <= 64 && LOCALE.test(language)) locale = language;
  } catch {
    /* an unavailable browser preference is not a location inference */
  }
  return { time_zone, locale };
}
