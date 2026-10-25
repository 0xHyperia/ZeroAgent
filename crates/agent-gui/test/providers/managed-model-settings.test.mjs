import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
const gui = name => fileURLToPath(new URL("../../src/" + name, import.meta.url));
const web = name => fileURLToPath(new URL("../../../agent-gateway/web/src/" + name, import.meta.url));
const seedLoader = createTsModuleLoader();
const settingsModule = seedLoader.loadModule("src/lib/settings/index.ts");
const fetched = [{ id: "Kimi-K2.5", displayName: "Catalog Kimi", contextWindow: 1000000, maxOutputToken: 32000, limitsSource: "provider" }, { id: "GLM-5", contextWindow: 200000, maxOutputToken: 16000 }];
const group = { id: 1, name: "USA0", status: "active", platform: "openai" };
const key = { id: 1, name: "Desktop", key: "synthetic-only", status: "active", group_id: 1 };
const binding = { providerId: "relay-key-1", baseUrl: "http://127.0.0.1:39999/b/synthetic", apiKey: "synthetic-capability" };
function makeLoader(surface, discover = async () => fetched, calls = []) {
  const bindings = new Map([[binding.providerId, binding]]);
  return createTsModuleLoader({ mocks: {
    "@/lib/settings": settingsModule,
    [gui("lib/kbrain/client.ts")]: { createKBrainClient: () => ({ discoverProviderModels: async id => { calls.push(id); assert.equal(id, "relay-key-1", "desktop discovery must identify the authorized binding"); return discover(); } }) },
    [gui("lib/relay/client.ts")]: { RELAY_ORIGIN: "https://usa0.top" },
    [gui("lib/relay/managedCredentials.ts")]: { managedModelBinding: id => bindings.get(id), replaceManagedModelCredentials: async () => bindings },
    [web("lib/relay/client.ts")]: { RELAY_ORIGIN: "https://usa0.top", getRelayProviderModels: async id => { calls.push(id); assert.equal(id, 1); return discover(); } },
  } });
}
for (const surface of ["desktop", "web"]) {
  test(surface + " first successful catalog enables models after a fresh, empty, or failed initial discovery", async () => {
    let mode = "success"; const calls = [];
    const loader = makeLoader(surface, async () => {
      if (mode === "offline") throw new Error("controlled offline catalog");
      return mode === "empty" ? [] : fetched;
    }, calls);
    const mod = loader.loadModule(surface === "desktop" ? "src/lib/relay/providers.ts" : web("lib/relay/providers.ts"));
    const [fresh] = await mod.buildRelayProviders([], [key], [group], true);
    assert.deepEqual([...fresh.activeModels], fetched.map(model => model.id), "a new provider defaults to the fetched catalog");
    for (const initial of ["empty", "offline"]) {
      mode = initial;
      const [empty] = await mod.buildRelayProviders([], [key], [group], true);
      assert.equal(empty.models.length, 0); assert.equal(empty.activeModels.length, 0);
      mode = "success";
      const [retry] = await mod.buildRelayProviders([empty], [key], [group], true);
      assert.deepEqual([...retry.activeModels], fetched.map(model => model.id), initial + " discovery cannot permanently disable the first successful catalog");
    }
    assert.ok(calls.length > 0);
    assert.ok(calls.every(id => id === (surface === "desktop" ? "relay-key-1" : 1)), "every discovery uses the current authorized provider/key ID");
  });
  test(surface + " managed refresh preserves disabled models, aliases, user limits, custom IDs and ordering", async () => {
    const loader = makeLoader(surface);
    const mod = loader.loadModule(surface === "desktop" ? "src/lib/relay/providers.ts" : web("lib/relay/providers.ts"));
    const existing = { id: "relay-key-1", name: "Old", type: "codex", baseUrl: "https://injected.invalid", apiKey: "injected", models: [
      { id: "Kimi-K2.5", displayName: "My Kimi", contextWindow: 262144, maxOutputToken: 8192, limitsSource: "user", inputModalities: ["text", "image"], promptCacheHintMode: "openai-key" },
      { id: "manual-alias", displayName: "Manual", contextWindow: 65536, maxOutputToken: 4096, limitsSource: "user" },
    ], activeModels: ["manual-alias"], modelOrder: ["manual-alias", "Kimi-K2.5"], requestFormat: "openai-completions", customHeaders: [{key:"Authorization",value:"injected"}], isFullUrl: true, modelsUrl: "https://injected.invalid/models", useSystemProxy: true };
    const [refreshed] = await mod.buildRelayProviders([existing], [key], [group], true);
    assert.deepEqual([...refreshed.activeModels], ["manual-alias"]);
    assert.deepEqual([...refreshed.modelOrder], existing.modelOrder);
    assert.equal(refreshed.requestFormat, "openai-completions");
    const kimi = refreshed.models.find(model => model.id === "Kimi-K2.5");
    assert.equal(kimi.displayName, "My Kimi"); assert.equal(kimi.contextWindow, 262144); assert.equal(kimi.maxOutputToken, 8192);
    assert.deepEqual([...kimi.inputModalities], ["text", "image"]);
    assert.equal(kimi.promptCacheHintMode, "openai-key");
    assert.ok(refreshed.models.some(model => model.id === "manual-alias"));
    assert.ok(refreshed.models.some(model => model.id === "GLM-5"));
    assert.equal(refreshed.isFullUrl, false); assert.equal(refreshed.modelsUrl, undefined); assert.equal(refreshed.customHeaders.length, 0); assert.equal(refreshed.useSystemProxy, false);
    assert.equal(refreshed.baseUrl, surface === "desktop" ? binding.baseUrl : "https://usa0.top");
    const settings = { ...settingsModule.getDefaultSettings(), customProviders: [refreshed], selectedModel: { customProviderId: refreshed.id, model: "manual-alias" } };
    const edited = mod.applyRelayProviderModelSettings(settings, refreshed.id, { ...refreshed, models: refreshed.models, activeModels: [], baseUrl: "https://attacker.invalid", apiKey: "attacker", customHeaders: [{key:"X-Injected",value:"1"}] });
    assert.equal(edited.selectedModel, undefined); assert.equal(edited.customProviders[0].baseUrl, refreshed.baseUrl); assert.equal(edited.customProviders[0].apiKey, refreshed.apiKey); assert.equal(edited.customProviders[0].customHeaders.length, 0);
    assert.throws(() => mod.applyRelayProviderModelSettings(settings, "external", refreshed));
    const [again] = await mod.buildRelayProviders(edited.customProviders, [key], [group], true);
    assert.equal(again.activeModels.length, 0, "all-disabled stays disabled after catalog refresh");
  });
}

test("Web managed catalog discovery uses owned-key HTTP and ignores draft endpoint credentials", async () => {
  const calls=[];
  const loader=createTsModuleLoader({mocks:{
    "@/lib/settings":settingsModule,
    [web("lib/relay/client.ts")]:{RELAY_ORIGIN:"https://usa0.top",getRelayProviderModels:async id=>{calls.push(id);return fetched;}},
    [web("lib/gatewaySocket.ts")]:{getGatewayWebSocketClient:()=>{throw new Error("managed discovery must not dispatch to a remote device");}},
    [web("lib/storage.ts")]:{loadToken:()=>"synthetic-local-only"},
  }});
  const {discoverProviderModels}=loader.loadModule(web("agent-ui-adapters/providerSettings.tsx"));
  const models=await discoverProviderModels({providerId:"relay-key-1",type:"codex",baseUrl:"https://injected.invalid",apiKey:"injected",modelsUrl:"https://injected.invalid/models",customHeaders:[{key:"X-Injected",value:"1"}]});
  assert.deepEqual(calls,[1]);assert.equal(models[0].id,"Kimi-K2.5");
});
