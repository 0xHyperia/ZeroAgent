import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const conversation = "83000000-0000-4000-8000-000000000001";
const firstId = "83000000-0000-4000-8000-000000000002";
const secondId = "83000000-0000-4000-8000-000000000003";
const at = "2026-10-31T01:00:00Z";
const pending = (id = firstId) => ({ client_item_id: id, content: "original message", model: "test-model", model_parameters: {}, presentation: "work", version: "1", created_at: at, updated_at: at });
const run = (id = firstId, state = "running") => ({ id, conversation_id: conversation, client_request_id: id, model: "test-model", state, user_message_id: firstId, assistant_message_id: secondId, output: "", last_seq: "1" });
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a,b) => { resolve=a; reject=b; });
  return {promise, resolve, reject};
};
function fixture(items = [pending()], host = {}) {
  const loader = createTsModuleLoader({ rootDir });
  const { CloudChatQueueController } = loader.loadModule("src/lib/cloudChatQueueController.ts");
  const errors = loader.loadModule("src/lib/cloudChatQueue.ts");
  let queue = { conversation_id: conversation, version: "1", items: structuredClone(items) };
  const calls = [], accepted = [];
  const client = {
    async list() { calls.push(["list"]); return structuredClone(queue); },
    async enqueue(cid, version, item) {
      calls.push(["enqueue",cid,version,item]);
      queue = {...queue,version:String(BigInt(queue.version)+1n),items:[...queue.items,{...structuredClone(item),version:"1",created_at:at,updated_at:at}]};
      return structuredClone(queue);
    },
    async edit(cid,id,version,item) {
      calls.push(["edit",cid,id,version,item]);
      queue={...queue,version:String(BigInt(queue.version)+1n),items:queue.items.map(entry=>entry.client_item_id===id?{...item,version:String(BigInt(version)+1n),created_at:at,updated_at:at}:entry)};
      return structuredClone(queue);
    },
    async remove(cid,id,version) {
      calls.push(["remove",cid,id,version]);
      queue={...queue,version:String(BigInt(queue.version)+1n),items:queue.items.filter(entry=>entry.client_item_id!==id)};
      return structuredClone(queue);
    },
    async reorder(cid,version,ids) {
      calls.push(["reorder",cid,version,ids]);
      queue={...queue,version:String(BigInt(queue.version)+1n),items:ids.map(id=>queue.items.find(item=>item.client_item_id===id))};
      return structuredClone(queue);
    },
    async submit(cid,id,version) {
      calls.push(["submit",cid,id,version]);
      queue={...queue,version:String(BigInt(queue.version)+1n),items:queue.items.filter(item=>item.client_item_id!==id)};
      return run(id);
    },
    async findSubmitted(cid,id) { calls.push(["find",cid,id]); return undefined; },
  };
  const controller = new CloudChatQueueController(conversation,client,{onAccepted:(value,item)=>accepted.push([value,item]),...host});
  return {controller,client,calls,accepted,errors,setQueue:value=>{queue=structuredClone(value);}};
}

test("initial load, refresh and returning never dispatch pending items", async()=>{
  const f=fixture(); f.controller.activate(); await flush();
  assert.equal(f.controller.getSnapshot().paused,true);
  assert.deepEqual(f.calls.map(c=>c[0]),["list"]);
  await f.controller.refresh(); f.controller.suspend(); f.controller.activate(); await flush();
  assert.ok(f.calls.every(c=>c[0]==="list"));
  assert.equal(f.controller.getSnapshot().paused,true);
});

test("an externally removed uncertain edit keeps editor ownership until explicit cancellation restores the ordinary draft",async()=>{
 const ordinary={composer:null,files:[],artifacts:[],presentation:"work",researchEnabled:false},restored=[];
 const f=fixture([pending()],{captureDraft:()=>ordinary,onEdit:()=>{},restoreDraft:value=>restored.push(value)});
 f.controller.activate();await flush();await f.controller.beginEdit(firstId);
 f.client.edit=async()=>{throw new Error("receipt unavailable");};
 await f.controller.saveEdit({...pending(),content:"unsaved edited text"});
 f.setQueue({conversation_id:conversation,version:"2",items:[]});
 await f.controller.reconcileUnknown();
 assert.equal(f.controller.getSnapshot().editingItem.client_item_id,firstId);
 assert.match(f.controller.getSnapshot().error,/已在其他页面移除/);assert.equal(restored.length,0);
 await f.controller.cancelEdit();assert.deepEqual(restored,[ordinary]);assert.equal(f.controller.getSnapshot().editingItem,null);
 assert.equal(f.calls.some(call=>call[0]==="submit"),false);
});

