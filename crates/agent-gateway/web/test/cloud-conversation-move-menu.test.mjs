import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, client, captureGuard = () => () => {}) {
  const icons = new Proxy({}, { get: () => () => null });
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": icons,
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url))]: icons,
  } });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const host = document.body.appendChild(document.createElement("div")), root = env.createRoot(host);
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); });
  const { CloudConversationMoveMenu } = env.loadModule("src/components/cloudchat/CloudConversationMoveMenu.tsx");
  const { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } = env.loadModule("../../agent-ui/src/components/ui/dropdown-menu.tsx");
  const moved = [], errors = []; let created = 0;
  await env.act(async () => { root.render(env.React.createElement(DropdownMenu, null,
    env.React.createElement(DropdownMenuTrigger, null, "更多"),
    env.React.createElement(DropdownMenuContent, null,
      env.React.createElement(CloudConversationMoveMenu, { conversationId: "chat", client, captureGuard, disabled: false,
        onMove: async project => moved.push(project?.id ?? null), onCreate: () => created++, onError: message => errors.push(message) })))); await tick(); });
  const find = text => [...document.querySelectorAll('button,[role="menuitem"]')].find(node => node.textContent === text);
  const click = async text => env.act(async () => { const node = find(text); assert.ok(node, text); node.click(); await tick(); });
  const open = async () => { await click("更多"); await click("移至项目"); };
  return { env, find, click, open, moved, errors, get created() { return created; } };
}

test("cloud destinations load lazily, mark the current project, retry and move out through the shared submenu", async t => {
  let reads = 0, offline = true;
  const app = await setup(t, {
    listProjects: async () => { reads++; if (offline) throw Error("offline"); return { items: [{id:"a", name:"当前项目"}, {id:"b", name:"新项目"}], next_before_id:"" }; },
    getAssociation: async id => { assert.equal(id,"chat"); return {project_id:"a"}; },
  });
  assert.equal(reads,0); await app.open(); assert.equal(reads,1);
  assert.ok(app.find("项目加载失败，重试"));
  offline=false; await app.click("项目加载失败，重试");
  assert.equal(app.find("当前项目").getAttribute("aria-disabled"),"true");
  await app.click("新项目"); assert.deepEqual(app.moved,["b"]);
  await app.open(); await app.click("移出项目"); assert.deepEqual(app.moved,["b",null]);
  await app.open(); await app.click("新建项目"); assert.equal(app.created,1);
});

test("a late destination response from a retired account is discarded", async t => {
  let retired = false, finish;
  const app = await setup(t, {
    listProjects: () => new Promise(resolve => { finish=resolve; }),
    getAssociation: async () => ({project_id:"private"}),
  }, () => () => { if(retired) throw Error("retired"); });
  await app.open(); retired=true;
  await app.env.act(async () => { finish({items:[{id:"private",name:"PRIVATE_PROJECT"}],next_before_id:""}); await tick(); });
  assert.equal(app.find("PRIVATE_PROJECT"),undefined); assert.deepEqual(app.errors,[]);
});
