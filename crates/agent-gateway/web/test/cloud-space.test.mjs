import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const ID="11111111-1111-4111-8111-111111111111";
const item=(overrides={})=>({id:ID,target_id:ID,kind:"file",name:"计划.md",folder_id:"",starred:false,trashed:false,version:0,created_at:"2026-10-30T00:00:00Z",updated_at:"2026-10-30T00:00:00Z",mime:"text/markdown",size:20,state:"ready",conversation_id:"",versions:0,...overrides});
const home={category:"all",scope:"all",folder:""};
const usage={used_bytes:20,limit_bytes:512*1024*1024,file_bytes:20,artifact_bytes:0,file_limit_bytes:256*1024*1024,artifact_limit_bytes:256*1024*1024,file_count:1,artifact_version_count:0,trash_bytes:0,file_limit_count:500,artifact_limit_count:500};
const page=(items=[item()])=>({items,total:items.length,next_offset:-1,next_cursor:"",usage,folders:[],pinned:[]});
const load=()=>createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudSpace.ts");
const safe=()=>()=>{};

test("site category preserves canonical artifact and preview version bindings and rejects forged file flags",async()=>{
 const api=load(),seen=[];
 const site=item({kind:"artifact",mime:"application/zip",site_version_id:"22222222-2222-4222-8222-222222222222",versions:2});
 const client=api.createCloudSpaceClient(async path=>{seen.push(path);return Response.json(page([site]));},safe);
 const result=await client.list({...home,category:"sites"});
 assert.match(seen[0],/category=sites/);assert.equal(result.items[0].site_version_id,site.site_version_id);
 assert.equal(result.items[0].target_id,ID);assert.equal(api.cloudSpaceTitle({...home,category:"sites"}),"站点");
 for(const invalid of [item({site_version_id:site.site_version_id}),{...site,site_version_id:"unbound"}]){
  const bad=api.createCloudSpaceClient(async()=>Response.json(page([invalid])),safe);
  await assert.rejects(()=>bad.list(),/响应无效/);
 }
});

