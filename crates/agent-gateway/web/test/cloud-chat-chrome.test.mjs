import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function mount(t, path, name, props, compact = false) {
  const icons = new Proxy({}, { get: () => () => null });
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": icons,
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url))]: icons,
  } });
  window.matchMedia = () => ({ matches: compact, addEventListener() {}, removeEventListener() {} });
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  t.after(async () => { await env.act(async () => root.unmount()); container.remove(); env.cleanup(); });
  const Component = env.loadModule(path)[name];
  await env.act(async () => { root.render(env.React.createElement(Component, props)); await tick(); });
  return { env, async click(selector) { const target = document.querySelector(selector); assert.ok(target, selector); await env.act(async () => { target.click(); await tick(); }); } };
}

for (const compact of [false, true]) {
  test(`resource panel uses ${compact ? "a narrow modal" : "an unobscured wide layout"} and keeps close reachable`, async (t) => {
    let closed = 0;
    const app = await mount(t, "src/components/cloudchat/CloudChatResourcePanel.tsx", "CloudChatResourcePanel", {
      title: "文件库", description: "账户资料", closeLabel: "关闭文件库", onClose: () => { closed++; }, children: "正式文件",
    }, compact);
    assert.ok(document.querySelector('[data-cloud-resource-panel]'));
    assert.equal(Boolean(document.querySelector('[data-slot="sheet-backdrop"]')), compact);
    assert.match(document.querySelector('[role="dialog"]').textContent, /文件库.*账户资料.*正式文件/s);
    if (!compact) {
      const outside = document.body.appendChild(document.createElement("button"));
      outside.textContent = "继续编辑对话";
      await app.env.act(async () => { outside.focus(); outside.click(); await tick(); });
      assert.equal(document.activeElement, outside);
      assert.equal(closed, 0, "wide resource work must survive returning to the conversation");
      outside.remove();
    }
    await app.click('[aria-label="关闭文件库"]');
    assert.equal(closed, 1);
  });
}


const project = (id, name) => ({ id, name, description: "", instructions: "", version: 1, created_at: "", updated_at: "" });
const firstProject = project("11111111-1111-4111-8111-111111111111", "Zero");
const secondProject = project("22222222-2222-4222-8222-222222222222", "Dubhe");
const headerProps = (extra={}) => ({title:"原对话", disabled:false, deleteDisabled:false, moveDisabled:false, pinned:false, archived:false,
  projectsClient:{listProjects:async()=>({items:[firstProject],next_before_id:""})},captureGuard:()=>()=>{},
  onRename(){},onTogglePinned(){},onToggleArchived(){},onDelete:async()=>{},onMoveToProject:async()=>{},onError(){},...extra});
