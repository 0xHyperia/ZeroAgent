import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

const load=()=>createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudChatBranches.ts");
const receipt={conversation:{id:"new",title:"新分支",model:"model",updated_at:"2026-10-29"},source_conversation_id:"source",source_message_id:"message",action:"fork"};
const input={client_request_id:"stable-request",message_id:"message",action:"fork"};
const safe=()=>()=>undefined;

test("branch loss is explicit and the original receipt is looked up before another same-ID attempt",async()=>{
 const api=load(),calls=[];let stored=false;
 const client=api.createCloudChatBranchesClient(async(path,init={})=>{calls.push({path,init});if(init.method==="POST"){stored=true;throw new Error("lost");}return Response.json({branch:receipt});},safe);
 await assert.rejects(client.create("source",input),api.CloudBranchUnconfirmedError);assert.equal(stored,true);assert.equal(calls.length,1);
 assert.deepEqual(await client.find(input.client_request_id),receipt);assert.equal(calls[1].path,"/api/web-chat/branches/stable-request");
 assert.equal(calls.filter(call=>call.init.method==="POST").length,1);
});

test("an absent receipt permits a caller to retry the exact original branch request",async()=>{
 const api=load(),bodies=[];
 const client=api.createCloudChatBranchesClient(async(path,init={})=>{if(path.includes("/branches/"))return Response.json({error:"missing"},{status:404});bodies.push(init.body);if(bodies.length===1)throw new Error("offline before acceptance");return Response.json({branch:receipt},{status:201});},safe);
 await assert.rejects(client.create("source",input),api.CloudBranchUnconfirmedError);assert.equal(await client.find(input.client_request_id),null);
 await client.create("source",input);assert.equal(bodies[0],bodies[1]);
});

test("definitive branch rejections and changed accounts do not masquerade as a retryable accepted branch",async()=>{
 const api=load();const rejected=api.createCloudChatBranchesClient(async()=>Response.json({error:"active source"},{status:409}),safe);
 await assert.rejects(rejected.create("source",input),error=>error instanceof api.CloudBranchRequestError&&error.status===409);
 let owner=1,release;
 const changed=api.createCloudChatBranchesClient(async()=>new Response(new ReadableStream({start(controller){release=()=>{owner=2;controller.enqueue(new TextEncoder().encode(JSON.stringify({branch:receipt})));controller.close();};}})),()=>{const captured=owner;return()=>{if(owner!==captured)throw new Error("Account changed");};});
 const pending=changed.create("source",input);await Promise.resolve();release();await assert.rejects(pending,/Account changed/);
});

test("exports preserve the account guard through bounded Blob creation and immediate download use",async()=>{
 const api=load();let owner=1;
 const client=api.createCloudChatBranchesClient(async()=>new Response("# 合成导出"),()=>{const captured=owner;return()=>{if(captured!==owner)throw new Error("Account changed");};});
 const result=await client.exportConversation("source","markdown");assert.equal(result.filename,"zeroagent-conversation.md");assert.equal(await result.blob.text(),"# 合成导出");owner=2;assert.throws(result.guard,/Account changed/);
 const oversized=api.createCloudChatBranchesClient(async()=>new Response("x",{headers:{"Content-Length":String(35*1024*1024)}}),safe);
 await assert.rejects(oversized.exportConversation("source","json"),/大小限制/);
});
