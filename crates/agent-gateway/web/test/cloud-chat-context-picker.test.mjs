import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const file=(id,name,state='ready')=>({id,name,state,mime:'text/markdown',size:10,text_bytes:10,workspace_loadable:true});
async function mount(t,overrides={}){
  const env=await createWebDomTestEnv({mocks:{'@liveagent/ui/components/IconSet':new Proxy({},{get:()=>()=>null})}});
  window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host);
  const anchor=document.body.appendChild(document.createElement('button'));anchor.textContent='文件';anchor.focus();
  const events={attached:[],projects:[],closed:0,focused:0,research:0};
  let revision=0;
  const captureGuard=()=>{const at=revision;return()=>{if(at!==revision)throw new Error('retired account');};};
  let props={kind:'files',anchor,mobile:false,scope:'one',revision:0,projectsClient:{listProjects:async()=>({items:[],next_before_id:''})},filesClient:{list:async()=>({files:[],nextCursor:''})},captureGuard,attachedIds:[],disabled:false,researchEnabled:false,onSelectProject:async project=>events.projects.push(project),onAttach:item=>events.attached.push(item.id),onBrowse(){},onToggleResearch:()=>events.research++,onFillDraft(){},onFocusComposer:()=>events.focused++,...overrides};
  const {CloudChatContextPicker}=env.loadModule('src/components/cloudchat/CloudChatContextPicker.tsx');
  const render=async()=>env.act(async()=>{root.render(env.React.createElement(CloudChatContextPicker,{...props,onClose:()=>{events.closed++;props={...props,kind:null};root.render(env.React.createElement(CloudChatContextPicker,{...props,onClose(){}}));}}));await tick();});
  t.after(async()=>{await env.act(async()=>root.unmount());host.remove();anchor.remove();env.cleanup();});
  await render();
  return {env,events,anchor,async update(next){props={...props,...next};await render();},retire(){revision++;},async flush(){await env.act(async()=>{await tick();});},async click(text){const el=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text);assert.ok(el,text);await env.act(async()=>{el.click();await tick();});}};
}

test('file picker distinguishes ready, processing and already attached files and returns focus after selection',async t=>{
  const app=await mount(t,{filesClient:{list:async()=>({files:[file('one','notes.md'),file('two','report.pdf','processing'),file('three','attached.md')],nextCursor:''})},attachedIds:['three']});
  const rows=[...document.querySelectorAll('[data-picker-entry]')];
  assert.equal(rows[0].disabled,false);assert.equal(rows[1].disabled,true);assert.equal(rows[2].disabled,true);
  await app.click('notes.md');assert.deepEqual(app.events.attached,['one']);assert.equal(app.events.closed,1);await app.flush();assert.equal(app.events.focused,1);
});

test('loaded-page filtering and pagination do not duplicate resources or parse file names as markup',async t=>{
  let calls=0;
  const app=await mount(t,{filesClient:{list:async()=>++calls===1?{files:[file('one','<img onerror=attack>.md')],nextCursor:'next'}:{files:[file('one','<img onerror=attack>.md'),file('two','other.md')],nextCursor:''}}});
  assert.equal(document.querySelector('img'),null);
  assert.equal(document.querySelector('input').getAttribute('aria-label'),'筛选已加载文件');
  await app.click('加载更多');assert.equal(document.querySelectorAll('[data-picker-entry]').length,2);
  const input=document.querySelector('input');
  await app.env.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'other');input.dispatchEvent(new window.Event('input',{bubbles:true}));await tick();});
  assert.equal(document.querySelectorAll('[data-picker-entry]').length,1);assert.match(document.querySelector('[data-picker-entry]').textContent,/other/);
});

test('late list results cannot populate a different view or account',async t=>{
  let release,calls=0;
  const app=await mount(t,{filesClient:{list:()=>++calls===1?new Promise(resolve=>{release=resolve;}):Promise.resolve({files:[file('new','current.md')],nextCursor:''})}});
  app.retire();await app.update({scope:'two'});
  await app.env.act(async()=>{release({files:[file('old','retired-private.md')],nextCursor:''});await tick();});
  assert.match(document.body.textContent,/current.md/);assert.doesNotMatch(document.body.textContent,/retired-private/);
});

test('failed listing retries explicitly without leaking internal errors or selecting a resource',async t=>{
  let calls=0;
  const app=await mount(t,{filesClient:{list:async()=>{if(++calls===1)throw new Error('private backend diagnostic');return {files:[file('one','recovered.md')],nextCursor:''};}}});
  assert.match(document.body.textContent,/加载失败/);assert.doesNotMatch(document.body.textContent,/private backend/);
  await app.click('重试');assert.match(document.body.textContent,/recovered.md/);assert.deepEqual(app.events.attached,[]);assert.equal(calls,2);
});

test('mobile picker uses the shared modal sheet and does not summon the keyboard on open',async t=>{
  const app=await mount(t,{mobile:true});
  assert.ok(document.querySelector('[data-slot="sheet-backdrop"]'));
  assert.equal(document.activeElement,document.querySelector('[data-slot="sheet-popup"]'));
  assert.notEqual(document.activeElement,document.querySelector('input'));
  const close=document.querySelector('button[aria-label="关闭从资料库添加"]');assert.ok(close);
  await app.env.act(async()=>{close.click();await tick();});assert.equal(app.events.closed,1);assert.equal(document.activeElement,app.anchor);
});

test('tool selection is an explicit research toggle and never loads account resources',async t=>{
  let requests=0;
  const app=await mount(t,{kind:'tools',filesClient:{list(){requests++;}},projectsClient:{listProjects(){requests++;}}});
  await app.click('公开联网研究发送前确认要公开搜索的研究主题');
  assert.equal(app.events.research,1);assert.equal(requests,0);assert.equal(app.events.attached.length,0);assert.equal(app.events.projects.length,0);
});

test('project selection is single-flight and waits for the association result before closing',async t=>{
  let release,selected=0;
  const project={id:'one',name:'计划'};
  const app=await mount(t,{kind:'projects',projectsClient:{listProjects:async()=>({items:[project],next_before_id:''})},onSelectProject:()=>{selected++;return new Promise(resolve=>{release=resolve;});}});
  await app.click('计划');const row=document.querySelector('[data-picker-entry]');assert.equal(row.disabled,true);
  await app.env.act(async()=>{row.click();await tick();});assert.equal(selected,1);assert.equal(app.events.closed,0);
  await app.env.act(async()=>{release();await tick();});assert.equal(app.events.closed,1);
});