test("space client sends full account search and metadata CAS without copying originals",async()=>{
 const api=load(),calls=[];
 const client=api.createCloudSpaceClient(async(path,init)=>{calls.push({path,init});return Response.json(init.method?{...item(),version:1}:page());},safe);
 await client.list({...home,category:"images"},"quarterly report","name","owner_query_cursor");
 assert.match(calls[0].path,/category=images/);assert.match(calls[0].path,/q=quarterly\+report/);assert.match(calls[0].path,/cursor=owner_query_cursor/);assert.doesNotMatch(calls[0].path,/offset=/);
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
 const observers=[];
 const previousObserver=globalThis.IntersectionObserver;
 globalThis.IntersectionObserver=class {
  constructor(callback,options){this.callback=callback;this.options=options;this.targets=new Set();observers.push(this);}
  observe(target){this.targets.add(target);}
  disconnect(){this.targets.clear();}
 };
 const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
 const calls={references:[],uploads:[],navigations:[]};let owner=1;
 const captureGuard=()=>{const at=owner;return()=>{if(at!==owner)throw new Error("Account changed");};};
 const {CloudSpacePage}=env.loadModule("src/components/cloudchat/CloudSpacePage.tsx");
 let props={client:{list:async()=>page(),update:async()=>{}},files:{upload:async(file,conversation)=>{calls.uploads.push({file,conversation});return {...item(),id:ID};}},artifacts:{},location:home,onNavigate:location=>calls.navigations.push(location),onOpen(){},onReference:async items=>calls.references.push(items),canReference:true,captureGuard,onChanged(){},onError(){},...overrides};
 const flush=async()=>env.act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});
 await env.act(async()=>root.render(env.React.createElement(CloudSpacePage,props)));await flush();
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();if(previousObserver)globalThis.IntersectionObserver=previousObserver;else delete globalThis.IntersectionObserver;});
 return {env,calls,flush,observers,retire(){owner++;},async nearEnd(){await env.act(async()=>{for(const observer of [...observers])for(const target of [...observer.targets])if(target.classList.contains("cloud-space-load-sentinel"))observer.callback([{target,isIntersecting:true}]);});await flush();},async update(next){props={...props,...next};await env.act(async()=>root.render(env.React.createElement(CloudSpacePage,props)));await flush();},async click(label){const button=[...document.querySelectorAll("button")].find(el=>el.textContent.trim()===label||el.getAttribute("aria-label")===label);assert.ok(button,label);await env.act(async()=>button.click());await flush();}};
}
test("space selection references real items only after an explicit action",async t=>{
 const app=await mount(t);
 assert.equal(app.calls.references.length,0);assert.match(document.body.textContent,/计划.md/);
 const checkbox=document.querySelector('input[aria-label="选择 计划.md"]');await app.env.act(async()=>checkbox.click());
 await app.click("在对话中使用");assert.equal(app.calls.references.length,1);assert.equal(app.calls.references[0][0].id,ID);
 await app.click("网格视图");assert.equal(document.querySelector('.cloud-space-results').dataset.view,"grid");
});
test("grid separates folders without remounting resources or losing selection and folder navigation",async t=>{
 const folder=item({id:"22222222-2222-4222-8222-222222222222",target_id:"22222222-2222-4222-8222-222222222222",kind:"folder",name:"项目资料",mime:"",size:0});
 const app=await mount(t,{client:{list:async()=>page([item(),folder]),update:async()=>{}}});
 const row=document.querySelector('.cloud-space-item'),cover=row.querySelector('.cloud-space-cover');
 await app.env.act(async()=>document.querySelector('input[aria-label="选择 计划.md"]').click());
 await app.click("网格视图");
 assert.deepEqual([...document.querySelectorAll('.cloud-space-grid-section h2')].map(el=>el.textContent),["文件夹","文件"]);
 const rows=[...document.querySelectorAll('.cloud-space-item')];
 assert.equal(rows[0].dataset.folder,"true");assert.equal(rows[1],row);assert.equal(row.querySelector('.cloud-space-cover'),cover);
 assert.equal(document.querySelector('input[aria-label="选择 计划.md"]').checked,true);
 await app.click("打开 项目资料");assert.equal(app.calls.navigations.at(-1).folder,folder.id);
 await app.click("列表视图");assert.equal(document.querySelector('.cloud-space-grid-section'),null);
 assert.equal(document.querySelector('.cloud-space-item'),row);assert.equal(row.querySelector('.cloud-space-cover'),cover);
});
test("space pagination keeps existing rows and an account change blocks late results",async t=>{
 let release,calls=0;
 const app=await mount(t,{client:{list:async()=>{calls++;if(calls===1)return {...page(),next_offset:50,next_cursor:"next_page",total:2};return new Promise(resolve=>{release=resolve;});},update:async()=>{}}});
 await app.nearEnd();assert.match(document.body.textContent,/计划.md/);
 app.retire();await app.env.act(async()=>{release(page([item({id:"22222222-2222-4222-8222-222222222222",name:"retired-private.md"})]));});await app.flush();
 assert.doesNotMatch(document.body.textContent,/retired-private/);
});
test("space scroll pagination keeps row nodes, adds tail skeletons and requests each cursor once",async t=>{
 let release;const cursors=[];
 const app=await mount(t,{client:{list:async(_location,_query,_sort,cursor)=>{cursors.push(cursor);if(!cursor)return {...page(),total:2,next_cursor:"page_two"};return new Promise(resolve=>{release=resolve;});},update:async()=>{}}});
 const row=document.querySelector('.cloud-space-item-list > li');
 const observer=app.observers.findLast(value=>[...value.targets].some(target=>target.classList.contains("cloud-space-load-sentinel")));
 assert.equal(observer.options.rootMargin,"0px 0px 200px 0px");
 await app.nearEnd();await app.nearEnd();
 assert.deepEqual(cursors,["","page_two"]);
 assert.equal(document.querySelector('.cloud-space-item-list > li'),row);
 assert.ok(document.querySelector('.cloud-space-skeleton[data-append]'));
 assert.equal(document.querySelector('.cloud-space-item-main').disabled,false);
 await app.env.act(async()=>release(page([item({id:"22222222-2222-4222-8222-222222222222",name:"第二页.md"})])));await app.flush();await app.nearEnd();
 assert.equal(document.querySelectorAll('.cloud-space-item-list > li').length,2);
 assert.equal(document.querySelector('.cloud-space-item-list > li'),row);
 assert.equal(document.querySelector('.cloud-space-skeleton'),null);
 assert.equal(document.querySelector('.cloud-space-footer'),null);
 assert.equal([...document.querySelectorAll("button")].some(el=>el.textContent.trim()==="加载更多"),false);
 assert.deepEqual(cursors,["","page_two"]);
});
test("hidden and replaced result scopes disconnect stale scroll observers",async t=>{
 const calls=[];
 const app=await mount(t,{client:{list:async(location,_query,_sort,cursor)=>{calls.push([location.scope,cursor]);return {...page(),next_cursor:"next_page"};},update:async()=>{}}});
 const observer=app.observers.findLast(value=>[...value.targets].some(target=>target.classList.contains("cloud-space-load-sentinel")));
 await app.update({active:false});await app.nearEnd();
 await app.env.act(async()=>observer.callback([{isIntersecting:true}]));await app.flush();
 assert.deepEqual(calls,[["all",""]]);
 await app.update({active:true,location:{...home,scope:"starred"}});
 await app.env.act(async()=>observer.callback([{isIntersecting:true}]));await app.flush();
 assert.deepEqual(calls,[["all",""],["starred",""]]);
});
test("initial list and grid use skeletons without announcing an empty library",async t=>{
 let release;const app=await mount(t,{client:{list:async()=>new Promise(resolve=>{release=resolve;}),update:async()=>{}}});
 assert.equal(document.querySelectorAll('.cloud-space-skeleton > div').length,10);
 assert.equal(document.querySelector('.cloud-space-empty'),null);
 assert.equal(document.querySelector('.cloud-space-results').getAttribute('aria-busy'),"true");
 await app.click("网格视图");assert.equal(document.querySelector('.cloud-space-results').dataset.view,"grid");
 assert.ok(document.querySelector('.cloud-space-skeleton'));
 await app.env.act(async()=>release(page()));await app.flush();
 assert.equal(document.querySelector('.cloud-space-skeleton'),null);
 assert.match(document.querySelector('.cloud-space-item-list').textContent,/计划.md/);
});
test("space upload uses the library scope and never creates or references a conversation",async t=>{
 const app=await mount(t);const input=document.querySelector('input[type="file"]');
 const file=new window.File(["sample"],"资料.md");Object.defineProperty(input,"files",{configurable:true,value:[file]});
 await app.env.act(async()=>input.dispatchEvent(new window.Event("change",{bubbles:true})));await app.flush();
 assert.equal(app.calls.uploads.length,1);assert.equal(app.calls.uploads[0].conversation,"");assert.equal(app.calls.references.length,0);
});

