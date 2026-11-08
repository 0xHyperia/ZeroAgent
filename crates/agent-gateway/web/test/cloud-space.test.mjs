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
 host.style.overflowY="auto";
 const calls={references:[],uploads:[],navigations:[]};let owner=1;
 const captureGuard=()=>{const at=owner;return()=>{if(at!==owner)throw new Error("Account changed");};};
 const {CloudSpacePage}=env.loadModule("src/components/cloudchat/CloudSpacePage.tsx");
 let props={browseOwner:1,client:{list:async()=>page(),update:async()=>{}},files:{upload:async(file,conversation)=>{calls.uploads.push({file,conversation});return {...item(),id:ID};}},artifacts:{},location:home,onNavigate:location=>calls.navigations.push(location),onOpen(){},onReference:async items=>calls.references.push(items),canReference:true,captureGuard,onChanged(){},onError(){},...overrides};
 const flush=async()=>env.act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});
 await env.act(async()=>root.render(env.React.createElement(CloudSpacePage,props)));await flush();
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();if(previousObserver)globalThis.IntersectionObserver=previousObserver;else delete globalThis.IntersectionObserver;});
 return {env,host,calls,flush,observers,retire(){owner++;},async nearEnd(){await env.act(async()=>{for(const observer of [...observers])for(const target of [...observer.targets])if(target.classList.contains("cloud-space-load-sentinel"))observer.callback([{target,isIntersecting:true}]);});await flush();},async update(next){props={...props,...next};await env.act(async()=>root.render(env.React.createElement(CloudSpacePage,props)));await flush();},async click(label){const button=[...document.querySelectorAll("button")].find(el=>el.textContent.trim()===label||el.getAttribute("aria-label")===label);assert.ok(button,label);await env.act(async()=>button.click());await flush();}};
}
test("returning to a saved library restores its search, selection and scroll after loading the matching pages",async t=>{
 const second=item({id:"22222222-2222-4222-8222-222222222222",name:"匹配资料.md"});
 const owner="https://account.example.test|user:1";
 const calls=[];
 const app=await mount(t,{browseOwner:owner,client:{list:async(location,query,sort,cursor)=>{
  calls.push([location.category,query,sort,cursor]);
  return cursor ? page([second]) : {...page(),total:2,next_cursor:"next_page"};
 },update:async()=>{}}});
 Object.defineProperties(app.host,{
  clientHeight:{value:120},
  scrollHeight:{get:()=>120*app.host.querySelectorAll(".cloud-space-item").length},
 });
 const {cloudSpaceBrowseKey,readCloudSpaceBrowseState,writeCloudSpaceBrowseState}=app.env.loadModule("src/lib/cloudSpaceBrowseState.ts");
 writeCloudSpaceBrowseState(cloudSpaceBrowseKey(owner,home),{
  query:"匹配",sort:"name",view:"grid",selected:[second.id],scrollTop:90,
 });
 await app.update({key:"reload"});
 await app.env.act(async()=>{await new Promise(resolve=>setTimeout(resolve,210));});
 await app.env.act(async()=>{await new Promise(resolve=>setTimeout(resolve,210));});
 assert.deepEqual(calls.slice(-2),[["all","匹配","name",""],["all","匹配","name","next_page"]]);
 assert.equal(document.querySelector('input[aria-label="搜索全部资料"]').value,"匹配");
 assert.equal(document.querySelector(".cloud-space-results").dataset.view,"grid");
 assert.equal(document.querySelector('input[aria-label="选择 匹配资料.md"]').checked,true);
 assert.equal(app.host.scrollTop,90);
 app.host.scrollTop=100;
 app.host.dispatchEvent(new window.Event("scroll"));
 window.dispatchEvent(new window.Event("pagehide"));
 assert.equal(readCloudSpaceBrowseState(cloudSpaceBrowseKey(owner,home),"list").scrollTop,100);
 await app.update({key:"other-account",browseOwner:"https://other.example.test|user:1"});
 assert.equal(document.querySelector('input[aria-label="搜索全部资料"]').value,"");
 assert.equal(document.querySelector(".cloud-space-results").dataset.view,"list");
 assert.equal(app.host.scrollTop,0);
 assert.doesNotMatch(document.body.textContent,/1 项已选择/);
});
test("return and list refresh retain a deep selection, even when the row moves to a later page", async (t) => {
 const second = item({ id: "22222222-2222-4222-8222-222222222222", name: "第二页.md" });
 const inserted = item({ id: "33333333-3333-4333-8333-333333333333", name: "新增资料.md" });
 const cursors = [];
 let updated = false;
 const app = await mount(t, { revision: 0, client: { async list(_location, _query, _sort, cursor) {
  cursors.push(cursor);
  if (!cursor) return { ...page(), next_cursor: updated ? "new_second" : "old_second" };
  if (cursor === "old_second") return { ...page([second]), next_cursor: "old_third" };
  if (cursor === "old_third") throw new TypeError("offline");
  if (cursor === "new_second") return { ...page([inserted]), next_cursor: "new_third" };
  return page([second]);
 } } });
 Object.defineProperties(app.host, {
  clientHeight: { value: 120 },
  scrollHeight: { get: () => 120 * app.host.querySelectorAll(".cloud-space-item").length },
 });
 await app.nearEnd();
 const selectedRow = () => app.host.querySelector('input[aria-label="选择 第二页.md"]');
 assert.ok(selectedRow());
 await app.env.act(async () => selectedRow().click());
 app.host.scrollTop = 90;
 app.host.dispatchEvent(new window.Event("scroll"));
 await app.update({ active: false });
 app.host.scrollTop = 0;
 await app.update({ active: true });
 assert.deepEqual(cursors, ["", "old_second"]);
 assert.equal(app.host.scrollTop, 90);
 assert.equal(selectedRow().checked, true);

 await app.nearEnd();
 assert.match(app.host.textContent, /暂时无法加载更多资料/);
 await app.update({ active: false });
 app.host.scrollTop = 0;
 await app.update({ active: true });
 assert.deepEqual(cursors, ["", "old_second", "old_third"]);
 assert.equal(app.host.scrollTop, 90);
 assert.equal(selectedRow().checked, true);

 updated = true;
 await app.update({ revision: 1 });
 await app.flush();
 await app.flush();
 assert.deepEqual(cursors, ["", "old_second", "old_third", "", "new_second", "new_third"]);
 assert.equal(app.host.scrollTop, 90);
 assert.equal(selectedRow().checked, true);
});

