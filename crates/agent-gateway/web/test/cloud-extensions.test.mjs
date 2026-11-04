import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {createWebDomTestEnv} from '../../test/helpers/dom-test-env.mjs';
import {createWebModuleLoader} from '../../test/helpers/load-web-module.mjs';

const loader=createWebModuleLoader();
const {cloudComposerSkills,buildCloudComposerText,parseExtensionCatalog}=loader.loadModule('src/lib/cloudExtensions.ts');
const drafts=loader.loadModule('@liveagent/ui/features/extensions/extensionDrafts.ts');
const skill={name:'weekly-review',description:'Review a week',entry:'SKILL.md'};
const pkg={id:'abc',kind:'skill',visibility:'personal',owned:true,name:'weekly-review',description:'Review a week',publisher:'你',version:3,installed:true,enabled:true,builtin:false,skills:[skill],disabled_skills:[],examples:[],updated_at:''};
const catalog={version:4,packages:[pkg]};
const revision={number:3,name:pkg.name,description:pkg.description,skills:[skill],files:{'SKILL.md':'# Private workflow\nInstructions','references/notes.md':'# Reference'},created_at:''};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('uncertain writes are fenced until a fresh catalog read; older in-flight reads cannot clear the fence',async()=>{
 let finishOldRead,oldRead=true,writes=0,invalidRead=false;
 const transport=createWebModuleLoader({mocks:{[fileURLToPath(new URL('../src/lib/accountRequest.ts',import.meta.url))]:{
  captureAccountRequestGuard:()=>()=>{},
  accountFetch:async(_path,init={})=>{
   if(init.method==='POST'){writes++;throw new Error('response lost after commit');}
   if(oldRead){oldRead=false;return await new Promise(resolve=>{finishOldRead=()=>resolve(Response.json(catalog));});}
   return invalidRead?Response.json({invalid:true}):Response.json(catalog);
  },
 }}});
 const adapter=transport.loadModule('src/lib/cloudExtensions.ts').createCloudExtensionsAdapter('test');
 const older=adapter.list();await tick();
 await assert.rejects(adapter.mutate(4,{action:'save',revision}),/结果尚未确认/);
 assert.equal(adapter.writeUnconfirmed,true);
 finishOldRead();await older;assert.equal(adapter.writeUnconfirmed,true);
 await assert.rejects(adapter.mutate(4,{action:'save',revision}),/先刷新目录/);assert.equal(writes,1);
 invalidRead=true;await assert.rejects(adapter.list());assert.equal(adapter.writeUnconfirmed,true);
 invalidRead=false;await adapter.list();assert.equal(adapter.writeUnconfirmed,false);
 await assert.rejects(adapter.mutate(4,{action:'save',revision}));assert.equal(writes,2);
});

test('acknowledged validation rejections allow correction; server failures and malformed success require reconciliation',async()=>{
 for(const [status,body,uncertain] of [[400,{error:'请检查技能文件'},false],[409,{error:'conflict'},false],[500,{error:'unavailable'},true],[200,{invalid:true},true]]){
  const transport=createWebModuleLoader({mocks:{[fileURLToPath(new URL('../src/lib/accountRequest.ts',import.meta.url))]:{
   captureAccountRequestGuard:()=>()=>{},accountFetch:async()=>Response.json(body,{status}),
  }}});
  const adapter=transport.loadModule('src/lib/cloudExtensions.ts').createCloudExtensionsAdapter('test');
  await assert.rejects(adapter.mutate(4,{action:'enable',id:'abc',enabled:false}));
  assert.equal(adapter.writeUnconfirmed,uncertain,`status ${status}`);
 }
});

test('new editor revisions send only writable fields and surface server validation errors',async()=>{
 let payload;
 const transport=createWebModuleLoader({mocks:{[fileURLToPath(new URL('../src/lib/accountRequest.ts',import.meta.url))]:{
  captureAccountRequestGuard:()=>()=>{},
  accountFetch:async(_path,init)=>{payload=JSON.parse(init.body);return new Response(JSON.stringify(catalog));},
 }}});
 const {createCloudExtensionsAdapter}=transport.loadModule('src/lib/cloudExtensions.ts');
 await createCloudExtensionsAdapter('test').mutate(4,{action:'save',revision:{...revision,number:0,created_at:''}});
 assert.equal(payload.expected_version,4);
 assert.equal(payload.revision.created_at,undefined);
 assert.equal(payload.revision.number,undefined);
 assert.equal(payload.revision.files['SKILL.md'],revision.files['SKILL.md']);
 const failing=createWebModuleLoader({mocks:{[fileURLToPath(new URL('../src/lib/accountRequest.ts',import.meta.url))]:{
  captureAccountRequestGuard:()=>()=>{},accountFetch:async()=>new Response(JSON.stringify({error:'请检查技能文件'}),{status:400}),
 }}}).loadModule('src/lib/cloudExtensions.ts');
 await assert.rejects(failing.createCloudExtensionsAdapter('test').mutate(4,{action:'enable',id:'abc',enabled:false}),/请检查技能文件/);
});

