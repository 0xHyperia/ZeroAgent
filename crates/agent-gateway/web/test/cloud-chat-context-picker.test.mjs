import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settleFocus(env) { await env.act(async()=>{ await new Promise(resolve=>setTimeout(resolve,250)); }); }
const file=(id,name,state='ready')=>({id,name,state,mime:'text/markdown',size:10,text_bytes:10,workspace_loadable:true});
async function mount(t,overrides={}){
  const env=await createWebDomTestEnv({mocks:{'@liveagent/ui/components/IconSet':new Proxy({},{get:()=>()=>null})}});
  window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host);
  const anchor=document.body.appendChild(document.createElement('button'));anchor.textContent='文件';anchor.focus();
  const events={attached:[],projects:[],closed:0,focused:0,research:0};
  let revision=0;
  const captureGuard=()=>{const at=revision;return()=>{if(at!==revision)throw new Error('retired account');};};
  let props={extensions:[],onTryExtension(){},onCustomize(){},kind:'files',anchor,mobile:false,scope:'one',revision:0,projectsClient:{listProjects:async()=>({items:[],next_before_id:''})},filesClient:{list:async()=>({files:[],nextCursor:''})},captureGuard,attachedIds:[],disabled:false,researchEnabled:false,onSelectProject:async project=>events.projects.push(project),onAttach:item=>events.attached.push(item.id),onBrowse(){},onCreateProject(){},onToggleResearch:()=>events.research++,onFillDraft(){},onFocusComposer:()=>events.focused++,...overrides};
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
  await app.click('notes.md');assert.deepEqual(app.events.attached,['one']);assert.equal(app.events.closed,1);await settleFocus(app.env);assert.equal(app.events.focused,1);
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
  await settleFocus(app.env);
  assert.ok(document.querySelector('[data-slot="sheet-backdrop"]'));
  assert.ok(document.activeElement===document.querySelector('[data-slot="sheet-popup"]'));
  assert.ok(document.activeElement!==document.querySelector('input'));
  const close=document.querySelector('button[aria-label="关闭从资料库添加"]');assert.ok(close);
  await app.env.act(async()=>{close.click();await tick();});await settleFocus(app.env);assert.equal(app.events.closed,1);assert.ok(document.activeElement===app.anchor);
});

test('tool selection is an explicit research toggle and never loads account resources',async t=>{
  let requests=0;
  const app=await mount(t,{kind:'tools',filesClient:{list(){requests++;}},projectsClient:{listProjects(){requests++;}}});
  await app.click('公开联网研究发送前确认要公开搜索的研究主题');
  assert.equal(app.events.research,1);assert.equal(requests,0);assert.equal(app.events.attached.length,0);assert.equal(app.events.projects.length,0);
});

test('independent skill search keeps an older pinned selection removable',async t=>{
 const used=[],removed=[];
 const skill={name:'design-audit',description:'核对产品界面',entry:'audit.md'};
 const pkg={id:'product-design',kind:'skill',name:'Design audit',installed:true,enabled:true,version:2,disabled_skills:[],skills:[skill]};
 const oldFile='zeroagent-skill:product-design/1/design-audit';
 const app=await mount(t,{kind:'tools',extensions:[pkg],selectedSkillFiles:[oldFile],onTryExtension:(...value)=>used.push(value),onRemoveSkill:file=>removed.push(file)});
 const input=document.querySelector('input[aria-label="搜索插件与技能"]');assert.ok(input);
 await app.env.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'audit');input.dispatchEvent(new window.Event('input',{bubbles:true}));await tick();});
 const rows=[...document.querySelectorAll('[data-picker-entry]')];assert.equal(rows.length,1);assert.equal(rows[0].getAttribute('aria-pressed'),'true');
 await app.env.act(async()=>{rows[0].click();await tick();});assert.deepEqual(removed,[oldFile]);assert.equal(used.length,0);
});

test('composer lists a plugin once and does not flatten its bundled skills',async t=>{
 const used=[];
 const pkg={id:'product-design',kind:'plugin',name:'Product Design',installed:true,enabled:true,version:2,disabled_skills:[],skills:[{name:'product-design',description:'设计',entry:'SKILL.md'},{name:'design-audit',description:'核对产品界面',entry:'audit.md'}]};
 const app=await mount(t,{kind:'tools',extensions:[pkg],onTryExtension:(...args)=>used.push(args)});
 const rows=[...document.querySelectorAll('[data-picker-entry]')];assert.equal(rows.length,1);
 assert.match(rows[0].textContent,/Product Design/);assert.doesNotMatch(document.body.textContent,/design-audit/);
 await app.env.act(async()=>{rows[0].click();await tick();});assert.equal(used[0][1].name,'product-design');
});

