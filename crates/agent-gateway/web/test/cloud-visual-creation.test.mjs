import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const iconFile = fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url));
const icons = new Proxy({}, { get: () => () => null });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const image = n => ({ id: `91000000-0000-4000-8000-${String(n).padStart(12,"0")}`, name: `方案 ${n}.png`, kind: "artifact", role: "output", mime: "image/png", status: "saved", link: { source: "relative", path: `cloud-artifacts/${n}` } });

async function surface(t, extra = {}) {
  const env = await createWebDomTestEnv({ mocks: {
    [iconFile]: icons,
    "@liveagent/ui/components/IconSet": icons,
    "@liveagent/ui/i18n/index": {useLocale: () => ({t: key => key, locale: "zh-CN"})},
    "@/lib/accountRequest": {captureAccountRequestGuard: () => () => {}},
    ...extra,
  }});
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  t.after(async () => {await env.act(async () => root.unmount()); host.remove(); env.cleanup();});
  return { ...env, host, root };
}

test("image gallery opens and edits the selected immutable result, then releases every owned URL", async t => {
  const env = await surface(t);
  const {AssistantVisualContext, AssistantImageGallery} = env.loadModule("@liveagent/ui/components/chat/AssistantVisuals.tsx");
  const {host, React: R} = env;
  const opened = [], edited = [], created = [], revoked = [], signals = [];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => {const value=`blob:visual-${created.length}`; created.push(value); return value;};
  URL.revokeObjectURL = value => revoked.push(value);
  t.after(() => {URL.createObjectURL=create; URL.revokeObjectURL=revoke;});
  const items = [image(1), image(2)];
  const value = {loadImage: async (_id, signal) => {signals.push(signal); return new Blob(["test"]);}, editImage: item => edited.push(item.id), activity: () => null};
  await env.act(async () => {env.root.render(R.createElement(AssistantVisualContext.Provider,{value},R.createElement(AssistantImageGallery,{items,onOpen:item=>opened.push(item.id)}))); await tick();});
  assert.equal(host.querySelectorAll(".za-visual-main img").length,1);
  await env.act(async () => host.querySelectorAll(".za-visual-thumbnail")[1].click());
  await env.act(tick);
  assert.equal(host.querySelector(".za-visual-main img").alt, items[1].name);
  assert.equal(host.querySelectorAll('[aria-pressed="true"]').length,1);
  await env.act(async () => {host.querySelector(".za-visual-open").click(); host.querySelector(".za-visual-image-actions button").click();});
  assert.deepEqual(opened,[items[1].id]); assert.deepEqual(edited,[items[1].id]);
  await env.act(async () => env.root.render(null));
  assert.ok(signals.every(signal=>signal.aborted));
  assert.deepEqual([...revoked].sort(),[...created].sort());
});

test("pending creation and missing-model action follow real tool state without submitting another job", async t => {
  const env=await surface(t);
  const {CloudChatVisualProvider}=env.loadModule("src/components/cloudchat/CloudChatVisualProvider.tsx");
  const {AssistantVisualActivity}=env.loadModule("@liveagent/ui/components/chat/AssistantVisuals.tsx");
  let configured=0;
  const props={client:{},running:true,onEdit:()=>{},onConfigure:()=>configured++};
  const render=async (state,status,running=true) => env.act(async()=>env.root.render(env.React.createElement(CloudChatVisualProvider,{...props,running,messages:[{id:"m",presentation:{blocks:[{type:"tool",name:"generate_image",state,status}]}}]},env.React.createElement(AssistantVisualActivity,{messageId:"m"}))));
  await render("executing"); assert.ok(env.host.querySelector(".za-visual-dots")); assert.doesNotMatch(env.host.textContent, /\d+%/);
  await render("failed","请先选择默认生图模型",false);
  assert.match(env.host.textContent,/请先选择默认生图模型/);
  await env.act(async()=>env.host.querySelector("button").click()); assert.equal(configured,1);
  await render("unknown",undefined,false); assert.match(env.host.textContent,/不会自动重复/); assert.equal(env.host.querySelectorAll("button").length,0);
  await render("succeeded",undefined,false); assert.equal(env.host.textContent,"");
});

test("image host shares private byte reads and discards reads after the conversation unmounts", async t => {
  const env=await surface(t);
  const {CloudChatVisualProvider}=env.loadModule("src/components/cloudchat/CloudChatVisualProvider.tsx");
  const {AssistantVisualContext}=env.loadModule("@liveagent/ui/components/chat/AssistantVisuals.tsx");
  let current, release, reads=0, lifecycle;
  function Probe(){current=env.React.useContext(AssistantVisualContext);return null;}
  const client={get:async(id,signal)=>{reads++; lifecycle=signal;await new Promise(resolve=>release=resolve);return{id};},image:async()=>({blob:new Blob(["test"]),guard:()=>{}})};
  await env.act(async()=>env.root.render(env.React.createElement(CloudChatVisualProvider,{client,messages:[],running:false,onConfigure:()=>{},onEdit:()=>{}},env.React.createElement(Probe))));
  const consumer=new AbortController();
  const first=current.loadImage("image",consumer.signal), second=current.loadImage("image",consumer.signal);
  assert.equal(reads,1);
  consumer.abort(); await env.act(async()=>env.root.render(null)); assert.ok(lifecycle.aborted);
  release(); await assert.rejects(first,{name:"AbortError"}); await assert.rejects(second,{name:"AbortError"});
});

test("default image setting uses its own CAS preference and preserves selected group identity", async t => {
  let env, preference={provider_key_id:0,model:"",version:0}; const writes=[];
  const settings=async update=>{if(update){writes.push(update);preference={provider_key_id:update.provider_key_id,model:update.model,version:preference.version+1};}return preference;};
  env=await surface(t,{
    "@/lib/cloudImageSettings":{cloudImageSettings:settings},
    "@/lib/relay/client":{listRelayApiKeys:async()=>[{id:41,name:"图像分组",status:"active",key_configured:true,group:{name:"设计",platform:"openai"}}],getRelayProviderModels:async()=>({data:[{id:"gpt-image-test"}]})},
    "@liveagent/ui/components/models/ModelPickerContent":{ModelPickerContent:props=>env.React.createElement("div",null,env.React.createElement("button",{onClick:()=>props.onSelect(props.options[0].value)},"选择测试模型"),env.React.createElement("button",{onClick:()=>props.onSelect("")},props.noneLabel))},
  });
  const {CloudImageSettingsSection}=env.loadModule("src/pages/settings/CloudImageSettingsSection.tsx");
  await env.act(async()=>{env.root.render(env.React.createElement(CloudImageSettingsSection));await tick();});
  await env.act(async()=>[...env.host.querySelectorAll("button")].find(x=>x.getAttribute("aria-label")==="生图模型").click());
  await env.act(async()=>[...document.querySelectorAll("button")].find(x=>x.textContent==="选择测试模型").click());
  assert.deepEqual(writes,[{expected_version:0,provider_key_id:41,model:"gpt-image-test"}]);
  assert.match(env.host.textContent,/gpt-image-test/);
  await env.act(async()=>env.host.querySelector('[aria-label="生图模型"]').click());
  await env.act(async()=>[...document.querySelectorAll("button")].find(x=>x.textContent==="未配置").click());
  assert.deepEqual(writes[1],{expected_version:1,provider_key_id:0,model:""});
});