test("reader return after a reload and list retry finds the original row without batch-selecting it", async (t) => {
 const original = item({ id: "22222222-2222-4222-8222-222222222222", name: "源文件.md" });
 const inserted = item({ id: "33333333-3333-4333-8333-333333333333", name: "新增资料.md" });
 const cursors = [], opened = [];
 let status = "initial";
 const app = await mount(t, {
  onOpen: (entry) => opened.push(entry.id),
  client: { async list(_location, _query, _sort, cursor) {
   cursors.push(cursor);
   if (status === "offline") throw new TypeError("offline");
   if (!cursor) return { ...page(), next_cursor: status === "initial" ? "initial_second" : "new_second" };
   if (cursor === "new_second") return { ...page([inserted]), next_cursor: "new_third" };
   return page([original]);
  } },
 });
 const viewport = app.host;
 Object.defineProperties(viewport, {
  clientHeight: { value: 120 },
  scrollHeight: { get: () => 120 * viewport.querySelectorAll(".cloud-space-item").length },
 });
 const prototype = window.HTMLElement.prototype;
 const originalRect = prototype.getBoundingClientRect;
 prototype.getBoundingClientRect = function () {
  if (!this.classList.contains("cloud-space-item")) return originalRect.call(this);
  const index = [...viewport.querySelectorAll(".cloud-space-item")].indexOf(this);
  return { top: index * 120 - viewport.scrollTop, height: 52 };
 };
 t.after(() => { prototype.getBoundingClientRect = originalRect; });
 const originRow = () => viewport.querySelector(`[data-space-item="file:${original.id}"]`);
 const { cloudSpaceBrowseKey, readCloudSpaceBrowseState } = app.env.loadModule("src/lib/cloudSpaceBrowseState.ts");
 const saved = () => readCloudSpaceBrowseState(cloudSpaceBrowseKey(1, home), "list");

 await app.nearEnd();
 viewport.scrollTop = 90;
 await app.env.act(async () => {
  const open = originRow().querySelector(".cloud-space-item-main");
  open.click();
  open.dispatchEvent(new MouseEvent("click", {bubbles:true, detail:2}));
 });
 assert.deepEqual(opened, [original.id]);
 await app.update({ active: false });
 const origin = { id: original.id, kind: "file", offset: 30 };
 assert.deepEqual(saved().readerOrigin, origin);
 assert.deepEqual(saved().selected, []);
 // A session saved before the cover and title were unified still restores the row.
 window.sessionStorage.setItem(cloudSpaceBrowseKey(1, home), JSON.stringify({
  ...saved(), readerOrigin: { ...origin, cover: true },
 }));

 status = "offline";
 await app.update({ key: "after-reader-reload", active: false });
 await app.update({ active: true });
 assert.match(viewport.textContent, /暂时无法读取资料/);
 assert.equal(saved().readerOrigin.id, original.id);

 status = "online";
 await app.click("刷新核对");
 await app.env.waitFor(() => !saved().readerOrigin, "original reader row restored");
 assert.deepEqual(cursors.slice(-3), ["", "new_second", "new_third"]);
 assert.equal(viewport.scrollTop, 210);
 assert.equal(document.activeElement, originRow().querySelector(".cloud-space-item-main"));
 assert.deepEqual(saved().selected, []);
});

