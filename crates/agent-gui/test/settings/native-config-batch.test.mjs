import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

async function fixture(run) {
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const savedFetch = globalThis.fetch;
  const local = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: key => local.get(key) ?? null,
    setItem: (key, value) => local.set(key, value),
  } });
  globalThis.fetch = async () => { throw new Error("Native canonical settings must not read or write HTTP domains separately"); };
  const backend = {settings:{mode:"kbrain",version:"kbrain.agent.v1",providers:[],models:[]},
    mcp:{settings:{servers:[],selected:[]}},prompts:{revision:1,globalTemplates:[],projectPrompts:{}}};
  let revision = 0;
  let uiRevision = 0;
  let uiPreferences = {};
  const uiVersion = () => `za-ui-v1-fixture-${uiRevision}`;
  let state;
  let failure;
  const calls = [];
  const version = () => `za-config-v1-fixture-${revision}`;
  const nativeVersion = () => `za-native-v1-fixture-${revision}`;
  const loader = createTsModuleLoader({ mocks: {
    [new URL("../../src/lib/host.ts", import.meta.url).pathname]: {
      isKBrainBrowserHost: () => false, isKBrainBackendEnabled: () => true, isTauriHost: () => true,
      kBrainOwnedDesktopCommand: () => false,
    },
    "@tauri-apps/api/core": { invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "settings_load_all") return { ...structuredClone(state), uiRevision: uiVersion(),uiPreferences:structuredClone(uiPreferences),nativeRevision: nativeVersion(), configurationRevision: version(),backend:structuredClone(backend) };
      if (command === "settings_save_ui_preferences") {
        if (args.update.expectedRevision !== uiVersion()) throw "ZEROAGENT_UI_PREFERENCES_CHANGED";
        uiPreferences = {...uiPreferences, ...structuredClone(args.update.changes)};
        uiRevision += 1;
        return {uiRevision:uiVersion(),uiPreferences:structuredClone(uiPreferences)};
      }
      assert.equal(command, "settings_save_canonical_batch", "all preference writes must use one versioned batch");
      if (failure) throw failure;
      assert.ok(args.update.expectedRevision, "must carry the actual read version");
      if (args.update.expectedRevision !== version()) throw "ZEROAGENT_CONFIGURATION_CHANGED";
      Object.assign(state, structuredClone(args.update.nativeChanges));
       if (args.update.mcp) {
         backend.mcp.settings = structuredClone(args.update.mcp);
         for (const server of backend.mcp.settings.servers) for (const field of ["env","headers"]) {
           server[`${field}Configured`] = Object.keys(server[field] ?? {});
           server[field] = Object.fromEntries(Object.keys(server[field] ?? {}).map(key => [key, ""]));
         }
       }
       if (args.update.templates) backend.prompts.globalTemplates = structuredClone(args.update.templates);
      revision += 1;
      return { nativeRevision: nativeVersion(), configurationRevision: version(), backend: structuredClone(backend),stt:args.update.nativeChanges.stt ?? null };
    } },
  } });
  const settings = loader.loadModule("src/lib/settings/index.ts");
  state = settings.getDefaultSettings();
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({
    baseUrl: "http://127.0.0.1:54321", token: "fixture", protocolVersion: "kbrain.agent.v1", managedLocal: true, storageId: "fixture",
  });
  const storage = loader.loadModule("src/lib/settings/storage.ts");
  try {
    await run({ storage, settings, loader, calls, local, version, nativeVersion, uiVersion,
      clearUi: () => {uiPreferences = null;},
      changeUiElsewhere: () => {uiRevision += 1; uiPreferences = {theme:"light"};},
      state: () => state,
      changeElsewhere: () => { revision += 1; },
      fail: error => { failure = error; },
    });
  } finally {
    globalThis.fetch = savedFetch;
    if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
    else delete globalThis.localStorage;
  }
}

test("a composite native edit commits once with the read snapshot version", async () => fixture(async f => {
  const before = await f.storage.loadPersistedSettings();
  const next = { ...before, system: { ...before.system, defaultTimeZone: "Asia/Tokyo" },
    memory: { ...before.memory, enabled: true }, remote: { ...before.remote, enabled: true },
    stt: { ...before.stt, enabled: true, allowIncomplete: true },
  };
  const result = await f.storage.persistSettings(before, next);
  const writes = f.calls.filter(c => c.command !== "settings_load_all");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args.update.expectedRevision, before.configurationRevision);
  assert.deepEqual(Object.keys(writes[0].args.update.nativeChanges).sort(), ["memory", "remote", "stt", "system"]);
  assert.equal(result.nativeConfigurationRevision, f.nativeVersion());
  assert.equal(result.stt.nativeConfigurationRevision, f.nativeVersion());
  assert.equal(writes[0].args.update.nativeChanges.stt.nativeConfigurationRevision, undefined);
}));

