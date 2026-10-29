import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const V1="11111111-1111-4111-8111-111111111111",V2="22222222-2222-4222-8222-222222222222",FAMILY="33333333-3333-4333-8333-333333333333",CONV="44444444-4444-4444-8444-444444444444",RUN="55555555-5555-4555-8555-555555555555";
const content="<html><script>window.untrusted=true</script><svg onload='alert(1)'></svg>合成网页</html>";
const version=(overrides={})=>({id:V2,family_id:FAMILY,number:2,conversation_id:CONV,source_run_id:RUN,name:"page.html",mime:"text/html",size:new TextEncoder().encode(content).length,sha256:"a".repeat(64),state:"ready",version:3,created_at:"2026-10-29T01:00:00Z",updated_at:"2026-10-29T01:00:01Z",download_url:`/api/web-chat/artifacts/versions/${V2}/download`,...overrides});
const oldVersion=()=>version({id:V1,number:1,name:"older.html",download_url:`/api/web-chat/artifacts/versions/${V1}/download`});
const load=()=>createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudChatArtifacts.ts");
const safe=()=>()=>undefined;
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test("artifact account/family metadata and immutable version downloads stay on owned API paths",async()=>{
 const api=load(),calls=[];
 const client=api.createCloudChatArtifactsClient(async(path,init={})=>{calls.push({path,init});if(path.endsWith("/download"))return new Response(new Uint8Array([0,255,128,65]));if(path.includes("?"))return Response.json({versions:[version()],next_cursor:""});return Response.json({version:version()});},safe);
 assert.equal((await client.list({conversationId:CONV})).versions[0].family_id,FAMILY);assert.equal((await client.get(V2)).number,2);
 const binary=version({name:"binary.bin",mime:"application/octet-stream",size:4});const result=await client.download(binary);
 assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()),new Uint8Array([0,255,128,65]));assert.equal(calls.at(-1).init.headers.Accept,"application/octet-stream");
 assert.ok(calls.every(call=>call.path.startsWith("/api/web-chat/artifacts")&&call.init.credentials==="include"));
 await assert.rejects(client.get("/workspace/file"),/标识/);
 const forged=api.createCloudChatArtifactsClient(async()=>Response.json({version:version({download_url:"https://example.com/unowned"})}),safe);await assert.rejects(forged.get(V2),/无效/);
});

test("unknown/staging/failed metadata never authorizes a download and byte limits reject partial files",async()=>{
 const api=load();let calls=0;
 const client=api.createCloudChatArtifactsClient(async()=>{calls++;return new Response("partial");},safe);
 for(const state of ["unknown","staging","failed","deleting","deleted"]){await assert.rejects(client.download(version({state,download_url:undefined})),error=>error.status===409);assert.notEqual(api.cloudArtifactStatus(version({state})),"正式版本已就绪");}
 assert.equal(calls,0);
 await assert.rejects(client.download(version()),/不完整/);
 const huge=api.createCloudChatArtifactsClient(async()=>new Response("x",{headers:{"Content-Length":String(api.CLOUD_ARTIFACT_MAX_BYTES+1)}}),safe);await assert.rejects(huge.download(version()),/大小限制/);
});

test("artifact text viewing returns UTF-8 strings rather than an executable HTML/SVG origin",async()=>{
 const api=load();const client=api.createCloudChatArtifactsClient(async()=>new Response(content),safe);
 assert.equal((await client.text(version())).text,content);assert.equal(api.cloudArtifactCanViewText(version({name:"icon.svg",mime:"image/svg+xml"})),true);
 assert.equal(api.cloudArtifactCanViewText(version({size:api.CLOUD_ARTIFACT_TEXT_BYTES+1})),false);
 const bad=api.createCloudChatArtifactsClient(async()=>new Response(new Uint8Array([0xff,0xfe])),safe);await assert.rejects(bad.text(version({size:2})),/UTF-8/);
});

