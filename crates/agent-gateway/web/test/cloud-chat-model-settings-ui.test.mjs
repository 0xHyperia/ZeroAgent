import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test("the real Cloud managed model form exposes CC-compatible choices while retaining device settings",async(t)=>{
 const icon=()=>null;
 const env=await createWebDomTestEnv({mocks:{
   "@liveagent/ui/components/IconSet":new Proxy({}, {get:(_target,name)=>name==="__esModule"?true:icon}),
   "@liveagent/ui/i18n/index":{useLocale:()=>({t:key=>key})},
   "@liveagent/adapters/providerSettings":{providerCredentialsRedacted:true,revealStoredProviderApiKey:async()=>null,discoverProviderModels:async()=>[]},
   "@liveagent/app/lib/providers/usageQuery":{testProviderUsage:async()=>null},
   "@liveagent/ui/lib/models/thinkingLive":{loadThinkingLiveSupplement:async()=>{}},
 }});
 window.HTMLElement.prototype.getAnimations??=()=>[];
 const {ProviderModal}=env.loadModule("@liveagent/ui/pages/settings/ProviderModal.tsx");
 const {getDefaultUsageQueryConfig}=env.loadModule("src/lib/settings/index.ts");
 const initial={id:"relay-key-1",name:"Synthetic",type:"codex",baseUrl:"https://usa0.top",apiKey:"",apiKeyConfigured:true,customHeaders:[],models:[{id:"test-model",contextWindow:64000,maxOutputToken:8000,limitsSource:"user"}],activeModels:["test-model"],requestFormat:"openai-responses",promptCacheHintMode:"auto",usageQuery:getDefaultUsageQueryConfig()};
 const saved=[],host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 await env.act(async()=>root.render(env.React.createElement(ProviderModal,{providerType:"codex",initialData:initial,connectionManaged:true,cloudChatMode:true,onSave:value=>saved.push(value),onClose:()=>{}})));
 assert.match(document.body.textContent,/云端对话使用 Chat Completions/);assert.match(document.body.textContent,/设备端的请求格式保持原设置/);
 assert.doesNotMatch(document.body.textContent,/settings.providerAdvancedSettings/);
 const providerCache=document.querySelector('[aria-label="settings.promptCacheHintMode"]');await env.act(async()=>providerCache.click());
 const options=[...document.querySelectorAll('[role="option"]')];assert.equal(options.length,2);assert.ok(options.some(node=>node.textContent.includes(".auto")));assert.ok(options.some(node=>node.textContent.includes(".none")));assert.ok(options.every(node=>!node.textContent.includes("openaiKey")&&!node.textContent.includes("openrouterSession")));
 await env.act(async()=>options.find(node=>node.textContent.includes(".none")).click());
 await env.act(async()=>document.querySelector('button[title="test-model"]').click());
 const modelCache=document.querySelector('[aria-label="settings.promptCacheHintModelOverride"]');await env.act(async()=>modelCache.click());
 const overrides=[...document.querySelectorAll('[role="option"]')];assert.equal(new Set(overrides.map(node=>node.textContent)).size,3);assert.ok(overrides.every(node=>!node.textContent.includes("openaiKey")&&!node.textContent.includes("openrouterSession")));
 await env.act(async()=>overrides.filter(node=>node.textContent.includes(".auto")).at(-1).click());
 const apply=[...document.querySelectorAll("button")].find(node=>node.textContent.trim()==="settings.providerModelApply");await env.act(async()=>apply.click());
 const save=[...document.querySelectorAll("button")].find(node=>node.textContent.trim()==="settings.save");await env.act(async()=>save.click());
 assert.equal(saved[0].requestFormat,"openai-responses");assert.equal(saved[0].promptCacheHintMode,"none");assert.equal(saved[0].models[0].promptCacheHintMode,"auto");
});

test("the shared composer attachment card opens and removes one ready reference through separate controls",async(t)=>{
 let env;const calls=[];
 env=await createWebDomTestEnv({mocks:{"@liveagent/ui/components/IconSet":{X:()=>null}}});
 const {ComposerAttachmentCard}=env.loadModule("@liveagent/ui/components/chat/ComposerAttachmentCard.tsx");
 const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 await env.act(async()=>root.render(env.React.createElement(ComposerAttachmentCard,{fileName:"website.html · v2",pathTitle:"website.html · v2",fallbackIcon:null,disabled:false,removeLabel:"移除",onOpen:()=>calls.push("open"),onRemove:()=>calls.push("remove")})));
 assert.equal(host.textContent.match(/website.html · v2/g).length,1);const buttons=host.querySelectorAll("button");await env.act(async()=>{buttons[0].click();buttons[1].click();});assert.deepEqual(calls,["open","remove"]);
});
