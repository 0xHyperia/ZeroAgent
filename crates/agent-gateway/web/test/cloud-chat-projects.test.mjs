import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const projectId = "d2ea0700-a200-4000-8000-000000000001";
const conversationId = "d2ea0700-a200-4000-8000-000000000002";
const memoryId = "d2ea0700-a200-4000-8000-000000000003";
const fileId = "d2ea0700-a200-4000-8000-000000000004";
const secondFileId = "d2ea0700-a200-4000-8000-000000000005";
const now = "2026-10-29T00:00:00Z";
const project = () => ({ id: projectId, name: "Research", description: "work", instructions: "project instructions", version: 1, created_at: now, updated_at: now });
const memory = () => ({ id: memoryId, content: "explicit user preference", enabled: true, version: 1, created_at: now, updated_at: now });
const file = (id = fileId) => ({ id, conversation_id: conversationId, name: `${id.slice(-1)}.txt`, state: "ready", mime: "text/plain", size: 3, text_bytes: 3, version: 1, sha256: "a".repeat(64), created_at: now, updated_at: now });
const binding = () => ({ conversation_id: conversationId, project_id: "", version: 0, created_at: now });
const page = (items) => ({ items, next_before_id: "" });

test("project and memory client uses account cookies, bounded pages and explicit CAS", async () => {
  const loader = createWebModuleLoader();
  const { createCloudChatProjectsClient } = loader.loadModule("src/lib/cloudChatProjects.ts");
  const calls = [];
  const client = createCloudChatProjectsClient(async (url, init) => { calls.push({ url, init }); if (url.includes("/conversations/")) return Response.json(binding()); if (url.endsWith("memory-settings")) return Response.json({ enabled: true, version: 1, updated_at: now }); if (url.includes("?")) return Response.json(page([project()])); return Response.json(project()); }, () => () => {});
  await client.listProjects();
  await client.updateProject(project(), { name: "draft", description: "", instructions: "explicit instruction" });
  await client.setAssociation(conversationId, projectId, 0);
  await client.setMemorySettings({ enabled: false, version: 0, updated_at: now }, true);
  assert.equal(calls[0].url, "/api/web-chat/projects?limit=50");
  assert.equal(calls[1].init.credentials, "include");
  assert.deepEqual(JSON.parse(calls[1].init.body), { name: "draft", description: "", instructions: "explicit instruction", expected_version: 1 });
  assert.deepEqual(JSON.parse(calls[2].init.body), { project_id: projectId, expected_version: 0 });
  assert.deepEqual(JSON.parse(calls[3].init.body), { enabled: true, expected_version: 0 });
  await assert.rejects(client.getProject("../other"), /标识/);
  assert.equal(calls.length, 4);
});

test("unknown creates are not retried and HTTP conflicts remain explicit", async () => {
  const loader = createWebModuleLoader();
  const { createCloudChatProjectsClient, CloudWorkUnconfirmedError, CloudWorkError } = loader.loadModule("src/lib/cloudChatProjects.ts");
  for (const response of [() => { throw new Error("ack lost"); }, () => Response.json({ error: "unavailable" }, { status: 503 }), () => Response.json({ malformed: true })]) {
    let calls = 0;
    const client = createCloudChatProjectsClient(async () => { calls++; return response(); }, () => () => {});
    await assert.rejects(client.createProject({ name: "draft", description: "", instructions: "" }), (error) => error instanceof CloudWorkUnconfirmedError);
    assert.equal(calls, 1);
  }
  const client = createCloudChatProjectsClient(async () => Response.json({ error: "conflict" }, { status: 409 }), () => () => {});
  await assert.rejects(client.updateMemory(memory(), "draft survives", true), (error) => error instanceof CloudWorkError && error.status === 409);
});

