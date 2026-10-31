import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const VERSION="11111111-1111-4111-8111-111111111111", SITE="22222222-2222-4222-8222-222222222222", GRANT="33333333-3333-4333-8333-333333333333";
const release={id:VERSION,site_id:SITE,sha256:"a".repeat(64),created_at:"2026-10-31T00:00:00Z",manifest:{format:1,entry_point:"index.html",expanded_bytes:1,entries:[{path:"index.html",size:1,sha256:"b".repeat(64),mime:"text/html; charset=utf-8"}]}};
const access=(mode="share",id=GRANT)=>({id,site_id:SITE,release_id:VERSION,mode,version:1,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+600000).toISOString(),url:`https://${SITE.replaceAll("-","")}.example.net/v/${id.replaceAll("-","")}.${"a".repeat(43)}/index.html`});
const module=()=>createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudChatSites.ts");
const safe=()=>()=>{};

test("site reads never create grants and mutations retain explicit version/request bindings",async()=>{
 const api=module(),calls=[];
 const client=api.createCloudChatSitesClient(async(path,init)=>{calls.push({path,init});if(path.endsWith("/config"))return Response.json({enabled:true});if(path.endsWith("/preview"))return Response.json({grant:access("private")});if(path.endsWith("/shares"))return Response.json({grant:access()});return Response.json({release});},safe);
 assert.equal(await client.enabled(),true);assert.equal((await client.get(VERSION)).id,VERSION);assert.equal(calls.some(call=>call.init.method),false);
 await client.share(VERSION,GRANT,7);assert.equal(calls.length,3);assert.deepEqual(JSON.parse(calls[2].init.body),{request_id:GRANT,expires_in_seconds:604800});assert.equal(calls[2].init.credentials,"include");
 await client.preview(VERSION,GRANT);assert.equal(JSON.parse(calls[3].init.body).request_id,GRANT);
});
test("site client rejects unbound origins and versions without installing content",async()=>{
 const api=module();
 for(const bad of [access("private"),{...access(),url:"javascript:alert(1)"},{...access(),url:access().url.replace("example.net","example.net@attacker.invalid")},{...access(),site_id:VERSION},{...access(),release_id:SITE},{...access(),url:access().url.replace(GRANT.replaceAll("-",""),VERSION.replaceAll("-",""))}]){
  const client=api.createCloudChatSitesClient(async()=>Response.json({grant:bad}),safe);
  await assert.rejects(client.share(VERSION,GRANT,7),api.CloudSiteWriteUnconfirmedError);
 }
});
test("unknown site writes do not retry and 5xx commit results remain unconfirmed",async()=>{
 const api=module();let calls=0;
 for(const result of [()=>{throw new Error("connection lost");},()=>Response.json({error:"unavailable"},{status:503})]){
  const client=api.createCloudChatSitesClient(async()=>{calls++;return result();},safe);const before=calls;
  await assert.rejects(client.share(VERSION,GRANT,7),api.CloudSiteWriteUnconfirmedError);assert.equal(calls,before+1);
 }
});
test("account changes during site response parsing discard private URLs",async()=>{
 const api=module();let owner=1,complete;
 const client=api.createCloudChatSitesClient(async()=>new Response(new ReadableStream({start(controller){complete=()=>{owner=2;controller.enqueue(new TextEncoder().encode(JSON.stringify({grant:access("private")})));controller.close();};}})),()=>{const at=owner;return()=>{if(at!==owner)throw new Error("Account changed");};});
 const pending=client.preview(VERSION,GRANT);await Promise.resolve();complete();await assert.rejects(pending,/Account changed/);
});

