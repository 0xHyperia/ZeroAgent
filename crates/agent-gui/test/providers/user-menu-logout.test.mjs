import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test("logout failures stay visible and retry completes without overlapping native requests",async t=>{
 const env=await createDomTestEnv({mocks:{"@liveagent/ui/components/IconSet":{ChevronUp:()=>null,LogOut:()=>null,Settings:()=>null,User:()=>null},"../../lib/relay/client":{formatRelayBalance:()=>"$0.00",formatRelayTokenCount:()=>"0"}}});
 const host=document.createElement("div");document.body.append(host);const root=env.createRoot(host);
 t.after(async()=>{await env.act(async()=>root.unmount());env.cleanup();});
 const {UserMenu}=env.loadModule("src/components/chat/UserMenu.tsx");const first=deferred(),second=deferred();let calls=0;
 await env.act(async()=>root.render(env.React.createElement(UserMenu,{user:{id:7,email:"current@example.test"},stats:null,onRefreshAccount:async()=>{},onOpenAccount:()=>{},onOpenSettings:()=>{},onLogout:()=>++calls===1?first.promise:second.promise})));
 await env.act(async()=>{document.querySelector('[aria-label="用户菜单"]').click();await tick();});
 const item=()=>[...document.querySelectorAll('[role="menuitem"]')].find(el=>/退出/.test(el.textContent));
 assert.ok(item(),"logout menu is visible");
 await env.act(async()=>{item().click();item().click();});
 assert.equal(calls,1);assert.match(item().textContent,/正在退出/);assert.equal(item().getAttribute("aria-disabled"),"true");
 await env.act(async()=>{first.reject(Error("fixture-private-native-error"));await tick();});
 assert.match(document.querySelector('[role="alert"]').textContent,/退出未完成/);
 assert.doesNotMatch(document.body.textContent,/fixture-private-native-error/);
 assert.match(item().textContent,/重试退出/);assert.ok(document.querySelector('[role="menu"]'));
 assert.match(document.body.textContent,/current/);
 assert.doesNotMatch(document.body.textContent,/current@example.test/);
 await env.act(async()=>{item().click();await tick();});assert.equal(calls,2);assert.equal(document.querySelector('[role="alert"]'),null);
 await env.act(async()=>{second.resolve();await tick();});assert.equal(document.querySelector('[role="menu"]'),null);
});


test("compact account menu keeps details on the account page and separates account from settings", async t => {
 const env=await createDomTestEnv({mocks:{"@liveagent/ui/components/IconSet":new Proxy({}, {get:()=>()=>null})}});
 const host=document.createElement("div");document.body.append(host);const root=env.createRoot(host);
 t.after(async()=>{await env.act(async()=>root.unmount());env.cleanup();});
 const {UserMenu}=env.loadModule("src/components/chat/UserMenu.tsx");const routes=[];let refreshes=0;
 await env.act(async()=>root.render(env.React.createElement(UserMenu,{user:{id:7,email:"private@example.test",username:"Zero",balance:123},stats:{today_tokens:321},onRefreshAccount:async()=>{refreshes++},onOpenAccount:()=>routes.push("account"),onOpenSettings:()=>routes.push("settings"),onLogout:async()=>{}})));
 const open=async()=>env.act(async()=>{document.querySelector('[aria-label="用户菜单"]').click();await tick();});
 assert.equal(host.querySelector('button').textContent.includes("Zero"),true);
 await open();assert.equal(refreshes,1);
 assert.doesNotMatch(document.body.textContent,/private@example|余额|今日 Token|123|321/);
 const items=()=>[...document.querySelectorAll('[role="menuitem"]')];
 await env.act(async()=>{items().find(x=>x.textContent==="账户").click();await tick();});
 assert.deepEqual(routes,["account"]);
 await open();
 await env.act(async()=>{items().find(x=>x.textContent==="设置").click();await tick();});
 assert.deepEqual(routes,["account","settings"]);
});
