import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const ID="11111111-1111-4111-8111-111111111111";
const item=(overrides={})=>({id:ID,target_id:ID,kind:"file",name:"计划.md",folder_id:"",starred:false,trashed:false,version:0,created_at:"2026-10-30T00:00:00Z",updated_at:"2026-10-30T00:00:00Z",mime:"text/markdown",size:20,state:"ready",conversation_id:"",versions:0,...overrides});
const home={category:"all",scope:"all",folder:""};
const usage={used_bytes:20,limit_bytes:512*1024*1024,file_bytes:20,artifact_bytes:0,file_limit_bytes:256*1024*1024,artifact_limit_bytes:256*1024*1024,file_count:1,artifact_version_count:0,trash_bytes:0};
const page=(items=[item()])=>({items,total:items.length,next_offset:-1,usage,folders:[],pinned:[]});
const load=()=>createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudSpace.ts");
const safe=()=>()=>{};

test("space client sends full account search and metadata CAS without copying originals",async()=>{
 const api=load(),calls=[];
 const client=api.createCloudSpaceClient(async(path,init)=>{calls.push({path,init});return Response.json(init.method?{...item(),version:1}:page());},safe);
 await client.list({...home,category:"images"},"quarterly report","name",50);
 assert.match(calls[0].path,/category=images/);assert.match(calls[0].path,/q=quarterly\+report/);assert.match(calls[0].path,/offset=50/);
 await client.update(item(),{starred:true,trashed:true});
 assert.deepEqual(JSON.parse(calls[1].init.body),{name:"计划.md",folder_id:"",starred:true,trashed:true,version:0});
 assert.equal(calls[1].init.credentials,"include");assert.doesNotMatch(calls[1].init.body,/sha256|object_key|content/);
});
test("space requests retain account guards through delayed body parsing",async()=>{
 const api=load();let owner=1,release;
 const client=api.createCloudSpaceClient(async()=>new Response(new ReadableStream({start(controller){release=()=>{owner=2;controller.enqueue(new TextEncoder().encode(JSON.stringify(page())));controller.close();};}})),()=>{const at=owner;return()=>{if(at!==owner)throw new Error("Account changed");};});
 const pending=client.list();await Promise.resolve();release();await assert.rejects(pending,/Account changed/);
});
test("unknown metadata saves never automatically retry and malformed pages are rejected",async()=>{
 const api=load();let calls=0;
 const client=api.createCloudSpaceClient(async()=>{calls++;throw new Error("network disconnected");},safe);
 await assert.rejects(client.update(item(),{starred:true}),api.CloudSpaceSaveUnconfirmedError);assert.equal(calls,1);
 const bad=api.createCloudSpaceClient(async()=>Response.json({...page(),items:[item({id:"../../other"})]}),safe);
 await assert.rejects(bad.list(),/无效/);
});
test("account uploads omit a conversation and preserve the original file bytes",async()=>{
 const api=createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudChatFiles.ts");let sent;
 const client=api.createCloudChatFilesClient(async(_path,init)=>{sent=init;return Response.json({file:{...item(),id:ID,conversation_id:"",sha256:"0".repeat(64),state:"ready",text_bytes:5,version:1}});},safe);
 await client.upload(new File(["hello"],"notes.md"));
 assert.equal(sent.body.has("conversation_id"),false);assert.equal(await sent.body.get("file").text(),"hello");
});

async function mount(t,overrides={}){
 const env=await createWebDomTestEnv({mocks:{"@liveagent/ui/components/IconSet":new Proxy({},{get:()=>()=>null})}});
 window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
 const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
 const calls={references:[],uploads:[],navigations:[]};let owner=1;
 const captureGuard=()=>{const at=owner;return()=>{if(at!==owner)throw new Error("Account changed");};};
 const {CloudSpacePage}=env.loadModule("src/components/cloudchat/CloudSpacePage.tsx");
 let props={client:{list:async()=>page(),update:async()=>{}},files:{upload:async(file,conversation)=>{calls.uploads.push({file,conversation});return {...item(),id:ID};}},artifacts:{},location:home,onNavigate:location=>calls.navigations.push(location),onOpen(){},onReference:async items=>calls.references.push(items),canReference:true,captureGuard,onChanged(){},onError(){},...overrides};
 const flush=async()=>env.act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});
 await env.act(async()=>root.render(env.React.createElement(CloudSpacePage,props)));await flush();
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 return {env,calls,flush,retire(){owner++;},async update(next){props={...props,...next};await env.act(async()=>root.render(env.React.createElement(CloudSpacePage,props)));await flush();},async click(label){const button=[...document.querySelectorAll("button")].find(el=>el.textContent.trim()===label||el.getAttribute("aria-label")===label);assert.ok(button,label);await env.act(async()=>button.click());await flush();}};
}
test("space selection references real items only after an explicit action",async t=>{
 const app=await mount(t);
 assert.equal(app.calls.references.length,0);assert.match(document.body.textContent,/计划.md/);
 const checkbox=document.querySelector('input[aria-label="选择 计划.md"]');await app.env.act(async()=>checkbox.click());
 await app.click("在对话中使用");assert.equal(app.calls.references.length,1);assert.equal(app.calls.references[0][0].id,ID);
 await app.click("网格视图");assert.equal(document.querySelector('.cloud-space-results').dataset.view,"grid");
});
test("space pagination keeps existing rows and an account change blocks late results",async t=>{
 let release,calls=0;
 const app=await mount(t,{client:{list:async()=>{calls++;if(calls===1)return {...page(),next_offset:50,total:2};return new Promise(resolve=>{release=resolve;});},update:async()=>{}}});
 await app.click("加载更多");assert.match(document.body.textContent,/计划.md/);
 app.retire();await app.env.act(async()=>{release(page([item({id:"22222222-2222-4222-8222-222222222222",name:"retired-private.md"})]));});await app.flush();
 assert.doesNotMatch(document.body.textContent,/retired-private/);
});
test("space upload uses the library scope and never creates or references a conversation",async t=>{
 const app=await mount(t);const input=document.querySelector('input[type="file"]');
 const file=new window.File(["sample"],"资料.md");Object.defineProperty(input,"files",{configurable:true,value:[file]});
 await app.env.act(async()=>input.dispatchEvent(new window.Event("change",{bubbles:true})));await app.flush();
 assert.equal(app.calls.uploads.length,1);assert.equal(app.calls.uploads[0].conversation,"");assert.equal(app.calls.references.length,0);
});

test("an unconfirmed upload blocks repeated writes until an explicit refresh succeeds",async t=>{
 const app=await mount(t);let writes=0;
 const {CloudFileUploadUnconfirmedError}=app.env.loadModule("src/lib/cloudChatFiles.ts");
 await app.update({files:{upload:async()=>{writes++;throw new CloudFileUploadUnconfirmedError();}}});
 const input=document.querySelector('input[type="file"]');
 Object.defineProperty(input,"files",{configurable:true,value:[new window.File(["sample"],"资料.md")]});
 const change=()=>input.dispatchEvent(new window.Event("change",{bubbles:true}));
 await app.env.act(async()=>change());await app.flush();
 assert.match(document.body.textContent,/尚未确认/);
 await app.env.act(async()=>change());await app.flush();assert.equal(writes,1);
 assert.equal(document.querySelector('.cloud-space-heading-actions button').disabled,true);
 await app.click("刷新核对");
 assert.equal(document.querySelector('.cloud-space-heading-actions button').disabled,false);
});
