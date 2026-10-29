import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
const load=()=>createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudChatMetadata.ts");
const record=(id,overrides={})=>({id,title:`会话 ${id}`,model:"test-model",updated_at:"2026-10-29T00:00:00Z",...overrides});
const head=(overrides={})=>({id:"run-a",conversation_id:"a",client_request_id:"client-a",model:"test-model",state:"interrupted",user_message_id:"user-a",assistant_message_id:"assistant-a",last_seq:"9007199254740993",error_code:"cloud_cancellation_outcome_unknown",...overrides});
const guard=()=>()=>{};
test("metadata pages project known fields, validate opaque cursors and merge duplicate IDs across moving pages",async()=>{
 const api=load(),calls=[];const client=api.createCloudChatMetadataClient(async(path,init)=>{calls.push({path,init});const hasMore=!path.includes("cursor=");return Response.json({conversations:[record("a",{messages:["private body"]})],has_more:hasMore,next_cursor:hasMore?"opaque+cursor/=":""});},guard);
 const page=await client.listConversations();assert.equal(page.conversations[0].messages,undefined);assert.equal(page.nextCursor,"opaque+cursor/=");assert.equal(calls[0].init.credentials,"include");
 await client.listConversations({cursor:page.nextCursor});assert.match(calls[1].path,/cursor=opaque%2Bcursor%2F%3D/);
 assert.deepEqual(api.mergeCloudChatConversations([record("a"),record("b")],[record("a",{title:"new"}),record("c")]).map(item=>item.id),["c","b","a"]);
 const duplicates=api.createCloudChatMetadataClient(async()=>Response.json({conversations:[record("a"),record("a")],has_more:false,next_cursor:""}),guard);await assert.rejects(duplicates.listConversations(),/重复/);
 const stuck=api.createCloudChatMetadataClient(async()=>Response.json({conversations:[],has_more:true,next_cursor:"again"}),guard);await assert.rejects(stuck.listConversations({cursor:"again"}),/分页响应/);
});
test("precise turn recovery reads only a bounded projected head with no output or request and validates turn ownership",async()=>{
 const api=load(),calls=[];const client=api.createCloudChatMetadataClient(async(path)=>{calls.push(path);return Response.json({runs:[head({output:"must not survive projection",public_research:{topic:"private"}})],output_included:false});},guard);
 const result=await client.findTurnRun("a","user-a");assert.equal(result.last_seq,"9007199254740993");assert.equal(result.output,undefined);assert.equal(result.public_research,undefined);assert.match(calls[0],/user_message_id=user-a/);assert.doesNotMatch(calls[0],/active=|client_request_id=/);
 for(const response of [{runs:[head({user_message_id:"other"})],output_included:false},{runs:[head(),head()],output_included:false},{runs:[head()],output_included:true},{runs:[head({state:"unknown"})],output_included:false}])await assert.rejects(api.createCloudChatMetadataClient(async()=>Response.json(response),guard).findTurnRun("a","user-a"),/摘要/);
 assert.equal(await api.createCloudChatMetadataClient(async()=>Response.json({runs:[],output_included:false}),guard).findTurnRun("a","user-a"),null);
});
test("metadata readers enforce streamed byte budgets and retain the captured account guard until JSON completes",async()=>{
 const api=load();let owner=1,release;
 const client=api.createCloudChatMetadataClient(async()=>new Response(new ReadableStream({start(controller){release=()=>{owner=2;controller.enqueue(new TextEncoder().encode(JSON.stringify({conversations:[],has_more:false,next_cursor:""})));controller.close();};}})),()=>{const account=owner;return()=>{if(owner!==account)throw new Error("Account changed");};});
 const pending=client.listConversations();await Promise.resolve();release();await assert.rejects(pending,/Account changed/);
 const huge=api.createCloudChatMetadataClient(async()=>new Response("x".repeat(16*1024+1)),guard);await assert.rejects(huge.findTurnRun("a","user-a"),/过大/);
 const failed=api.createCloudChatMetadataClient(async()=>Response.json({error:"private secret"},{status:503}),guard);await assert.rejects(failed.listConversations(),cause=>cause.status===503&&!cause.message.includes("private"));
});