test('cloud references preserve immutable identity without enabling disabled skills',()=>{
 const selected=cloudComposerSkills(catalog);assert.equal(selected.length,1);assert.equal(selected[0].skillFile,'zeroagent-skill:abc/3/weekly-review');
 const draft={segments:[{type:'text',text:'Please '},{type:'skillMention',skill:selected[0]},{type:'text',text:' with these notes'}]};
 assert.match(buildCloudComposerText(draft),/\[weekly-review\]\(zeroagent-skill:abc\/3\/weekly-review\)/);
 assert.equal(cloudComposerSkills({...catalog,packages:[{...pkg,disabled_skills:['weekly-review']}]}).length,0);
 assert.equal(cloudComposerSkills({...catalog,packages:[{...pkg,installed:false}]}).length,0);
 assert.throws(()=>parseExtensionCatalog({...catalog,packages:[{...pkg,skills:[null]}]}));
});

test('editor draft recovery is bounded and separated by account and package',()=>{
 const items=new Map(), storage={getItem:key=>items.get(key),setItem:(key,value)=>items.set(key,value),removeItem:key=>items.delete(key)};
 const draft={revision,baseline:'before',version:4};
 drafts.writeExtensionDraft(storage,'cloud:one','abc',draft);
 assert.equal(drafts.readExtensionDraft(storage,'cloud:one','abc').revision.files['SKILL.md'],revision.files['SKILL.md']);
 assert.equal(drafts.readExtensionDraft(storage,'cloud:two','abc'),null);
 assert.equal(drafts.readExtensionDraft(storage,'cloud:one','other'),null);
 items.set(drafts.extensionDraftKey('cloud:one','abc'),'{broken');assert.equal(drafts.readExtensionDraft(storage,'cloud:one','abc'),null);
 drafts.writeExtensionDraft(storage,'cloud:one','abc',draft);drafts.writeExtensionDraft(storage,'cloud:one','abc',null);assert.equal(items.size,0);
});

async function mount(t,overrides={}) {
 const env=await createWebDomTestEnv({mocks:{[fileURLToPath(new URL('../../../agent-ui/src/components/Markdown.tsx',import.meta.url))]:{Markdown:({content})=>env.React.createElement('div',null,content)}}});
 const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host),calls=[];
 const adapter={scope:'test-account',list:async()=>catalog,read:async()=>({revision,version:4}),mutate:async(version,input)=>{calls.push({version,input});return catalog;},importArchive:async()=>catalog,download:async()=>new Blob(['archive']),...overrides};
 const {ExtensionsWorkspace}=env.loadModule('@liveagent/ui/features/extensions/ExtensionsWorkspace.tsx');
 let props={adapter,catalog:overrides.catalog??catalog,loading:false,error:'',onRefresh(){calls.push({refresh:true});},onBack(){},onTry(...args){calls.push({try:args});},onCatalog(next){props={...props,catalog:next};root.render(env.React.createElement(ExtensionsWorkspace,props));}};
 const render=()=>env.act(async()=>{root.render(env.React.createElement(ExtensionsWorkspace,props));await tick();});
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});await render();
 const click=async(name)=>{const el=[...document.querySelectorAll('button,[role^="menuitem"]')].find(el=>(el.getAttribute('aria-label')??el.textContent).trim()===name);assert.ok(el,name);await env.act(async()=>{el.click();await tick();});};
 return {env,calls,click,adapter,async flush(){await env.act(async()=>{await tick();});},async fill(label,value){const el=document.querySelector(`[aria-label="${label}"]`)??[...document.querySelectorAll('label')].find(el=>el.textContent.trim().startsWith(label))?.control;assert.ok(el,label);await env.act(async()=>{Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));await tick();});}};
}

