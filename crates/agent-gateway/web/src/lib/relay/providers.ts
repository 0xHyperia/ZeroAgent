import {
  mergeManagedModels,
  normalizeFetchedModels,
} from "@liveagent/ui/pages/settings/providerUtils";
import {
  type AppSettings,
  type CustomProvider,
  getDefaultUsageQueryConfig,
  normalizeProviderModelConfigs,
  type ProviderId,
  type ProviderModelConfig,
} from "@/lib/settings";
import { getRelayProviderModels, RELAY_ORIGIN, type RelayApiKey, type RelayGroup } from "./client";

const RELAY_PROVIDER_PREFIX = "relay-key-";

export function relayProviderTypeForPlatform(platform: string): ProviderId | null {
  switch (platform.trim().toLowerCase()) {
    case "anthropic":
      return "claude_code";
    case "openai":
      return "codex";
    case "grok":
      return "xai";
    case "deepseek":
      return "deepseek";
    case "gemini":
    case "antigravity":
      return "gemini";
    default:
      return null;
  }
}

export function relayProviderBaseUrl(_type: ProviderId) {
  return RELAY_ORIGIN;
}

export function relayProviderId(keyId: number) {
  return `${RELAY_PROVIDER_PREFIX}${keyId}`;
}

export function relayProviderKeyId(providerId: string) {
  if (!providerId.startsWith(RELAY_PROVIDER_PREFIX)) return 0;
  const value = Number(providerId.slice(RELAY_PROVIDER_PREFIX.length));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function isRelayProvider(provider: Pick<CustomProvider, "id">) {
  return provider.id.startsWith(RELAY_PROVIDER_PREFIX);
}

function resolveKeyGroup(key: RelayApiKey, groups: RelayGroup[]) {
  return key.group ?? groups.find((group) => group.id === key.group_id);
}

export function enforceRelayProviderConstraint(settings: AppSettings): AppSettings {
  const customProviders = settings.customProviders.filter(isRelayProvider).map((provider) => ({
    ...provider,
    baseUrl: relayProviderBaseUrl(provider.type),
    isFullUrl: false,
    modelsUrl: undefined,
    customHeaders: [],
    useSystemProxy: false,
    usageQuery: getDefaultUsageQueryConfig(),
  }));
  const selected = settings.selectedModel;
  const selectedProvider = selected
    ? customProviders.find((provider) => provider.id === selected.customProviderId)
    : undefined;
  return {
    ...settings,
    customProviders,
    selectedModel:
      selected && selectedProvider?.activeModels.includes(selected.model) ? selected : undefined,
  };
}

export function mergeRefreshedRelaySettings(
  current: AppSettings,
  refreshed: Pick<AppSettings, "customProviders" | "selectedModel">,
): AppSettings {
  const selectedModel = current.selectedModel;
  const selectedStillAvailable = selectedModel
    ? refreshed.customProviders.some(
        (provider) =>
          provider.id === selectedModel.customProviderId &&
          provider.activeModels.includes(selectedModel.model),
      )
    : false;
  return {
    ...current,
    customProviders: refreshed.customProviders,
    selectedModel: selectedStillAvailable ? selectedModel : refreshed.selectedModel,
  };
}

export async function buildRelayProviders(
  existingProviders: CustomProvider[],
  keys: RelayApiKey[],
  groups: RelayGroup[],
  forceModelRefresh = false,
) {
  const existingById = new Map(existingProviders.map((provider) => [provider.id, provider]));
  const providers = await Promise.all(
    keys
      .filter((key) => key.status === "active" && key.group_id != null && key.key.trim())
      .map(async (key): Promise<CustomProvider | null> => {
        const group = resolveKeyGroup(key, groups);
        if (group?.status !== "active") return null;
        const type = relayProviderTypeForPlatform(group.platform);
        if (!type) return null;
        const existing = existingById.get(relayProviderId(key.id));
        let models: ProviderModelConfig[] = existing?.models ?? [];
        if (forceModelRefresh || models.length === 0) {
          try {
            const response = await getRelayProviderModels(key.id);
            const payload = response as { data?: unknown; models?: unknown } | null;
            const items = Array.isArray(response)
              ? response
              : Array.isArray(payload?.data)
                ? payload.data
                : Array.isArray(payload?.models)
                  ? payload.models
                  : [];
            models = mergeManagedModels(
              normalizeFetchedModels(items, type),
              existing?.models ?? [],
            );
          } catch {
            models = existing?.models ?? [];
          }
        }
        const ids = new Set(models.map((model) => model.id));
        return {
          ...existing,
          id: relayProviderId(key.id),
          name: `${group.name} / ${key.name}`,
          type,
          baseUrl: relayProviderBaseUrl(type),
          isFullUrl: false,
          modelsUrl: undefined,
          apiKey: key.key,
          apiKeyConfigured: Boolean(key.key.trim()),
          customHeaders: [],
          usageQuery: getDefaultUsageQueryConfig(),
          models,
          activeModels:
            existing && existing.models.length > 0
              ? existing.activeModels.filter((id) => ids.has(id))
              : models.map((model) => model.id),
          requestFormat:
            type === "xai"
              ? "openai-responses"
              : type === "codex"
                ? (existing?.requestFormat ?? "openai-responses")
                : undefined,
          reasoning: existing?.reasoning ?? "high",
          promptCachingEnabled: existing?.promptCachingEnabled ?? type === "claude_code",
          nativeWebSearchEnabled: existing?.nativeWebSearchEnabled ?? true,
          useSystemProxy: false,
        };
      }),
  );
  return providers.filter((provider): provider is CustomProvider => provider !== null);
}

export async function bindRelayKeysToSettings(
  settings: AppSettings,
  keys: RelayApiKey[],
  groups: RelayGroup[],
  forceModelRefresh = false,
): Promise<AppSettings> {
  const customProviders = await buildRelayProviders(
    settings.customProviders,
    keys,
    groups,
    forceModelRefresh,
  );
  const current = settings.selectedModel;
  const currentAvailable = current
    ? customProviders.some(
        (provider) =>
          provider.id === current.customProviderId && provider.activeModels.includes(current.model),
      )
    : false;
  const first = customProviders.find((provider) => provider.activeModels.length > 0);
  return {
    ...settings,
    customProviders,
    selectedModel: currentAvailable
      ? current
      : first
        ? { customProviderId: first.id, model: first.activeModels[0] }
        : undefined,
  };
}

/** Model editing never grants the editor control of a managed connection. */
export function applyRelayProviderModelSettings(
  settings: AppSettings,
  providerId: string,
  draft: Pick<
    CustomProvider,
    | "models"
    | "activeModels"
    | "modelOrder"
    | "requestFormat"
    | "promptCacheHintMode"
    | "promptCachingEnabled"
    | "promptCacheRetention"
  >,
): AppSettings {
  const provider = settings.customProviders.find((item) => item.id === providerId);
  if (!provider || !isRelayProvider(provider)) {
    throw new Error("只能配置当前账户的托管模型");
  }
  const models = normalizeProviderModelConfigs(draft.models, provider.type).map(
    ({ promptCacheHintMode: _unsupportedModelHint, ...model }) => model,
  );
  const ids = new Set(models.map((model) => model.id));
  return enforceRelayProviderConstraint({
    ...settings,
    customProviders: settings.customProviders.map((item) =>
      item.id !== providerId
        ? item
        : {
            ...item,
            models,
            activeModels: draft.activeModels.filter((id) => ids.has(id)),
            modelOrder: draft.modelOrder?.filter((id) => ids.has(id)),
            requestFormat: item.type === "codex" ? draft.requestFormat : item.requestFormat,
            promptCachingEnabled: draft.promptCachingEnabled,
            promptCacheHintMode: item.type === "codex" ? draft.promptCacheHintMode : undefined,
            promptCacheRetention:
              item.type === "claude_code" ? draft.promptCacheRetention : undefined,
          },
    ),
  });
}
