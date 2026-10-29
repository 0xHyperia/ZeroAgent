import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";
const loader=()=>createWebModuleLoader();

test("public-topic consent validates exact bounded UTF-8 and does not retain unknown response metadata",()=>{
 const api=loader().loadModule("src/lib/cloudChatResearch.ts");
 const input={topic:"  approved topic  "},snapshot=api.parseCloudChatPublicResearch(input);input.topic="private mutation";assert.deepEqual(snapshot,{topic:"approved topic"});
 assert.deepEqual(api.parseCloudChatPublicResearch({topic:"public",future_metadata:{secret:"never retain"}},true),{topic:"public"});
 for(const value of [null,{},{topic:""},{topic:"a\0b"},{topic:"中".repeat(3000)},{topic:"ok",scope:"forged"}])assert.throws(()=>api.parseCloudChatPublicResearch(value),/公开检索|8 KiB/);
 assert.equal(api.initialCloudResearchTopic("private "+"x".repeat(2*1024*1024)),"");
});

test("Run snapshots project consent metadata and unknown acceptance retries keep the exact approved topic body",async()=>{
 const api=loader().loadModule("src/lib/cloudChatRuns.ts"),bodies=[];let accepted;
 const base={id:"run",conversation_id:"conversation",client_request_id:"request",model:"m",state:"queued",user_message_id:"u",assistant_message_id:"a",output:"",last_seq:"1",public_research:{topic:"approved public topic",unknown_secret:"discard"}};
 const parsed=api.parseCloudChatRun(base);assert.deepEqual(parsed.public_research,{topic:"approved public topic"});base.public_research.topic="mutated";assert.equal(parsed.public_research.topic,"approved public topic");
 const client=api.createCloudChatRunsClient(async(path,init)=>{if(init?.method==="POST"){bodies.push(init.body);accepted={...base,public_research:{topic:"approved public topic"}};throw new Error("response lost");}return Response.json({runs:[accepted]});});
 const request={conversation_id:"conversation",client_request_id:"request",model:"m",content:"private combined task",public_research:{topic:"approved public topic"}};
 assert.equal((await client.createRun(request)).id,"run");assert.ok(bodies.every(body=>body===bodies[0]));assert.deepEqual(JSON.parse(bodies[0]).public_research,{topic:"approved public topic"});assert.equal(JSON.parse(bodies[0]).content,"private combined task");
 let calls=0;const invalid=api.createCloudChatRunsClient(async()=>{calls++;return Response.json({run:accepted});});await assert.rejects(invalid.createRun({...request,public_research:{topic:"ok",scope:"browser forged"}}),/公开检索/);assert.equal(calls,0);
});
