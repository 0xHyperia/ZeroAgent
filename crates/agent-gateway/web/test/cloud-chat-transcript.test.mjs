import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const load = () => createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudChatTranscript.ts");
const start="2026-10-31T01:00:00Z", end="2026-10-31T01:00:04Z";
const options={live:false,fallbackText:"CANONICAL",mapText:text=>text};
const message=(blocks,more={})=>({id:"message-a",role:"assistant",content:"CANONICAL",created_at:start,presentation:{version:1,model:"prior-model",state:"completed",reasoning_effort:"high",blocks,...more}});
const prose={id:"text:1",type:"text",round:1,text:"CANONICAL"};

test("a verified extension draft remains actionable even without a model-written citation",()=>{
 const id="36e2b5c0-8c13-4f81-825c-f5d8a9a1d021";
 const api=load(), block={id:"tool:t1",type:"tool",round:0,name:"prepare_extension",state:"succeeded",
  resources:[{kind:"extension-draft",id,name:"review-helper",role:"output"}]};
 const [draft]=api.cloudChatAssistantDeliverables(message([block,prose]));
 assert.equal(draft.status,"draft");
 assert.equal(draft.link.path,`cloud-extension-drafts/${id}`);
 assert.deepEqual(api.cloudChatAssistantDeliverables(message([{...block,state:"unknown"},prose])),[]);
});

test("cloud projection preserves ordered rounds, real process status and per-round usage without fabricated cost",()=>{
  const api=load(),m=message([
    {id:"reasoning:0",type:"reasoning",round:0,text:"PUBLIC_REASONING",started_at:start,completed_at:end},
    {id:"tool:t1",type:"tool",round:0,name:"read_file",state:"succeeded",status:"读取资料",started_at:start,completed_at:end},
    prose,
  ],{completed_at:end,rounds:[{round:0,model:"prior-model",started_at:start,completed_at:end,usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}},{round:1,model:"prior-model",usage:{total_tokens:30}}]});
  const rounds=api.cloudChatAssistantRounds(m,options);
  assert.equal(rounds.length,2);assert.equal(rounds[0].blocks[0].kind,"thinking");assert.equal(rounds[0].blocks[0].durationMs,4000);
  assert.deepEqual(rounds[0].blocks[1].item.publicStatus,{label:"读取文件",state:"succeeded",durationMs:4000});
  assert.deepEqual(rounds[0].blocks[1].item.toolCall.arguments,{});assert.equal(rounds[0].blocks[1].item.toolResult,undefined);
  assert.deepEqual(rounds[0].meta.tokenUsage,{input:100,output:20,totalTokens:120});assert.equal(rounds[0].meta.usage,undefined);
  assert.deepEqual(rounds[1].meta.tokenUsage,{input:undefined,output:undefined,totalTokens:30});assert.equal(rounds[1].meta.model,"prior-model");
  assert.equal(api.cloudChatMessageTimestamp(m),Date.parse(end));
  assert.deepEqual(api.cloudChatAssistantRounds(structuredClone(m),options),rounds);
});

test("legacy, omitted and incomplete snapshots keep the canonical reply without inventing reasoning",()=>{
  const api=load();for(const m of [message([prose],{blocks:[]}),{...message([prose]),presentation_omitted:true},{id:"a",role:"assistant",content:"CANONICAL"}]){
    const rounds=api.cloudChatAssistantRounds(m,options);assert.equal(rounds.length,1);assert.equal(rounds[0].blocks[0].text,"CANONICAL");assert.ok(rounds[0].blocks.every(block=>block.kind==="text"));
  }
});

test("exact paragraph-separated canonical bodies preserve ordered reasoning and tools through restoration",()=>{
 const api=load(),blocks=[{id:"reasoning:0",round:0,type:"reasoning",text:"PUBLIC_FIRST"},{id:"text:0",round:0,type:"text",text:"第一段"},{id:"tool:0",round:0,type:"tool",name:"publish_artifact",state:"succeeded"},{id:"reasoning:1",round:1,type:"reasoning",text:"PUBLIC_SECOND"},{id:"text:1",round:1,type:"text",text:"第二段"}],m={...message(blocks),content:"第一段\n\n第二段"};
 const opts={...options,fallbackText:m.content},rounds=api.cloudChatAssistantRounds(m,opts),rendered=rounds.flatMap(round=>round.blocks);
 assert.deepEqual(rendered.map(block=>block.kind),["thinking","text","tool","thinking","text"]);
 assert.equal(rendered.filter(block=>block.kind==='text').map(block=>block.text).join(''),m.content);
 assert.equal(rendered[2].item.publicStatus.state,"succeeded");
 assert.deepEqual(api.cloudChatAssistantRounds(structuredClone(m),opts),rounds);
 assert.equal(m.presentation.blocks[4].text,"第二段","projection data is never rewritten");
 const continuous={...m,content:"第一段第二段"},continuousRounds=api.cloudChatAssistantRounds(continuous,{...opts,fallbackText:continuous.content});
 assert.equal(continuousRounds.flatMap(round=>round.blocks).filter(block=>block.kind==='text').map(block=>block.text).join(''),continuous.content);
});