test("changed library pages retain visible rows and require an explicit first-page refresh",async t=>{
 const cursors=[];let calls=0;
 const app=await mount(t,{client:{list:async(_location,_query,_sort,cursor)=>{cursors.push(cursor);calls++;if(calls===1)return {...page(),next_offset:50,next_cursor:"generation_cursor",total:2};if(calls===2)throw new Error("资料已更新，请刷新列表后继续浏览。");return page([item({name:"刷新后的资料.md"})]);},update:async()=>{}}});
 await app.nearEnd();
 assert.match(document.body.textContent,/资料已更新/);assert.match(document.body.textContent,/计划.md/);
 assert.equal([...document.querySelectorAll("button")].some(el=>el.textContent.trim()==="加载更多"),false);
 assert.equal(calls,2);
 await app.click("刷新核对");
 assert.deepEqual(cursors,["","generation_cursor",""]);assert.match(document.body.textContent,/刷新后的资料/);
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
 assert.equal(document.querySelector('.cloud-space-upload').disabled,true);
 await app.click("刷新核对");
 assert.equal(document.querySelector('.cloud-space-upload').disabled,false);
});

test("bulk selection only includes loaded rows and stays selected when switching views",async t=>{
 const second=item({id:"22222222-2222-4222-8222-222222222222",name:"资料二.md"});
 const app=await mount(t,{client:{list:async()=>({...page([item(),second]),total:75,next_cursor:"next_page"}),update:async()=>{}}});
 assert.match(document.querySelector('.cloud-space-results-status').textContent,/已显示 2 \/ 75 项/);
 const all=document.querySelector('input[aria-label="全选已加载资料"]');
 await app.env.act(async()=>all.click());
 await app.click("网格视图");
 assert.equal(document.querySelectorAll('.cloud-space-item-list input:checked').length,2);
 await app.click("在对话中使用");
 assert.deepEqual(app.calls.references[0].map(value=>value.id),[ID,second.id]);
 await app.click("取消选择");
 assert.equal(document.querySelectorAll('.cloud-space-item-list input:checked').length,0);
});

