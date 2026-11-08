import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { nativeConfigurationFixture } from "../helpers/native-configuration-fixture.mjs";

const HOST_MODULE = new URL("../../src/lib/host.ts", import.meta.url).pathname;

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const legacy = (id, name, type, baseUrl) => ({
  id,
  name,
  type,
  baseUrl,
  isFullUrl: false,
  apiKey: "",
  models: [],
  activeModels: [],
  reasoning: "off",
  promptCachingEnabled: false,
});

// A K-brain settings endpoint that keeps whatever providers the last PUT sent.
async function startKBrain(initialProviders = []) {
  let providers = initialProviders;
  let puts = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.method === "PUT" && request.url === "/v1/settings") {
      puts++;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (Array.isArray(body.providers)) {
        providers = body.providers.map((p) => ({ id: p.id, name: p.name, type: p.type, apiKeyConfigured: false, models: [] }));
      }
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/v1/mcp" ? {settings:{servers:[],selected:[]}}
      : request.url?.startsWith("/v1/prompts") ? {revision:0,globalTemplates:[],projectPrompts:{}}
      : {version:"kbrain.agent.v1",mode:"kbrain",providers}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    ids: () => providers.map((p) => p.id).sort(),
    deleteProvider: (id) => {
      providers = providers.filter((p) => p.id !== id);
    },
    puts: () => puts,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("a legacy provider deleted in K-brain is not imported again on the next launch", async () => {
  globalThis.localStorage = memoryStorage();
  // Desktop host: the legacy store (config.sqlite provider_settings) keeps both built-ins
  // forever; deleting a provider in K-brain never prunes it.
  const legacyProviders = [
    legacy("builtin-gemini", "Gemini", "gemini", "https://generativelanguage.googleapis.com/v1beta"),
    legacy("builtin-xai", "Grok", "xai", "https://api.x.ai/v1"),
  ];
  const kbrain = await startKBrain(legacyProviders);
  const canonical = nativeConfigurationFixture(() => ({baseUrl:kbrain.baseUrl,token:"t"}),{providers:legacyProviders});
  const loader = createTsModuleLoader({
    mocks: {
      [HOST_MODULE]: {
        isKBrainBrowserHost: () => false,
        isKBrainBackendEnabled: () => true,
        isTauriHost: () => true,
      },
      "@liveagent/app/shims/tauriCore": {
        invoke: canonical,
      },
    },
  });
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ baseUrl: kbrain.baseUrl, token: "t", protocolVersion: "kbrain.agent.v1" });
  const storageApi = loader.loadModule("src/lib/settings/storage.ts");
  try {
    // Providers already present in a prior backend remain canonical; startup adds none.
    await storageApi.loadPersistedSettingsWithDefaults();
    assert.deepEqual(kbrain.ids(), ["builtin-gemini", "builtin-xai"]);

    assert.equal(kbrain.puts(), 0, "startup never registers legacy cache records");

    // The user deletes Grok in K-brain, then restarts twice.
    kbrain.deleteProvider("builtin-xai");
    const putsBefore = kbrain.puts();
    await storageApi.loadPersistedSettingsWithDefaults();
    await storageApi.loadPersistedSettingsWithDefaults();
    assert.deepEqual(kbrain.ids(), ["builtin-gemini"]);
    assert.equal(kbrain.puts(), putsBefore, "no import was attempted for the deleted provider");
  } finally {
    runtime.clearKBrainRuntimeConnection();
    await kbrain.close();
  }
});