test("a genuinely mismatched process cannot replace the canonical answer and remains explicitly accessible",()=>{
 const api=load(),m=message([{id:"reasoning:0",round:0,type:"reasoning",text:"PUBLIC_REASONING"},{id:"tool:0",round:0,type:"tool",name:"execute_code",state:"unknown"},{id:"text:0",round:0,type:"text",text:"OLD_OR_RESUMED_SUFFIX"}],{usage:{total_tokens:24},state:"interrupted"});
 const rounds=api.cloudChatAssistantRounds(m,options);
 assert.equal(rounds.length,1);assert.equal(rounds[0].blocks[0].text,"CANONICAL");
 assert.deepEqual(rounds[0].blocks.map(block=>block.kind),["text","text"]);
 assert.equal(rounds[0].blocks[1].text,"[查看完整工作过程](cloud-messages/message-a)");
 assert.doesNotMatch(JSON.stringify(rounds[0].blocks),/OLD_OR_RESUMED_SUFFIX|PUBLIC_REASONING/);
 assert.equal(rounds[0].meta.outcome,"interrupted");assert.equal(rounds[0].meta.tokenUsage.totalTokens,24);
 assert.match(api.cloudChatProcessText(m.presentation),/PUBLIC_REASONING/);
 for(const content of [' OLD_OR_RESUMED_SUFFIX','OLD_OR_RESUMED_SUFFIX\n','OLD_OR_RESUMED_SUFFIX extra']){
  const result=api.cloudChatAssistantRounds({...m,content},{...options,fallbackText:content});
  assert.equal(result[0].blocks[0].text,content);assert.match(result[0].blocks[1].text,/查看完整工作过程/);
 }
});

test("large reasoning stays bounded in the transcript and remains complete in the paged process reader",()=>{
  const api=load(),reasoning="SYNTHETIC_REASONING ".repeat(20000),m=message([{id:"reasoning:0",round:0,type:"reasoning",text:reasoning},prose]);
  const rounds=api.cloudChatAssistantRounds(m,options),thinking=rounds.flatMap(r=>r.blocks).find(b=>b.kind==="thinking");
  assert.ok(thinking.text.length<8500);assert.match(thinking.text,/查看完整工作过程/);assert.ok(api.cloudChatProcessText(m.presentation).includes(reasoning));
  assert.equal(rounds.at(-1).blocks.at(-1).text,"CANONICAL");
});

test("only active tools and the current reasoning segment receive live affordances",()=>{
  const api=load(),m=message([{id:"tool:t1",type:"tool",round:0,name:"execute_code",state:"unknown",status:"执行代码"},{id:"reasoning:1",type:"reasoning",round:1,text:"PUBLIC"}],{state:"running"});m.content="";
  let rounds=api.cloudChatAssistantRounds(m,{...options,live:true});assert.deepEqual(rounds[0].runningToolCallIds,[]);assert.equal(rounds[1].thinkingOpen,true);
  rounds=api.cloudChatAssistantRounds(m,options);assert.equal(rounds[1].thinkingOpen,false);assert.match(api.cloudChatProcessText(m.presentation),/结果待确认/);
});

test("public tool receipt renders state updates without exposing native arguments, results or controls",async t=>{
  let env;const nil=()=>null;
  env=await createWebDomTestEnv({mocks:{
    "@liveagent/ui/i18n/index":{useLocale:()=>({t:key=>key,locale:"zh-CN"})},
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx",import.meta.url))]:new Proxy({},{get:()=>nil}),
  }});
  const {PublicToolActivity}=env.loadModule("@liveagent/ui/components/chat/assistant-bubble/PublicToolActivity.tsx");
  const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
  t.after(async()=>{await env.act(async()=>root.unmount());env.cleanup();});
  const item={toolCall:{id:"id",name:"execute_code",arguments:{SECRET:"must-never-render"}},toolResult:{content:"PRIVATE_RAW_RESULT"},publicStatus:{label:"分析表格",state:"executing"}};
  await env.act(async()=>root.render(env.React.createElement(PublicToolActivity,{item,isRunning:true})));
  assert.match(host.textContent,/分析表格.*chat.tool.running/);assert.equal(host.querySelectorAll("button").length,0);
  await env.act(async()=>root.render(env.React.createElement(PublicToolActivity,{item:{...item,publicStatus:{...item.publicStatus,state:"unknown"}}})));
  assert.match(host.textContent,/chat.tool.unknown/);assert.doesNotMatch(host.textContent,/must-never-render|PRIVATE_RAW_RESULT|chat.tool.success/);
});
