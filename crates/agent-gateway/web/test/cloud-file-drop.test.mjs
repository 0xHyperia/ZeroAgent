import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const ID="11111111-1111-4111-8111-111111111111",VERSION="22222222-2222-4222-8222-222222222222";
function transfer(types=["Files"],files=[],items=[]){const values=new Map();return {types,files,items,dropEffect:"none",setData(type,value){values.set(type,value);if(!this.types.includes(type))this.types.push(type);},getData(type){return values.get(type)??"";}};}
async function mount(t,overrides={}){
 const env=await createWebDomTestEnv({mocks:{"@liveagent/ui/components/IconSet":new Proxy({},{get:()=>()=>null})}});
 const {FileDropBoundary}=env.loadModule("../../agent-ui/src/components/files/FileDropBoundary.tsx");
 const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host),calls={files:[],resources:[],rejections:[]};
 let props={"aria-label":"drop target",fileLabel:"松开添加到当前草稿",resourceLabel:"松开引用资料",hint:"不会自动发送",resourceMime:"application/x-zeroagent-cloud-resource+json",onFiles:(files,directories)=>calls.files.push({files,directories}),onResources:value=>calls.resources.push(value),onRejected:value=>calls.rejections.push(value),...overrides};
 async function render(){await env.act(async()=>root.render(env.React.createElement(FileDropBoundary,props,env.React.createElement("div",{"data-child":""},"content"))));}
 await render();t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 return {env,host,calls,async update(next){props={...props,...next};await render();},async drag(type,data,target=host.querySelector("section"),relatedTarget=null,point={x:300,y:200}){const event=new window.Event(type,{bubbles:true,cancelable:true});Object.defineProperties(event,{dataTransfer:{value:data},relatedTarget:{value:relatedTarget},clientX:{value:point.x},clientY:{value:point.y}});await env.act(async()=>target.dispatchEvent(event));return event;}};
}

test("file target handles nested entry, exit and global cancellation without intercepting text or existing drags",async t=>{
 const app=await mount(t),data=transfer(),section=app.host.querySelector("section"),child=app.host.querySelector("[data-child]");
 assert.equal((await app.drag("dragenter",data)).defaultPrevented,true);
 await app.drag("dragenter",data,child);await app.drag("dragleave",data,child,section);
 assert.match(app.host.textContent,/松开添加到当前草稿/);
 await app.drag("dragleave",data,section,document.body);assert.equal(app.host.querySelector('[role="status"]'),null);
 for(const clear of [()=>window.dispatchEvent(new window.KeyboardEvent("keydown",{key:"Escape"})),()=>window.dispatchEvent(new window.Event("blur")),()=>document.body.dispatchEvent(new window.Event("drop",{bubbles:true}))]){
  await app.drag("dragenter",data);await app.env.act(async()=>clear());assert.equal(app.host.querySelector('[role="status"]'),null);
 }
 for(const types of [["text/plain"],["text/uri-list"],["application/x-liveagent-workspace-path+json","Files"],["application/x-liveagent-conversation-reference+json"]]){
  const event=await app.drag("drop",transfer(types));assert.equal(event.defaultPrevented,false);assert.equal(app.host.querySelector('[role="status"]'),null);
 }
 assert.equal(app.calls.files.length,0);
});

test("blocked and hidden targets preserve callbacks while an enabled drop distinguishes directories and resource identities",async t=>{
 const app=await mount(t,{disabledReason:"正在上传，请稍候"}),data=transfer();
 await app.drag("dragover",data);assert.equal(data.dropEffect,"none");assert.match(app.host.textContent,/正在上传/);
 await app.drag("drop",data);assert.deepEqual(app.calls.rejections,["正在上传，请稍候"]);assert.equal(app.calls.files.length,0);
 await app.update({disabledReason:undefined});
 const file=new File(["hello"],"notes.md");
 await app.drag("drop",transfer(["Files"],[file],[{kind:"file",webkitGetAsEntry:()=>({isDirectory:true})},{kind:"file",getAsFile:()=>file}]));
 assert.equal(app.calls.files[0].directories,1);assert.deepEqual(app.calls.files[0].files,[file]);
 const resource=transfer(["application/x-zeroagent-cloud-resource+json"]);await app.drag("drop",resource);assert.equal(app.calls.resources[0],resource);
 await app.drag("dragenter",data);await app.update({active:false});assert.equal(app.host.querySelector('[role="status"]'),null);
 assert.equal((await app.drag("drop",data)).defaultPrevented,false);assert.equal(app.calls.files.length,1);
});

