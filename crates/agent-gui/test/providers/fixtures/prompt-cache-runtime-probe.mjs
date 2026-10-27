// Invoked by the Native fixture with a disposable profile and a local model server.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../../helpers/load-ts-module.mjs";

test("production provider settings survive restart and determine brokered model cache requests", { timeout: 60_000 }, async () => {
  const connection = { baseUrl: process.env.ZEROAGENT_CACHE_PROBE_URL, token: process.env.ZEROAGENT_CACHE_PROBE_TOKEN, protocolVersion: "kbrain.agent.v1" };
  const fixture = process.env.ZEROAGENT_CACHE_PROBE_MODEL?.replace(/\/+$/, "");
  const phase = process.env.ZEROAGENT_CACHE_PROBE_PHASE;
  assert.ok(connection.baseUrl && connection.token && fixture && phase);
  const loader = createTsModuleLoader({ mocks: {
    [new URL("../../../src/lib/host.ts", import.meta.url).pathname]: { isKBrainBrowserHost: () => true, isKBrainBackendEnabled: () => true },
    "@tauri-apps/api/core": { invoke: async () => assert.fail("runtime probe must use the public Native facade") },
  } });
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection(connection);
  const adapter = loader.loadModule("src/lib/kbrain/providerSettings.ts");
  const client = loader.loadModule("src/lib/kbrain/client.ts").createKBrainClient(connection);
  const settings = loader.loadModule("src/lib/settings/index.ts");
  const request = async (path, body) => {
    const response = await fetch(connection.baseUrl + path, { method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  let snapshot = await client.getConfiguration();
  let document = snapshot.settings;
  const providers = adapter.appProvidersFromKBrain(document);
  assert.equal(providers.length, 1, "disposable account has exactly its own managed provider");
  let current = settings.normalizeSettings({ ...settings.getDefaultSettings(), customProviders: providers });
  assert.equal(current.customProviders[0].promptCacheHintMode, phase === "reopened" ? "none" : "auto");
  const expected = phase === "reopened" ? [undefined, "openai-key", "openrouter-session", "none"] : [undefined, undefined, undefined, undefined];
  assert.deepEqual(current.customProviders[0].models.map(model => model.promptCacheHintMode), expected);
  const save = async (providerMode, overrides, format = "openai-responses") => {
    const observed = await client.getConfiguration();
    assert.equal(observed.configurationVersion, snapshot.configurationVersion,
      `configuration changed before ${phase}/${providerMode}; changed domains: ${["settings", "mcp", "prompts", "skills"].filter(key => JSON.stringify(observed[key]) !== JSON.stringify(snapshot[key])).join(",")}`);
    console.log(`Saving cache ${phase}/${providerMode}/${format}`);
    const next = settings.normalizeSettings({ ...current, customProviders: current.customProviders.map(provider => ({
      ...provider, promptCacheHintMode: providerMode, promptCachingEnabled: providerMode !== "none", requestFormat: format,
      models: provider.models.map((model, index) => ({ ...model, promptCacheHintMode: overrides[index] })),
    })) });
    snapshot = await client.updateConfiguration(
      { settings: adapter.kBrainSettingsUpdateFromAppSettings(current, next) },
      snapshot.configurationVersion,
    );
    document = snapshot.settings;
    current = { ...next, customProviders: adapter.appProvidersFromKBrain(document) };
    assert.equal(current.customProviders[0].promptCacheHintMode, providerMode);
    assert.deepEqual(current.customProviders[0].models.map(model => model.promptCacheHintMode), overrides);
  };
  const generate = async (index, key, session) => {
    const before = await (await fetch(fixture + "/_test/captures")).json();
    await request("/v1/generate", { model: { provider: "relay-key-7", model: `cache-model-${index}` }, messages: [{ role: "user", content: [{ type: "text", text: "Local cache transport fixture." }] }], cache_key: "stable-fixture-session", max_output_tokens: 32 });
    const after = await (await fetch(fixture + "/_test/captures")).json();
    assert.equal(after.length, before.length + 1, "one request, no replay or paid external inference");
    const last = after.at(-1);
    assert.equal(last.ownedCredential, true, "Native broker owns the real synthetic credential");
    assert.equal(last.key, key ? "stable-fixture-session" : null);
    assert.equal(last.session, session ? "stable-fixture-session" : null);
    assert.equal(last.retention, null);
    assert.equal(last.options, null);
  };
  if (phase === "reopened") {
    await generate(0, false, false); await generate(1, true, false); await generate(2, false, true); await generate(3, false, false);
    await save("none", [undefined, undefined, "openrouter-session", "none"]);
    await generate(1, false, false); // Clearing is transmitted, not just hidden in UI.
  }
  for (const mode of ["auto", "openai-key", "openrouter-session", "none"]) {
    await save(mode, [undefined, "openai-key", "openrouter-session", "none"]);
    await generate(0, mode === "auto" || mode === "openai-key", mode === "openrouter-session");
    await generate(1, true, false); await generate(2, false, true); await generate(3, false, false);
  }
  await save("none", [undefined, "auto", "openrouter-session", "none"]);
  await generate(1, true, false); // Model auto is an override, unlike inherit.
  await save("none", [undefined, undefined, "openrouter-session", "none"]);
  await generate(1, false, false);
  await save("auto", [undefined, undefined, undefined, undefined], "openai-completions");
  await generate(0, false, false); // Unknown Chat endpoint: upstream's conservative auto path.
  await save("openrouter-session", [undefined, undefined, undefined, undefined], "openai-completions");
  await generate(0, false, true);
  await save("none", [undefined, "openai-key", "openrouter-session", "none"]);
  console.log(`Cache runtime ${phase}: defaults, four modes, model precedence, clearing and Native header forwarding passed.`);
});
