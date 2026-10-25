import { createKBrainClient } from "../kbrain/client";
import {
  type AppSettings,
  type CustomProvider,
  getDefaultUsageQueryConfig,
  normalizeProviderModelConfigs,
  type ProviderId,
  type ProviderModelConfig,
} from "../settings";
import { RELAY_ORIGIN, type RelayApiKey, type RelayGroup } from "./client";
import {
  type ManagedModelBinding,
  managedModelBinding,
  replaceManagedModelCredentials,
} from "./managedCredentials";

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

export function isRelayProvider(provider: Pick<CustomProvider, "id">) {
  return provider.id.startsWith(RELAY_PROVIDER_PREFIX);
}

function buildRelayProvider(
  key: RelayApiKey,
  group: RelayGroup,
  existing?: CustomProvider,
  fetchedModels?: ProviderModelConfig[],
  binding?: ManagedModelBinding,
): CustomProvider | null {
  const type = relayProviderTypeForPlatform(group.platform);
  if (!type) return null;
  const models = fetchedModels ?? existing?.models ?? [];
  const activeModels = models.map((model) => model.id);

  return {
    id: relayProviderId(key.id),
    name: `${group.name} / ${key.name}`,
    type,
    baseUrl: binding?.baseUrl ?? "",
    isFullUrl: false,
    apiKey: binding?.apiKey ?? "",
    apiKeyConfigured: Boolean(binding),
    customHeaders: [],
    models,
    activeModels,
    requestFormat: type === "codex" || type === "xai" ? "openai-responses" : undefined,
    reasoning: existing?.reasoning ?? "high",
    promptCachingEnabled: type === "claude_code",
    nativeWebSearchEnabled: true,
    useSystemProxy: false,
    usageQuery: existing?.usageQuery ?? getDefaultUsageQueryConfig(),
  };
}

function resolveKeyGroup(key: RelayApiKey, groups: RelayGroup[]) {
  return key.group ?? groups.find((group) => group.id === key.group_id);
}

export function enforceRelayProviderConstraint(settings: AppSettings): AppSettings {
  const customProviders = settings.customProviders.filter(isRelayProvider).map((provider) => {
    const binding = managedModelBinding(provider.id);
    return {
      ...provider,
      baseUrl: binding?.baseUrl ?? "",
      apiKey: binding?.apiKey ?? "",
      apiKeyConfigured: Boolean(binding),
      activeModels: binding ? provider.activeModels : [],
    };
  });
  const selectedModel = settings.selectedModel;
  const selectedProvider = selectedModel
    ? customProviders.find((provider) => provider.id === selectedModel.customProviderId)
    : undefined;

  return {
    ...settings,
    customProviders,
    selectedModel:
      selectedModel && selectedProvider?.activeModels.includes(selectedModel.model)
        ? selectedModel
        : undefined,
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
  const activeKeys = keys.filter(
    (key) => key.status === "active" && key.group_id != null && key.key.trim().length > 0,
  );
  const bindings = await replaceManagedModelCredentials(
    RELAY_ORIGIN,
    activeKeys
      .filter((key) => {
        const group = resolveKeyGroup(key, groups);
        return group?.status === "active" && relayProviderTypeForPlatform(group.platform);
      })
      .map((key) => ({ providerId: relayProviderId(key.id) })),
  );

  const providers = await Promise.all(
    activeKeys.map(async (key) => {
      const group = resolveKeyGroup(key, groups);
      if (!group || group.status !== "active") return null;
      const type = relayProviderTypeForPlatform(group.platform);
      if (!type) return null;
      const binding = bindings.get(relayProviderId(key.id));
      if (!binding) throw new Error("Managed model credential registration failed");
      const existing = existingById.get(relayProviderId(key.id));
      let models: ProviderModelConfig[] | undefined;
      if (forceModelRefresh || !existing?.models.length) {
        try {
          const response = await createKBrainClient().discoverProviderModels(undefined, {
            type,
            baseUrl: binding.baseUrl,
            apiKey: binding.apiKey,
            useSystemProxy: false,
          });
          const list = Array.isArray(response)
            ? response
            : (response as { models?: unknown })?.models;
          if (!Array.isArray(list)) throw new Error("Invalid managed model catalog");
          models = normalizeProviderModelConfigs(list, type);
        } catch {
          models = existing?.models ?? [];
        }
      }
      return buildRelayProvider(key, group, existing, models, binding);
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
  const currentSelected = settings.selectedModel;
  const selectedStillAvailable = currentSelected
    ? customProviders.some(
        (provider) =>
          provider.id === currentSelected.customProviderId &&
          provider.activeModels.includes(currentSelected.model),
      )
    : false;
  const firstProvider = customProviders.find((provider) => provider.activeModels.length > 0);
  const selectedModel = selectedStillAvailable
    ? currentSelected
    : firstProvider
      ? { customProviderId: firstProvider.id, model: firstProvider.activeModels[0] }
      : undefined;

  return {
    ...settings,
    customProviders,
    selectedModel,
  };
}
