import assert from "node:assert/strict";
import test from "node:test";
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
  const env = await createWebDomTestEnv();
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

test("Project DOM associates current conversation and adds owned file refs with CAS", async (t) => {
  let current = project(); let association = binding(); let refs = [file()]; const mutations = [];
  const client = { listProjects: async () => page([current]), getProject: async () => current, getAssociation: async () => association, listConversations: async () => page(association.project_id ? [association] : []), listFiles: async () => page(refs), setAssociation: async (conversation, project, version) => { mutations.push({ conversation, project, version }); association = { ...association, project_id: project, version: version + 1 }; return association; }, setFile: async (previous, id, attached) => { mutations.push({ id, attached, version: previous.version }); current = { ...previous, version: previous.version + 1 }; refs = attached ? [...refs, file(id)] : refs.filter((item) => item.id !== id); return current; } };
  const filesClient = { list: async () => ({ files: [file(), file(secondFileId)], nextCursor: "" }) };
  const env = await mountPanel(t, "CloudChatProjectsPanel", { client, filesClient, conversationId, captureGuard: () => () => {} });
  await text(env, "选择项目", projectId);
  assert.equal(document.querySelector('[aria-label="项目指令"]').value, "project instructions");
  await click(env, "归入此项目"); assert.deepEqual(mutations[0], { conversation: conversationId, project: projectId, version: 0 });
  await text(env, "选择项目资料", secondFileId); await click(env, "关联资料"); assert.deepEqual(mutations[1], { id: secondFileId, attached: true, version: 1 });
  assert.match(document.body.textContent, /5.txt/);
});

test("retired account downloads never create a browser download", async (t) => {
  let epoch = 0; let finish; const pending = new Promise((resolve) => { finish = resolve; });
  const client = { listProjects: async () => page([project()]), getProject: async () => project(), listConversations: async () => page([]), listFiles: async () => page([file()]) };
  const filesClient = { list: async () => ({ files: [], nextCursor: "" }), download: () => pending };
  const captureGuard = () => { const start = epoch; return () => { if (start !== epoch) throw new Error("Account changed"); }; };
  const env = await mountPanel(t, "CloudChatProjectsPanel", { client, filesClient, captureGuard });
  let downloads = 0; const anchorPrototype = window.HTMLAnchorElement.prototype; const original = anchorPrototype.click; anchorPrototype.click = () => { downloads++; }; t.after(() => { anchorPrototype.click = original; });
  await text(env, "选择项目", projectId); await click(env, "下载原件"); epoch++;
  await env.act(async () => { finish({ blob: new Blob(["old"]), guard: () => { if (epoch) throw new Error("Account changed"); } }); await pending; });
  assert.equal(downloads, 0);
});

test("Project DOM opens the current conversation's project even outside the first page without overriding New", async (t) => {
  const current = project();
  const client = {
    listProjects: async () => page([]),
    getProject: async (id) => { assert.equal(id, projectId); return current; },
    getAssociation: async () => ({ ...binding(), project_id: projectId, version: 1 }),
    listConversations: async () => page([]),
    listFiles: async () => page([]),
  };
  const env = await mountPanel(t, "CloudChatProjectsPanel", { client, conversationId, captureGuard: () => () => {} }, { strict: true });
  assert.equal(document.querySelector('[aria-label="选择项目"]').value, projectId);
  assert.equal(document.querySelector('[aria-label="项目指令"]').value, current.instructions);
  assert.match(document.body.textContent, /当前会话已归入此项目/);
  await text(env, "选择项目", "");
  assert.equal(document.querySelector('[aria-label="选择项目"]').value, "");
  assert.equal(document.querySelector('[aria-label="项目名称"]').value, "");
});