test("artifact response/Blob guards reject results after an account changes",async()=>{
 const api=load();let owner=1,release;
 const capture=()=>{const captured=owner;return()=>{if(owner!==captured)throw new Error("Account changed");};};
 const delayed=api.createCloudChatArtifactsClient(async()=>new Response(new ReadableStream({start(controller){release=()=>{owner=2;controller.enqueue(new TextEncoder().encode(content));controller.close();};}})),capture);
 const pending=delayed.download(version());await Promise.resolve();release();await assert.rejects(pending,/Account changed/);
 const ready=api.createCloudChatArtifactsClient(async()=>new Response(content),capture);const download=await ready.download(version());owner=3;assert.throws(download.guard,/Account changed/);
});

test("artifact citations identify exact versions without rewriting ordinary external links",()=>{
 const api=load();assert.equal(api.linkCloudArtifactCitations(`成果【成果:${V1}】 [官方](https://example.com/)`),`成果[成果](cloud-artifacts/${V1}) [官方](https://example.com/)`);
 assert.equal(api.cloudArtifactVersionURI(version()),`zeroagent://artifact-version/${V2}`);
 assert.throws(()=>api.cloudArtifactVersionURI(version({state:"unknown",download_url:undefined})),error=>error.status===409);
 assert.equal(api.cloudArtifactSize(21),"21 B");assert.equal(api.cloudArtifactSize(1024),"1.0 KiB");assert.equal(api.cloudArtifactSize(2*1024*1024),"2.0 MiB");
 assert.equal(api.cloudArtifactVersionFromLink(`cloud-artifacts/${V1}`),V1);assert.equal(api.cloudArtifactVersionFromLink(`/api/web-chat/artifacts/versions/${V1}/download`),V1);
 assert.equal(api.cloudArtifactVersionFromLink("/workspace/output.csv"),null);assert.equal(api.cloudArtifactVersionFromLink("https://example.com/a"),null);
});

async function mount(t,{record=version(),lateBinary=false,deleteState="deleted",initial=true,libraryRecords,failInitial=false,binaryContent=content}={}){
 let env,revision=0,active=true,release;const calls=[],deleted=[],notices=[],continues=[];
 const capture=()=>{const owner=revision;return()=>{if(owner!==revision)throw new Error("Account changed");};};
 const records=libraryRecords??[oldVersion(),record];let failMore=false,delayMore=false,finishMore;
 const request=async(path,init={})=>{
   calls.push({path,init});assert.ok(path.startsWith("/api/web-chat/artifacts"),"artifact panel attempted a VM path or external origin");
   if(init.method==="DELETE"){deleted.push(path);return Response.json({family_id:FAMILY,state:deleteState},{status:deleteState==="deleting"?202:200});}
   if(path.endsWith("/download")){if(lateBinary)await new Promise(resolve=>{release=resolve;});return new Response(binaryContent);}
   if(path.includes("?")){
     const url=new URL(path,"http://fixture.local"),before=url.searchParams.get("before"),limit=Number(url.searchParams.get("limit"));
     if(!before&&failInitial)return Response.json({error:"unavailable"},{status:503});
     if(before&&delayMore)await new Promise(resolve=>{finishMore=resolve;});
     if(before&&failMore)return Response.json({error:"unavailable"},{status:503});
     const filtered=deleted.length?[]:records.filter(item=>!url.searchParams.has("family_id")||item.family_id===url.searchParams.get("family_id"));
     const start=before?filtered.findIndex(item=>item.id===before)+1:0,page=filtered.slice(start,start+limit);
     return Response.json({versions:page,next_cursor:filtered.length>start+limit?page.at(-1).id:""});
   }
   const id=path.split("/").at(-1);return Response.json({version:records.find(item=>item.id===id)});
 };
 env=await createWebDomTestEnv({mocks:{"@/lib/accountRequest":{captureAccountRequestGuard:capture},[fileURLToPath(new URL("../src/components/cloudchat/CloudChatResourcePanel.tsx",import.meta.url))]:{CloudChatResourcePanel:props=>env.React.createElement("div",{role:"dialog"},env.React.createElement("h2",null,props.title),env.React.createElement("p",null,props.description),props.children)},"@liveagent/ui/components/ui/dialog":{Dialog:props=>props.children,DialogContent:props=>env.React.createElement("div",{role:"dialog"},props.children),DialogTitle:props=>env.React.createElement("h2",null,props.children),DialogDescription:props=>env.React.createElement("p",null,props.children)}}});
 const {createCloudChatArtifactsClient}=env.loadModule("src/lib/cloudChatArtifacts.ts"),client=createCloudChatArtifactsClient(request,capture);
 const {CloudChatArtifactsPanel}=env.loadModule("src/components/cloudchat/CloudChatArtifactsPanel.tsx");const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
 await env.act(async()=>{root.render(env.React.createElement(CloudChatArtifactsPanel,{client,conversationId:CONV,initialVersionId:initial?record.id:undefined,isCurrent:()=>active,onClose:()=>{},onDeleted:id=>notices.push(id),onContinue:version=>continues.push(version)}));await tick();});
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 return{env,host,calls,deleted,notices,continues,switchAccount(){revision++;},set failInitial(value){failInitial=value;},set failMore(value){failMore=value;},set delayMore(value){delayMore=value;},async finishMore(){await env.act(async()=>{finishMore();await tick();});},async click(label){const button=[...host.querySelectorAll("button")].find(button=>button.textContent===label);assert.ok(button,`missing ${label}`);await env.act(async()=>{button.click();await tick();});},async choose(id){const select=host.querySelector('select[aria-label="成果版本"]');await env.act(async()=>{select.value=id;select.dispatchEvent(new Event("change",{bubbles:true}));await tick();});},async retire(){await env.act(async()=>{revision++;active=false;root.render(null);await tick();});},async finishBinary(){await env.act(async()=>{release();await tick();});}};
}