test('directory, actual source reading and explicit try use the same selected identity',async t=>{
 const app=await mount(t);await app.click('技能');await app.click('个人');await app.click('weekly-reviewReview a week');await app.flush();
 assert.match(document.querySelector('[role="dialog"]').textContent,/# Private workflow/);
 await app.click('references/notes.md');assert.match(document.querySelector('[role="dialog"]').textContent,/# Reference/);
 await app.click('在对话中使用');assert.equal(app.calls[0].try[0].id,'abc');assert.equal(app.calls[0].try[1].entry,'SKILL.md');
});

test('customization navigation uses shared menu rows and exposes one current category',async t=>{
 const app=await mount(t,{catalog:{version:4,packages:[publicPlugin,publicSkill]}});
 await app.click('技能');
 const navigation=document.querySelector('nav[aria-label="自定义"]');
 const current=navigation.querySelectorAll('[aria-current="page"]');assert.equal(current.length,1);assert.equal(current[0].textContent.trim(),'技能');
 assert.equal(current[0].getAttribute('data-slot'),'sidebar-menu-button');
 assert.equal([...navigation.querySelectorAll('button')].find(node=>node.textContent.trim()==='插件').hasAttribute('data-active'),false);
});

test('editing retains the draft after a failed save and only saves through explicit version CAS',async t=>{
 const app=await mount(t,{mutate:async(version,input)=>{app.calls.push({version,input});throw new Error('内容已在其他页面更新');}});
 await app.click('技能');await app.click('个人');await app.click('weekly-review的操作');await app.click('编辑技能');await app.flush();
 await app.fill('名称','review-updated');await app.click('保存');
 assert.equal(app.calls.length,1);assert.equal(app.calls[0].version,4);assert.equal(app.calls[0].input.revision.name,'review-updated');
 assert.match(document.body.textContent,/内容已在其他页面更新/);
 assert.equal(document.querySelector('input[value="review-updated"]').value,'review-updated');
 assert.ok(window.sessionStorage.getItem(drafts.extensionDraftKey('test-account','abc')));
});

const publicPlugin={...pkg,id:'product-design',kind:'plugin',visibility:'public',owned:false,builtin:true,name:'Product Design',skills:[{name:'product-design',description:'Design',entry:'SKILL.md'},{name:'bundled-audit',description:'Private to plugin',entry:'audit.md'}]};
const publicSkill={...pkg,id:'skill-creator',visibility:'public',owned:false,builtin:true,name:'skill-creator',skills:[{name:'skill-creator',description:'Create a skill',entry:'SKILL.md'}]};

test('kind, source and installation filters are independent and bundled skills stay in their plugin',async t=>{
 const uninstalled={...pkg,id:'uninstalled',name:'uninstalled-review',installed:false};
 const app=await mount(t,{catalog:{version:4,packages:[publicPlugin,publicSkill,pkg,uninstalled]}});
 const directory=()=>document.querySelector('.za-extension-directory').textContent;
 assert.match(directory(),/产品设计/);assert.doesNotMatch(directory(),/bundled-audit|weekly-review|创建技能/);
 await app.click('技能');assert.match(directory(),/创建技能/);assert.doesNotMatch(directory(),/bundled-audit|产品设计/);
 await app.click('个人');assert.match(directory(),/weekly-review/);assert.match(directory(),/uninstalled-review/);
 await app.click('安装状态');await app.click('未安装');assert.doesNotMatch(directory(),/weekly-review/);assert.match(directory(),/uninstalled-review/);
 assert.notEqual(document.querySelector('button[aria-label="安装状态"]').getAttribute('aria-expanded'),'true');
 await app.click('安装 uninstalled-review');assert.equal(app.calls.at(-1).input.action,'install');assert.equal(app.calls.at(-1).input.id,'uninstalled');
});

test('public actions allow disable and uninstall without edit or download',async t=>{
 const app=await mount(t,{catalog:{version:4,packages:[publicPlugin]}});
 await app.click('产品设计的操作');
 const menu=document.querySelector('[role="menu"]');assert.ok(menu);
 assert.doesNotMatch(menu.textContent,/编辑|下载/);assert.match(menu.textContent,/停用/);assert.match(menu.textContent,/卸载/);
 await app.click('停用');assert.equal(app.calls.at(-1).input.action,'enable');assert.equal(app.calls.at(-1).input.enabled,false);
});

test('an empty installation filter does not claim the owner has no personal content',async t=>{
 const app=await mount(t);
 await app.click('技能');await app.click('个人');await app.click('安装状态');await app.click('未安装');
 assert.match(document.body.textContent,/没有未安装的技能/);assert.doesNotMatch(document.body.textContent,/还没有个人内容/);
});

test('a successful import reveals the new item even when the prior filter had no matches',async t=>{
 const imported={...pkg,id:'imported',name:'imported-review',skills:[{...skill,name:'imported-review'}]};
 const app=await mount(t,{importArchive:async()=>({version:5,packages:[pkg,imported]})});
 await app.click('技能');await app.click('个人');await app.click('安装状态');await app.click('未安装');
 await app.click('添加');await app.click('上传技能包');
 const input=document.querySelector('input[type="file"]');
 await app.env.act(async()=>{Object.defineProperty(input,'files',{configurable:true,value:[new window.File(['fixture'],'skill.zip',{type:'application/zip'})]});input.dispatchEvent(new Event('change',{bubbles:true}));await tick();});
 assert.doesNotMatch(document.querySelector('.za-extension-directory').textContent,/imported-review/);
 await app.click('添加技能');
 assert.match(document.querySelector('.za-extension-directory').textContent,/imported-review/);
 assert.match(document.querySelector('button[aria-label="安装状态"]').textContent,/全部/);
});

test('personal uninstalled content keeps edit and download rights and can be reinstalled',async t=>{
 const app=await mount(t,{catalog:{version:4,packages:[{...pkg,installed:false}]}});
 await app.click('技能');await app.click('个人');await app.click('weekly-review的操作');
 assert.match(document.querySelector('[role="menu"]').textContent,/编辑技能/);assert.match(document.querySelector('[role="menu"]').textContent,/下载/);
 await app.click('安装');assert.equal(app.calls.at(-1).input.action,'install');
});

test('creating a plugin keeps a separate draft from the existing new skill draft',async t=>{
 const app=await mount(t);
 drafts.writeExtensionDraft(window.sessionStorage,'test-account',undefined,{revision,baseline:'before',version:4});
 await app.click('添加');await app.click('使用编辑器创建');
 assert.match(document.querySelector('h1').textContent,/创建插件/);assert.equal(document.querySelector('input').value,'');
 await app.fill('名称','personal-plugin');
 assert.equal(drafts.readExtensionDraft(window.sessionStorage,'test-account','new-plugin').revision.name,'personal-plugin');
 assert.equal(drafts.readExtensionDraft(window.sessionStorage,'test-account',undefined).revision.name,'weekly-review');
});

test('a plugin display label does not change the immutable reference identity or inject Markdown',()=>{
 const mention=cloudComposerSkills({version:1,packages:[{...publicPlugin,id:'personal-design',builtin:false,visibility:'personal',owned:true,name:'Product [Design]'}]})[0];
 assert.equal(mention.name,'product-design');assert.equal(mention.displayName,'Product [Design]');
 const text=buildCloudComposerText({segments:[{type:'skillMention',skill:mention}]});
 assert.equal(text,'[Product \\[Design\\]](zeroagent-skill:personal-design/3/product-design)');
 assert.throws(()=>parseExtensionCatalog({...catalog,packages:[{...pkg,visibility:'public',owned:true}]}));
});

test('inline display labels survive DOM and persisted draft round trips without changing skill identity',async t=>{
 const env=await createWebDomTestEnv();t.after(()=>env.cleanup());
 const {createSkillMentionChip,collectDraftSegments}=env.loadModule('@liveagent/ui/components/chat/MentionComposerInternals.tsx');
 const {parseCloudPendingComposer}=env.loadModule('src/lib/cloudChatQueue.ts');
 const mention=cloudComposerSkills({version:1,packages:[publicPlugin]})[0];
 const editor=document.createElement('div');editor.appendChild(createSkillMentionChip(mention));
 const segments=collectDraftSegments(editor,new Map());assert.equal(editor.textContent.trim(),'产品设计');assert.equal(segments[0].skill.name,'product-design');assert.equal(segments[0].skill.displayName,'产品设计');
 const draft={text:'',textWithoutLargePastes:'',isEmpty:false,segments,largePastes:[],skillMentions:[],appMentions:[],commitMentions:[],gitFileMentions:[],codeMentions:[]};
 const restored=parseCloudPendingComposer(JSON.parse(JSON.stringify(draft)));assert.equal(restored.skillMentions[0].displayName,'产品设计');assert.equal(restored.skillMentions[0].skillFile,mention.skillFile);
 assert.throws(()=>parseCloudPendingComposer({...draft,segments:[{type:'skillMention',skill:{...mention,displayName:{invalid:true}}}]}));
});

test('chat creation selects the plugin creator for plugins and standalone creator for skills',async t=>{
 const pluginCreator={...publicPlugin,id:'plugin-creator',name:'Plugin Creator'};
 const app=await mount(t,{catalog:{version:4,packages:[pluginCreator,publicSkill]}});
 await app.click('添加');await app.click('通过聊天创建');assert.equal(app.calls.at(-1).try[0].id,'plugin-creator');
 await app.click('技能');await app.click('添加');await app.click('通过聊天创建');assert.equal(app.calls.at(-1).try[0].id,'skill-creator');
});

test('Chinese builtin presentation preserves personal names and both language search aliases',()=>{
 const display=loader.loadModule('@liveagent/ui/lib/extensions/presentation.ts');
 assert.equal(display.extensionDisplayName(publicPlugin),'产品设计');
 assert.equal(display.extensionDisplayName({...publicPlugin,builtin:false,visibility:'personal',name:'My own design'}),'My own design');
 assert.match(display.extensionSearchText(publicPlugin),/产品设计/);assert.match(display.extensionSearchText(publicPlugin),/product design/);
 const mention=cloudComposerSkills({version:4,packages:[publicPlugin]})[0];
 assert.equal(mention.name,'product-design');assert.equal(mention.skillFile,'zeroagent-skill:product-design/3/product-design');assert.equal(mention.displayName,'产品设计');
 assert.match(mention.searchText,/product design/);
});

test('a legacy English reference renders Chinese without changing its immutable target or surrounding text',async t=>{
 const env=await createWebDomTestEnv();t.after(()=>env.cleanup());
 const {createSkillMentionChip,collectDraftSegments}=env.loadModule('@liveagent/ui/components/chat/MentionComposerInternals.tsx');
 const mention={name:'product-design',displayName:'Product Design',description:'Design',baseDir:'cloud',skillFile:'zeroagent-skill:product-design/2/product-design'};
 const editor=document.createElement('div');editor.append('Existing draft ',createSkillMentionChip(mention),' remains');
 const segments=collectDraftSegments(editor,new Map());assert.equal(editor.textContent,'Existing draft 产品设计 remains');
 assert.equal(segments.find(segment=>segment.type==='skillMention').skill.skillFile,mention.skillFile);assert.equal(segments.find(segment=>segment.type==='skillMention').skill.name,'product-design');
 assert.equal(editor.querySelector('img').getAttribute('src').endsWith('product-design.webp'),true);
});

async function chooseArchive(app,name,body='fixture') {
 const input=document.querySelector('input[type="file"]');
 await app.env.act(async()=>{Object.defineProperty(input,'files',{configurable:true,value:[new window.File([body],name,{type:'application/zip'})]});input.dispatchEvent(new Event('change',{bubbles:true}));await tick();});
}
test('import cancellation and invalid files never write, and replacing a valid choice invalidates it',async t=>{
 let writes=0;const app=await mount(t,{importArchive:async()=>{writes++;return catalog;}});
 await app.click('添加');await app.click('上传插件包');await chooseArchive(app,'plugin.zip');assert.equal(writes,0);
 await app.click('取消');assert.equal(writes,0);
 await app.click('添加');await app.click('上传插件包');await chooseArchive(app,'plugin.zip');await chooseArchive(app,'notes.txt');
 assert.match(document.querySelector('[role="alert"]').textContent,/ZIP/);
 assert.equal([...document.querySelectorAll('button')].find(el=>el.textContent==='添加插件').disabled,true);
 assert.equal(writes,0);
});

test('an unknown import keeps its file, fences resubmission and offers an explicit read-only reconciliation',async t=>{
 let writes=0;const app=await mount(t,{importArchive:async()=>{writes++;app.adapter.writeUnconfirmed=true;throw new Error('导入结果尚未确认');}});
 await app.click('添加');await app.click('上传插件包');await chooseArchive(app,'plugin.zip');await app.click('添加插件');
 assert.equal(writes,1);assert.match(document.querySelector('[role="dialog"]').textContent,/plugin.zip/);
 assert.equal([...document.querySelectorAll('button')].find(el=>el.textContent==='添加插件').disabled,true);
 await app.click('刷新目录核对');assert.equal(app.calls.at(-1).refresh,true);assert.equal(writes,1);
});

test('long plugin details progressively disclose skills without losing the rest of the list',async t=>{
 const many={...publicPlugin,skills:Array.from({length:8},(_,i)=>({name:`workflow-${i}`,description:`Workflow ${i}`,entry:'SKILL.md'}))};
 const app=await mount(t,{catalog:{version:4,packages:[many]}});await app.click('产品设计');
 assert.equal(document.querySelectorAll('.za-extension-skill-link').length,5);
 await app.click('查看其余 3 项技能');assert.equal(document.querySelectorAll('.za-extension-skill-link').length,8);
 await app.click('收起技能');assert.equal(document.querySelectorAll('.za-extension-skill-link').length,5);
});
