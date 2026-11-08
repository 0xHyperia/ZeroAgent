import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const ID="11111111-1111-4111-8111-111111111111";
const CONV="22222222-2222-4222-8222-222222222222";
const record=(overrides={})=>({id:ID,conversation_id:CONV,name:"notes.md",mime:"text/markdown",size:5,sha256:"0".repeat(64),state:"ready",text_bytes:5,version:4,created_at:"2026-10-29T00:00:00Z",updated_at:"2026-10-29T00:00:00Z",uploaded_at:"2026-10-29T00:00:00Z",...overrides});
function load(){return createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudChatFiles.ts");}
const safe=()=>()=>undefined;

test("multipart upload preserves original bytes and identity without setting a JSON content type",async()=>{
 const api=load();let captured;
 const client=api.createCloudChatFilesClient(async(path,init)=>{captured={path,init};return Response.json({file:record()},{status:201});},safe);
 const original=new File(["hello"],"notes.md",{type:"text/markdown"});
 const file=await client.upload(original,CONV);
 assert.equal(file.id,ID);assert.equal(captured.path,"/api/web-chat/files");
 assert.equal(captured.init.headers["Content-Type"],undefined);
 assert.equal(captured.init.body.get("conversation_id"),CONV);
 assert.equal(await captured.init.body.get("file").text(),"hello");
 assert.equal(captured.init.credentials,"include");
});

test("an unknown upload is never retried and directs recovery to the durable file library",async()=>{
 const api=load();let calls=0;
 const client=api.createCloudChatFilesClient(async()=>{calls++;throw new Error("lost after server accepted");},safe);
 await assert.rejects(client.upload(new File(["hello"],"notes.md"),CONV),api.CloudFileUploadUnconfirmedError);
 assert.equal(calls,1);
});

test("timeouts and gateway errors may hide a saved upload while explicit rejection stays actionable",async()=>{
 const api=load();
 for(const status of [408,502,503,504,413]){
   let calls=0;
   const client=api.createCloudChatFilesClient(async()=>{calls++;return Response.json({error:"fixture"},{status});},safe);
   await assert.rejects(client.upload(new File(["hello"],"notes.md"),CONV),(error)=>
      status===413 ? error instanceof api.CloudChatFileError && error.status===413 : error instanceof api.CloudFileUploadUnconfirmedError);
   assert.equal(calls,1);
 }
});

test("file JSON parsing retains the original account guard through an asynchronous body",async()=>{
 const api=load();let account=1;let release;
 const client=api.createCloudChatFilesClient(async()=>new Response(new ReadableStream({start(controller){release=()=>{account=2;controller.enqueue(new TextEncoder().encode(JSON.stringify({file:record()})));controller.close();};}})),()=>{const owner=account;return()=>{if(owner!==account)throw new Error("Account changed while the request was pending");};});
 const result=client.get(ID);await Promise.resolve();release();await assert.rejects(result,/Account changed/);
});

test("library cursors, delete versions and bounded source excerpts use account-scoped resource endpoints",async()=>{
 const api=load();const calls=[];
 const client=api.createCloudChatFilesClient(async(path,init)=>{
   calls.push({path,init});
   if(path.includes("/content?"))return Response.json({file_id:ID,name:"notes.md",sha256:"0".repeat(64),total_lines:3,from_line:2,to_line:3,lines:[{line:2,text:"B"},{line:3,text:"C"}]});
   if(init.method==="DELETE")return Response.json({file:record({state:"deleted",version:6})});
   return Response.json({files:[record()],next_cursor:ID});
 },safe);
 const page=await client.list({before:ID});assert.equal(page.nextCursor,ID);assert.match(calls[0].path,/before=/);assert.doesNotMatch(calls[0].path,/conversation_id/);
 await client.remove(record());assert.equal(calls[1].init.headers["If-Match"],'"4"');
 const source=await client.source(ID,2,3);assert.equal(source.lines[0].line,2);
 await assert.rejects(client.source(ID,1,201),/行号/);
 await assert.rejects(client.get("../../secrets"),/标识/);
});

test("download is bounded, rejects truncated originals and returns a guard for its final browser use",async()=>{
 const api=load();let owner=1;
 const capture=()=>{const id=owner;return()=>{if(owner!==id)throw new Error("Account changed");};};
 const client=api.createCloudChatFilesClient(async()=>new Response("hello"),capture);
 const downloaded=await client.download(record());assert.equal(await downloaded.blob.text(),"hello");
 owner=2;assert.throws(downloaded.guard,/Account changed/);
 const truncated=api.createCloudChatFilesClient(async()=>new Response("hell"),safe);
 await assert.rejects(truncated.download(record()),/不完整/);
 const oversized=api.createCloudChatFilesClient(async()=>new Response("x",{headers:{"Content-Length":String(api.CLOUD_FILE_MAX_BYTES+1)}}),safe);
 await assert.rejects(oversized.download(record()),/大小限制/);
});

test("references retain server metadata, pending formats stay explicit, and citations use controlled file links",()=>{
 const api=load();assert.equal(api.cloudFileCanReference(record()),true);
 assert.equal(api.cloudFileCanReference(record({state:"uploaded",processing_stage:"awaiting_isolated_parser"})),false);
 assert.match(api.cloudFileStatus(record({state:"uploaded"})),/等待隔离解析/);
 assert.equal(api.cloudFileCanReference(record({text_bytes:api.CLOUD_FILE_CONTEXT_BYTES+1})),false);
 assert.match(api.cloudFileStatus(record({parse_truncated:true})),/部分内容/);
 assert.equal(api.cloudFileReferences([{type:"file_reference",file_id:ID,name:"notes.md",mime:"text/markdown",size:5}])[0].size,5);
 assert.deepEqual(api.cloudFileReferences([{type:"file_reference",file_id:"../../bad"}]),[]);
 assert.equal(api.linkCloudFileCitations(`证据【文件:${ID}:L2-L4】。`),`证据[原文 L2–L4](cloud-files/${ID}#L2-L4)。`);
 assert.equal(api.linkCloudFileCitations(`【文件:${ID}:L4-L2】`),`【文件:${ID}:L4-L2】`);
});

test("verified vision images are referenceable without claiming text extraction",async()=>{
 const api=load();const image=record({mime:"image/png",state:"vision_ready",processing_stage:"vision_ready",text_bytes:0});
 const client=api.createCloudChatFilesClient(async()=>Response.json({file:image}),safe);
 assert.equal((await client.get(ID)).state,"vision_ready");
 assert.equal(api.cloudFileCanReference(image),true);assert.match(api.cloudFileStatus(image),/图片已就绪/);
 for(const invalid of [{size:8*1024*1024+1},{text_bytes:1},{mime:"image/svg+xml"},{uploaded_at:undefined}])assert.equal(api.cloudFileCanReference({...image,...invalid}),false);
});

test("ZIP originals remain workspace-only and become referenceable only with the server workspace capability",async()=>{
 const api=load(),zip=record({name:"project.zip",mime:"application/zip",state:"uploaded",processing_stage:"workspace_only",text_bytes:0,workspace_loadable:true});
 const client=api.createCloudChatFilesClient(async()=>Response.json({file:zip}),safe);
 const parsed=await client.get(ID);assert.equal(parsed.state,"uploaded");assert.equal(parsed.text_bytes,0);assert.equal(api.cloudFileCanReference(parsed),true);assert.match(api.cloudFileStatus(parsed),/隔离沙箱读取或解压/);
 assert.equal(api.cloudFileCanReference({...zip,workspace_loadable:false}),false);assert.match(api.cloudFileStatus({...zip,workspace_loadable:false}),/隔离沙箱暂不可用/);
});

test("a server-verified original can be loaded in an isolated workspace without pretending extraction finished",async()=>{
 const api=load();for(const data of [{state:"uploaded",text_bytes:0},{state:"processing",text_bytes:0},{state:"failed",text_bytes:0},{state:"ready",text_bytes:api.CLOUD_FILE_CONTEXT_BYTES+1}]){
   const file=record({...data,workspace_loadable:true});assert.equal(api.cloudFileCanReference(file),true);assert.match(api.cloudFileStatus(file),/原件可在隔离沙箱读取/);
 }
 for(const data of [{uploaded_at:undefined},{state:"deleted"},{state:"deleting"},{state:"uploading"}])assert.equal(api.cloudFileCanReference(record({state:"uploaded",workspace_loadable:true,...data})),false);
 const client=api.createCloudChatFilesClient(async()=>Response.json({file:record({workspace_loadable:"yes"})}),safe);await assert.rejects(client.get(ID),/无效/);
});

async function mountReader(t, {fromLine, attachResult=false,recordOverrides={},getFile,locale="zh-CN",workFromSpace=false,inTrash=false,removeFile}={}) {
 let env,closed=0,sourceReads=0;const attached=[],deleted=[],errors=[];
 const capture=()=>()=>undefined;
 const icons=new Proxy({},{get:()=>()=>null});
 const mocks={
  "@liveagent/ui/components/IconSet":icons,
  [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx",import.meta.url))]:icons,
  "@/lib/accountRequest":{captureAccountRequestGuard:capture},
  "@liveagent/ui/components/resource-preview/ResourcePreview":{ResourcePreview:props=>env.React.createElement("div",{"data-file-preview":"","data-source-from":props.sourceRange?.fromLine},"文件正文")},
  [fileURLToPath(new URL("../src/components/cloudchat/CloudChatResourcePanel.tsx",import.meta.url))]:{CloudChatResourcePanel:props=>env.React.createElement("section",null,env.React.createElement("header",null,props.backToLibrary?env.React.createElement("button",{onClick:props.onClose},"Back to Library"):null,props.title,props.subtitle,props.headerActions),props.children,props.details)},
 };
 env=await createWebDomTestEnv({mocks});
 const {CloudChatFilePanel}=env.loadModule("src/components/CloudChatFilePanel.tsx");
 const {LocaleContext,t:translate}=env.loadModule("../../agent-ui/src/i18n/index.ts");
 const {CloudChatFileError}=env.loadModule("src/lib/cloudChatFiles.ts");
 const client={get:async(id)=>getFile?getFile(id,CloudChatFileError):record(recordOverrides),source:async()=>{sourceReads++;return {from_line:fromLine??1,to_line:3,total_lines:3,lines:[{line:fromLine??1,text:"资料原文"}]};},download:async()=>{throw new Error("unexpected download");},remove:removeFile};
 const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 await env.act(async()=>{root.render(env.React.createElement(LocaleContext.Provider,{value:{locale,t:key=>translate(key,locale)}},env.React.createElement(CloudChatFilePanel,{client,initialFileId:ID,fromLine,workFromSpace,inTrash,canAttach:true,isCurrent:()=>true,onClose:()=>closed++,onAttach:file=>{attached.push(file.id);return attachResult;},onDeleted:id=>deleted.push(id),onError:cause=>errors.push(cause)})));await flush();});
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 return {env,host,client,attached,deleted,errors,get closed(){return closed;},get sourceReads(){return sourceReads;},set attachResult(value){attachResult=value;},async click(label){
   let button=[...document.querySelectorAll('button,[role="menuitem"]')].find(item=>item.textContent.trim()===label);
   if(!button){const trigger=host.querySelector('[aria-label^="文件菜单："]');assert.ok(trigger,'file title menu');await env.act(async()=>{trigger.click();await flush();});button=[...document.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent.trim()===label);}
   assert.ok(button,label);const menuItem=button.getAttribute('role')==='menuitem';await env.act(async()=>{button.click();await flush();});
   if(menuItem) await env.waitFor(()=>!document.querySelector('[role="menu"]'),'file menu to close');
 }};
}

test("a failed file link retries its exact file and restores focus without treating the library as empty", async (t) => {
  const requests = [];
  let finish;
  const app = await mountReader(t, {
    fromLine: 2,
    locale: "en-US",
    workFromSpace: true,
    getFile: async (id, FileError) => {
      requests.push(id);
      if (requests.length === 1) throw new FileError("文件不存在或已删除。", 404);
      if (requests.length === 2) throw new FileError("存储暂不可用。", 503);
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  assert.match(app.host.textContent, /File unavailable/);
  assert.doesNotMatch(app.host.textContent, /文件不存在|还没有文件|No files yet/);
  const retry = [...app.host.querySelectorAll("button")].find((button) => button.textContent === "Try again");
  retry.focus();
  await app.click("Try again");
  assert.match(app.host.textContent, /Couldn't open the file/);
  assert.equal(document.activeElement, retry);
  await app.click("Try again");
  assert.equal(retry.getAttribute("aria-disabled"), "true");
  assert.equal(retry.textContent, "Opening file…");
  assert.equal(document.activeElement, retry);
  assert.equal(app.closed, 0);
  await app.env.act(async () => { finish(record()); });
  assert.equal(app.host.querySelector("[data-file-preview]").dataset.sourceFrom, "2");
  assert.equal(document.activeElement.getAttribute("aria-label"), `File menu for ${record().name}`);
  assert.deepEqual(requests, [ID, ID, ID]);
  assert.deepEqual(app.errors.map((error) => error.status), [404, 503]);
  await app.click("Back to Library");
  assert.equal(app.closed, 1);
});

test("a rejected file reference stays in the reader with local feedback; a successful reference closes it",async t=>{
 const app=await mountReader(t);
 assert.ok(app.host.querySelector("header button"),"file actions remain beside the title");
 await app.click("引用到消息");assert.deepEqual(app.attached,[ID]);assert.equal(app.closed,0);assert.match(app.host.querySelector('[role="alert"]').textContent,/未能添加引用/);assert.ok(app.host.querySelector("[data-file-preview]"));
 app.attachResult=undefined;await app.click("引用到消息");assert.equal(app.closed,1,"existing void-returning hosts remain compatible");
});

test("ordinary text uses the shared reader without a duplicate excerpt request",async t=>{
 const app=await mountReader(t);assert.equal(app.sourceReads,0);assert.equal(Boolean(app.host.querySelector('details')),false);
 assert.equal(app.host.querySelector('[data-file-preview]').getAttribute('data-source-from'),null);
});

test("a cited text file sends its exact line to the shared reader rather than opening a second excerpt",async t=>{
 const app=await mountReader(t,{fromLine:2});assert.equal(app.sourceReads,0);assert.equal(Boolean(app.host.querySelector('details')),false);
 assert.equal(app.host.querySelector('[data-file-preview]').getAttribute('data-source-from'),'2');
});

test("a server excerpt is collapsed for ordinary PDF reading and opens from its summary",async t=>{
 const app=await mountReader(t,{recordOverrides:{name:'notes.pdf',mime:'application/pdf'}});assert.equal(app.host.querySelector("details").open,false);
 await app.env.act(async()=>{app.host.querySelector('summary').click();await new Promise(resolve=>setImmediate(resolve));});assert.equal(app.host.querySelector("details").open,true);
});

test("opening a cited file keeps the requested original lines expanded",async t=>{
 const app=await mountReader(t,{fromLine:2,recordOverrides:{name:'notes.pdf',mime:'application/pdf'}});assert.equal(app.host.querySelector("details").open,true);assert.match(app.host.querySelector("summary").textContent,/第 2–3 行/);
});


test("file reading menu keeps contextual actions and opening details preserves the preview",async t=>{
 const app=await mountReader(t);const preview=app.host.querySelector("[data-file-preview]");
 await app.env.act(async()=>{app.host.querySelector('[aria-label^="文件菜单："]').click();await new Promise(resolve=>setImmediate(resolve));});
 const items=[...document.querySelectorAll('[role="menuitem"]')];
 assert.ok(!items.some(item=>/刷新状态|全部文件/.test(item.textContent)));
 assert.ok(!items.some(item=>item.textContent.includes("彻底删除原件")));
 await app.env.act(async()=>{items.find(item=>item.textContent==="文件信息").click();await new Promise(resolve=>setImmediate(resolve));});
 assert.ok(app.host.querySelector('[aria-label="文件详情"]'));
 assert.equal(app.host.querySelector("[data-file-preview]"),preview);
});

test("the Trash file reader returns only after confirming removal of the selected original", async (t) => {
  const requests = [];
  let finish;
  const app = await mountReader(t, {
    workFromSpace: true,
    inTrash: true,
    removeFile(file) {
      requests.push({ id: file.id, version: file.version });
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  const alert = () => document.querySelector('[role="alertdialog"]');
  const preview = app.host.querySelector("[data-file-preview]");
  await app.click("彻底删除原件");
  assert.match(alert().textContent, /notes\.md.*已有对话/);
  assert.deepEqual(requests, []);
  await app.click("保留文件");
  await app.env.waitFor(() => !alert(), "the delete confirmation to close");
  assert.equal(app.host.querySelector("[data-file-preview]"), preview);
  await app.click("彻底删除原件");
  await app.click("确认删除");
  assert.deepEqual(requests, [{ id: ID, version: 4 }]);
  assert.deepEqual(app.deleted, []);
  assert.equal(app.closed, 0);
  assert.match(alert().textContent, /正在删除/);
  await app.env.act(async () => { finish(record({ state: "deleted", version: 6 })); });
  assert.deepEqual(app.deleted, [ID]);
  assert.equal(app.closed, 1);
});

test("an unconfirmed Trash deletion keeps the original preview and prevents a blind retry", async (t) => {
  let requests = 0;
  const app = await mountReader(t, {
    workFromSpace: true,
    inTrash: true,
    async removeFile() { requests++; return record({ state: "deleting" }); },
  });
  const alert = () => document.querySelector('[role="alertdialog"]');
  const preview = app.host.querySelector("[data-file-preview]");
  await app.click("彻底删除原件");
  await app.click("确认删除");
  assert.match(alert().querySelector('[role="alert"]').textContent, /返回资料空间核对/);
  assert.equal([...alert().querySelectorAll("button")].find((button) => button.textContent === "确认删除").disabled, true);
  assert.deepEqual(app.deleted, []);
  assert.equal(app.closed, 0);
  await app.click("关闭");
  await app.env.waitFor(() => !alert(), "the delete confirmation to close");
  assert.equal(app.host.querySelector("[data-file-preview]"), preview);
  await app.click("彻底删除原件");
  assert.match(alert().querySelector('[role="alert"]').textContent, /返回资料空间核对/);
  assert.equal(requests, 1);
});
