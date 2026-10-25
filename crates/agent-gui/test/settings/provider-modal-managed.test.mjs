import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
test("managed modal edits upstream model fields, retains disabled state on refresh and projects fixed connection", async () => {
  let vm; const saved=[];
  const env=await createDomTestEnv({mocks:{
    [fileURLToPath(new URL("../../../agent-ui/src/pages/settings/ProviderModalView.tsx",import.meta.url))]:{ProviderModalView:({viewModel})=>{vm=viewModel;return null;}},
    "@liveagent/adapters/providerSettings":{providerCredentialsRedacted:true,revealStoredProviderApiKey:async()=>null,discoverProviderModels:async()=>[{id:"Kimi-K2.5",displayName:"Catalog",contextWindow:1000000,maxOutputToken:32000,limitsSource:"provider"},{id:"GLM-5",contextWindow:200000,maxOutputToken:8192}]},
    "@liveagent/ui/i18n/index":{useLocale:()=>({t:key=>key})},
    "@liveagent/app/lib/providers/usageQuery":{testProviderUsage:async()=>null},
    "@liveagent/ui/lib/models/thinkingLive":{loadThinkingLiveSupplement:async()=>{}},
  }});
  const {ProviderModal}=env.loadModule("@liveagent/ui/pages/settings/ProviderModal.tsx");
  const {getDefaultUsageQueryConfig}=env.loadModule("src/lib/settings/index.ts");
  const initial={id:"relay-key-1",name:"USA0",type:"codex",baseUrl:"http://127.0.0.1:39999/b/synthetic",apiKey:"synthetic-capability",apiKeyConfigured:true,customHeaders:[],models:[{id:"Kimi-K2.5",displayName:"My Kimi",contextWindow:262144,maxOutputToken:8192,limitsSource:"user"}],activeModels:[],requestFormat:"openai-responses",usageQuery:getDefaultUsageQueryConfig()};
  const root=env.createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await env.act(async()=>root.render(env.React.createElement(ProviderModal,{providerType:"codex",initialData:initial,connectionManaged:true,onSave:next=>saved.push(next),onClose:()=>{}})));
    assert.equal(vm.connectionManaged,true);
    await env.act(async()=>vm.handleRefresh());
    assert.equal(vm.models.find(model=>model.id==="Kimi-K2.5").displayName,"My Kimi");
    assert.equal(vm.activeModels.size,0,"refresh cannot reactivate disabled models");
    await env.act(async()=>vm.setNewModelName("manual-alias"));
    await env.act(async()=>vm.handleAddModel());
    await env.act(async()=>vm.setEditingModel(previous=>({...previous,contextWindow:"65536",maxOutputToken:"4096",model:{...previous.model,displayName:"Manual Kimi",promptCacheHintMode:"none"}})));
    await env.act(async()=>vm.setEditingModelInputModalitiesMode("text-image"));
    await env.act(async()=>vm.setRequestFormat("openai-completions"));
    await env.act(async()=>vm.setPromptCacheHintMode("none"));
    await env.act(async()=>vm.setBaseUrl("https://injected.invalid"));
    await env.act(async()=>vm.setApiKey("injected"));
    await env.act(async()=>vm.setModelsUrl("https://injected.invalid/models"));
    await env.act(async()=>vm.setIsFullUrl(true));
    await env.act(async()=>vm.setUseSystemProxy(true));
    await env.act(async()=>vm.handleSave());
    assert.equal(saved.length,1); const result=saved[0];
    assert.equal(result.baseUrl,initial.baseUrl);assert.equal(result.apiKey,initial.apiKey);assert.equal(result.isFullUrl,false);assert.equal(result.modelsUrl,undefined);assert.equal(result.useSystemProxy,false);assert.equal(result.customHeaders.length,0);
    assert.equal(result.requestFormat,"openai-completions"); assert.deepEqual([...result.activeModels],["manual-alias"]);
    const model=result.models.find(model=>model.id==="manual-alias");assert.equal(model.displayName,"Manual Kimi");assert.equal(model.contextWindow,65536);assert.equal(model.maxOutputToken,4096);assert.equal(model.limitsSource,"user");assert.equal(model.promptCacheHintMode,undefined,"unsupported per-model cache state is not sent");assert.equal(result.promptCacheHintMode,"none");assert.equal(result.promptCachingEnabled,false);assert.deepEqual([...model.inputModalities],["text","image"]);
  } finally {await env.act(async()=>root.unmount());env.cleanup();}
});