test("artifact reader switches immutable family versions and downloads the chosen old version",async(t)=>{
 const app=await mount(t);assert.match(app.host.textContent,/v2 · 正式版本已就绪/);await app.choose(V1);assert.match(app.host.textContent,/v1 · 正式版本已就绪/);
 const downloads=[];const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;URL.createObjectURL=()=>"blob:artifact-fixture";URL.revokeObjectURL=()=>{};t.after(()=>{URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;});
 app.env.dom.window.HTMLAnchorElement.prototype.click=function(){downloads.push(this.download);};
 await app.click("下载此版本");assert.deepEqual(downloads,["older.html"]);assert.ok(app.calls.some(call=>call.path===`/api/web-chat/artifacts/versions/${V1}/download`));
});

test("HTML artifact preview renders source text without executing scripts, SVG or frames",async(t)=>{
 const app=await mount(t);await app.click("查看文本");assert.equal(app.host.querySelector("pre").textContent,content);
 assert.equal(app.host.querySelector("script,svg,iframe,img"),null);assert.match(app.host.textContent,/以源码显示/);
});

test("an unknown artifact has no working download link while its family remains inspectable",async(t)=>{
 const app=await mount(t,{record:version({state:"unknown",download_url:undefined})});assert.match(app.host.textContent,/保存结果待核对/);
 assert.equal([...app.host.querySelectorAll("button")].find(button=>button.textContent==="下载此版本").disabled,true);assert.equal(app.host.querySelector('a[href]'),null);
 assert.equal(app.calls.some(call=>call.path.endsWith("/download")),false);
 await app.click("继续修改");assert.equal(app.continues.length,0);
});

test("continuing work selects the exact ready version and rejects metadata from a retired account",async(t)=>{
 const app=await mount(t);await app.choose(V1);await app.click("继续修改");
 assert.equal(app.continues.length,1);assert.equal(app.continues[0].id,V1);assert.equal(app.continues[0].family_id,FAMILY);assert.equal(app.continues[0].name,"older.html");
 app.switchAccount();await app.click("继续修改");assert.equal(app.continues.length,1);assert.match(app.host.textContent,/Account changed/);
});

test("family deletion is explicit and a 202 cleanup receipt never pretends the objects were erased",async(t)=>{
 const app=await mount(t,{deleteState:"deleting"});await app.click("删除全部版本");assert.equal(app.deleted.length,0);
 await app.click("确认删除成果");assert.deepEqual(app.notices,[FAMILY]);assert.equal(app.deleted.length,1);assert.match(app.host.textContent,/删除已提交.*正在清理原件/);assert.doesNotMatch(app.host.textContent,/已删除这项成果/);
});

