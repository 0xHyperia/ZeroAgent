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

test("message reader reaches ordered sources and exact versions through one keyboard-navigable list", async (t) => {
  let env;
  const element = (tag) => ({ children }) => env.React.createElement(tag, null, children);
  env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/ui/dialog": { Dialog: element("div"), DialogContent: element("section"), DialogTitle: element("h2"), DialogDescription: element("p") },
  } });
  const { CloudChatMessageReader } = env.loadModule("src/components/cloudchat/CloudChatMessageReader.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); });
  const id = (value) => `12345678-1234-4234-8234-${String(value).padStart(12, "0")}`;
  const resources = [
    { kind: "artifact", id: id(2), name: "新成果", role: "output", version: 2 },
    { kind: "source", id: id(3), name: "授权来源", role: "source" },
    { kind: "file", id: id(4), name: "重复的工作附件", role: "input" },
    { kind: "source", id: "https://untrusted.invalid/file", name: "无效链接", role: "source" },
    ...Array.from({ length: 17 }, (_, index) => ({ kind: "source", id: id(index + 10), name: `额外来源 ${index + 1}`, role: "source" })),
  ];
  const opened = [];
  const message = {
    id: "message", role: "assistant",
    content: [
      { type: "text", text: "独立消息正文" },
      { type: "artifact_reference", version_id: id(1), name: "固定旧版", number: 1 },
      { type: "file_reference", file_id: id(4), name: "工作附件" },
    ],
    presentation: { version: 1, blocks: [
      { id: "tool:0", type: "tool", round: 0, state: "succeeded", name: "publish_artifact", resources },
      { id: "tool:1", type: "tool", round: 0, state: "failed", name: "publish_artifact", resources: [
        { kind: "artifact", id: id(5), name: "待核对成果", role: "output", version: 3 },
      ] },
    ] },
  };
  await env.act(async () => root.render(env.React.createElement(CloudChatMessageReader, {
    message, onRetry() {}, onClose() {}, captureGuard: () => () => {},
    onOpenFile: (id) => opened.push(["file", id]),
    onOpenArtifact: (id) => opened.push(["artifact", id]),
    onOpenFileLink: (link) => opened.push(["link", link.path]),
  })));
  assert.doesNotMatch(host.textContent, /固定旧版|授权来源/);
  const tabs = [...host.querySelectorAll('[role="tab"]')];
  const right = (tab) => tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await env.act(async () => { tabs[0].focus(); right(tabs[0]); });
  assert.equal(document.activeElement, tabs[1]);
  await env.act(async () => right(tabs[1]));
  assert.equal(document.activeElement, tabs[2]);
  assert.equal(tabs[2].getAttribute("aria-selected"), "true");
  const related = host.querySelector('[data-message-reader-section="resources"]');
  const buttons = [...related.querySelectorAll("button")];
  assert.equal(buttons.length, 20);
  assert.deepEqual(buttons.slice(0, 4).map((button) => button.textContent), ["固定旧版 · v1输入资料", "工作附件输入资料", "新成果 · v2产出", "授权来源来源"]);
  assert.doesNotMatch(related.textContent, /无效链接|重复的工作附件|独立消息正文/);
  await env.act(async () => { for (const button of buttons.slice(0, 4)) button.click(); });
  assert.deepEqual(opened, [["artifact", id(1)], ["file", id(4)], ["link", `cloud-artifacts/${id(2)}`], ["link", `cloud-sources/${id(3)}`]]);
  await env.act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === "下一页").click());
  assert.match(related.textContent, /待核对成果 · v3待核对/);
  assert.equal(related.querySelectorAll("button").length, 2);
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
