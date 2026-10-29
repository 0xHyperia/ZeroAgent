import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const answerText="合成公开成品：这是一份完整工作方案，包含目标、步骤与交付结果。".repeat(20);
const row=(text=answerText,blocks)=>({key:"answer",kind:"assistant",origin:"history",turnKey:"answer",rounds:[{key:"answer:round:1",round:1,runningToolCallIds:[],blocks:blocks??[{kind:"text",id:"answer:text",text}]}]});
async function mount(t,{mode="streaming",streaming=false,assistant=row()}={}){
 let env;
 const nil=()=>null;
 const locale={locale:"zh-CN",t:key=>({"chat.work.activity":"已处理","chat.work.running":"处理中"}[key]??key)};
 env=await createWebDomTestEnv({mocks:{
  "@liveagent/ui/components/IconSet":new Proxy({}, {get:()=>nil}),
  [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx",import.meta.url))]:new Proxy({}, {get:()=>nil}),
  "lucide-react":new Proxy({}, {get:()=>nil}),
  "@liveagent/ui/i18n/LocaleContext":{useLocale:()=>locale},
  "@liveagent/ui/i18n/index":{useLocale:()=>locale},
  "@liveagent/ui/lib/chat/useCommitDetailsLoader":{useCommitDetailsLoader:()=>async()=>null},
  "@liveagent/ui/lib/transcript-virtual/useTranscriptNavigation":{useTranscriptNavigation:()=>{}},
  "@liveagent/ui/components/chat/UserAttachmentCards":{UserAttachmentCards:nil},
  "@liveagent/ui/components/chat/ChatEmptyState":{ChatEmptyState:nil},
  "@liveagent/ui/components/chat/ContextCheckpointCard":{ContextCheckpointCard:nil},
  "@liveagent/ui/components/chat/EditableUserMessageBubble":{EditableUserMessageBubble:nil},
  "@liveagent/ui/components/chat/RetryDetailsBlock":{RetryDetailsBlock:nil},
  "@liveagent/ui/lib/chat/userMessageContent":{UserMessageContent:props=>env.React.createElement("span",null,props.text)},
  "@liveagent/ui/components/chat/TranscriptMessageActions":{TranscriptUserMessageActions:nil,TranscriptAssistantMessageActions:nil},
  // Keep GatewayTranscript -> real shared AssistantBubble -> RoundContent ->
  // WorkTrace/LazyCollapse intact. Only leaf Markdown/tool visuals are replaced.
  "@liveagent/ui/components/Markdown":{Markdown:props=>env.React.createElement("div",{"data-markdown-leaf":""},props.content??props.children)},
  "@liveagent/ui/components/chat/StreamingSplitMarkdown":{StreamingSplitMarkdown:props=>env.React.createElement("div",{"data-markdown-leaf":""},props.content)},
  "@liveagent/ui/components/chat/assistant-bubble/ToolCallItem":{MemoToolCallItem:()=>env.React.createElement("div",{"data-tool-leaf":""},"SYNTHETIC_TOOL_LOG")},
  "@liveagent/ui/components/chat/assistant-bubble/ToolTraceGroup":{ToolTraceGroup:()=>env.React.createElement("div",{"data-tool-leaf":""},"SYNTHETIC_TOOL_LOG")},
  [fileURLToPath(new URL("../../../agent-ui/src/components/chat/assistant-bubble/ToolTraceGroup.tsx",import.meta.url))]:{ToolTraceGroup:()=>env.React.createElement("div",{"data-tool-leaf":""},"SYNTHETIC_TOOL_LOG")},
  "@liveagent/ui/components/chat/assistant-bubble/ToolImages":{getNativeDisplayImagePayload:()=>null,NativeDisplayImageBlock:nil},
  "@liveagent/ui/components/chat/assistant-bubble/CompactionSeamRow":{CompactionSeamRow:nil},
  "@liveagent/ui/components/chat/HostedSearchGroupView":{HostedSearchGroupView:nil},
  "@tanstack/react-virtual":{useVirtualizer:options=>({getVirtualItems:()=>Array.from({length:options.count},(_,index)=>({index,key:options.getItemKey(index),start:index*100,size:100,end:(index+1)*100})),getTotalSize:()=>options.count*100,measureElement:()=>{},scrollToEnd:()=>{},takeSnapshot:()=>[],getSettledScrollOffset:()=>0})},
 }});
 const {GatewayTranscript}=env.loadModule("src/components/GatewayTranscript.tsx");
 const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
 const render=async(next={})=>{if("assistant"in next)assistant=next.assistant;if("streaming"in next)streaming=next.streaming;await env.act(async()=>{root.render(env.React.createElement(GatewayTranscript,{conversationId:"cloud",rows:[assistant],isStreaming:streaming,...(mode===null?{}:{assistantLiveMode:mode}),activeTurnKey:streaming?"answer":null,liveStartIndex:streaming?0:-1}));await tick();});};
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 await render();return{env,host,render,async reload(){await env.act(async()=>{root.render(null);await tick();});await render();}};
}
function finalProse(host){return[...host.querySelectorAll("[data-markdown-leaf]")].filter(node=>!node.closest("[data-chat-work-trace]"));}

test("completed and refreshed Cloud prose is the visible shared answer without fabricated provider metadata",async(t)=>{
 const assistant=row(),app=await mount(t,{assistant});assert.equal(assistant.rounds[0].meta,undefined);
 assert.equal(app.host.querySelector("[data-chat-work-trace]"),null);assert.equal(finalProse(app.host)[0].textContent,answerText);
 await app.reload();assert.equal(app.host.querySelector("[data-chat-work-trace]"),null);assert.equal(finalProse(app.host)[0].textContent,answerText);
});

test("a manually collapsed active trace cannot hide the finished Cloud answer",async(t)=>{
 const app=await mount(t,{streaming:true,assistant:{...row(),origin:"stream"}}),work=app.host.querySelector("[data-chat-work-trace]");
 assert.ok(work);assert.equal(work.getAttribute("aria-busy"),"true");assert.equal(finalProse(app.host).length,0);
 await app.env.act(async()=>{work.querySelector("button").click();await tick();});assert.equal(work.querySelector("button").getAttribute("aria-expanded"),"false");
 await app.render({streaming:false,assistant:row()});assert.equal(app.host.querySelector("[data-chat-work-trace]"),null);assert.equal(finalProse(app.host)[0].textContent,answerText);
});

test("failed and interrupted-unknown saved partials remain visible answers and do not restart work",async(t)=>{
 for(const state of ["failed","interrupted"])await t.test(state,async(child)=>{
  const text=`${state}：已保存的合成部分答复`,app=await mount(child,{assistant:row(text)});
  assert.equal(finalProse(app.host)[0].textContent,text);assert.equal(app.host.querySelector('[aria-busy="true"]'),null);assert.equal(app.host.querySelector("[data-chat-work-trace]"),null);
  await app.reload();assert.equal(finalProse(app.host)[0].textContent,text);
 });
});

test("the retained local Agent default stays unchanged and work/reasoning blocks never enter the answer layer",async(t)=>{
 await t.test("default retained mode",async(child)=>{const app=await mount(child,{mode:null});assert.ok(app.host.querySelector("[data-chat-work-trace]"));assert.equal(finalProse(app.host).length,0);});
 await t.test("separate trace",async(child)=>{
  const blocks=[{kind:"thinking",id:"synthetic:thinking",text:"SYNTHETIC_PRIVATE_REASONING"},{kind:"tool",item:{toolCall:{id:"tool-1",name:"Read",arguments:{path:"synthetic.txt"}},toolResult:{content:"SYNTHETIC_TOOL_LOG"}}},{kind:"text",id:"answer:text",text:answerText}];
  const app=await mount(child,{assistant:row(answerText,blocks)}),work=app.host.querySelector("[data-chat-work-trace]");assert.ok(work);assert.equal(finalProse(app.host).at(-1).textContent,answerText);assert.ok(finalProse(app.host).every(node=>!node.textContent.includes("SYNTHETIC_PRIVATE_REASONING")&&!node.textContent.includes("SYNTHETIC_TOOL_LOG")));
  await app.env.act(async()=>{work.querySelector("button").click();await tick();});const tool=app.host.querySelector("[data-tool-leaf]");assert.ok(tool?.closest("[data-chat-work-trace]"));assert.ok(finalProse(app.host).some(node=>node.textContent===answerText));
  await app.env.act(async()=>{work.querySelector("[data-thinking-disclosure] button").click();await tick();});const syntheticReasoning=[...work.querySelectorAll("[data-markdown-leaf]")].find(node=>node.textContent==="SYNTHETIC_PRIVATE_REASONING");assert.ok(syntheticReasoning?.closest("[data-chat-work-trace]"));assert.ok(finalProse(app.host).every(node=>!node.textContent.includes("SYNTHETIC_PRIVATE_REASONING")));
 });
});

test("a real multi-megabyte Cloud answer remains a bounded preview in the shared answer DOM",async(t)=>{
 const complete="BEGIN\n"+"0123456789ABCDEFGHIJ\n".repeat(110000)+"END";
 const env=await createWebDomTestEnv();const {cloudMessageTranscriptPreview}=env.loadModule("src/lib/cloudChatMessagePreview.ts");env.cleanup();
 const preview=cloudMessageTranscriptPreview(complete),app=await mount(t,{assistant:row(`${preview.text}\n\n${preview.notice} [分段查看完整正文](cloud-messages/answer)`)});
 assert.ok(complete.length>2*1024*1024);assert.ok(app.host.textContent.length<6000);assert.equal(app.host.querySelector("[data-chat-work-trace]"),null);assert.match(finalProse(app.host)[0].textContent,/分段查看完整正文/);assert.ok(!app.host.textContent.includes("END"));
});
