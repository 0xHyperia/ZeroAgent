import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
const load=()=>createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudChatModelLimits.ts");
const setting=(overrides={})=>({provider_key_id:41,model:"model/a",mode:"platform",context_window:64000,max_output_tokens:8000,version:1,updated_at:"2026-10-29T00:00:00Z",...overrides});
const safe=()=>()=>{};
test("account model limits use an exact scoped key and versioned PUT without AppSettings or credentials",async()=>{
 const api=load(),calls=[];const client=api.createCloudChatModelLimitsClient(async(path,init)=>{calls.push({path,init});return Response.json({setting:setting({private_extra:"ignored"})});},safe);
 const value=await client.get(41,"model/a");assert.equal(value.private_extra,undefined);assert.match(calls[0].path,/provider_key_id=41&model=model%2Fa/);assert.equal(calls[0].init.credentials,"include");
 await client.save(41,"model/a",{expected_version:0,mode:"platform",context_window:0,max_output_tokens:0});assert.deepEqual(JSON.parse(calls[1].init.body),{expected_version:0,mode:"platform",context_window:0,max_output_tokens:0});assert.equal(calls[1].init.method,"PUT");
 assert.equal(await api.createCloudChatModelLimitsClient(async()=>Response.json({setting:null}),safe).get(41,"model/a"),null);
});
test("invalid pairs never write, response ownership is strict and conflicts contain no upstream diagnostic",async()=>{
 const api=load();let calls=0;const client=api.createCloudChatModelLimitsClient(async()=>{calls++;return Response.json({setting:setting()});},safe);
 for(const input of [{mode:"custom",context_window:0,max_output_tokens:0},{mode:"custom",context_window:1024,max_output_tokens:1024},{mode:"platform",context_window:0,max_output_tokens:128},{mode:"invented",context_window:64000,max_output_tokens:8000}])await assert.rejects(client.save(41,"model/a",{expected_version:0,...input}));assert.equal(calls,0);
 for(const invalid of [{provider_key_id:42},{model:"other"},{mode:"unknown"},{version:0},{context_window:1023}])await assert.rejects(api.createCloudChatModelLimitsClient(async()=>Response.json({setting:setting(invalid)}),safe).get(41,"model/a"));
 const conflict=api.createCloudChatModelLimitsClient(async()=>Response.json({reason:"cloud_model_limits_changed",error:"private model key"},{status:409}),safe);await assert.rejects(conflict.save(41,"model/a",{expected_version:1,mode:"platform",context_window:0,max_output_tokens:0}),cause=>cause.status===409&&/其他页面或设备/.test(cause.message)&&!cause.message.includes("private"));
});
test("limits responses are bounded and remain tied to the account throughout streamed JSON",async()=>{
 const api=load();let owner=1,release;
 const client=api.createCloudChatModelLimitsClient(async()=>new Response(new ReadableStream({start(controller){release=()=>{owner=2;controller.enqueue(new TextEncoder().encode(JSON.stringify({setting:setting()})));controller.close();};}})),()=>{const captured=owner;return()=>{if(owner!==captured)throw new Error("Account changed");};});
 const promise=client.get(41,"model/a");await Promise.resolve();release();await assert.rejects(promise,/Account changed/);
 await assert.rejects(api.createCloudChatModelLimitsClient(async()=>new Response("x".repeat(16*1024+1)),safe).get(41,"model/a"),/过大/);
});