test("refresh preserves known rows, announces progress and resumes actions after the new page",async t=>{
 let release,calls=0;
 const app=await mount(t,{client:{list:async()=>++calls===1?page():new Promise(resolve=>{release=resolve;}),update:async()=>{}}});
 await app.click("刷新资料");
 assert.match(document.querySelector('.cloud-space-results-status').textContent,/正在更新/);
 assert.match(document.querySelector('.cloud-space-item-list').textContent,/计划.md/);
 assert.equal(document.querySelector('.cloud-space-item-main').disabled,true);
 await app.env.act(async()=>release(page([item({name:"更新后的资料.md"})])));await app.flush();
 assert.match(document.querySelector('.cloud-space-item-list').textContent,/更新后的资料/);
 assert.equal(document.querySelector('.cloud-space-item-main').disabled,false);
});

test("empty folder and empty outputs give the next step without pretending an upload creates an output",async t=>{
 const app=await mount(t,{client:{list:async()=>page([]),update:async()=>{}},location:{...home,folder:ID}});
 assert.match(document.querySelector('.cloud-space-empty').textContent,/这个文件夹还是空的/);
 assert.match(document.querySelector('.cloud-space-empty').textContent,/移动到这个文件夹/);
 await app.update({location:{...home,category:"outputs"}});
 assert.match(document.querySelector('.cloud-space-empty').textContent,/正式保存的成果/);
 assert.doesNotMatch(document.querySelector('.cloud-space-empty').textContent,/上传资料/);
 await app.click("查看全部资料");assert.deepEqual(app.calls.navigations.at(-1),home);
});

test("loading an empty result does not announce the library is empty or offer a misleading empty action",async t=>{
 let release;
 const app=await mount(t,{client:{list:async()=>page([]),update:async()=>{}}});
 await app.update({client:{list:async()=>new Promise(resolve=>{release=resolve;}),update:async()=>{}}});
 assert.equal(document.querySelector('.cloud-space-empty'),null);
 assert.ok(document.querySelector('.cloud-space-skeleton'));
 assert.match(document.querySelector('.cloud-space-results-status').textContent,/正在更新/);
 await app.env.act(async()=>release(page([])));await app.flush();
 assert.match(document.querySelector('.cloud-space-empty').textContent,/从一份资料开始/);
});

test("trash is not shown as the all filter and storage explains the independent limits",async t=>{
 const app=await mount(t,{location:{...home,scope:"trash"}});
 assert.equal(document.querySelector('.cloud-space-scopes [aria-pressed="true"]'),null);
 await app.update({storageOpen:true,onStorageOpenChange(){}});
 const dialog=document.querySelector('[role="dialog"]');
 assert.match(dialog.textContent,/各有独立限额/);
 assert.match(dialog.textContent,/已计入上方用量/);
 assert.match(dialog.textContent,/每个版本分别计数/);
});


function spaceTransfer(types=["Files"],files=[]){const values=new Map();return {types,files,items:[],setData(type,value){values.set(type,value);if(!this.types.includes(type))this.types.push(type);},getData(type){return values.get(type)??"";}};}
async function spaceDrag(app,type,data,target=document.querySelector('[data-file-drop-boundary]')){const event=new window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:data});await app.env.act(async()=>target.dispatchEvent(event));return event;}

