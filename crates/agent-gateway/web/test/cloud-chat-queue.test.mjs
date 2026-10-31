import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const load = () => createTsModuleLoader({rootDir}).loadModule("src/lib/cloudChatQueue.ts");
const conversation = "83000000-0000-4000-8000-000000000001";
const itemId = "83000000-0000-4000-8000-000000000002";
const secondId = "83000000-0000-4000-8000-000000000003";
const at = "2026-10-31T01:00:00Z";
const composer = {segments:[{type:"largePaste",paste:{id:"paste-a",label:"Pasted",text:"full contents",preview:"full",charCount:13,lineCount:1}}],text:"full contents",textWithoutLargePastes:"",largePastes:[],skillMentions:[],appMentions:[],commitMentions:[],gitFileMentions:[],codeMentions:[],isEmpty:false};
composer.largePastes = [structuredClone(composer.segments[0].paste)];
const item = {client_item_id:itemId,content:[{type:"text",text:"next"},{type:"file_reference",file_id:secondId}],model:"test-model",reasoning_effort:"high",model_parameters:{},presentation:"work",composer,version:"1",created_at:at,updated_at:at};
const queue = {conversation_id:conversation,version:"1",items:[item]};
const run = {id:secondId,conversation_id:conversation,client_request_id:itemId,model:"test-model",state:"queued",user_message_id:"83000000-0000-4000-8000-000000000004",assistant_message_id:"83000000-0000-4000-8000-000000000005",output:"",last_seq:"1"};
const response = value => new Response(JSON.stringify(value),{headers:{"Content-Type":"application/json"}});

test("local preflight rejection never becomes an unknown write or reaches the network", async()=>{
  const api=load();let requests=0;
  const client=api.createCloudChatQueueClient(async()=>{requests++;return response({queue});},()=>()=>{});
  for(const operation of [
    ()=>client.enqueue(conversation,"0",{...item,composer:{...composer,segments:[{type:"invalid"}]}}),
    ()=>client.edit(conversation,itemId,"1",{...item,model:""}),
    ()=>client.reorder(conversation,"1",[itemId,itemId]),
    ()=>client.remove(conversation,"invalid-id","1"),
    ()=>client.submit(conversation,itemId,"invalid-version"),
  ])await assert.rejects(async()=>operation(),error=>error instanceof api.CloudChatQueueError&&error.status===400);
  await assert.rejects(async()=>client.enqueue(conversation,"0",{...item,composer:{...composer,text:"x".repeat(1024*1024)}}),error=>error instanceof api.CloudChatQueueError&&error.status===413);
  assert.equal(requests,0);
});

test("pending snapshot preserves structured composer references and exact decimal CAS",()=>{
  const api=load();const result=api.parseCloudChatPendingQueue({...queue,version:"9007199254740993"},conversation);
  assert.equal(result.version,"9007199254740993");assert.deepEqual(result.items[0].composer,composer);assert.deepEqual(result.items[0].content,item.content);
  result.items[0].composer.segments[0].paste.text="edited";assert.equal(composer.segments[0].paste.text,"full contents");
  for(const invalid of [{...queue,version:1},{...queue,version:"9223372036854775808"},{...queue,items:[item,item]},{...queue,conversation_id:secondId},{...queue,items:[{...item,composer:{...composer,segments:[{type:"fileMention",reference:null}]}}]}])assert.throws(()=>api.parseCloudChatPendingQueue(invalid,conversation));
});

test("list and mutations never submit or call execution implicitly",async()=>{
  const api=load(),requests=[];const client=api.createCloudChatQueueClient(async(path,init)=>{requests.push([path,init]);return response({queue});},()=>()=>{});
  await client.list(conversation);await client.enqueue(conversation,"0",item);await client.edit(conversation,itemId,"1",item);await client.reorder(conversation,"1",[itemId]);await client.remove(conversation,itemId,"1");
  assert.deepEqual(requests.map(([,i])=>i.method),[undefined,"POST","PATCH","POST","DELETE"]);
  assert.ok(requests.every(([p])=>!p.includes("submit")&&!p.includes("/runs")));
  assert.deepEqual(JSON.parse(requests[3][1].body),{expected_version:"1",item_ids:[itemId]});
  assert.ok(requests.every(([,i])=>i.credentials==="include"));
});

test("explicit submit sends only stable item identity and CAS; unknown receipt is queried without resending",async()=>{
  const api=load(),requests=[];const client=api.createCloudChatQueueClient(async(path,init)=>{
    requests.push([path,init]);if(init.method==="POST")throw new Error("lost receipt");return response({runs:[run]});
  },()=>()=>{});
  await assert.rejects(client.submit(conversation,itemId,"1"),error=>error instanceof api.CloudChatPendingSubmitUnknownError&&error.clientItemId===itemId);
  const accepted=await client.findSubmitted(conversation,itemId);assert.equal(accepted.client_request_id,itemId);
  assert.equal(requests.length,2);assert.deepEqual(JSON.parse(requests[0][1].body),{expected_version:"1"});assert.equal(requests[1][1].method,undefined);
});

test("known rejection retains pending distinction while server failure and malformed success are unknown",async()=>{
  const api=load();for(const status of [400,401,404,409,413,429]){
    const client=api.createCloudChatQueueClient(async()=>new Response("",{status}),()=>()=>{});
    await assert.rejects(client.submit(conversation,itemId,"1"),error=>error instanceof api.CloudChatQueueError&&error.status===status);
  }
  for(const make of [()=>new Response("",{status:503}),()=>response({run:{...run,client_request_id:secondId}})]){
    const client=api.createCloudChatQueueClient(async()=>make(),()=>()=>{});
    await assert.rejects(client.submit(conversation,itemId,"1"),api.CloudChatPendingSubmitUnknownError);
  }
});

test("late account response and oversized streams never return private pending state",async()=>{
  const api=load();let current=true,finish;
  const client=api.createCloudChatQueueClient(()=>new Promise(resolve=>{finish=resolve;}),()=>()=>{if(!current)throw new Error("retired account");});
  const pending=client.list(conversation);current=false;finish(response({queue}));await assert.rejects(pending,/retired account/);
  let cancelled=false;
  const bounded=api.createCloudChatQueueClient(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(17*1024*1024));},cancel(){cancelled=true;}})),()=>()=>{});
  await assert.rejects(bounded.list(conversation));assert.equal(cancelled,true);
});