test("managed model form exposes provider cache settings and omits unsupported model overrides", async () => {
  const icon=()=>null;
  const env=await createDomTestEnv({mocks:{
    "@liveagent/ui/components/IconSet":new Proxy({}, {get:(_target,name)=>name==="__esModule"?true:icon}),
    "@liveagent/ui/i18n/index":{useLocale:()=>({t:key=>key})},
    "@liveagent/adapters/providerSettings":{providerCredentialsRedacted:true,revealStoredProviderApiKey:async()=>null,discoverProviderModels:async()=>[]},
    "@liveagent/app/lib/providers/usageQuery":{testProviderUsage:async()=>null},
    "@liveagent/ui/lib/models/thinkingLive":{loadThinkingLiveSupplement:async()=>{}},
  }});
  window.HTMLElement.prototype.getAnimations??=()=>[];
  const {ProviderModal}=env.loadModule("@liveagent/ui/pages/settings/ProviderModal.tsx");
  const {getDefaultUsageQueryConfig}=env.loadModule("src/lib/settings/index.ts");
  const initial={id:"relay-key-1",name:"USA0",type:"codex",baseUrl:"http://127.0.0.1:39999/b/synthetic",apiKey:"synthetic-only",apiKeyConfigured:true,customHeaders:[],models:[{id:"Kimi-K2.5",contextWindow:300000,maxOutputToken:20000}],activeModels:["Kimi-K2.5"],requestFormat:"openai-responses",promptCacheHintMode:"auto",usageQuery:getDefaultUsageQueryConfig()};
  const saved=[];const root=env.createRoot(document.body.appendChild(document.createElement("div")));
  try {
    await env.act(async()=>root.render(env.React.createElement(ProviderModal,{providerType:"codex",initialData:initial,connectionManaged:true,onSave:value=>saved.push(value),onClose:()=>{}})));
    assert.equal(document.querySelector("#modal-apikey"),null);assert.equal(document.querySelector("#modal-baseurl"),null);
    assert.ok(document.querySelector('[aria-label="settings.promptCacheHintMode"]'),"the existing provider cache select is reachable");
    await env.act(async()=>document.querySelector('button[title="Kimi-K2.5"]').click());
    assert.ok(document.querySelector("#model-context-window"),"real model editor is open");
    assert.equal(document.body.textContent.includes("settings.promptCacheHintModelOverride"),false,"managed models cannot select a field rejected by canonical Go");
    await env.act(async()=>document.querySelector('[aria-label="settings.promptCacheHintMode"]').click());
    const none=[...document.querySelectorAll('[role="option"]')].find(node=>node.getAttribute("data-value")==="none" || node.textContent.includes("settings.promptCacheHintMode.none"));
    assert.ok(none,"provider-level none option exists");
    await env.act(async()=>none.click());
    const save=[...document.querySelectorAll("button")].find(node=>node.textContent.trim()==="settings.save");
    assert.ok(save);await env.act(async()=>save.click());
    assert.equal(saved.length,1);assert.equal(saved[0].promptCacheHintMode,"none");assert.equal(saved[0].promptCachingEnabled,false);assert.equal(saved[0].models[0].promptCacheHintMode,undefined);
  }finally{await env.act(async()=>root.unmount());env.cleanup();}
});