test("space drops show the destination, keep library ownership and expose canonical identity-only drag sources",async t=>{
 const folder=item({kind:"folder",id:"22222222-2222-4222-8222-222222222222",target_id:"22222222-2222-4222-8222-222222222222",name:"研究资料"}),moves=[];
 const app=await mount(t,{location:{...home,folder:folder.id},client:{list:async()=>({...page(),folders:[folder]}),update:async(target,changes)=>moves.push({target,changes})}});
 const file=new File(["hello"],"notes.md"),data=spaceTransfer(["Files"],[file]);
 await spaceDrag(app,"dragenter",data);assert.match(document.body.textContent,/松开上传到“研究资料”/);assert.match(document.body.textContent,/不会自动发送/);
 await spaceDrag(app,"drop",data);await app.flush();assert.equal(app.calls.uploads[0].conversation,"");assert.equal(moves[0].changes.folder_id,folder.id);assert.equal(app.calls.references.length,0);
 const source=document.querySelector('.cloud-space-item-main'),identity=spaceTransfer([]);await spaceDrag(app,"dragstart",identity,source);
 const api=app.env.loadModule("src/lib/cloudResourceDrag.ts");assert.deepEqual(api.readCloudResourceDragPayload(identity),[{kind:"file",id:ID,target_id:ID}]);
 assert.doesNotMatch(identity.getData(api.CLOUD_RESOURCE_DRAG_MIME),/计划|name|content|url/);
 const event=await spaceDrag(app,"drop",identity);assert.equal(event.defaultPrevented,false);assert.equal(app.calls.uploads.length,1);
 // A title in the sibling reader can expose the same target, without belonging to the list DOM.
 const sibling=document.body.appendChild(document.createElement("div"));await spaceDrag(app,"dragstart",identity,sibling);
 const target=document.querySelector('.cloud-space-reference-drop');assert.ok(target);
 await spaceDrag(app,"drop",identity,target);await app.flush();assert.equal(app.calls.references.length,1);
 assert.deepEqual(app.calls.references[0],[{kind:"file",id:ID,target_id:ID}]);sibling.remove();
});

test("space upload claims a mutation synchronously and rejects a busy drop instead of silently losing it",async t=>{
 let release,writes=0;const app=await mount(t,{files:{upload:async()=>{writes++;await new Promise(resolve=>{release=resolve;});return {...item(),id:ID};}}});
 const data=spaceTransfer(["Files"],[new File(["hello"],"notes.md")]),target=document.querySelector('[data-file-drop-boundary]');
 await app.env.act(async()=>{for(let index=0;index<2;index++){const event=new window.Event("drop",{bubbles:true,cancelable:true});Object.defineProperty(event,"dataTransfer",{value:data});target.dispatchEvent(event);}});
 assert.equal(writes,1);assert.match(document.body.textContent,/等待当前操作完成/);await app.env.act(async()=>release());await app.flush();
 await app.update({active:false});const ignored=await spaceDrag(app,"drop",data);assert.equal(ignored.defaultPrevented,false);assert.equal(writes,1);
});


test("combinable type, origin and folder filters are sent together with scoped pagination", async () => {
 const api=load(),paths=[];
 const client=api.createCloudSpaceClient(async path=>{paths.push(path);return Response.json(page());},safe);
 await client.list({...home,category:"recent",type:"document",origin:"uploads",folder:ID},"计划","name","filter_cursor");
 const query=new URL(paths[0],"http://localhost").searchParams;
 assert.equal(query.get("category"),"recent");assert.equal(query.get("type"),"document");assert.equal(query.get("origin"),"uploads");assert.equal(query.get("folder"),ID);assert.equal(query.get("cursor"),"filter_cursor");
 await client.list(home);
 assert.equal(new URL(paths[1],"http://localhost").searchParams.has("type"),false);
});

test("the sidebar folder action opens an in-place dialog without changing existing items", async t => {
 const app=await mount(t,{newFolderRequest:0});
 await app.update({newFolderRequest:1});
 assert.match(document.querySelector('[role="dialog"]').textContent,/新建文件夹/);
 assert.match(document.querySelector('.cloud-space-item-list').textContent,/计划.md/);
 assert.equal(app.calls.navigations.length,0);
});