test("explicit continuation sends one item and waits for normal completion", async()=>{
  const f=fixture([pending(),pending(secondId)]); f.controller.activate(); await flush();
  await f.controller.resume(); await flush();
  assert.equal(f.calls.filter(c=>c[0]==="submit").length,1);
  assert.equal(f.accepted[0][1].content,"original message");
  f.controller.setRuntime(null,false); await flush();
  assert.equal(f.calls.filter(c=>c[0]==="submit").length,1);
  f.controller.setRuntime(run(firstId,"completed"),false); await flush();
  assert.equal(f.calls.filter(c=>c[0]==="submit").length,2);
  assert.equal(f.calls.filter(c=>c[0]==="submit")[1][2],secondId);
});

test("history attachment finishes before a completed run can advance the queue", async()=>{
  const attach=deferred();
  const f=fixture([pending(),pending(secondId)],{onAccepted:()=>attach.promise});
  f.controller.activate(); await flush(); await f.controller.resume(); await flush();
  f.controller.setRuntime(run(firstId,"completed"),false); await flush();
  assert.equal(f.calls.filter(c=>c[0]==="submit").length,1);
  assert.equal(f.controller.getSnapshot().busy,true);
  attach.resolve(); await flush();
  assert.equal(f.calls.filter(c=>c[0]==="submit").length,2);
});

test("failed cancelled interrupted states pause while keeping remaining items", async()=>{
  for(const state of ["failed","cancelled","interrupted"]){
    const f=fixture([pending(),pending(secondId)]); f.controller.activate(); await flush();
    await f.controller.resume(); await flush();
    f.controller.setRuntime(run(firstId,state),false); await flush();
    assert.equal(f.controller.getSnapshot().paused,true);
    assert.equal(f.controller.getSnapshot().queue.items.length,1);
    assert.equal(f.calls.filter(c=>c[0]==="submit").length,1);
  }
});

test("run now cannot interrupt active runs or bypass unresolved host state", async()=>{
  const f=fixture(); f.controller.activate(); await flush(); f.controller.setRuntime(run(secondId),false);
  assert.equal(await f.controller.runNow(firstId),false);
  f.controller.setRuntime(null,true); assert.equal(await f.controller.runNow(firstId),false);
  assert.ok(f.calls.every(c=>c[0]==="list"));
});

test("unknown submit retains identity and explicit reconciliation only reads", async()=>{
  const f=fixture();
  f.client.submit=async(cid,id)=>{f.calls.push(["submit",cid,id]);throw new f.errors.CloudChatPendingSubmitUnknownError(cid,id);};
  f.controller.activate(); await flush(); await f.controller.resume(); await flush();
  assert.equal(f.controller.getSnapshot().unknown.kind,"submit");
  assert.equal(f.controller.getSnapshot().paused,true);
  await f.controller.resume(); await f.controller.runNow(firstId); await f.controller.reconcileUnknown();
  assert.equal(f.calls.filter(c=>c[0]==="submit").length,1);
  assert.equal(f.calls.filter(c=>c[0]==="find").length,1);
  assert.ok(f.controller.getSnapshot().unknown);
  f.client.findSubmitted=async()=>run(); await f.controller.reconcileUnknown();
  assert.equal(f.controller.getSnapshot().unknown,null);
  assert.equal(f.accepted[0][1].client_item_id,firstId);
  assert.equal(f.controller.getSnapshot().paused,true);
});

test("unknown enqueue is acknowledged only after its original snapshot is observed", async()=>{
  const f=fixture([]); f.client.enqueue=async()=>{throw new TypeError("lost response");};
  f.controller.activate(); await flush(); assert.equal(await f.controller.enqueue(pending()),false);
  assert.equal(f.controller.getSnapshot().unknown.kind,"enqueue");
  await f.controller.reconcileUnknown(); assert.ok(f.controller.getSnapshot().unknown);
  f.setQueue({conversation_id:conversation,version:"1",items:[pending()]});
  const result=await f.controller.reconcileUnknown(); assert.equal(result.client_item_id,firstId);
  assert.equal(f.controller.getSnapshot().paused,true);
  assert.ok(!f.calls.some(c=>c[0]==="submit"));
});