test("returning from a preview opened by the row menu restores the same closed menu trigger", async (t) => {
 const opened = [];
 const app = await mount(t, { onOpen: entry => opened.push(entry.id) });
 await app.click("计划.md的更多操作");
 const preview = () => [...document.querySelectorAll('[role="menuitem"]')]
  .find(entry => entry.textContent.trim() === "打开预览");
 await app.env.waitFor(() => preview(), "preview menu action");
 await app.env.act(async () => preview().click());
 assert.deepEqual(opened, [ID]);
 await app.update({ active:false });
 const { cloudSpaceBrowseKey, readCloudSpaceBrowseState } = app.env.loadModule("src/lib/cloudSpaceBrowseState.ts");
 const saved = () => readCloudSpaceBrowseState(cloudSpaceBrowseKey(1, home), "list");
 assert.equal(saved().readerOrigin.opener,"menu");
 await app.update({ key:"library-reload", active:true });
 const trigger = () => app.host.querySelector(".cloud-space-row-more");
 await app.env.waitFor(() => document.activeElement === trigger(), "restored More actions trigger");
 assert.equal(trigger().getAttribute("aria-expanded"), "false");
 assert.equal(document.querySelector('[role="menu"]'), null);
 assert.equal(saved().readerOrigin, undefined);
});