test("queued optimistic edits inherit only their exact successful predecessor version", async () => fixture(async f => {
  const before = await f.storage.loadPersistedSettings();
  const first = { ...before, system: { ...before.system, defaultTimeZone: "Asia/Tokyo" } };
  const second = { ...first, remote: { ...first.remote, enabled: true } };
  const third = { ...second, stt: { ...second.stt, enabled: true, allowIncomplete: true } };
  await f.storage.persistSettings(before, first);
  await f.storage.persistSettings(first, second);
  await f.storage.persistSettings(second, third);
  const versions = f.calls.filter(c => c.command === "settings_save_canonical_batch").map(c => c.args.update.expectedRevision);
  assert.deepEqual(versions, [0, 1, 2].map(n => `za-config-v1-fixture-${n}`));
  const staleEditor = { ...before, system: { ...before.system, defaultTimeZone: "Europe/Paris" } };
  await assert.rejects(f.storage.persistSettings(before, staleEditor), error => error.code === "native_settings_changed");
  assert.equal(f.state().system.defaultTimeZone, "Asia/Tokyo");
}));

test("loading a newer snapshot cannot lend its version to an older editor", async () => fixture(async f => {
  const old = await f.storage.loadPersistedSettings();
  f.changeElsewhere();
  const fresh = await f.storage.loadPersistedSettings();
  assert.notEqual(old.configurationRevision, fresh.configurationRevision);
  await assert.rejects(f.storage.persistSettings(old, { ...old, remote: { ...old.remote, enabled: true } }),
    error => error.code === "native_settings_changed");
  assert.equal(f.calls.at(-1).args.update.expectedRevision, old.configurationRevision);
}));

test("a failed native write clears lineage and local UI preferences still persist", async () => fixture(async f => {
  const before = await f.storage.loadPersistedSettings();
  const first = { ...before, remote: { ...before.remote, enabled: true } };
  await f.storage.persistSettings(before, first);
  f.fail("database unavailable");
  const second = { ...first, theme: "dark", system: { ...first.system, defaultTimeZone: "Asia/Tokyo" } };
  await assert.rejects(f.storage.persistSettings(first, second), error => error.code === "save_failed");
  assert.equal(JSON.parse([...f.local.values()].at(-1)).theme, "dark");
  f.fail(undefined);
  await assert.rejects(f.storage.persistSettings(first, second), error => error.code === "native_settings_changed");
  assert.equal(f.state().system.defaultTimeZone, "");
}));

test("independent STT editors keep their own read version and accept the committed version", async () => fixture(async f => {
  const service = f.loader.loadModule("src/lib/stt/desktopSttSettingsService.ts").desktopSttSettingsService;
  const old = await service.get();
  f.changeElsewhere();
  const fresh = await service.get();
  await assert.rejects(service.update({ ...old, enabled: true }), error => error.message === "配置已更新，请重新加载设置后再保存。");
  const saved = await service.update({ ...fresh, enabled: true });
  assert.equal(saved.configurationRevision, f.version());
  assert.equal(saved.enabled, true);
}));

test("normalization and authoritative merges retain the version without recreating provider data", async () => fixture(async f => {
  const before = await f.storage.loadPersistedSettings();
  const merge = f.loader.loadModule("src/lib/settings/backendOwnedMerge.ts").mergeBackendOwnedSettings;
  const after = merge(before, { nativeConfigurationRevision: "za-native-v1-fixture-new" }, f.settings.normalizeSettings);
  assert.equal(after.nativeConfigurationRevision, "za-native-v1-fixture-new");
  assert.equal(after.customProviders, before.customProviders);
  assert.equal(merge(after, { nativeConfigurationRevision: after.nativeConfigurationRevision }, f.settings.normalizeSettings), undefined);
}));

test("MCP, templates, project prompts and native preferences share one checked batch", async () => fixture(async f => {
  const before = await f.storage.loadPersistedSettings();
  const next = { ...before, memory:{...before.memory,enabled:true},
    mcp:{...before.mcp,servers:[{id:"m",transport:"stdio",command:"node",enabled:false,env:{TOKEN:""},envConfigured:["TOKEN"]}]},
    agents:[{id:"a",name:"Canonical",description:"",prompt:"instructions",enabled:true}],
    system:{...before.system,workspaceResourceSettings:{"d:/fixture":{projectPrompt:"Project instructions",projectPromptStrategy:"replace"}}}
  };
  const result = await f.storage.persistSettings(before,next);
  const writes = f.calls.filter(c => c.command === "settings_save_canonical_batch");
  assert.equal(writes.length,1);
  assert.equal(writes[0].args.update.expectedRevision,before.configurationRevision);
  assert.deepEqual(writes[0].args.update.projects,[{workdir:"d:/fixture",prompt:"Project instructions",strategy:"replace"}]);
  assert.deepEqual(writes[0].args.update.mcp.servers[0].env,{TOKEN:""});
  assert.equal(result.configurationRevision,f.version());
  assert.equal(result.mcp.servers[0].env.TOKEN,"");
}));

