import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test("reader related conversations show verified titles and retire a delayed title when the account view changes", async t => {
  let active = true, release, opened;
  const env = await createWebDomTestEnv({mocks:{"@/lib/accountRequest":{captureAccountRequestGuard:()=>()=>{if(!active)throw new Error('retired')}}}});
  const {CloudChatRelatedConversations}=env.loadModule("src/components/cloudchat/CloudChatRelatedConversations.tsx");
  const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host),h=env.React.createElement;
  t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup()});
  const stable=()=>active;
  const client={async get(id,signal){if(id==='slow')return new Promise(resolve=>{release=()=>resolve({id,title:'过期账户标题'});});return {id,title:'季度交付讨论'};}};
  const render=async ids=>env.act(async()=>root.render(h(CloudChatRelatedConversations,{ids,client,isCurrent:stable,onOpen:id=>{opened=id;}})));
  await render(['current']);await env.act(async()=>{await new Promise(setImmediate)});
  assert.match(host.textContent,/关联对话/);assert.match(host.textContent,/季度交付讨论/);
  await env.act(async()=>host.querySelector('li button').click());assert.equal(opened,'current');
  await render(['slow']);active=false;await env.act(async()=>{release();await new Promise(setImmediate)});
  assert.doesNotMatch(host.textContent,/过期账户标题|季度交付讨论/);
});

test("reader details return keyboard focus to the file menu after a transient opener is removed", async (t) => {
  const icons = new Proxy({}, { get: () => () => null });
  const env = await createWebDomTestEnv({ mocks: {
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url))]: icons,
  } });
  const { ResourceInspector } = env.loadModule("../../agent-ui/src/components/resource-preview/ResourceReaderDetails.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const h = env.React.createElement;
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); });
  let readerEscapes = 0;
  function Reader() {
    const [open, setOpen] = env.React.useState(false);
    return h("section", { onKeyDown: (event) => { if (event.key === "Escape") readerEscapes++; } },
      h("header", null,
        h("button", { className: "za-reader-title-menu", onClick: () => setOpen(true) }, "File menu"),
        h("button", { className: "direct-opener", onClick: () => setOpen(true) }, "Show history")),
      h("div", { className: "za-reader-stage" },
        h("article", null, "Reader content"),
        open ? h(ResourceInspector, { title: "详情", onClose: () => setOpen(false) }, "File details") : null));
  }
  await env.act(async () => root.render(h(env.React.StrictMode, null, h(Reader))));
  const menu = host.querySelector(".za-reader-title-menu");
  const close = () => host.querySelector("aside header button");
  await env.act(async () => menu.click());
  assert.equal(document.activeElement, close());
  assert.equal(host.querySelector(".za-reader-inspector-dismiss").tabIndex, -1);
  await env.act(async () => close().dispatchEvent(new window.KeyboardEvent("keydown", {
    key: "Escape", bubbles: true, cancelable: true,
  })));
  assert.equal(readerEscapes, 0);
  assert.equal(document.activeElement, menu);
  assert.equal(host.querySelector("article").textContent, "Reader content");

  const opener = host.querySelector(".direct-opener");
  opener.focus();
  await env.act(async () => opener.click());
  await env.act(async () => close().click());
  assert.equal(document.activeElement, opener);
});