test("cloud resource drag serializes only bounded identities and rejects corrupt or oversized batches",async t=>{
 const env=await createWebDomTestEnv();t.after(()=>env.cleanup());
 const api=env.loadModule("src/lib/cloudResourceDrag.ts"),data=transfer([]);
 assert.equal(api.writeCloudResourceDragPayload(data,[{kind:"artifact",id:ID,target_id:VERSION,name:"private title",url:"https://private.test",credential:"secret"}]),true);
 const raw=data.getData(api.CLOUD_RESOURCE_DRAG_MIME);assert.doesNotMatch(raw,/private|secret|url|name/);assert.equal(data.effectAllowed,"copy");
 assert.deepEqual(api.readCloudResourceDragPayload(data),[{kind:"artifact",id:ID,target_id:VERSION}]);
 api.writeCloudResourceDragPayload(data,[{kind:"file",id:ID,target_id:ID},{kind:"file",id:ID,target_id:ID}]);assert.equal(api.readCloudResourceDragPayload(data).length,1);
 assert.equal(api.writeCloudResourceDragPayload(transfer([]),Array(9).fill({kind:"file",id:ID,target_id:ID})),false);
 for(const value of [{version:2,items:[]},{version:1,items:[{kind:"file",id:"../x",target_id:ID}]},{version:1,items:[{kind:"file",id:ID,target_id:ID,site_version_id:VERSION}]}]){data.setData(api.CLOUD_RESOURCE_DRAG_MIME,JSON.stringify(value));assert.equal(api.readCloudResourceDragPayload(data),null);}
});

test("viewport coverage is portalled above the whole application and retires with its owning view",async t=>{
 const app=await mount(t,{coverage:"viewport"});
 await app.drag("dragenter",transfer());
 const overlay=document.querySelector('[data-coverage="viewport"]');
 assert.ok(overlay);assert.equal(app.host.contains(overlay),false);assert.equal(overlay.parentElement,document.body);
 // The body portal replaces the native target. Leave can precede enter and have
 // a null relatedTarget even though the pointer remains inside the viewport.
 await app.drag("dragleave",transfer(),app.host.querySelector("section"));
 assert.equal(document.querySelector('[data-coverage="viewport"]'),overlay);
 await app.drag("dragenter",transfer(),overlay);
 await app.drag("dragleave",transfer(),overlay,null,{x:0,y:200});
 assert.equal(document.querySelector('[data-coverage="viewport"]'),overlay,"portal target swaps can report zero coordinates");
 await app.drag("dragleave",transfer(),document.documentElement,null,{x:0,y:200});
 assert.equal(document.querySelector('[data-coverage="viewport"]'),null);
 await app.drag("dragenter",transfer());
 const dropTarget=document.querySelector('[data-coverage="viewport"]');
 const file=new File(["preview-only"],"sample.txt");await app.drag("drop",transfer(["Files"],[file]),dropTarget);assert.equal(app.calls.files.length,1);
 await app.drag("dragenter",transfer());
 await app.update({active:false});assert.equal(document.querySelector('[data-coverage="viewport"]'),null);
 assert.equal((await app.drag("drop",transfer())).defaultPrevented,false);assert.equal(app.calls.files.length,1);
});

test("viewport capture accepts an external file over a non-React surface exactly once",async t=>{
 const app=await mount(t,{coverage:"viewport"}),outside=document.body.appendChild(document.createElement("div"));
 t.after(()=>outside.remove());
 const file=new File(["not sent"],"drop.md"),data=transfer(["Files"],[file]);
 await app.drag("dragenter",data,outside);
 assert.ok(document.querySelector('[data-coverage="viewport"]'));
 assert.equal((await app.drag("dragover",data,outside)).defaultPrevented,true);
 const drop=await app.drag("drop",data,outside);
 assert.equal(drop.defaultPrevented,true);
 assert.deepEqual(app.calls.files,[{files:[file],directories:0}]);
 assert.equal(document.querySelector('[data-coverage="viewport"]'),null);
});

test("upload preflight keeps valid originals and explains rejected size, type, directory and count",async t=>{
 const env=await createWebDomTestEnv();t.after(()=>env.cleanup());const {prepareCloudFileBatch}=env.loadModule("src/lib/cloudFileDrop.ts");
 const valid=new File(["hello"],"notes.md"),oversized=new File([],"large.pdf");Object.defineProperty(oversized,"size",{value:33*1024*1024});
 const result=prepareCloudFileBatch([new File([],"not-supported.exe"),oversized,valid,new File(["hi"],"second.txt")],1,1);
 assert.deepEqual(result.files,[valid]);assert.match(result.message,/文件夹/);assert.match(result.message,/格式/);assert.match(result.message,/32 MiB/);assert.match(result.message,/尚未上传/);
});