test("body parsing after an account switch cannot return project metadata", async () => {
  const loader = createWebModuleLoader();
  const { createCloudChatProjectsClient } = loader.loadModule("src/lib/cloudChatProjects.ts");
  let epoch = 0; let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const client = createCloudChatProjectsClient(async () => new Response(stream), () => { const start = epoch; return () => { if (start !== epoch) throw new Error("Account changed"); }; });
  const pending = client.getProject(projectId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  epoch++;
  controller.enqueue(new TextEncoder().encode(JSON.stringify(project()))); controller.close();
  await assert.rejects(pending, /Account changed/);
});

function button(text) { const found = [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === text); assert.ok(found, `missing button ${text}`); return found; }
async function click(env, text) { await env.act(async () => button(text).click()); }
async function text(env, label, value) { const element = document.querySelector(`[aria-label="${label}"]`); assert.ok(element, label); const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value").set; await env.act(async () => { setter.call(element, value); element.dispatchEvent(new window.Event("input", { bubbles: true })); element.dispatchEvent(new window.Event("change", { bubbles: true })); }); return element; }
async function submit(env, element) { await env.act(async () => element.closest("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))); }
async function mountPanel(t, name, props, { strict = false } = {}) {
  const icons = new Proxy({}, { get: () => () => null });
  const env = await createWebDomTestEnv({mocks:{"@liveagent/ui/components/IconSet":icons,[fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx",import.meta.url))]:icons}});
  const component = env.loadModule(`src/components/cloudchat/${name}.tsx`)[name];
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  t.after(async () => { await env.act(async () => root.unmount()); env.cleanup(); });
  await env.act(async () => root.render(env.React.createElement(strict ? env.React.StrictMode : env.React.Fragment, null, env.React.createElement(component, props))));
  return env;
}

test("Memory DOM starts off, keeps conflict drafts, refreshes CAS and deletes explicitly", async (t) => {
  let current = memory(); let settings = { enabled: false, version: 0, updated_at: now }; let conflict = true; const updates = []; let removed = false;
  const client = { getMemorySettings: async () => settings, listMemories: async () => page(removed ? [] : [current]), setMemorySettings: async (previous, enabled) => { assert.equal(previous.version, 0); settings = { ...settings, enabled, version: 1 }; return settings; }, updateMemory: async (previous, content, enabled) => { updates.push({ previous, content }); if (conflict) { conflict = false; current = { ...current, version: 2, content: "other page" }; const { CloudWorkError } = createWebModuleLoader().loadModule("src/lib/cloudChatProjects.ts"); throw new CloudWorkError("内容已修改，草稿已保留，请刷新。", 409); } assert.equal(previous.version, 2); current = { ...previous, content, enabled, version: 3 }; return current; }, removeMemory: async () => { removed = true; } };
  const env = await mountPanel(t, "CloudChatMemoryPanel", { client, captureGuard: () => () => {} }, { strict: true });
  assert.equal(document.querySelector('[aria-label="使用显式记忆"]').checked, false);
  await env.act(async () => document.querySelector('[aria-label="使用显式记忆"]').click());
  assert.equal(settings.enabled, true);
  await click(env, "编辑"); const editor = await text(env, "编辑记忆内容", "my unsaved draft"); await submit(env, editor);
  assert.equal(editor.value, "my unsaved draft"); assert.match(document.querySelector('[role="alert"]').textContent, /草稿/);
  await click(env, "刷新列表"); assert.equal(editor.value, "my unsaved draft"); await submit(env, editor);
  assert.equal(updates.length, 2); assert.equal(updates[1].content, "my unsaved draft"); assert.match(document.body.textContent, /my unsaved draft/);
  await click(env, "删除"); assert.equal(removed, false); await click(env, "确认删除记忆"); assert.equal(removed, true);
});

test("unknown memory creation retains draft and disables blind resubmission until refresh", async (t) => {
  let creates = 0; let Unconfirmed;
  const client = { getMemorySettings: async () => ({ enabled: false, version: 0, updated_at: now }), listMemories: async () => page([]), createMemory: async () => { creates++; throw new Unconfirmed(); } };
  // Use the component loader's own error class so the production instanceof branch executes.
  const env = await createWebDomTestEnv();
  Unconfirmed = env.loadModule("src/lib/cloudChatProjects.ts").CloudWorkUnconfirmedError;
  const { CloudChatMemoryPanel } = env.loadModule("src/components/cloudchat/CloudChatMemoryPanel.tsx");
  const root = env.createRoot(document.body.appendChild(document.createElement("div"))); t.after(async () => { await env.act(async () => root.unmount()); env.cleanup(); });
  await env.act(async () => root.render(env.React.createElement(CloudChatMemoryPanel, { client, captureGuard: () => () => {} })));
  const draft = await text(env, "新记忆内容", "explicit new memory"); await submit(env, draft);
  assert.equal(creates, 1); assert.equal(draft.value, "explicit new memory"); assert.equal(button("保存记忆").disabled, true);
  await click(env, "刷新列表"); assert.equal(button("保存记忆").disabled, false); assert.equal(draft.value, "explicit new memory");
});


const settingsProps = extra => ({projectId, filesClient:{list:async()=>({files:[file(),file(secondFileId)],nextCursor:""})},captureGuard:()=>()=>{},onClose(){},onSelect(){},onCreate(){},onChanged(){},onPreviewFile(){},...extra});

test("project settings keep unsaved fields, use canonical CAS and save the selected appearance",async t=>{
 let current=project(),saved,closed=0;let conflict=true;
 const client={getProject:async()=>current,updateProject:async(previous,draft)=>{saved={previous,draft};if(conflict){conflict=false;current={...current,version:2};throw Error("已在其他页面修改，请重新读取");}return{...current,...draft,version:3};}};
 const env=await mountPanel(t,"CloudProjectSettingsDialog",settingsProps({client,onClose:()=>closed++}),{strict:true});
 assert.ok(document.querySelector('[role="dialog"]'));assert.equal(document.querySelector('[aria-label="选择项目"]'),null);
 const editor=await text(env,"项目指令","简洁回复");await submit(env,editor);assert.equal(editor.value,"简洁回复");assert.equal(closed,0);
 await env.act(async()=>document.querySelector('[aria-label="重新读取项目"]').click());assert.equal(editor.value,"简洁回复");
 await submit(env,editor);assert.equal(saved.previous.version,2);assert.equal(saved.draft.instructions,"简洁回复");assert.equal(saved.draft.icon,"folder");assert.equal(closed,1);
});

test("project settings close requires an explicit discard and deletion keeps a separate confirmation",async t=>{
 let closed=0,deleted=0;const client={getProject:async()=>project(),removeProject:async()=>deleted++};
 const env=await mountPanel(t,"CloudProjectSettingsDialog",settingsProps({client,onClose:()=>closed++}));
 await text(env,"项目名称","新名称");await click(env,"关闭");assert.equal(closed,0);assert.match(document.querySelector('[role="alertdialog"]').textContent,/未保存/);
 await click(env,"继续编辑");await click(env,"删除项目");assert.equal(deleted,0);await click(env,"取消");assert.equal(deleted,0);
 await click(env,"关闭");await click(env,"放弃修改并关闭");assert.equal(closed,1);
});

test("project files are associated with their CAS, previewed through the shared reader and never removed as originals",async t=>{
 let current=project(),refs=[file()],preview,removed=0;
 const client={getProject:async()=>current,listFiles:async()=>page(refs),setFile:async(previous,id,attached)=>{assert.equal(previous.version,current.version);refs=attached?[...refs,file(id)]:refs.filter(item=>item.id!==id);current={...current,version:current.version+1};return current;}};
 const env=await mountPanel(t,"CloudProjectSettingsDialog",settingsProps({client,onPreviewFile:id=>preview=id}));
 await click(env,"项目资料");await click(env,file().name);assert.equal(preview,fileId);
 await click(env,"添加资料");await click(env,file(secondFileId).name);assert.equal(current.version,2);assert.equal(refs.length,2);
 await env.act(async()=>document.querySelector('[aria-label="解除关联：4.txt"]').click());assert.equal(refs.length,1);assert.equal(removed,0);
});

test("late project settings cannot display another account's instructions",async t=>{
 let finish,retired=false;const client={getProject:()=>new Promise(resolve=>finish=resolve)};
 const env=await mountPanel(t,"CloudProjectSettingsDialog",settingsProps({client,captureGuard:()=>()=>{if(retired)throw Error("retired");}}));
 retired=true;await env.act(async()=>finish({...project(),instructions:"PRIVATE_ACCOUNT_A"}));assert.doesNotMatch(document.body.textContent,/PRIVATE_ACCOUNT_A/);
});

test("mobile Back closes a clean settings overlay but confirms unsaved edits",async t=>{
 let closed=0;const client={getProject:async()=>project()};const env=await mountPanel(t,"CloudProjectSettingsDialog",settingsProps({client,onClose:()=>closed++}));
 await text(env,"项目指令","新的项目要求");
 const back=new Event('zeroagent:mobile-back',{cancelable:true});await env.act(async()=>window.dispatchEvent(back));
 assert.equal(back.defaultPrevented,true);assert.equal(closed,0);assert.match(document.querySelector('[role="alertdialog"]').textContent,/未保存/);
 await click(env,"继续编辑");assert.equal(document.querySelector('[aria-label="项目指令"]').value,"新的项目要求");
});
