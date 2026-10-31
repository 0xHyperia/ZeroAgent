import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test("full process reader is explicit, paged and independent from canonical answer copy",async t=>{
  let env;
  const element=tag=>({children})=>env.React.createElement(tag,null,children);
  env=await createWebDomTestEnv({mocks:{
    "@liveagent/ui/components/ui/dialog":{Dialog:element("div"),DialogContent:element("section"),DialogTitle:element("h2"),DialogDescription:element("p")},
  }});
  const {CloudChatMessageReader}=env.loadModule("src/components/cloudchat/CloudChatMessageReader.tsx");
  const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
  const message={id:"msg",role:"assistant",content:"VISIBLE_CANONICAL_ANSWER",presentation:{version:1,blocks:[{id:"reasoning:0",type:"reasoning",round:0,text:"BEGIN_PROCESS\n"+"READING_EXCERPT ".repeat(1800)+"END_PROCESS"},{id:"text:0",type:"text",round:0,text:"VISIBLE_CANONICAL_ANSWER"}]}};
  t.after(async()=>{await env.act(async()=>root.unmount());env.cleanup();});
  await env.act(async()=>root.render(env.React.createElement(CloudChatMessageReader,{message,onRetry(){},onClose(){},onOpenFile(){},onOpenArtifact(){},captureGuard:()=>()=>{}})));
  assert.match(host.querySelector("pre").textContent,/VISIBLE_CANONICAL_ANSWER/);assert.doesNotMatch(host.querySelector("pre").textContent,/BEGIN_PROCESS/);
  await env.act(async()=>[...host.querySelectorAll('[role="tab"]')].find(n=>n.textContent==="工作过程").click());
  assert.equal(host.querySelector('[aria-selected="true"]').textContent,"工作过程");
  assert.match(host.querySelector("pre").textContent,/BEGIN_PROCESS/);assert.ok(host.querySelector("pre").textContent.length<=8192);assert.doesNotMatch(host.querySelector("pre").textContent,/END_PROCESS/);
  assert.match(host.textContent,/下载完整工作过程/);
  await env.act(async()=>[...host.querySelectorAll("button")].find(n=>n.textContent==="末段").click());
  assert.match(host.querySelector("pre").textContent,/END_PROCESS/);assert.ok(host.querySelector("pre").textContent.length<=8192);
  await env.act(async()=>[...host.querySelectorAll('[role="tab"]')].find(n=>n.textContent==="消息正文").click());
  assert.equal(host.querySelector("pre").textContent,"VISIBLE_CANONICAL_ANSWER");
});

test("usage details display only provided counters, preserving unknown values",async t=>{
  let env;const nil=()=>null;
  env=await createWebDomTestEnv({mocks:{
    "@liveagent/ui/i18n/index":{useLocale:()=>({locale:"en-US",t:key=>key})},
    "@liveagent/ui/components/IconSet":new Proxy({},{get:()=>nil}),
  }});
  const {UsagePanel}=env.loadModule("@liveagent/ui/components/chat/UsagePanel.tsx");
  const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
  t.after(async()=>{await env.act(async()=>root.unmount());env.cleanup();});
  await env.act(async()=>root.render(env.React.createElement(UsagePanel,{usage:{totalTokens:42}})));
  assert.equal(host.querySelectorAll("dt").length,1);assert.equal(host.querySelector("dd").textContent,"42");assert.doesNotMatch(host.textContent,/cost|USD|费用/);
});