test("an unavailable reader row falls back to results only after the list is checked", async (t) => {
 const original = item({ id: "22222222-2222-4222-8222-222222222222", name: "原资料.md" });
 let removed = false;
 const app = await mount(t, { client: { list: async () => removed ? page() : page([original]) } });
 const { cloudSpaceBrowseKey, readCloudSpaceBrowseState } = app.env.loadModule("src/lib/cloudSpaceBrowseState.ts");
 const key = cloudSpaceBrowseKey(1, home);
 await app.click("网格视图");
 await app.click("打开 原资料.md");
 await app.update({ active: false });
 const anchor = readCloudSpaceBrowseState(key, "list").readerOrigin;
 assert.equal(anchor.id, original.id);
 assert.equal(anchor.opener, undefined);
 removed = true;
 await app.update({ key: "other-owner", browseOwner: 2, active: true });
 assert.equal(document.activeElement, document.body);
 assert.deepEqual(readCloudSpaceBrowseState(key, "list").readerOrigin, anchor);
 await app.update({ key: "original-owner", browseOwner: 1 });
 assert.equal(document.activeElement, app.host.querySelector(".cloud-space-results"));
 assert.equal(readCloudSpaceBrowseState(key, "list").readerOrigin, undefined);
});

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
test("the folder heading returns to all locations without discarding the collection, filters, or saved list", async (t) => {
 const folderId = "22222222-2222-4222-8222-222222222222";
 const folder = item({ id: folderId, target_id: folderId, kind: "folder", name: "交付资料", mime: "", size: 0 });
 const collection = { ...home, scope: "starred", type: "document", origin: "uploads" };
 const location = { ...collection, folder: folderId };
 const app = await mount(t, { location, client: { list: async () => ({ ...page(), folders: [folder] }) } });
 const { cloudSpaceBrowseKey, writeCloudSpaceBrowseState } = app.env.loadModule("src/lib/cloudSpaceBrowseState.ts");
 writeCloudSpaceBrowseState(cloudSpaceBrowseKey(1, collection), {
  query: "之前的搜索", sort: "name", view: "grid", selected: [ID], scrollTop: 100,
 });
 Object.defineProperties(app.host, { clientHeight: { value: 120 }, scrollHeight: { value: 600 } });
 const heading = app.host.querySelector("header.cloud-space-heading");
 assert.equal(heading.querySelector("h1").textContent, "交付资料");
 assert.ok(heading.querySelector('[aria-label="返回全部位置"]'));
 assert.ok(heading.querySelector('input[aria-label="搜索当前文件夹"]'));
 await app.click("返回全部位置");
 assert.deepEqual(app.calls.navigations.at(-1), collection);
 await app.update({ location: app.calls.navigations.at(-1) });
 await app.env.waitFor(() => app.host.scrollTop === 100, "previous library scroll position");
 assert.equal(app.host.querySelector('input[aria-label="搜索全部资料"]').value, "之前的搜索");
 assert.equal(app.host.querySelector('input[aria-label="选择 计划.md"]').checked, true);
 assert.equal(document.activeElement, app.host.querySelector(".cloud-space-results"));
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
 const cursors=[];let calls=0,CloudSpaceError;
 const app=await mount(t,{client:{list:async(_location,_query,_sort,cursor)=>{cursors.push(cursor);calls++;if(calls===1)return {...page(),next_offset:50,next_cursor:"generation_cursor",total:2};if(calls===2)throw new CloudSpaceError("资料已更新，请刷新列表后继续浏览。",409);return page([item({name:"刷新后的资料.md"})]);},update:async()=>{}}});
 ({CloudSpaceError}=app.env.loadModule("src/lib/cloudSpace.ts"));
 await app.nearEnd();
 assert.match(document.body.textContent,/资料已更新/);assert.match(document.body.textContent,/计划.md/);
 assert.equal([...document.querySelectorAll("button")].some(el=>el.textContent.trim()==="加载更多"),false);
 assert.equal(calls,2);
 await app.click("重新读取列表");
 assert.deepEqual(cursors,["","generation_cursor",""]);assert.match(document.body.textContent,/刷新后的资料/);
});

