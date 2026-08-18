import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const relay = loader.loadModule("src/lib/relay/providers.ts");
const settingsModule = loader.loadModule("src/lib/settings/index.ts");

test("relay platform mapping and endpoints are fixed", () => {
  assert.equal(relay.relayProviderTypeForPlatform("anthropic"), "claude_code");
  assert.equal(relay.relayProviderTypeForPlatform("openai"), "codex");
  assert.equal(relay.relayProviderTypeForPlatform("grok"), "xai");
  assert.equal(relay.relayProviderTypeForPlatform("deepseek"), "deepseek");
  assert.equal(relay.relayProviderTypeForPlatform("gemini"), "gemini");
  assert.equal(relay.relayProviderTypeForPlatform("antigravity"), "gemini");
  assert.equal(relay.relayProviderTypeForPlatform("unsupported"), null);
  assert.equal(relay.relayProviderBaseUrl("claude_code"), "https://usa0.top");
  assert.equal(relay.relayProviderBaseUrl("codex"), "https://usa0.top");
  assert.equal(relay.relayProviderBaseUrl("gemini"), "https://usa0.top");
});

test("built-in provider defaults cannot point to third-party endpoints", () => {
  const providers = settingsModule.getBuiltinCustomProviders();
  assert.deepEqual(
    Array.from(providers, (provider) => provider.baseUrl),
    [
      "https://usa0.top",
      "https://usa0.top",
      "https://usa0.top",
      "https://usa0.top",
      "https://usa0.top",
    ],
  );
});

test("binding relay keys removes third-party providers and selects an available model", async () => {
  const relayProvider = {
    id: "relay-key-42",
    name: "Old relay name",
    type: "codex",
    baseUrl: "https://changed.invalid",
    apiKey: "old-key",
    customHeaders: [],
    models: [{ id: "gpt-5.4", name: "GPT 5.4" }],
    activeModels: ["gpt-5.4"],
    requestFormat: "openai-responses",
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: true,
    useSystemProxy: false,
  };
  const arbitraryProvider = {
    ...relayProvider,
    id: "third-party",
    baseUrl: "https://third-party.invalid/v1",
  };
  const appSettings = {
    customProviders: [arbitraryProvider, relayProvider],
    selectedModel: { customProviderId: "third-party", model: "gpt-5.4" },
  };
  const group = {
    id: 7,
    name: "Codex group",
    platform: "openai",
    rate_multiplier: 1,
    status: "active",
  };
  const key = {
    id: 42,
    key: "sk-relay-key",
    name: "ZeroAgent",
    group_id: 7,
    status: "active",
    quota: 0,
    quota_used: 0,
    created_at: "2026-07-20T00:00:00Z",
    group,
  };

  const bound = await relay.bindRelayKeysToSettings(appSettings, [key], [group]);

  assert.equal(bound.customProviders.length, 1);
  assert.equal(bound.customProviders[0].id, "relay-key-42");
  assert.equal(bound.customProviders[0].baseUrl, "https://usa0.top");
  assert.equal(bound.customProviders[0].apiKey, "sk-relay-key");
  assert.equal(bound.customProviders[0].requestFormat, "openai-responses");
  assert.equal(bound.selectedModel.customProviderId, "relay-key-42");
  assert.equal(bound.selectedModel.model, "gpt-5.4");
});

test("runtime constraint rejects injected providers and restores relay URLs", () => {
  const constrained = relay.enforceRelayProviderConstraint({
    customProviders: [
      {
        id: "third-party",
        type: "codex",
        baseUrl: "https://third-party.invalid",
        activeModels: ["gpt-5.4"],
      },
      {
        id: "relay-key-9",
        type: "claude_code",
        baseUrl: "https://changed.invalid",
        activeModels: ["claude-opus-4-8"],
      },
    ],
    selectedModel: { customProviderId: "third-party", model: "gpt-5.4" },
  });

  assert.equal(constrained.customProviders.length, 1);
  assert.equal(constrained.customProviders[0].id, "relay-key-9");
  assert.equal(constrained.customProviders[0].baseUrl, "https://usa0.top");
  assert.equal(constrained.selectedModel, undefined);
});

test("Grok relay groups bind as xAI Responses providers", async () => {
  const provider = {
    id: "relay-key-43",
    name: "Grok",
    type: "codex",
    baseUrl: "https://usa0.top",
    apiKey: "sk-grok",
    customHeaders: [],
    models: [{ id: "grok-4" }],
    activeModels: ["grok-4"],
    reasoning: "high",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: true,
    useSystemProxy: false,
  };
  const group = {
    id: 8,
    name: "Grok group",
    platform: "grok",
    rate_multiplier: 1,
    status: "active",
  };
  const key = {
    id: 43,
    key: "sk-grok",
    name: "ZeroAgent Grok",
    group_id: 8,
    status: "active",
    quota: 0,
    quota_used: 0,
    created_at: "2026-07-20T00:00:00Z",
    group,
  };

  const bound = await relay.bindRelayKeysToSettings(
    {
      customProviders: [provider],
      selectedModel: { customProviderId: provider.id, model: "grok-4" },
    },
    [key],
    [group],
  );

  assert.equal(bound.customProviders[0].type, "xai");
  assert.equal(bound.customProviders[0].requestFormat, "openai-responses");
  assert.deepEqual(bound.selectedModel, { customProviderId: "relay-key-43", model: "grok-4" });
});

test("model refresh merges providers without overwriting concurrent settings changes", () => {
  const current = {
    theme: "dark",
    customProviders: [
      { id: "relay-key-1", activeModels: ["old-model"] },
      { id: "relay-key-2", activeModels: ["keep-model"] },
    ],
    selectedModel: { customProviderId: "relay-key-2", model: "keep-model" },
  };
  const refreshed = {
    theme: "light",
    customProviders: [
      { id: "relay-key-1", activeModels: ["new-model"] },
      { id: "relay-key-2", activeModels: ["keep-model", "new-model"] },
    ],
    selectedModel: { customProviderId: "relay-key-1", model: "new-model" },
  };

  const merged = relay.mergeRefreshedRelaySettings(current, refreshed);

  assert.equal(merged.theme, "dark");
  assert.equal(merged.customProviders, refreshed.customProviders);
  assert.deepEqual(merged.selectedModel, current.selectedModel);

  const fallback = relay.mergeRefreshedRelaySettings(
    { ...current, selectedModel: { customProviderId: "relay-key-1", model: "old-model" } },
    refreshed,
  );
  assert.deepEqual(fallback.selectedModel, refreshed.selectedModel);
});