test("a retired artifact download never creates a Blob URL or a browser download",async(t)=>{
 const app=await mount(t,{lateBinary:true});let blobs=0;
 const originalCreate=URL.createObjectURL;URL.createObjectURL=()=>{blobs++;return "blob:private";};t.after(()=>{URL.createObjectURL=originalCreate;});
 await app.click("下载此版本");await app.retire();await app.finishBinary();assert.equal(blobs,0);assert.equal(app.host.querySelector('[role="dialog"]'),null);
});

test("artifact page cursors are scoped and validated before older results are appended",async()=>{
 const api=load(),calls=[];let forged=false;
 const records=[version(),oldVersion()];
 const client=api.createCloudChatArtifactsClient(async(path)=>{calls.push(path);return Response.json(path.includes("before=")?{versions:[],next_cursor:""}:{versions:records,next_cursor:forged?V2:V1});},safe);
 const page=await client.list({conversationId:CONV,limit:2});assert.equal(page.nextCursor,V1);assert.equal(page.versions.length,2);
 await client.list({familyId:FAMILY,before:V1,limit:3});assert.match(calls.at(-1),new RegExp(`family_id=${FAMILY}.*before=${V1}`));
 forged=true;await assert.rejects(client.list({limit:2}),/分页响应无效/);
 for(const options of [{limit:0},{limit:101},{before:"/workspace/file"}])await assert.rejects(client.list(options),/无效/);
});

const manyVersions=()=>Array.from({length:55},(_,index)=>{
 const suffix=String(55-index).padStart(12,"0"),id=`99999999-9999-4999-8999-${suffix}`;
 return version({id,family_id:`88888888-8888-4888-8888-${suffix}`,name:`generated-${55-index}.html`,download_url:`/api/web-chat/artifacts/versions/${id}/download`});
});

test("artifact library loads older pages, preserves existing results on failure, and stops at the actual end",async(t)=>{
 const records=manyVersions();records[54].family_id=records[0].family_id;records[54].number=1;
 const app=await mount(t,{initial:false,libraryRecords:records});assert.match(app.host.textContent,/已加载 50 个版本/);assert.doesNotMatch(app.host.textContent,/已显示全部可用成果/);
 app.failMore=true;await app.click("加载更多成果");assert.match(app.host.textContent,/暂时不可用/);assert.match(app.host.textContent,/已加载 50 个版本/);assert.equal(app.host.querySelectorAll("li").length,50);
 app.failMore=false;app.delayMore=true;await app.click("加载更多成果");assert.match(app.host.textContent,/正在加载更多…/);assert.equal(app.host.querySelectorAll("li").length,50);
 await app.finishMore();assert.match(app.host.textContent,/已加载 55 个版本/);assert.match(app.host.textContent,/已显示全部可用成果/);assert.equal(app.host.querySelectorAll("li").length,54,"one family across two pages stays one card");
 assert.doesNotMatch(app.host.textContent,/加载更多成果|正在加载更多|暂时不可用/);assert.ok(app.calls.some(call=>call.path.includes(`before=${records[49].id}`)));
});

test("a late older-results page cannot expose its library after the account retires",async(t)=>{
 const app=await mount(t,{initial:false,libraryRecords:manyVersions()});app.delayMore=true;await app.click("加载更多成果");await app.retire();await app.finishMore();assert.equal(app.host.querySelector('[role="dialog"]'),null);assert.doesNotMatch(app.host.textContent,/generated-/);
});

test("a real empty artifact page is shown without a fake continuation",async(t)=>{
 const app=await mount(t,{initial:false,libraryRecords:[]});assert.match(app.host.textContent,/还没有成果/);assert.doesNotMatch(app.host.textContent,/加载更多成果|已加载/);
});

test("an initial library failure is not presented as an empty library and can be retried",async(t)=>{
 const app=await mount(t,{initial:false,failInitial:true});assert.match(app.host.textContent,/暂时无法读取成果/);assert.doesNotMatch(app.host.textContent,/还没有成果|已显示全部/);
 app.failInitial=false;await app.click("刷新状态");assert.match(app.host.textContent,/已加载 2 个版本/);assert.doesNotMatch(app.host.textContent,/暂时无法读取成果/);
});