test('project selection is single-flight and waits for the association result before closing',async t=>{
  let release,selected=0;
  const project={id:'one',name:'计划'};
  const app=await mount(t,{kind:'projects',projectsClient:{listProjects:async()=>({items:[project],next_before_id:''})},onSelectProject:()=>{selected++;return new Promise(resolve=>{release=resolve;});}});
  await app.click('计划');const row=document.querySelector('[data-picker-entry]');assert.equal(row.disabled,true);
  await app.env.act(async()=>{row.click();await tick();});assert.equal(selected,1);assert.equal(app.events.closed,0);
  await app.env.act(async()=>{release();await tick();});assert.equal(app.events.closed,1);
});


test('Chinese and original names find builtin skills while details never insert a reference',async t=>{
 const pkg={id:'product-design',kind:'plugin',builtin:true,visibility:'public',name:'Product Design',description:'设计工作流',installed:true,enabled:true,version:2,disabled_skills:[],skills:[{name:'product-design',description:'设计',entry:'SKILL.md'},{name:'design-audit',description:'核对产品界面',entry:'audit.md'}]};
 const viewed=[],selected=[];const app=await mount(t,{kind:'tools',extensions:[pkg],onViewExtension:pkg=>viewed.push(pkg.id),onTryExtension:(_pkg,skill)=>selected.push(skill.name)});
 assert.equal(document.querySelectorAll('[data-picker-entry]').length,1);assert.match(document.querySelector('[data-picker-entry]').textContent,/产品设计/);
 await app.env.act(async()=>document.querySelector('[aria-label="查看产品设计详情"]').click());
 assert.deepEqual(viewed,['product-design']);assert.deepEqual(selected,[]);
 await app.update({kind:'tools'});
 const input=document.querySelector('input');
 await app.env.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'审查体验');input.dispatchEvent(new Event('input',{bubbles:true}));await tick();});
 assert.equal(document.querySelectorAll('[data-picker-entry]').length,0);
 await app.env.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'Product Design');input.dispatchEvent(new Event('input',{bubbles:true}));await tick();});
 const rows=document.querySelectorAll('[data-picker-entry]');
 assert.equal(rows.length,1);assert.match(rows[0].textContent,/研究产品问题、探索设计方向/);
 await app.env.act(async()=>{rows[0].click();await tick();});assert.deepEqual(selected,['product-design']);
});

test('the add menu presents the installed capability catalog with stable identities',async t=>{
 const env=await createWebDomTestEnv();t.after(()=>env.cleanup());
 const {CloudChatComposerMenu}=env.loadModule('src/components/cloudchat/CloudChatComposerMenu.tsx');
 const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host),chosen=[];
 const item={id:'plugin-creator',kind:'plugin',builtin:true,visibility:'public',name:'Plugin Creator',description:'整理工作方法',installed:true,enabled:true,disabled_skills:[],skills:[{name:'plugin-creator',description:'创建',entry:'SKILL.md'}]};
 const props={open:true,disabled:false,researchEnabled:false,onUpload(){},onOpenFiles(){},onOpenProjects(){},onToggleResearch(){},onCreateImage(){},onProductDesign(){},onCustomize(){},onTryExtension:(pkg,skill)=>chosen.push([pkg.id,skill.name]),extensions:[item,{...item,id:'disabled',name:'Hidden',enabled:false}]};
 try{await env.act(async()=>{root.render(env.React.createElement(CloudChatComposerMenu,props));await tick();});
 const option=[...document.querySelectorAll('[role="menuitem"]')].find(el=>el.textContent.includes('创建插件'));assert.ok(option);assert.equal(Boolean([...document.querySelectorAll('[role="menuitem"]')].find(el=>el.textContent.includes('Hidden'))),false);
 await env.act(async()=>option.click());assert.deepEqual(chosen,[['plugin-creator','plugin-creator']]);
 }finally{await env.act(async()=>root.unmount());host.remove();}
});

test('creating a project from the composer closes the picker and opens creation without page navigation',async t=>{
 let created=0,browsed=0;
 const app=await mount(t,{kind:'projects',onCreateProject:()=>created++,onBrowse:()=>browsed++});
 await app.click('新建项目');assert.equal(created,1);assert.equal(browsed,0);assert.equal(app.events.closed,1);
});
