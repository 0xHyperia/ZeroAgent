import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
const load=()=>createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudChatModelParameters.ts");
const settings=(model={},provider={})=>({customProviders:[{id:"key-1",type:"codex",requestFormat:"openai-responses",promptCacheHintMode:"auto",promptCachingEnabled:true,models:[{id:"test-model",contextWindow:64000,maxOutputToken:16000,...model}],...provider}]});
test("Cloud parameters use the selected provider/model configuration while retaining the device protocol",()=>{
 const api=load(),input=settings({inputModalities:["text"],promptCacheHintMode:"none"});
 const params=api.buildCloudChatModelParameters(input,"key-1","test-model");
 assert.deepEqual(params,{request_format:"openai-completions",context_window:64000,max_output_tokens:16000,input_modalities:["text"],provider_cache_mode:"auto",model_cache_mode:"none"});
 assert.equal(input.customProviders[0].requestFormat,"openai-responses");input.customProviders[0].models[0].inputModalities.push("image");assert.deepEqual(params.input_modalities,["text"],"a pending Run owns its parameter array");
 assert.deepEqual(api.buildCloudChatModelParameters({customProviders:[]},"absent","test-model"),{request_format:"openai-completions",provider_cache_mode:"auto"});
});

test("an explicit account platform mode omits both limits while an unsaved model keeps its local values",()=>{
 const api=load(),original=settings({inputModalities:["text","image"],promptCacheHintMode:"none"}),saved={provider_key_id:1,model:"test-model",mode:"platform",context_window:64000,max_output_tokens:8000,version:1,updated_at:"2026-10-29T00:00:00Z"};
 const inherited=api.buildCloudChatModelParameters(original,"key-1","test-model",undefined,saved);assert.equal(inherited.context_window,undefined);assert.equal(inherited.max_output_tokens,undefined);assert.deepEqual(inherited.input_modalities,["text","image"]);assert.equal(inherited.model_cache_mode,"none");assert.equal(original.customProviders[0].models[0].contextWindow,64000);assert.equal(original.customProviders[0].requestFormat,"openai-responses");
 const explicit=api.buildCloudChatModelParameters(original,"key-1","test-model",undefined,{...saved,mode:"custom",context_window:96000,max_output_tokens:12000});assert.equal(explicit.context_window,96000);assert.equal(explicit.max_output_tokens,12000);
 assert.equal(api.buildCloudChatModelParameters(original,"key-1","test-model",undefined,null).max_output_tokens,16000);
});
test("model cache overrides take priority and unsupported effective manual modes are explicit",()=>{
 const api=load();
 assert.deepEqual(api.buildCloudChatModelParameters(settings({promptCacheHintMode:"none"},{promptCacheHintMode:"openai-key"}),"key-1","test-model"),{request_format:"openai-completions",context_window:64000,max_output_tokens:16000,model_cache_mode:"none"});
 for(const data of [settings({promptCacheHintMode:"openrouter-session"}),settings({},{promptCacheHintMode:"openai-key"})])assert.throws(()=>api.buildCloudChatModelParameters(data,"key-1","test-model"),/手动缓存提示/);
 assert.equal(api.buildCloudChatModelParameters(settings({},{promptCacheHintMode:undefined,promptCachingEnabled:false}),"key-1","test-model").provider_cache_mode,"none");
});
test("reasoning and explicit zero limits retain their protocol meaning and invalid settings do not disappear",()=>{
 const api=load();assert.equal(api.cloudChatReasoningEffort("off"),"none");assert.equal(api.cloudChatReasoningLevel("none"),"off");
 for(const value of ["minimal","low","medium","high","xhigh","max"])assert.equal(api.cloudChatReasoningEffort(value),value);
 assert.deepEqual(api.parseCloudChatModelParameters({context_window:0,max_output_tokens:0}),{context_window:0,max_output_tokens:0});
 for(const params of [{context_window:100},{max_output_tokens:1},{context_window:1024,max_output_tokens:1024},{provider_cache_mode:"openai-key"},{request_format:"openai-responses"},{input_modalities:["image"]},{temperature:0.5}])assert.throws(()=>api.parseCloudChatModelParameters(params));
});

test("browser timezone and locale are frozen preferences and never supply a client clock or authority",()=>{
 const api=load(),preferences=api.cloudChatClientPreferences({timeZone:()=>"Asia/Hong_Kong",locale:()=>"zh-HK"});assert.deepEqual(preferences,{time_zone:"Asia/Hong_Kong",locale:"zh-HK"});
 const params=api.buildCloudChatModelParameters(settings(),"key-1","test-model",preferences);preferences.time_zone="UTC";assert.equal(params.time_zone,"Asia/Hong_Kong");assert.equal(params.locale,"zh-HK");assert.ok(!("now" in params));assert.ok(!("city" in params));assert.ok(!("permissions" in params));
 assert.deepEqual(api.cloudChatClientPreferences({timeZone:()=>{throw new Error("unavailable");},locale:()=>"not a locale"}),{time_zone:"UTC",locale:"und"});
 for(const value of [{time_zone:"Local"},{time_zone:1},{locale:"zh HK"},{locale:"a".repeat(65)}])assert.throws(()=>api.parseCloudChatModelParameters(value));
});

test("response snapshots accept additive metadata without retaining it and still reject invalid known values",()=>{
 const api=load();assert.deepEqual(api.parseCloudChatModelParameters({request_format:"openai-completions",time_zone:"UTC",locale:"und",new_optional_metadata:{version:2},upstream_secret:"private"},{fromResponse:true}),{request_format:"openai-completions",time_zone:"UTC",locale:"und"});
 assert.throws(()=>api.parseCloudChatModelParameters({request_format:"openai-completions",new_optional_metadata:true}));
 for(const value of [{request_format:"openai-responses"},{provider_cache_mode:"openai-key"},{input_modalities:["image"]},{context_window:-1}])assert.throws(()=>api.parseCloudChatModelParameters(value,{fromResponse:true}));
});