async function mount(t,overrides={},view={}){
 const env=await createWebDomTestEnv({mocks:{"@liveagent/ui/components/IconSet":new Proxy({},{get:()=>()=>null})}});
 const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);let owner=1;
 const captureGuard=()=>{const at=owner;return()=>{if(at!==owner)throw new Error("Account changed");};};
 const calls={preview:[],share:[],revoke:[]};let shares=[];
 const client={captureGuard,enabled:async()=>true,get:async()=>release,register:async()=>release,preview:async(...args)=>{calls.preview.push(args);return access("private");},shares:async()=>shares,share:async(...args)=>{calls.share.push(args);const g=access("share",args[1]);shares=[g];return g;},revoke:async(...args)=>{calls.revoke.push(args);shares=[];return {...args[0],revoked_at:new Date().toISOString(),version:2};},...overrides};
 const {CloudChatSiteView}=env.loadModule("src/components/cloudchat/CloudChatSiteView.tsx");
 const flush=async()=>env.act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});
 await env.act(async()=>root.render(env.React.createElement(CloudChatSiteView,{client,artifact:{id:VERSION,family_id:SITE,name:"site.zip",number:3},isCurrent:()=>owner===1,...view})));await flush();
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 return {env,calls,client,flush,retire(){owner=2;},async click(label){const button=[...document.querySelectorAll("button")].find(el=>el.textContent.trim()===label||el.getAttribute("aria-label")===label);assert.ok(button,label);assert.equal(button.disabled,false,`${label} disabled`);await env.act(async()=>button.click());await flush();}};
}
test("site UI opens private content and shares only after separate explicit actions",async t=>{
 const app=await mount(t);assert.equal(app.calls.preview.length,0);assert.equal(app.calls.share.length,0);assert.equal(document.querySelector("iframe"),null);
 await app.click("预览站点");const frame=document.querySelector("iframe");assert.ok(frame);assert.equal(frame.getAttribute("sandbox"),"allow-scripts allow-same-origin allow-downloads");assert.equal(app.calls.share.length,0);
 await app.click("分享");assert.equal(app.calls.share.length,0);await app.click("创建分享链接");assert.equal(app.calls.share.length,1);assert.ok(document.querySelector('input[aria-label="站点分享链接"]'));
 await app.click("撤销链接");assert.equal(app.calls.revoke.length,1);assert.equal(document.querySelector('input[aria-label="站点分享链接"]'),null);
});

test("opening a known space site previews its immutable version without creating a public share",async t=>{
 const app=await mount(t,{}, {openOnMount:true});
 assert.equal(app.calls.preview.length,1);assert.equal(app.calls.preview[0][0],VERSION);
 assert.ok(document.querySelector("iframe"));assert.equal(app.calls.share.length,0);
 await app.click("分享");assert.equal(app.calls.share.length,0);
});

test("a disabled site host explains the unavailable preview without issuing grants",async t=>{
 const app=await mount(t,{enabled:async()=>false},{openOnMount:true});
 assert.match(document.body.textContent,/托管尚未启用/);
 assert.equal(app.calls.preview.length,0);assert.equal(app.calls.share.length,0);assert.equal(document.querySelector("iframe"),null);
});
test("lost share responses retain the request identity and require explicit retry",async t=>{
 let api,attempts=[],saved=[];
 const app=await mount(t,{shares:async()=>saved,share:async(_version,id,days)=>{attempts.push({id,days});if(attempts.length===1){const error=new Error("unconfirmed");Object.setPrototypeOf(error,api.CloudSiteWriteUnconfirmedError.prototype);throw error;}const g=access("share",id);saved=[g];return g;}});
 api=app.env.loadModule("src/lib/cloudChatSites.ts");await app.click("分享");await app.click("创建分享链接");assert.equal(attempts.length,1);
 await app.click("刷新分享状态");assert.equal(attempts.length,1);const create=[...document.querySelectorAll("button")].find(el=>el.textContent.trim()==="创建分享链接");assert.equal(create.disabled,true);
 await app.click("重试未确认的创建");assert.equal(attempts.length,2);assert.deepEqual(attempts[1],attempts[0]);
});
test("retired site views never install delayed private content",async t=>{
 let complete;const app=await mount(t,{preview:()=>new Promise(resolve=>{complete=resolve;})});await app.click("预览站点");app.retire();await app.env.act(async()=>complete(access("private")));await app.flush();assert.equal(document.querySelector("iframe"),null);
});
