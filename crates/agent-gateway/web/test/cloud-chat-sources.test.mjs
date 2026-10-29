import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const ID="11111111-1111-4111-8111-111111111111",RUN="22222222-2222-4222-8222-222222222222",CONV="33333333-3333-4333-8333-333333333333";
const source=(overrides={})=>({id:ID,run_id:RUN,conversation_id:CONV,kind:"page",url:"https://example.com/start",final_url:"https://docs.example.com/final",title:"网页快照",sha256:"a".repeat(64),body_sha256:"b".repeat(64),observed_at:"2026-10-29T01:00:00Z",truncated:false,text_bytes:15,line_count:3,version:1,created_at:"2026-10-29T01:00:01Z",...overrides});
const summary=()=>source({kind:"search_snippet",title:"搜索结果",snippet:"只是搜索摘要",final_url:undefined,body_sha256:undefined,text_bytes:0,line_count:0});
const excerpt=(overrides={})=>({source_id:ID,kind:"page",title:"网页快照",final_url:"https://docs.example.com/final",sha256:"a".repeat(64),observed_at:"2026-10-29T01:00:00Z",truncated:false,total_lines:3,from_line:1,to_line:3,lines:[{line:1,text:"第一行"},{line:2,text:"第二行"},{line:3,text:"<script>不执行</script>"}],...overrides});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const load=()=>createTsModuleLoader({rootDir:fileURLToPath(new URL("..",import.meta.url))}).loadModule("src/lib/cloudChatSources.ts");
const safe=()=>()=>undefined;

test("source metadata, pagination, versions and line excerpts use only account resource APIs",async()=>{
 const api=load(),calls=[];
 const client=api.createCloudChatSourcesClient(async(path,init={})=>{calls.push({path,init});if(init.method==="DELETE")return Response.json({deleted:true});if(path.includes("/content?"))return Response.json(excerpt());if(path.includes("/sources?"))return Response.json({sources:[source()],next_cursor:ID});return Response.json({source:source()});},safe);
 assert.equal((await client.get(ID)).id,ID);assert.equal((await client.list({before:ID})).nextCursor,ID);assert.equal((await client.excerpt(ID)).lines.length,3);await client.remove(source());
 assert.ok(calls.every(call=>call.path.startsWith("/api/web-chat/sources")&&call.init.credentials==="include"));assert.equal(calls.at(-1).init.headers["If-Match"],'"1"');
 await assert.rejects(client.get("../secret"),/标识/);await assert.rejects(client.excerpt(ID,1,201),/行号/);
});

test("source body parsing remains bound to the original account and rejects oversized responses",async()=>{
 const api=load();let owner=1,release;
 const client=api.createCloudChatSourcesClient(async()=>new Response(new ReadableStream({start(controller){release=()=>{owner=2;controller.enqueue(new TextEncoder().encode(JSON.stringify({source:source()})));controller.close();};}})),()=>{const captured=owner;return()=>{if(captured!==owner)throw new Error("Account changed");};});
 const pending=client.get(ID);await Promise.resolve();release();await assert.rejects(pending,/Account changed/);
 const oversized=api.createCloudChatSourcesClient(async()=>new Response("x",{headers:{"Content-Length":String(4*1024*1024+1)}}),safe);await assert.rejects(oversized.get(ID),/过大/);
});

test("search summaries cannot masquerade as a fetched page or accept forged source identity",async()=>{
 const api=load();const forged=api.createCloudChatSourcesClient(async()=>Response.json({source:summary()}),safe);assert.equal((await forged.get(ID)).kind,"search_snippet");
 const bad=api.createCloudChatSourcesClient(async()=>Response.json({source:{...summary(),line_count:3,text_bytes:15}}),safe);await assert.rejects(bad.get(ID),/无效/);
 const wrong=api.createCloudChatSourcesClient(async()=>Response.json(excerpt({source_id:RUN})),safe);await assert.rejects(wrong.excerpt(ID),/无效/);
 const failed=api.createCloudChatSourcesClient(async()=>Response.json({error:"synthetic-secret-provider-body"},{status:503}),safe);await assert.rejects(failed.get(ID),error=>error.status===503&&!error.message.includes("synthetic-secret"));
});

test("source citations map only opaque UUIDs to controlled links and external hosts remain explicit",()=>{
 const api=load();assert.equal(api.linkCloudSourceCitations(`证据【来源:${ID}:L1-L3】与【来源:${ID}】`),`证据[来源 L1–L3](cloud-sources/${ID}#L1-L3)与[来源](cloud-sources/${ID})`);
 assert.equal(api.linkCloudSourceCitations(`【来源:${ID}:L9-L1】`),`【来源:${ID}:L9-L1】`);
 for(const url of ["javascript:alert(1)","data:text/html,unsafe","file:///secret","https://user:password@example.com/","https://example.com\\@elsewhere/"])assert.equal(api.cloudSourceExternalURL(url),null);
 assert.deepEqual(api.cloudSourceExternalURL("https://docs.example.com/path"),{href:"https://docs.example.com/path",host:"docs.example.com"});
});