test("a changed queued item does not acknowledge the retained original composer", async()=>{
  const f=fixture([]); f.client.enqueue=async()=>{throw new TypeError("lost response");};
  f.controller.activate(); await flush(); await f.controller.enqueue(pending());
  f.setQueue({conversation_id:conversation,version:"2",items:[{...pending(),version:"2",content:"changed elsewhere"}]});
  assert.equal(await f.controller.reconcileUnknown(),null);
  assert.match(f.controller.getSnapshot().error,/草稿/);
  assert.equal(f.controller.getSnapshot().unknown,null);
});

test("editing pauses dispatch, uses item CAS and restores the previous draft", async()=>{
  const restored=[], edits=[], draft={composer:null,files:[],artifacts:[],presentation:"chat",researchEnabled:true};
  const f=fixture([pending()],{captureDraft:()=>draft,restoreDraft:value=>restored.push(value),onEdit:item=>edits.push(item)});
  f.controller.activate(); await flush(); assert.equal(await f.controller.beginEdit(firstId),true);
  assert.equal(f.controller.getSnapshot().paused,true); assert.equal(await f.controller.resume(),false);
  assert.equal(await f.controller.saveEdit({...pending(),content:"edited"}),true);
  assert.equal(f.calls.find(c=>c[0]==="edit")[3],"1");
  assert.equal(f.controller.getSnapshot().queue.items[0].content,"edited");
  assert.equal(f.controller.getSnapshot().editingItem,null); assert.deepEqual(restored,[draft]); assert.equal(edits.length,1);
});

test("navigation or pause during enqueue wins over a late successful receipt", async()=>{
  for(const stop of [c=>c.suspend(),c=>c.pause(),c=>c.setRuntime(run(secondId,"cancelled"),false)]){
    const wait=deferred(); const f=fixture([]); f.client.enqueue=()=>wait.promise;
    f.controller.activate(); await flush();
    const request=f.controller.enqueue(pending()); stop(f.controller);
    wait.resolve({conversation_id:conversation,version:"1",items:[pending()]}); await request; await flush();
    assert.equal(f.controller.getSnapshot().paused,true);
    assert.equal(f.controller.getSnapshot().queue.items.length,1);
    assert.ok(!f.calls.some(c=>c[0]==="submit"));
  }
});

test("reorder and removal use stored versions and remain inert", async()=>{
  const f=fixture([pending(),pending(secondId)]); f.controller.activate(); await flush();
  await f.controller.moveUp(secondId);
  assert.deepEqual(f.calls.find(c=>c[0]==="reorder").slice(2),["1",[secondId,firstId]]);
  await f.controller.remove(firstId); assert.equal(f.calls.find(c=>c[0]==="remove")[3],"1");
  assert.equal(f.controller.getSnapshot().queue.items[0].client_item_id,secondId);
  assert.ok(!f.calls.some(c=>c[0]==="submit"));
});

test("a late queue-edit resource read cannot claim the ordinary composer after navigation", async()=>{
  const wait=deferred(),draft={composer:null,files:[],artifacts:[],presentation:"chat",researchEnabled:false};
  const f=fixture([pending()],{captureDraft:()=>draft,onEdit:()=>wait.promise});
  f.controller.activate();await flush();
  const editing=f.controller.beginEdit(firstId);
  f.controller.suspend();f.controller.activate();
  wait.resolve();assert.equal(await editing,false);
  assert.equal(f.controller.getSnapshot().editingItem,null);
  assert.equal(await f.controller.saveEdit({...pending(),content:"ordinary draft"}),false);
  assert.ok(!f.calls.some(call=>call[0]==="edit"));
  assert.equal(f.controller.getSnapshot().paused,true);
});

test("saving an edited queue item away from its conversation restores the ordinary draft on return", async()=>{
  const wait=deferred(),restored=[],draft={composer:null,files:[],artifacts:[],presentation:"chat",researchEnabled:true};
  const f=fixture([pending()],{captureDraft:()=>draft,onEdit:()=>{},restoreDraft:value=>restored.push(value)});
  f.controller.activate();await flush();await f.controller.beginEdit(firstId);
  f.client.edit=()=>wait.promise;
  const save=f.controller.saveEdit({...pending(),content:"edited pending"});
  f.controller.suspend();
  wait.resolve({conversation_id:conversation,version:"2",items:[{...pending(),version:"2",content:"edited pending"}]});
  assert.equal(await save,true);assert.equal(restored.length,0);
  f.controller.activate();await flush();
  assert.deepEqual(restored,[draft]);assert.equal(f.controller.getSnapshot().editingItem,null);
  assert.equal(f.controller.getSnapshot().paused,true);
  assert.ok(!f.calls.some(call=>call[0]==="submit"));
});