const pngBytes=()=>new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTMsAAAAASUVORK5CYII=","base64"));
const pngVersion=()=>version({name:"chart.png",mime:"image/png",size:pngBytes().byteLength});
test("raster previews use guarded owned downloads and bound PNG/JPEG dimensions without enabling HTML or SVG",async()=>{
 const api=load(),calls=[];
 const client=api.createCloudChatArtifactsClient(async(path,init)=>{calls.push({path,init});return new Response(pngBytes());},safe);
 const result=await client.image(pngVersion());assert.equal(result.width,1);assert.equal(result.height,1);assert.equal(result.blob.type,"image/png");assert.equal(calls[0].init.headers.Accept,"application/octet-stream");
 for(const mime of ["image/svg+xml","text/html","image/gif","image/webp"])assert.equal(api.cloudArtifactCanPreviewImage(version({mime})),false);
 const before=calls.length;await assert.rejects(client.image(version({mime:"image/svg+xml"})),cause=>cause.status===409);assert.equal(calls.length,before);
 const bomb=pngBytes();new DataView(bomb.buffer).setUint32(16,20000);const huge=api.createCloudChatArtifactsClient(async()=>new Response(bomb),safe);await assert.rejects(huge.image(pngVersion()),/尺寸/);
 const jpeg=new Uint8Array([255,216,255,192,0,11,8,0,2,0,3,1,1,17,0,255,217]);const headerClient=api.createCloudChatArtifactsClient(async()=>new Response(jpeg),safe);const dimensions=await headerClient.image(version({name:"chart.jpg",mime:"image/jpeg",size:jpeg.length}));assert.equal(dimensions.width,3);assert.equal(dimensions.height,2);
});

test("the artifact panel explicitly previews one controlled raster Blob and revokes it when the selected version changes",async(t)=>{
 const app=await mount(t,{record:pngVersion(),binaryContent:pngBytes()});let blobs=0;const revoked=[];
 const create=URL.createObjectURL,revoke=URL.revokeObjectURL;URL.createObjectURL=blob=>{blobs++;assert.equal(blob.type,"image/png");return "blob:private-chart";};URL.revokeObjectURL=url=>revoked.push(url);t.after(()=>{URL.createObjectURL=create;URL.revokeObjectURL=revoke;});
 assert.equal(blobs,0);await app.click("查看图片");const image=app.host.querySelector("img");assert.ok(image);assert.equal(image.getAttribute("src"),"blob:private-chart");assert.equal(image.getAttribute("alt"),"chart.png");assert.equal(app.host.querySelector("iframe,svg,script"),null);assert.match(app.host.textContent,/1 × 1/);
 await app.choose(V1);assert.equal(app.host.querySelector("img"),null);assert.deepEqual(revoked,["blob:private-chart"]);
});

test("a retired raster fetch never publishes a Blob URL or exposes an old-account image",async(t)=>{
 const app=await mount(t,{record:pngVersion(),binaryContent:pngBytes(),lateBinary:true});let urls=0;const create=URL.createObjectURL;URL.createObjectURL=()=>{urls++;return "blob:retired";};t.after(()=>{URL.createObjectURL=create;});
 await app.click("查看图片");await app.retire();await app.finishBinary();assert.equal(urls,0);assert.equal(app.host.querySelector("img"),null);
});

test("a raster decoder failure offers the original without changing the ready storage fact",async(t)=>{
 const app=await mount(t,{record:pngVersion(),binaryContent:pngBytes()});const create=URL.createObjectURL,revoke=URL.revokeObjectURL;URL.createObjectURL=()=>"blob:synthetic-image";URL.revokeObjectURL=()=>{};t.after(()=>{URL.createObjectURL=create;URL.revokeObjectURL=revoke;});
 await app.click("查看图片");await app.env.act(async()=>app.host.querySelector("img").dispatchEvent(new Event("error")));assert.equal(app.host.querySelector("img"),null);assert.match(app.host.textContent,/图片未能解码，请下载原件查看/);assert.match(app.host.textContent,/正式版本已就绪/);assert.equal([...app.host.querySelectorAll("button")].find(button=>button.textContent==="下载此版本").disabled,false);
});
