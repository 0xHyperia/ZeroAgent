import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({ rootDir: fileURLToPath(new URL("..", import.meta.url)) });
const { createCloudChatSavedDraftsClient, parseCloudChatSavedDraft, cloudSavedDraftEqual, CloudSavedDraftError, CloudSavedDraftUnconfirmedError } = loader.loadModule("src/lib/cloudChatSavedDrafts.ts");
const { CloudSavedDraftController } = loader.loadModule("src/lib/cloudChatSavedDraftController.ts");
const id = n => `92000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const draft = (text="") => ({version:1,draft:{composer:{text,textWithoutLargePastes:text,isEmpty:!text,segments:text?[{type:"text",text}]:[],largePastes:[],skillMentions:[],appMentions:[],commitMentions:[],gitFileMentions:[],conversationMentions:[],codeMentions:[]},files:[],artifacts:[],presentation:"work",researchEnabled:false},modelSelection:{model:"test",reasoningEffort:"medium"}});
const snapshot=(scope="blank",value=null,version="0",extra={})=>({scope,draft:value,version,...extra});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const setup=(client,more={})=>{
  const applied=[];let operation=0;
  const controller=new CloudSavedDraftController({client,isOwnerCurrent:()=>true,apply:(value,scope)=>applied.push({value,scope}),operationId:()=>id(++operation),debounceMs:100_000,...more});
  return{controller,applied};
};
const accepted=(scope,value,op,version="1")=>snapshot(scope,value,version,{last_operation_id:op.client_operation_id,applied_version:version});

test("JSONB object field ordering is not a draft conflict",()=>{
  const original=draft("same content");
  const reordered=JSON.parse(JSON.stringify(original,(_key,value)=>value&&typeof value==="object"&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value));
  assert.equal(cloudSavedDraftEqual(original,reordered),true);
});

test("draft refresh is read-only and scoped to the blank editor, without creating a conversation",async()=>{
  const calls=[];
  const client=createCloudChatSavedDraftsClient(async(path,init)=>{calls.push([path,init.method]);return Response.json(snapshot("blank",draft("恢复草稿"),"9007199254740993"));},()=>()=>{});
  const {controller,applied}=setup(client);
  try{await controller.activate("",draft());assert.equal(applied[0].value.draft.composer.text,"恢复草稿");assert.deepEqual(calls,[["/api/web-chat/drafts/blank","GET"]]);assert.equal(controller.getState().status,"ready");}
  finally{controller.dispose();}
});

test("a late GET cannot replace text typed while loading; existing remote draft becomes an explicit conflict",async()=>{
  const read=deferred();const {controller,applied}=setup({get:()=>read.promise});
  try{const active=controller.activate("blank",draft());controller.markDirty(draft("刚输入"));read.resolve(snapshot("blank",draft("其他设备"),"3"));await active;assert.equal(applied.length,0);assert.equal(controller.getState().status,"conflict");await controller.resolveConflict("use-server");assert.equal(applied[0].value.draft.composer.text,"其他设备");}
  finally{controller.dispose();}
});

test("switching conversations flushes the captured old editor and does not apply old results to the new editor",async()=>{
  const saving=deferred();const puts=[];
  const {controller,applied}=setup({get:async scope=>snapshot(scope),put:async(scope,value,op)=>{puts.push([scope,value,op]);await saving.promise;return accepted(scope,value,op);}});
  try{await controller.activate("blank",draft());controller.markDirty(draft("旧会话草稿"));await controller.activate(id(9),draft());assert.equal(puts.length,1);assert.equal(puts[0][0],"blank");saving.resolve();await controller.flush("blank");assert.equal(controller.getState().scope,id(9));assert.equal(applied.length,0);}
  finally{controller.dispose();}
});

test("unknown PUT retries the exact same operation and body, then saves later local edits separately",async()=>{
  const puts=[];let attempt=0;
  const {controller}=setup({get:async scope=>snapshot(scope),put:async(scope,value,op)=>{puts.push(structuredClone({value,op}));if(++attempt===1)throw new CloudSavedDraftUnconfirmedError();return accepted(scope,value,op,attempt===2?"1":"2");}});
  try{await controller.activate("blank",draft());controller.markDirty(draft("第一次"));await controller.flush();assert.equal(controller.getState().status,"unknown");controller.markDirty(draft("继续输入"));await controller.retry();await controller.flush();assert.deepEqual(puts[1],puts[0]);assert.notEqual(puts[2].op.client_operation_id,puts[0].op.client_operation_id);assert.equal(puts[2].value.draft.composer.text,"继续输入");assert.equal(controller.getState().status,"ready");}
  finally{controller.dispose();}
});

test("a superseded replay receipt retains the local editor and requires a conflict decision",async()=>{
  let attempt=0;
  const {controller,applied}=setup({get:async scope=>snapshot(scope),put:async(scope,value,op)=>{if(++attempt===1)throw new CloudSavedDraftUnconfirmedError();return snapshot(scope,draft("远端更新"),"3",{applied_version:"1",last_operation_id:id(88),replayed:true});}});
  try{await controller.activate("blank",draft());controller.markDirty(draft("本地内容"));await controller.flush();await controller.retry();assert.equal(controller.getState().status,"conflict");assert.equal(applied.length,0);assert.equal(controller.getState().conflict.server.version,"3");}
  finally{controller.dispose();}
});

test("CAS conflict keeps local input until keep-local explicitly saves using the newly read version",async()=>{
  let reads=0;const puts=[];
  const {controller}=setup({get:async scope=>snapshot(scope,reads++?draft("远端"):null,reads===1?"0":"4"),put:async(scope,value,op)=>{puts.push(op);if(puts.length===1)throw new CloudSavedDraftError(409);return accepted(scope,value,op,"5");}});
  try{await controller.activate("blank",draft());controller.markDirty(draft("本地"));await controller.flush();assert.equal(controller.getState().status,"conflict");assert.equal(puts.length,1);await controller.resolveConflict("keep-local");assert.equal(puts[1].expected_version,"4");assert.notEqual(puts[1].client_operation_id,puts[0].client_operation_id);}
  finally{controller.dispose();}
});

test("send completion never deletes a newer unsent editor and matching deletion uses a tombstone receipt",async()=>{
  let removes=0;
  const {controller}=setup({get:async scope=>snapshot(scope),put:async(scope,value,op)=>accepted(scope,value,op),remove:async(scope,op)=>{removes++;return accepted(scope,null,op,"2");}});
  try{await controller.activate("blank",draft());const sent=draft("已发送");controller.markDirty(sent);await controller.flush();controller.markDirty(draft("下一条"));assert.equal(await controller.clearIfUnchanged(sent),false);assert.equal(removes,0);await controller.clearIfUnchanged(draft("下一条"));assert.equal(removes,1);assert.equal(controller.getState().status,"ready");}
  finally{controller.dispose();}
});

test("owner invalidation fences late reads and cancels future synchronization",async()=>{
  let owner=1;const read=deferred();const {controller,applied}=setup({get:()=>read.promise},{isOwnerCurrent:()=>owner===1});
  try{const active=controller.activate("blank",draft());owner=2;read.resolve(snapshot("blank",draft("旧账户"),"1"));await active;controller.markDirty(draft("新账户"));assert.equal(await controller.flush(),false);assert.equal(applied.length,0);}
  finally{controller.dispose();}
});

test("snapshot allowlists resource metadata and model settings, excluding transient URLs and credentials",()=>{
  const item=draft("附件");item.modelSelection.apiKey="secret";
  item.draft.artifacts=[{id:id(1),family_id:id(2),conversation_id:id(3),source_run_id:id(4),name:"报告.txt",mime:"text/plain",size:4,sha256:"a".repeat(64),number:1,version:1,state:"ready",created_at:"2026-10-31T10:00:00Z",updated_at:"2026-10-31T10:00:00Z",download_url:"https://private.example/token"}];
  const value=parseCloudChatSavedDraft(item);assert.equal(value.modelSelection.apiKey,undefined);assert.equal(value.draft.artifacts[0].download_url,undefined);assert.equal(value.draft.artifacts[0].id,id(1));
});

test("transport errors and malformed accepted writes remain unconfirmed without echoing response data",async()=>{
  const client=createCloudChatSavedDraftsClient(async()=>new Response("secret-token"),()=>()=>{});
  await assert.rejects(client.put("blank",draft("test"),{expected_version:"9007199254740993",client_operation_id:id(1)}),error=>error instanceof CloudSavedDraftUnconfirmedError&&!error.message.includes("secret-token"));
  const invalid=createCloudChatSavedDraftsClient(async()=>Response.json(snapshot("blank",null,"01")),()=>()=>{});
  await assert.rejects(invalid.get("blank"));
});

test("explicit New conversation clears only blank scope, never restores its old content, and uses CAS deletion",async()=>{
  const calls=[];
  const {controller,applied}=setup({get:async scope=>{calls.push(["get",scope]);return snapshot(scope,scope==="blank"?draft("旧空白页草稿"):null,scope==="blank"?"8":"0");},remove:async(scope,op)=>{calls.push(["delete",scope,op.expected_version]);return accepted(scope,null,op,"9");}});
  try{await controller.activate(id(42),draft());const reset=controller.resetBlank();await controller.activate("blank",draft());await reset;assert.deepEqual(calls,[["get",id(42)],["get","blank"],["delete","blank","8"]]);assert.equal(applied.some(item=>item.value?.draft.composer.text==="旧空白页草稿"),false);assert.equal(controller.getState().status,"ready");}
  finally{controller.dispose();}
});

test('project New seeds only the blank draft and survives delayed canonical restoration',async()=>{
 const stored=[];const seed=draft();seed.draft.projectId=id(22);
 const {controller,applied}=setup({get:async scope=>snapshot(scope),put:async(scope,value,op)=>{stored.push({scope,value});return accepted(scope,value,op);}});
 try{
  await controller.activate(id(9),draft("旧会话草稿"));
  const reset=controller.resetBlank(seed);
  await controller.activate("blank",seed);
  await reset;
  assert.equal(applied.at(-1).value.draft.projectId,id(22));
  assert.equal(stored.find(item=>item.scope==='blank').value.draft.projectId,id(22));
  assert.ok(stored.filter(item=>item.scope===id(9)).every(item=>item.value.draft.composer.text==='旧会话草稿'));
  await controller.activate(id(9));assert.equal(applied.at(-1).value.draft.composer.text,"旧会话草稿");
 }finally{controller.dispose();}
});