test("a library tail retry reuses only its failed cursor and preserves loaded rows, scroll and selection", async t => {
 const second = item({ id:"22222222-2222-4222-8222-222222222222", name:"第二页.md" });
 const third = item({ id:"33333333-3333-4333-8333-333333333333", name:"第三页.md" });
 const reads=[];
 let release, mutations=0;
 const app = await mount(t,{onChanged:()=>mutations++,client:{async list(location,query,sort,cursor) {
   reads.push([location,query,sort,cursor]);
   if (!cursor) return {...page(),total:3,next_cursor:"second"};
   if (cursor==="second") return {...page([second]),total:3,next_cursor:"third"};
   if (reads.length===3) throw new TypeError("offline");
   return new Promise(resolve=>{release=()=>resolve({...page([third]),total:3});});
 }}});
 Object.defineProperties(app.host,{
   clientHeight:{value:120},
   scrollHeight:{get:()=>120*app.host.querySelectorAll(".cloud-space-item").length},
 });
 await app.nearEnd();
 const first = app.host.querySelector('.cloud-space-item');
 const secondRow = app.host.querySelector(`[data-space-item="file:${second.id}"]`);
 await app.env.act(async()=>secondRow.querySelector('input[type="checkbox"]').click());
 app.host.scrollTop=90;
 app.host.dispatchEvent(new window.Event("scroll"));
 await app.nearEnd();
 const retry=[...app.host.querySelectorAll("button")].find(button=>button.textContent==="重试加载更多");
 assert.ok(retry.closest(".cloud-space-results [role=alert]"));
 assert.match(retry.closest("[role=alert]").textContent,/已加载的资料仍可使用/);
 assert.equal(secondRow.querySelector(".cloud-space-item-main").disabled,false);
 retry.focus();
 await app.click("重试加载更多");
 assert.equal(document.activeElement,retry);
 assert.equal(retry.getAttribute("aria-disabled"),"true");
 await app.env.act(async()=>{retry.click();release();});
 await app.flush();
 assert.deepEqual(reads.map(read=>read[3]),["","second","third","third"]);
 assert.deepEqual(reads[2],reads[3]);
 assert.equal(mutations,0);
 assert.equal(app.host.querySelector(".cloud-space-item"),first);
 assert.equal(secondRow.querySelector('input[type="checkbox"]').checked,true);
 assert.equal(app.host.scrollTop,90);
 assert.equal(document.activeElement,app.host.querySelector(`[data-space-item="file:${third.id}"] .cloud-space-item-main`));
});

test("a lost library upload response is checked by its exact ID across reload and account changes", async t => {
 const opened=[], checks=[], writes=[];
 const saved = item({id:"33333333-3333-4333-8333-333333333333",name:"资料.md",uploaded_at:"2026-10-30T00:00:00Z"});
 const folder = item({id:"22222222-2222-4222-8222-222222222222",kind:"folder",name:"原始目录"});
 const app = await mount(t,{location:{...home,folder:folder.id},onOpen:value=>opened.push(value.target_id),client:{list:async()=>({...page([item({name:"资料.md"})]),folders:[folder]}),update:async()=>{throw new Error("Unexpected metadata write");}}});
 const {CloudChatFileError,CloudFileUploadUnconfirmedError}=app.env.loadModule("src/lib/cloudChatFiles.ts");
 await app.update({files:{
   upload:async (file,conversation,_signal,id)=>{writes.push({name:file.name,conversation,id});throw new CloudFileUploadUnconfirmedError();},
   readUpload:async (id)=>{
     checks.push(id);
     if(checks.length===1) throw new CloudChatFileError("Not yet found",404);
     return saved;
   },
 }});
 const input=document.querySelector('input[type="file"]');
 Object.defineProperty(input,"files",{configurable:true,value:[new window.File(["sample"],"资料.md"),new window.File(["later"],"后续.md")]});
 const change=()=>input.dispatchEvent(new window.Event("change",{bubbles:true}));
 await app.env.act(async()=>change());await app.flush();
 assert.match(document.body.textContent,/上传结果待核对.*资料.md/);
 assert.match(document.body.textContent,/另有 1 个文件尚未上传/);
 await app.env.act(async()=>change());await app.flush();assert.equal(writes.length,1);
 assert.equal(document.querySelector('.cloud-space-upload').disabled,true);
 await app.click("刷新资料");
 assert.equal(document.querySelector('.cloud-space-upload').disabled,true,"an unrelated list read does not confirm the upload");

 await app.update({key:"other",browseOwner:2});
 assert.doesNotMatch(document.body.textContent,/上传结果待核对/);
 await app.update({key:"reload",browseOwner:1,location:{...home,scope:"starred"}});
 assert.match(document.body.textContent,/上传结果待核对.*资料.md/);
 await app.click("核对上传");
 assert.match(document.body.textContent,/还未找到本次上传的记录/);
 assert.equal(document.querySelector('.cloud-space-upload').disabled,true);
 const retry=[...document.querySelectorAll('button')].find(button=>button.textContent==="核对上传");
 retry.focus();
 await app.click("核对上传");
 assert.match(document.body.textContent,/已确认保存.*资料.md/);
 assert.match(document.body.textContent,/尚未放入「原始目录」/);
 assert.equal(document.activeElement.textContent,"查看已保存文件");
 await app.click("查看已保存文件");
 assert.deepEqual(opened,[saved.id]);
 assert.deepEqual(checks,[writes[0].id,writes[0].id]);
 assert.equal(writes[0].conversation,"");
 assert.equal(writes.length,1);
 assert.equal(document.querySelector('.cloud-space-upload').disabled,false);
});