async function mountPanel(t,{record=source(),delayed=false}={}){
 let env,revision=0,active=true,release;const calls=[],deleted=[];
 const guard=()=>{const captured=revision;return()=>{if(captured!==revision)throw new Error("Account changed");};};
 const request=async(path,init={})=>{
   calls.push({path,init});assert.ok(path.startsWith("/api/web-chat/sources"),"panel must not fetch an external website");
   if(init.method==="DELETE"){deleted.push(path.split("/").at(-1));return Response.json({deleted:true});}
   if(path.includes("/content?"))return Response.json(excerpt());
   if(path.includes("/sources?"))return Response.json({sources:deleted.length?[]:[record],next_cursor:""});
   if(delayed)await new Promise(resolve=>{release=resolve;});
   return Response.json({source:record});
 };
 env=await createWebDomTestEnv({mocks:{
   "@/lib/accountRequest":{captureAccountRequestGuard:guard},
   [fileURLToPath(new URL("../src/components/cloudchat/CloudChatResourcePanel.tsx",import.meta.url))]:{CloudChatResourcePanel:props=>env.React.createElement("div",{role:"dialog"},env.React.createElement("h2",null,props.title),env.React.createElement("p",null,props.description),props.children)},"@liveagent/ui/components/ui/dialog":{Dialog:props=>props.children,DialogContent:props=>env.React.createElement("div",{role:"dialog"},props.children),DialogTitle:props=>env.React.createElement("h2",null,props.children),DialogDescription:props=>env.React.createElement("p",null,props.children)},
 }});
 const {createCloudChatSourcesClient}=env.loadModule("src/lib/cloudChatSources.ts");const client=createCloudChatSourcesClient(request,guard);
 const {CloudChatSourcesPanel}=env.loadModule("src/components/cloudchat/CloudChatSourcesPanel.tsx");
 const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);const notices=[];
 await env.act(async()=>{root.render(env.React.createElement(CloudChatSourcesPanel,{client,initialSourceId:ID,isCurrent:()=>active,onClose:()=>{},onDeleted:id=>notices.push(id)}));await tick();});
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 return{env,host,calls,deleted,notices,async click(label){const button=[...host.querySelectorAll("button")].find(button=>button.textContent===label);assert.ok(button,`missing ${label}`);await env.act(async()=>{button.click();await tick();});},async retire(){await env.act(async()=>{revision++;active=false;root.render(null);await tick();});},async finish(){await env.act(async()=>{release();await tick();});},invalidateGuard(){revision++;}};
}

test("source reader renders persisted lines as text with an explicit original-domain link",async(t)=>{
 const app=await mountPanel(t);
 assert.match(app.host.textContent,/网页正文快照/);assert.match(app.host.textContent,/L1第一行/);assert.match(app.host.textContent,/<script>不执行<\/script>/);assert.equal(app.host.querySelector("script"),null);
 const link=app.host.querySelector("a");assert.equal(link.host,"docs.example.com");assert.equal(link.rel,"noopener noreferrer");assert.equal(link.target,"_blank");assert.match(link.textContent,/docs.example.com/);
 assert.ok(app.calls.some(call=>call.path.includes("/content?")));
 app.invalidateGuard();const click=new app.env.dom.window.MouseEvent("click",{bubbles:true,cancelable:true});assert.equal(link.dispatchEvent(click),false,"retired metadata must not open an external page");
});

test("a search-only source shows its summary without inventing page lines or fetching the website",async(t)=>{
 const app=await mountPanel(t,{record:summary()});assert.match(app.host.textContent,/搜索摘要，未抓取网页正文/);assert.match(app.host.textContent,/只是搜索摘要/);
 assert.equal(app.calls.some(call=>call.path.includes("/content?")),false);assert.match(app.host.querySelector("a").textContent,/打开搜索结果网页 · example.com/);
});

test("source deletion requires an explicit choice, retains its version and refreshes the library",async(t)=>{
 const app=await mountPanel(t);await app.click("删除此快照");assert.equal(app.deleted.length,0);await app.click("确认删除来源");
 assert.equal(app.deleted.length,1);assert.deepEqual(app.notices,[ID]);assert.equal(app.calls.find(call=>call.init.method==="DELETE").init.headers["If-Match"],'"1"');
 assert.ok(app.calls.some(call=>call.path.startsWith("/api/web-chat/sources?")));assert.doesNotMatch(app.host.textContent,/第一行/);
});

test("a late source response cannot populate a retired account/view",async(t)=>{
 const app=await mountPanel(t,{delayed:true});await app.retire();await app.finish();assert.doesNotMatch(app.host.textContent,/网页快照|第一行|资料/);assert.equal(app.host.querySelector('[role="dialog"]'),null);
});
