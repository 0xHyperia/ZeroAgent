import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

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