test("a saved upload with an uncertain folder move keeps its exact file available for verification", async t => {
 const folder = item({id:"22222222-2222-4222-8222-222222222222",kind:"folder",name:"资料目录"});
 const saved = item({id:"33333333-3333-4333-8333-333333333333",name:"已保存.md",uploaded_at:"2026-10-30T00:00:00Z"});
 const app = await mount(t,{location:{...home,folder:folder.id}});
 const {CloudSpaceSaveUnconfirmedError}=app.env.loadModule("src/lib/cloudSpace.ts");
 const moves=[], checks=[];
 let uploadId;
 await app.update({
   client:{list:async()=>({...page(),folders:[folder]}),update:async(file,change)=>{moves.push([file.id,change.folder_id]);throw new CloudSpaceSaveUnconfirmedError();}},
   files:{upload:async(_file,_conversation,_signal,id)=>{uploadId=id;return saved;},readUpload:async id=>{checks.push(id);return saved;}},
 });
 const input=app.host.querySelector('input[type="file"]');
 Object.defineProperty(input,"files",{configurable:true,value:[new window.File(["example"],saved.name)]});
 await app.env.act(async()=>input.dispatchEvent(new window.Event("change",{bubbles:true})));
 await app.flush();
 assert.match(app.host.textContent,/文件夹位置待核对.*已保存.md/);
 await app.update({key:"reload-with-unknown-placement"});
 await app.click("核对上传");
 assert.match(app.host.textContent,/已确认保存.*已保存.md/);
 assert.match(app.host.textContent,/核对是否已放入「资料目录」/);
 assert.deepEqual(moves,[[saved.id,folder.id]]);
 assert.deepEqual(checks,[uploadId]);
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

test("a partially saved batch move retries only remaining files and keeps the destination", async (t) => {
 const second = item({ id: "22222222-2222-4222-8222-222222222222", name: "下一项.md" });
 const folder = item({ id: "33333333-3333-4333-8333-333333333333", kind: "folder", name: "交付资料" });
 const moved = new Set();
 const writes = [];
 let fail = true;
 const app = await mount(t, { client: {
  list: async () => ({ ...page([item(), second].filter((row) => !moved.has(row.id))), folders: [folder] }),
  update: async (row, changes) => {
   writes.push([row.id, changes.folder_id]);
   if (moved.has(row.id)) throw new Error("Already saved; obsolete version");
   if (row.id === second.id && fail) { fail = false; throw new Error("Temporarily unavailable"); }
   moved.add(row.id);
   return { ...row, ...changes, version: row.version + 1 };
  },
 } });
 await app.env.act(async () => app.host.querySelector('input[aria-label="全选已加载资料"]').click());
 await app.click("移动");
 await app.click(folder.name);
 await app.click("保存");
 const dialog = document.querySelector('[role="dialog"]');
 assert.match(dialog.textContent, /已完成 1 项，剩余 1 项/);
 assert.match(dialog.textContent, /Temporarily unavailable/);
 assert.equal([...dialog.querySelectorAll('button[aria-pressed="true"]')][0].textContent, folder.name);
 assert.doesNotMatch(app.host.querySelector(".cloud-space-results").textContent, /计划.md/);
 await app.click("保存");
 assert.deepEqual(writes, [[ID, folder.id], [second.id, folder.id], [second.id, folder.id]]);
 assert.equal(moved.size, 2);
});

test("a batch move conflict refreshes before reselecting the remaining file with its new version", async (t) => {
 const second = item({ id: "22222222-2222-4222-8222-222222222222", name: "并发更改.md" });
 const folder = item({ id: "33333333-3333-4333-8333-333333333333", kind: "folder", name: "交付资料" });
 const moved = new Set();
 const writes = [];
 let conflict;
 let offline = false;
 const app = await mount(t, { client: {
  list: async () => {
   if (offline) throw new TypeError("offline");
   return { ...page([item(), { ...second, version: conflict ? 2 : 0 }].filter((row) => !moved.has(row.id))), folders: [folder] };
  },
  update: async (row, changes) => {
   writes.push([row.id, row.version]);
   if (row.id === second.id && row.version === 0) throw conflict;
   moved.add(row.id);
   return { ...row, ...changes, version: row.version + 1 };
  },
 } });
 const { CloudSpaceError } = app.env.loadModule("src/lib/cloudSpace.ts");
 conflict = new CloudSpaceError("资料已变更，请刷新后重试。", 409);
 await app.env.act(async () => app.host.querySelector('input[aria-label="全选已加载资料"]').click());
 await app.click("移动");
 await app.click(folder.name);
 await app.click("保存");
 const dialog = document.querySelector('[role="dialog"]');
 assert.equal(dialog.querySelector('button[type="submit"]').disabled, true);
 assert.match(dialog.textContent, /已完成 1 项，剩余 1 项/);
 const refresh = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "刷新核对");
 assert.ok(refresh);
 offline = true;
 await app.env.act(async () => refresh.click());
 await app.flush();
 assert.match(app.host.textContent, /暂时无法读取资料/);
 assert.equal([...app.host.querySelectorAll("button")].find((button) => button.textContent === "移动").disabled, true);
 assert.deepEqual(writes, [[ID, 0], [second.id, 0]]);
 offline = false;
 await app.click("刷新核对");
 assert.equal(app.host.querySelector('input[aria-label="选择 并发更改.md"]').checked, true);
 await app.click("移动");
 await app.click(folder.name);
 await app.click("保存");
 assert.deepEqual(writes, [[ID, 0], [second.id, 0], [second.id, 2]]);
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

test("a confirmed row rename restores its menu focus after the dialog and list refresh settle", async (t) => {
 let finishList;
 let calls=0;
 const writes=[];
 const renamed=item({name:"更名资料.md",version:1});
 const app=await mount(t,{client:{
  list:async()=>++calls===1?page():new Promise(resolve=>{finishList=()=>resolve(page([renamed]));}),
  update:async (entry,changes)=>{writes.push([entry.id,changes]);return renamed;},
 }});
 await app.click("计划.md的更多操作");
 const rename=()=>[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent.trim()==="重命名");
 await app.env.waitFor(rename,"row rename menu action");
 await app.env.act(async()=>rename().click());
 const field=document.querySelector('[role="dialog"] input');
 await app.env.act(async()=>{
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(field,renamed.name);
  field.dispatchEvent(new Event("input",{bubbles:true}));
 });
 await app.click("保存");
 await app.env.waitFor(()=>finishList&&!document.querySelector('[role="dialog"]'),"closed dialog with the refresh still pending");
 assert.equal(document.activeElement===document.body,true);
 await app.env.act(async()=>finishList());
 const trigger=()=>app.host.querySelector('.cloud-space-row-more');
 await app.env.waitFor(()=>document.activeElement===trigger(),"row menu focus after refresh");
 assert.equal(trigger().getAttribute("aria-label"),"更名资料.md的更多操作");
 assert.deepEqual(writes,[[ID,{name:renamed.name}]]);
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
