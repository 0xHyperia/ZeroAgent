import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
const load=()=>createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudChatHistory.ts");
const safe=()=>()=>undefined;
const message=(id,content="body",more={})=>({id,role:"user",content,...more});
test("history pages retain ascending stable IDs and omitted bodies are fetched only on explicit request",async()=>{
 const api=load(),calls=[],omitted=message("m-2",null,{content_omitted:true,content_bytes:4000000,content_sha256:"a".repeat(64)});
 const client=api.createCloudChatHistoryClient(async(path,init)=>{calls.push({path,init});return path.includes("/messages/")?Response.json({message:message("m-2","original",{content_omitted:false})}):path.includes("before_id=")?Response.json({messages:[message("m-1")],next_before_id:"",has_more:false}):Response.json({messages:[omitted,message("m-3")],next_before_id:"m-2",has_more:true});},safe);
 const page=await client.list("conversation-1");assert.equal(page.nextBeforeId,"m-2");assert.equal(page.messages[0].content,null);assert.equal(calls.length,1);
 await client.list("conversation-1",{beforeId:"m-2",limit:2});assert.match(calls.at(-1).path,/limit=2&before_id=m-2/);
 const full=await client.get("conversation-1","m-2");assert.equal(full.content,"original");assert.equal(calls.at(-1).path,"/api/web-chat/conversations/conversation-1/messages/m-2");assert.equal(calls.at(-1).init.credentials,"include");
});
test("history rejects contradictory omission, cursor, scope and oversized-body responses",async()=>{
 const api=load();
 for(const data of [{messages:[message("m",null,{content_omitted:true})],next_before_id:"",has_more:false},{messages:[message("m")],next_before_id:"wrong",has_more:true},{messages:[message("m","body",{conversation_id:"other"})],next_before_id:"",has_more:false},{messages:[message("m"),message("m")],next_before_id:"",has_more:false}]){
   const client=api.createCloudChatHistoryClient(async()=>Response.json(data),safe);await assert.rejects(client.list("conversation-1"));
 }
 const big=api.createCloudChatHistoryClient(async()=>new Response("x",{headers:{"Content-Length":String(33*1024*1024)}}),safe);await assert.rejects(big.get("conversation-1","m"),/大小限制/);
 const rejected=api.createCloudChatHistoryClient(async()=>Response.json({error:"private body"},{status:413}),safe);await assert.rejects(rejected.get("conversation-1","m"),cause=>cause.status===413&&!cause.message.includes("private"));
});
test("history parsing stays attached to its original account/view throughout the response body",async()=>{
 const api=load();let owner=1,release;const capture=()=>{const prior=owner;return()=>{if(owner!==prior)throw new Error("Account changed");};};
 const client=api.createCloudChatHistoryClient(async()=>new Response(new ReadableStream({start(controller){release=()=>{owner++;controller.enqueue(new TextEncoder().encode(JSON.stringify({messages:[message("m")],next_before_id:"",has_more:false})));controller.close();};}})),capture);
 const pending=client.list("conversation-1");await Promise.resolve();release();await assert.rejects(pending,/Account changed/);
});
test("older pages and terminal refreshes merge by canonical ID without erasing expanded content or duplicating streaming rows",()=>{
 const api=load(),live=[message("m-2","explicit full"),message("m-3","partial",{role:"assistant"})];
 const older=api.mergeCloudChatHistory(live,[message("m-1"),message("m-2","stale")],true);assert.deepEqual(older.map(item=>item.id),["m-1","m-2","m-3"]);assert.equal(older[1].content,"explicit full");
 const terminal=api.mergeCloudChatHistory(older,[message("m-2",null,{content_omitted:true}),message("m-3","final",{role:"assistant"})]);assert.equal(terminal[1].content,"explicit full");assert.equal(terminal[2].content,"final");assert.equal(terminal.length,3);
});
