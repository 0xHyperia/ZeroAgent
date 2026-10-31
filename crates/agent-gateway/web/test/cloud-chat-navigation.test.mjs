import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function setup(t) {
  const icons = new Proxy({}, { get: () => () => null });
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": icons,
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url))]: icons,
  } });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); });
  const render = async (node) => env.act(async () => { root.render(node); await tick(); });
  const click = async (label) => env.act(async () => {
    const button = [...document.querySelectorAll("button")].find((node) => node.textContent === label);
    assert.ok(button, label); button.click(); await tick();
  });
  return { env, host, render, click };
}

test("project edits protect navigation and unload; a retired account cannot confirm old navigation", async (t) => {
  const app = await setup(t);
  const { useUnsavedChangesPrompt } = app.env.loadModule("../../agent-ui/src/application/useUnsavedChangesPrompt.tsx");
  let prompt;
  let navigations = 0;
  function Harness({ account }) {
    prompt = useUnsavedChangesPrompt(account);
    return app.env.React.createElement("div", null,
      app.env.React.createElement("button", { onClick: () => prompt.request(() => navigations++) }, "离开"), prompt.dialog);
  }
  await app.render(app.env.React.createElement(Harness, { account: "a" }));
  prompt.setDirty(true);
  const unload = new window.Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  await app.click("离开"); assert.equal(navigations, 0);
  assert.match(document.querySelector('[role="alertdialog"]').textContent, /未保存/);
  await app.click("继续编辑"); assert.equal(navigations, 0);
  await app.click("离开");
  await app.render(app.env.React.createElement(Harness, { account: "b" }));
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
  assert.equal(navigations, 0);
  prompt.setDirty(true);
  await app.click("离开"); await app.click("放弃修改并离开");
  assert.equal(navigations, 1);
});

test("the same resource shell renders an accessible full page without a modal or backdrop", async (t) => {
  const app = await setup(t);
  const { CloudChatResourcePanel, CloudChatResourcePresentation } = app.env.loadModule("src/components/cloudchat/CloudChatResourcePanel.tsx");
  let closed = 0;
  await app.render(app.env.React.createElement(CloudChatResourcePresentation.Provider, { value: "page" },
    app.env.React.createElement(CloudChatResourcePanel, { title: "文件库", description: "账户资料", onClose: () => closed++ }, "受保护的资料内容")));
  assert.ok(app.host.querySelector('[data-cloud-resource-page]'));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(document.querySelector('[data-slot="sheet-backdrop"]'), null);
  await app.click("返回对话"); assert.equal(closed, 1);
});

test("a project list arriving after account retirement never enters the navigation", async (t) => {
  const app = await setup(t);
  const { CloudChatProjectNavigation } = app.env.loadModule("src/components/cloudchat/CloudChatProjectNavigation.tsx");
  let retired = false, finish;
  const client = { listProjects: () => new Promise((resolve) => { finish = resolve; }) };
  const captureGuard = () => () => { if (retired) throw new Error("retired account"); };
  await app.render(app.env.React.createElement(CloudChatProjectNavigation, { client, captureGuard, revision: 0, onOpen() {}, onCreate() {} }));
  retired = true;
  await app.env.act(async () => { finish({ items: [{ id: "private-a", name: "PRIVATE_PROJECT_A" }] }); await tick(); });
  assert.doesNotMatch(app.host.textContent, /PRIVATE_PROJECT_A/);
});


test("new-project shortcuts use the creation dialog callback while existing projects keep their own navigation",async(t)=>{
 const app=await setup(t),opened=[];let created=0;
 const {CloudChatProjectNavigation}=app.env.loadModule("src/components/cloudchat/CloudChatProjectNavigation.tsx");
 await app.render(app.env.React.createElement(CloudChatProjectNavigation,{client:{listProjects:async()=>({items:[]})},captureGuard:()=>()=>{},revision:0,onOpen:id=>opened.push(id),onCreate:()=>created++}));
 await app.env.act(async()=>{document.querySelector('button[aria-label="新建项目"]').click();await tick();});
 await app.click("创建第一个项目");assert.equal(created,2);assert.deepEqual(opened,[]);
});

test("project groups load on expansion, retain collapse state, highlight and open their own conversations", async t => {
 const app=await setup(t),opened=[],created=[];let reads=0;
 const {CloudChatProjectNavigation}=app.env.loadModule("src/components/cloudchat/CloudChatProjectNavigation.tsx");
 const project={id:"p",name:"研发项目"};
 const client={listProjects:async()=>({items:[project]}),listConversations:async()=>{reads++;return {items:[{conversation_id:"c",created_at:"2026-11-01",conversation:{title:"项目内的方案",updated_at:"2026-11-01"}},{conversation_id:"archived",conversation:{title:"归档内容",archived:true}}],next_before_id:""};}};
 const props={client,captureGuard:()=>()=>{},revision:0,onOpen(){},onCreate(){},onNewConversation:p=>created.push(p.id),onOpenConversation:id=>opened.push(id),currentConversationId:"c"};
 await app.render(app.env.React.createElement(CloudChatProjectNavigation,props));assert.equal(reads,0);
 await app.click("研发项目");assert.equal(reads,1);assert.doesNotMatch(app.host.textContent,/归档内容/);
 assert.equal(app.host.querySelector('.cloud-project-conversation[aria-current="page"]').textContent,"项目内的方案");
 await app.click("项目内的方案");assert.deepEqual(opened,["c"]);
 await app.env.act(async()=>{app.host.querySelector('[aria-label="在研发项目中新建对话"]').click();await tick();});assert.deepEqual(created,["p"]);
 await app.click("研发项目");assert.equal(app.host.querySelector('.cloud-project-disclosure').getAttribute('aria-hidden'),"true");
 await app.click("研发项目");assert.equal(reads,1);
});

test("a selected project outside the first five is revealed, and late membership reads are retired", async t => {
 const app=await setup(t);let finish,retired=false;
 const {CloudChatProjectNavigation}=app.env.loadModule("src/components/cloudchat/CloudChatProjectNavigation.tsx");
 const client={listProjects:async()=>({items:Array.from({length:6},(_,i)=>({id:`p${i}`,name:`项目${i}`}))}),listConversations:()=>new Promise(resolve=>finish=resolve)};
 await app.render(app.env.React.createElement(CloudChatProjectNavigation,{client,captureGuard:()=>()=>{if(retired)throw Error('retired');},revision:0,activeProjectId:"p5",onOpen(){},onCreate(){}}));
 assert.equal([...app.host.querySelectorAll('[aria-expanded="true"]')][0].textContent,"项目5");
 retired=true;await app.env.act(async()=>{finish({items:[{conversation_id:"private",conversation:{title:"PRIVATE_MEMBER"}}],next_before_id:""});await tick();});
 assert.doesNotMatch(app.host.textContent,/PRIVATE_MEMBER/);
});