async function clickMenu(app, label) {
  const item=[...document.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent.trim()===label);
  assert.ok(item, label);await app.env.act(async()=>{item.click();await tick();});
}
for (const compact of [false,true]) test(`conversation menu exposes only five actions in ${compact?"mobile":"desktop"} layout`,async(t)=>{
  let renamed=0,pinned=0;const app=await mount(t,"src/components/cloudchat/CloudChatHeaderActions.tsx","CloudChatHeaderActions",headerProps({onRename(){renamed++;},onTogglePinned(){pinned++;}}),compact);
  assert.equal(document.querySelector('[aria-label="对话资料与项目"]'),null);
  await app.click('[aria-label="对话选项"]');
  assert.deepEqual([...document.querySelectorAll('[role="menuitem"]')].map(node=>node.textContent.trim()),["重命名","置顶","归档","删除","移至项目"]);
  assert.doesNotMatch(document.body.textContent,/模型参数|导出 Markdown|导出 JSON|来源资料|文件库/);
  await clickMenu(app,"重命名");assert.equal(renamed,1);
  await app.click('[aria-label="对话选项"]');await clickMenu(app,"置顶");assert.equal(pinned,1);
});
test("move submenu loads all project pages and routes the chosen project without creating one",async(t)=>{
  const reads=[],moves=[];const app=await mount(t,"src/components/cloudchat/CloudChatHeaderActions.tsx","CloudChatHeaderActions",headerProps({projectsClient:{listProjects:async(cursor="")=>{reads.push(cursor);return {items:[cursor?secondProject:firstProject],next_before_id:cursor?"":"next"};}},onMoveToProject:async(value)=>moves.push(value)}));
  await app.click('[aria-label="对话选项"]');await clickMenu(app,"移至项目");
  assert.deepEqual(reads,[""]);await clickMenu(app,"加载更多项目");assert.deepEqual(reads,["","next"]);
  await clickMenu(app,"Dubhe");assert.deepEqual(moves,[secondProject]);
});
test("deletion requires explicit confirmation and cancellation keeps the conversation",async(t)=>{
  let removed=0;const app=await mount(t,"src/components/cloudchat/CloudChatHeaderActions.tsx","CloudChatHeaderActions",headerProps({onDelete:async()=>{removed++;}}));
  await app.click('[aria-label="对话选项"]');await clickMenu(app,"删除");assert.equal(removed,0);
  let cancel=[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==="取消");assert.ok(cancel);await app.env.act(async()=>{cancel.click();await tick();});assert.equal(removed,0);
  await app.click('[aria-label="对话选项"]');await clickMenu(app,"删除");
  let accept=[...document.querySelectorAll('[role="alertdialog"] button')].find(node=>node.textContent.trim()==="删除");assert.ok(accept);await app.env.act(async()=>{accept.click();await tick();});assert.equal(removed,1);
});
test("creating a project then retrying its association never creates a duplicate project",async(t)=>{
  let creates=0,moves=0;const app=await mount(t,"src/components/cloudchat/CloudChatHeaderActions.tsx","CloudChatHeaderActions",headerProps({projectsClient:{listProjects:async()=>({items:[],next_before_id:""}),createProject:async()=>{creates++;return firstProject;}},onMoveToProject:async()=>{moves++;if(moves===1)throw new Error("关联冲突，请重试");}}));
  await app.click('[aria-label="对话选项"]');await clickMenu(app,"移至项目");await clickMenu(app,"新建项目");
  const input=document.querySelector('input[aria-label="项目名称"]');assert.ok(input);
  await app.env.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(input,"Zero");input.dispatchEvent(new Event("input",{bubbles:true}));await tick();});
  const submit=async()=>app.env.act(async()=>{document.querySelector('form').dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));await tick();});
  await submit();assert.equal(creates,1);assert.equal(moves,1);assert.match(document.body.textContent,/重试移入项目/);
  await submit();assert.equal(creates,1);assert.equal(moves,2);assert.equal(document.querySelector('input[aria-label="项目名称"]'),null);
});

test("an unknown project creation stays blocked after closing and reopening the dialog",async(t)=>{
  let creates=0;
  const app=await mount(t,"src/components/cloudchat/CloudChatHeaderActions.tsx","CloudChatHeaderActions",headerProps({projectsClient:{listProjects:async()=>({items:[],next_before_id:""}),createProject:async()=>{creates++;const Unknown=app.env.loadModule("src/lib/cloudChatProjects.ts").CloudWorkUnconfirmedError;throw new Unknown();}}}));
  const open=async()=>{await app.click('[aria-label="对话选项"]');await clickMenu(app,"移至项目");await clickMenu(app,"新建项目");};
  await open();const input=document.querySelector('input[aria-label="项目名称"]');
  await app.env.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(input,"待核对项目");input.dispatchEvent(new Event("input",{bubbles:true}));await tick();document.querySelector('form').dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));await tick();});
  assert.equal(creates,1);assert.match(document.body.textContent,/创建结果尚未确认/);
  await app.click('[aria-label="关闭新建项目"]');await open();
  assert.equal(document.querySelector('input[aria-label="项目名称"]').disabled,true);
  assert.equal([...document.querySelectorAll('button')].find(node=>node.textContent.trim()==="创建并移入").disabled,true);
  assert.equal(creates,1);
});
