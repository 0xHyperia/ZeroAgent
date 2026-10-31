import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({ rootDir: fileURLToPath(new URL("..", import.meta.url)) });
const { createCloudChatConversationsClient, createCloudConversationSearchAdapter } = loader.loadModule("src/lib/cloudChatConversations.ts");
const time = "2026-10-31T10:00:00Z";
const conversation = (id="conversation-1", extra={}) => ({id,title:"预算 [v2]",model:"test",created_at:time,updated_at:time,pinned:false,archived:false,management_version:0,...extra});
const guard = () => () => {};

test("catalog and management stay in explicit server scopes and preserve revision preconditions", async () => {
  const calls=[];
  const client=createCloudChatConversationsClient(async(path,init)=>{calls.push([path,init]);return Response.json(path.includes("/management")?{conversation:conversation("conversation-1",{pinned:true,management_version:1})}:{conversations:[conversation()],has_more:false,next_cursor:""});},guard);
  const page=await client.list({scope:"archived"}); assert.equal(page.conversations.length,1); assert.match(calls[0][0],/scope=archived/);
  const pinned=await client.manage(conversation(),{pinned:true});assert.equal(pinned.management_version,1);
  assert.deepEqual(JSON.parse(calls[1][1].body),{expected_version:0,pinned:true});assert.equal(calls[1][1].method,"PATCH");
});

test("search adapter retains multiple message anchors in one conversation and never calls device APIs", async () => {
  const paths=[];
  const client=createCloudChatConversationsClient(async path=>{paths.push(path);return Response.json({items:["m-1","m-2"].map(message_id=>({conversation:conversation(),message_id,role:"assistant",excerpt:"预算正常",match:"message",created_at:time})),has_more:true,next_cursor:"next"});},guard);
  const adapter=createCloudConversationSearchAdapter(client,()=>{});const page=await adapter.search("预算",{signal:new AbortController().signal});
  assert.deepEqual(page.items.map(item=>item.messageId),["m-1","m-2"]);assert.equal(page.items[0].matchType,"message");assert.equal(page.nextCursor,"next");
  assert.match(paths[0],/^\/api\/web-chat\/conversations\/search\?/);
});

test("exact message windows allow forward continuation without requiring the sidebar first page", async()=>{
  let path;
  const client=createCloudChatConversationsClient(async value=>{path=value;return Response.json({messages:[{id:"m-50",conversation_id:"older",role:"user",content:"anchor"},{id:"m-51",conversation_id:"older",role:"assistant",content:"next"}],anchor_id:"m-50",has_before:true,has_after:true,next_before_id:"m-50",next_after_id:"m-51"});},guard);
  const window=await client.window("older","m-50",{before:0,after:49});assert.equal(window.nextAfterId,"m-51");assert.match(path,/before=0&after=49/);
});

test("lineage distinguishes unavailable source and paginated child conversations", async()=>{
  const client=createCloudChatConversationsClient(async()=>Response.json({source:{conversation_id:"source",message_id:"message",action:"fork",title:"",available:false},children:[{conversation:conversation("child"),source_message_id:"message",action:"fork"}],has_more:false,next_cursor:""}),guard);
  const page=await client.branches("current");assert.equal(page.source.available,false);assert.equal(page.children[0].conversation.id,"child");
});

test("management conflicts and malformed responses cannot echo private response text", async()=>{
  const conflict=createCloudChatConversationsClient(async()=>new Response("private-token",{status:409}),guard);
  await assert.rejects(conflict.manage(conversation(),{archived:true}),error=>error.status===409&&!error.message.includes("private-token"));
  const bad=createCloudChatConversationsClient(async()=>new Response("private-token"),guard);
  await assert.rejects(bad.get("c"),error=>!error.message.includes("private-token"));
  const oversized=createCloudChatConversationsClient(async()=>new Response("{}",{headers:{"Content-Length":"9999999999"}}),guard);
  await assert.rejects(oversized.get("c"),/大小限制/);
});

test("account changes during body reading abort results before any old account can be rendered",async()=>{
  let account=1;
  const client=createCloudChatConversationsClient(async()=>new Response(new ReadableStream({start(controller){account=2;controller.enqueue(new TextEncoder().encode(JSON.stringify({conversation:conversation()})));controller.close();}})),()=>{const captured=account;return()=>{if(captured!==account)throw new Error("account changed");};});
  await assert.rejects(client.get("conversation-1"),/account changed/);
});

test("catalog and search reject replaying cursors and contradictory metadata",async()=>{
  const bad=createCloudChatConversationsClient(async()=>Response.json({conversations:[conversation()],has_more:true,next_cursor:"same"}),guard);
  await assert.rejects(bad.list({cursor:"same"}),/响应无效/);
  const wrong=createCloudChatConversationsClient(async()=>Response.json({conversation:conversation("other")}),guard);
  await assert.rejects(wrong.get("conversation-1"),/响应无效/);
});