test("a queued editor cannot borrow a version after its MCP baseline diverges", async () => fixture(async f => {
  const before = await f.storage.loadPersistedSettings();
  const first = {...before,remote:{...before.remote,enabled:true}};
  await f.storage.persistSettings(before,first);
  const changedBaseline = {...first,mcp:{...first.mcp,selected:["other"]}};
  await assert.rejects(f.storage.persistSettings(changedBaseline,{...changedBaseline,memory:{...first.memory,enabled:true}}),
    error => error.code === "native_settings_changed");
  assert.equal(f.calls.at(-1).args.update.expectedRevision,before.configurationRevision);
}));

test("native UI preferences survive losing the WebView cache without writing backend configuration", async () => fixture(async f => {
  const before = await f.storage.loadPersistedSettings();
  const result = await f.storage.persistSettings(before, {...before,theme:"dark"});
  assert.equal(result.uiPreferencesRevision, f.uiVersion());
  assert.equal(f.calls.filter(c => c.command === "settings_save_canonical_batch").length, 0);
  f.local.clear();
  const reopened = await f.storage.loadPersistedSettings();
  assert.equal(reopened.theme, "dark");
  assert.equal(reopened.uiPreferencesRevision, result.uiPreferencesRevision);
  assert.equal(reopened.configurationRevision, before.configurationRevision);
}));

test("a rejected backend edit still durably saves independent UI changes", async () => fixture(async f => {
  const before = await f.storage.loadPersistedSettings();
  f.fail("backend rejected the update");
  await assert.rejects(f.storage.persistSettings(before, {...before,theme:"dark",remote:{...before.remote,enabled:true}}));
  f.local.clear();
  const reopened = await f.storage.loadPersistedSettings();
  assert.equal(reopened.theme, "dark");
  assert.equal(reopened.remote.enabled, false);
  assert.equal(reopened.configurationRevision, before.configurationRevision);
}));

test("UI edits inherit only their exact queued baseline and never a newer window's version", async () => fixture(async f => {
  const before = await f.storage.loadPersistedSettings();
  const first = {...before,theme:"dark"};
  const second = {...first,locale:first.locale === "zh-CN" ? "en-US" : "zh-CN"};
  await f.storage.persistSettings(before,first);
  await f.storage.persistSettings(first,second);
  const writes = f.calls.filter(c => c.command === "settings_save_ui_preferences");
  assert.deepEqual(writes.map(c => c.args.update.expectedRevision), ["za-ui-v1-fixture-0","za-ui-v1-fixture-1"]);
  f.changeUiElsewhere();
  await f.storage.loadPersistedSettings();
  await assert.rejects(f.storage.persistSettings(second,{...second,theme:"light"}), error => error.code === "native_settings_changed");
  assert.equal(f.calls.at(-1).args.update.expectedRevision, before.uiPreferencesRevision);
}));

test("fresh Native preferences ignore old WebView data and persist current edits", async () => fixture(async f => {
  f.clearUi();
  const scope = f.loader.loadModule("src/lib/kbrain/mapping.ts").kBrainStorageScope();
  const key = `liveagent.ui-settings.v1:${scope}`;
  const legacy = JSON.stringify({theme:"dark",locale:"zh-CN",selectedModel:{customProviderId:"legacy",model:"archived"}});
  f.local.set(key, legacy);
  const initial = await f.storage.loadPersistedSettings();
  assert.notEqual(initial.theme,"dark");
  assert.equal(initial.selectedModel,undefined);
  assert.equal(f.local.get(key),legacy,"the old source must remain intact");
  assert.equal(f.calls.filter(c => c.command === "settings_save_ui_preferences").length,0,"loading must not migrate old preferences");
  await f.storage.persistSettings(initial,{...initial,theme:"dark"});
  f.local.clear();
  const reopened = await f.storage.loadPersistedSettings();
  assert.equal(reopened.theme,"dark");
  assert.equal(reopened.selectedModel,undefined);
  assert.equal(f.calls.filter(c => c.command === "settings_save_ui_preferences").length,1);
}));
