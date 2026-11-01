import assert from "node:assert/strict";
import test from "node:test";
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
