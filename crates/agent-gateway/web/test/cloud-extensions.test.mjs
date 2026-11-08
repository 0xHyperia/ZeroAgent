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

test('a missing or inaccessible fixed revision is distinct from a temporary read error', async()=>{
 for(const status of [403,404,503]){
  const calls=[];
  const transport=createWebModuleLoader({mocks:{[fileURLToPath(new URL('../src/lib/accountRequest.ts',import.meta.url))]:{
   captureAccountRequestGuard:()=>()=>{},
   accountFetch:async(path)=>{calls.push(path);return Response.json({error:'fixture'},{status});},
  }}});
  const {createCloudExtensionsAdapter}=transport.loadModule('src/lib/cloudExtensions.ts');
  const {ExtensionRevisionUnavailable}=transport.loadModule('@liveagent/ui/features/extensions/extensionTypes.ts');
  await assert.rejects(createCloudExtensionsAdapter('test').read(pkg.id,undefined,2),error=>
   error instanceof Error && (error instanceof ExtensionRevisionUnavailable)===(status!==503));
  assert.deepEqual(calls,[`/api/web-chat/extensions/${pkg.id}?revision=2`]);
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
 const env=await createWebDomTestEnv({mocks:{[fileURLToPath(new URL('../../../agent-ui/src/components/Markdown.tsx',import.meta.url))]:{Markdown:props=>overrides.renderMarkdown?.(env.React,props)??env.React.createElement('div',null,props.content)}}});
 const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host),calls=[];
 const adapter={scope:'test-account',list:async()=>catalog,read:async()=>({revision,version:4}),mutate:async(version,input)=>{calls.push({version,input});return catalog;},importArchive:async()=>catalog,download:async()=>new Blob(['archive']),...overrides};
 const {ExtensionsWorkspace}=env.loadModule('@liveagent/ui/features/extensions/ExtensionsWorkspace.tsx');
 const {LocaleContext}=env.loadModule('@liveagent/ui/i18n/LocaleContext.tsx');
 const {t:translate}=env.loadModule('@liveagent/ui/i18n/index.ts');
 let props={adapter,openPackage:overrides.openPackage,location:overrides.location,onNavigate:overrides.location?location=>{props={...props,location};renderWorkspace();}:undefined,onConfigureImages:overrides.onConfigureImages,onTryOnDevice:overrides.onTryOnDevice,catalog:overrides.catalog===undefined?catalog:overrides.catalog,loading:false,error:overrides.error??'',onRefresh(){calls.push({refresh:true});},onBack:overrides.onBack??(()=>{}),onTry(...args){calls.push({try:args});return overrides.onTry?.(...args)??'accepted';},onCatalog(next){props={...props,catalog:next};renderWorkspace();}};
 const locale=overrides.locale??'zh-CN';
 const renderWorkspace=()=>root.render(env.React.createElement(LocaleContext.Provider,{value:{locale,t:key=>translate(key,locale)}},env.React.createElement(ExtensionsWorkspace,props)));
 const render=()=>env.act(async()=>{renderWorkspace();await tick();});
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});await render();
 const click=async(name)=>{const el=[...document.querySelectorAll('button,[role^="menuitem"]')].find(el=>(el.getAttribute('aria-label')??el.textContent).trim()===name);assert.ok(el,name);await env.act(async()=>{el.click();await tick();});};
 return {env,calls,click,adapter,async setContext(scope,location){props={...props,adapter:{...props.adapter,scope},location};await render();},async setDirectory(next,{error='',loading=false}={}){props={...props,catalog:next,error,loading};await render();},async flush(){await env.act(async()=>{await tick();});},async fill(label,value){const el=document.querySelector(`[aria-label="${label}"]`)??[...document.querySelectorAll('label')].find(el=>el.textContent.trim().startsWith(label))?.control;assert.ok(el,label);await env.act(async()=>{Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));await tick();});}};
}

test('directory, actual source reading and explicit try use the same selected identity',async t=>{
 const app=await mount(t);await app.click('技能');await app.click('个人');await app.click('weekly-reviewReview a week');await app.flush();
 assert.match(document.querySelector('[role="dialog"]').textContent,/# Private workflow/);
 const currentFile=()=>document.querySelector('[role="menuitemradio"][aria-checked="true"]');
 await app.click('浏览技能文件');
 assert.equal(currentFile().getAttribute('aria-label'),'技能正文');
 await app.click('references/notes.md');assert.match(document.querySelector('[role="dialog"]').textContent,/# Reference/);
 await app.click('浏览技能文件');
 assert.equal(currentFile().getAttribute('aria-label'),'references/notes.md');
 assert.match(currentFile().textContent,/notes\.mdreferences\//);
 await app.click('技能正文');assert.match(document.querySelector('[role="dialog"]').textContent,/# Private workflow/);
 await app.click('在对话中使用');assert.equal(app.calls[0].try[0].id,'abc');assert.equal(app.calls[0].try[1].entry,'SKILL.md');
});

test('a rejected use action preserves the open file and focus until the conversation accepts it', async t => {
 let result = 'conversation-unavailable';
 const app = await mount(t, {onTry: () => result});
 await app.click('技能'); await app.click('个人'); await app.click('weekly-reviewReview a week');
 await app.click('浏览技能文件'); await app.click('references/notes.md');
 const reader = document.querySelector('[role="dialog"]');
 const use = [...reader.querySelectorAll('button')].find(button => button.textContent === '在对话中使用');
 await app.env.act(async () => use.focus());
 await app.click('在对话中使用');
 assert.ok(document.querySelector('[role="dialog"]') === reader);
 assert.equal(document.activeElement, use);
 assert.match(reader.querySelector('[role="alert"]').textContent, /此对话暂时无法添加技能/);
 assert.match(reader.querySelector('.za-skill-reader-content').textContent, /# Reference/);
 result = 'skill-unavailable';
 await app.click('在对话中使用');
 assert.match(reader.querySelector('[role="alert"]').textContent, /此技能暂不可用/);
 result = 'accepted';
 await app.click('在对话中使用');
 assert.ok(!document.querySelector('[role="dialog"]'));
 assert.deepEqual(app.calls.map(call => call.try.map(item => item.id ?? item.name)), Array(3).fill(['abc', 'weekly-review']));
});

test('skill reader reconciles an uncertain installation in place without replacing the selected file', async t => {
 const initial = {version:4,packages:[{...pkg,installed:false}]};
 const writes = [];
 let fail, unknown = false;
 const app = await mount(t, {
  locale:'en-US',catalog:initial,location:{route:{page:'skills'}},
  mutate:async (version,input) => {
   writes.push({version,input});
   return new Promise((_resolve,reject)=>{
    fail = uncertain => {
     unknown = uncertain;
     reject(new Error(uncertain ? 'lost fixture receipt' : 'Installation was rejected.'));
    };
   });
  },
 });
 Object.defineProperty(app.adapter,'writeUnconfirmed',{get:()=>unknown});
 await app.click('Personal');
 await app.click('weekly-reviewReview a week');
 await app.click('Browse skill files');
 await app.click('references/notes.md');
 const reader = document.querySelector('[role="dialog"]');
 const action = [...reader.querySelectorAll('footer button')].find(button=>button.textContent==='Install skill');
 const press = async () => app.env.act(async()=>{action.click();await tick();});
 const reject = async uncertain => app.env.act(async()=>{fail(uncertain);await tick();});
 action.focus();
 await press();
 assert.equal(action.textContent,'Installing…');
 assert.equal(action.getAttribute('aria-disabled'),'true');
 assert.equal(document.activeElement,action);
 await press();
 assert.equal(writes.length,1);
 await reject(false);
 assert.match(reader.querySelector('footer [role="alert"]').textContent,/Installation was rejected/);
 assert.equal(action.textContent,'Install skill');

 await press();
 await reject(true);
 assert.equal(action.textContent,'Check installation');
 assert.match(reader.querySelector('footer [role="status"]').textContent,/installation result is unconfirmed/);
 await press();
 await app.setDirectory(initial,{loading:true});
 assert.equal(action.textContent,'Checking…');
 assert.equal(document.activeElement,action);
 await press();
 assert.deepEqual(app.calls,[{refresh:true}]);
 await app.setDirectory(initial,{error:'offline'});
 assert.equal(action.textContent,'Check installation');
 assert.match(reader.querySelector('footer [role="alert"]').textContent,/Couldn't check installation/);

 await press();
 unknown = false;
 await app.setDirectory(initial);
 assert.equal(action.textContent,'Check installation','the original directory is not confirmation');
 await app.setDirectory({version:4,packages:initial.packages});
 assert.equal(action.textContent,'Install skill');
 assert.match(reader.querySelector('footer [role="status"]').textContent,/still uninstalled/);
 assert.equal(writes.length,2);

 await press();
 await reject(true);
 await press();
 unknown = false;
 await app.setDirectory({version:5,packages:[pkg]});
 assert.equal(action.textContent,'Try in chat');
 assert.equal(document.activeElement,action);
 assert.match(reader.querySelector('footer [role="status"]').textContent,/confirms this skill is installed/);
 assert.match(reader.querySelector('.za-skill-reader-content').textContent,/# Reference/);
 assert.deepEqual(writes,Array.from({length:3},()=>({version:4,input:{action:'install',id:pkg.id}})));
 assert.deepEqual(app.calls,[{refresh:true},{refresh:true},{refresh:true}]);
 await press();
 assert.equal(app.calls[3].try[0].id,pkg.id);
 assert.equal(app.calls[3].try[1].entry,skill.entry);
});

test('an uninstalled skill opened with a fenced directory offers a read before another write',async t=>{
 const initial = {version:4,packages:[{...pkg,installed:false}]};
 const app = await mount(t, {
  locale:'en-US',catalog:initial,location:{route:{page:'skills'},reader:{id:pkg.id}},
  writeUnconfirmed:true,
 });
 const reader = document.querySelector('[role="dialog"]');
 assert.match(reader.querySelector('footer [role="status"]').textContent,/Check the directory before installing/);
 assert.ok(![...reader.querySelectorAll('footer button')].some(button=>button.textContent==='Install skill'));
 await app.click('Check installation');
 assert.deepEqual(app.calls,[{refresh:true}]);
});

test('a rejected plugin example keeps details open and offers a deliberate return to the draft', async t => {
 const example = 'Use the latest review workflow';
 const plugin = {...pkg,kind:'plugin',examples:[example]};
 let returns = 0;
 const app = await mount(t, {
  locale:'en-US',
  catalog:{version:4,packages:[plugin]},
  location:{route:{page:'plugin',id:plugin.id}},
  onBack(){returns++;},
  onTry:()=> 'draft-reference-conflict',
 });
 const detail = document.querySelector('.za-extension-detail-header');
 const starter = document.querySelector('.za-extension-starters button');
 await app.env.act(async()=>{starter.focus();starter.click();await tick();});
 assert.equal(returns,0);
 assert.equal(document.querySelector('.za-extension-detail-header'),detail);
 assert.equal(document.activeElement,starter);
 assert.match(document.querySelector('[data-extension-try-failure]').textContent,/draft already references another revision/);
 assert.equal(app.calls[0].try[2],example);
 await app.click('Back to draft');
 assert.equal(returns,1);
 assert.equal(document.querySelector('[data-extension-try-failure]'),null);
});

test('closing a missing composer-linked skill returns to the conversation', async t => {
 let returned = 0;
 let reads = 0;
 const app = await mount(t, {
  locale: 'en-US',
  location: {route: {page: 'skills'}, reader: {id: 'missing', returnToChat: true}},
  async read() { reads++; throw new Error('A missing package should not be read'); },
  onBack() { returned++; },
 });
 const reader = document.querySelector('[role="dialog"]');
 assert.match(reader.textContent, /Skill unavailable/);
 const back = [...reader.querySelectorAll('button')].find(button => button.textContent === 'Back to chat');
 await app.env.act(async () => {back.click(); await tick();});
 assert.ok(!document.querySelector('[role="dialog"]'));
 assert.equal(returned, 1);
 assert.equal(reads, 0);
});

test('a missing linked plugin returns to the plugin directory', async t => {
 const app = await mount(t, {
  locale: 'en-US',
  location: {route: {page: 'plugin', id: 'missing'}, reader: {id: 'missing', skillName: 'missing'}},
 });
 await app.click('Back to directory');
 assert.ok(!document.querySelector('[role="dialog"]'));
 assert.equal(document.querySelector('.za-extensions-header h1').textContent, 'Plugins');
});

test('opening a standalone skill from the composer goes to its reader and closing returns to chat',async t=>{
 let returned=0;
 const app=await mount(t,{openPackage:{id:'abc',key:1},onBack(){returned++;}});
 const reader=document.querySelector('[role="dialog"]');
 assert.ok(reader);assert.match(reader.textContent,/# Private workflow/);
 await app.click('关闭技能详情');
 assert.equal(document.querySelector('[role="dialog"]'),null);
 assert.equal(returned,1);
 assert.deepEqual(app.calls,[]);
});

test('reloading a pinned skill link reads the archived entry rather than the current package',async t=>{
 const {readCloudChatRoute,cloudChatRouteHref}=loader.loadModule('src/lib/cloudChatRoute.ts');
 const standalone=new URL('http://localhost/skills?skill_id=abc&skill_name=old-review&skill_revision=2');
 const plugin=new URL('http://localhost/plugins/design/skills/old-audit?skill_revision=1');
 const route=readCloudChatRoute(standalone);
 assert.equal(cloudChatRouteHref(route,standalone),standalone.pathname+standalone.search);
 assert.equal(cloudChatRouteHref(readCloudChatRoute(plugin),plugin),plugin.pathname+plugin.search);
 const oldSkill={...skill,name:'old-review',entry:'archived/SKILL.md'};
 let reads=0;
 await mount(t,{
  location:route.location,
  read:async(id,_signal,number)=>{
   assert.equal(id,'abc');assert.equal(number,2);reads++;
   return {version:4,revision:{...revision,number:2,skills:[oldSkill],files:{'archived/SKILL.md':'# Archived source\nFixed instructions'}}};
  },
 });
 const dialog=document.querySelector('[role="dialog"]');
 assert.match(dialog.textContent,/Archived source/);
 assert.equal(dialog.querySelector('nav [aria-current="true"] span[title]').title,'archived/SKILL.md');
 assert.ok(![...dialog.querySelectorAll('button')].some(button=>button.textContent.includes('在对话中使用')));
 assert.equal(reads,1);
});

test('standalone skill management and directory agree on its sole effective switch', async t => {
 const disabled = {...pkg, enabled:false};
 const writes = [];
 const app = await mount(t, {
  locale:'en-US',
  location:{route:{page:'skills'}},
  catalog:{version:4,packages:[disabled]},
  mutate:async(version,input)=>{
   writes.push({version,input});
   return {version:5,packages:[{...pkg,disabled_skills:[]}]};
  },
 });
 await app.click('Personal');
 const row = () => document.querySelector(`[data-extension-open="${pkg.id}"]`).closest('li');
 assert.match(row().textContent,/Disabled/);
 await app.click(`Actions for ${pkg.name}`);
 const menu = document.querySelector('[role="menu"]');
 assert.equal([...menu.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent.trim()==='Use in chat').getAttribute('aria-disabled'),'true');
 assert.ok([...menu.querySelectorAll('[role="menuitem"]')].some(item=>item.textContent.trim()==='Enable'));
 await app.click('Manage');
 const switches = document.querySelectorAll('[role="switch"]');
 assert.equal(switches.length,1);
 const toggle = switches[0];
 assert.equal(toggle.getAttribute('aria-label'),`Enable skill ${pkg.name}`);
 assert.equal(toggle.getAttribute('aria-checked'),'false');
 assert.ok(document.querySelector('.za-extension-skill-link'));
 await app.env.act(async()=>{toggle.click();await tick();});
 assert.deepEqual(writes,[{version:4,input:{action:'enable',id:pkg.id,enabled:true}}]);
 assert.equal(toggle.getAttribute('aria-checked'),'true');
 await app.env.act(async()=>{document.querySelector('.za-extension-breadcrumb button').click();await tick();});
 assert.match(row().textContent,/Installed/);
 await app.click(`Actions for ${pkg.name}`);
 const actions = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
 assert.ok(actions.some(item=>item.textContent.trim()==='Disable'));
 assert.equal(actions.find(item=>item.textContent.trim()==='Use in chat').getAttribute('aria-disabled'),null);
});

test('a disabled pinned skill can return from management to the original revision and chat', async t => {
 const disabled = {...pkg, enabled:false};
 const archived = {...skill, name:'old-review', entry:'archived/SKILL.md'};
 const location = {route:{page:'skills'},reader:{id:pkg.id,skillName:archived.name,revision:2,returnToChat:true}};
 let returns = 0;
 const reads = [];
 const app = await mount(t, {
  locale:'en-US', location,
  catalog:{version:4,packages:[disabled]},
  onBack:()=>returns++,
  read:async(id,_signal,number)=>{
   reads.push({id,number});
   return {version:4,revision:{...revision,number:2,skills:[archived],files:{[archived.entry]:'# Archived instructions'}}};
  },
 });
 const dialog = document.querySelector('[role="dialog"]');
 assert.match(dialog.querySelector('.za-skill-reader-availability').textContent,/This skill is disabled/);
 assert.match(dialog.querySelector('.za-skill-reader-content').textContent,/Archived instructions/);
 await app.click('Manage skill');
 assert.equal(document.querySelector('[role="dialog"]'),null);
 assert.equal(document.activeElement,document.querySelector('.za-extensions-main h1'));
 const toggle = [...document.querySelectorAll('[role="switch"]')].find(node=>node.getAttribute('aria-label')===`Enable skill ${pkg.name}`);
 assert.equal(toggle?.getAttribute('aria-checked'),'false');
 assert.equal(returns,0);
 assert.deepEqual(app.calls,[]);
 const actions = document.querySelector('.za-extension-detail-header');
 assert.match(actions.textContent,/Back to original skill/);
 assert.doesNotMatch(actions.textContent,/Try in chat/);
 await app.setDirectory(null,{error:'fixture directory offline'});
 await app.click('Back to original skill');
 assert.match(document.querySelector('.za-skill-reader-content').textContent,/Archived instructions/);
 assert.deepEqual(reads,[{id:pkg.id,number:2},{id:pkg.id,number:2}]);
 await app.click('Close skill details');
 assert.equal(returns,1);
});

test('a readable archived reference can reinstall its own package and return to the original draft', async t => {
 for (const kind of ['skill','plugin']) await t.test(kind, async t => {
  const uninstalled={...pkg,kind,installed:false};
  const archived={...skill,name:'old-review',entry:'archived/SKILL.md'};
  const route=kind==='plugin'?{page:'plugin',id:pkg.id}:{page:'skills'};
  const reads=[],writes=[];
  let returns=0, finishInstall;
  const app=await mount(t,{
   locale:'en-US',location:{route,reader:{id:pkg.id,skillName:archived.name,revision:2,returnToChat:true}},
   catalog:{version:4,packages:[uninstalled]},
   onBack:()=>returns++,
   read:async(id,_signal,number)=>{
    reads.push([id,number]);
    return {version:4,revision:{...revision,number:2,skills:[archived],files:{[archived.entry]:'# Original instructions'}}};
   },
   mutate:async(version,input)=>{
    writes.push({version,input});
    await new Promise(resolve=>{finishInstall=resolve;});
    return {version:5,packages:[{...uninstalled,installed:true}]};
   },
  });
  const dialog=()=>document.querySelector('[role="dialog"]');
  assert.match(dialog().querySelector('.za-skill-reader-content').textContent,/Original instructions/);
  assert.match(dialog().querySelector('.za-skill-reader-availability')?.textContent??'',new RegExp(`This ${kind} is not installed`));
  await app.click(`Manage ${kind}`);
  assert.equal(dialog(),null);
  assert.equal(writes.length,0);
  assert.equal(returns,0);
  const install=[...document.querySelectorAll('.za-extension-detail-header button')].find(button=>button.textContent==='Install');
  await app.env.act(async()=>{install.focus();install.click();await tick();});
  assert.equal(document.activeElement,install);
  assert.equal(install.getAttribute('aria-disabled'),'true');
  await app.env.act(async()=>{install.click();finishInstall();await tick();});
  assert.deepEqual(writes,[{version:4,input:{action:'install',id:pkg.id}}]);
  assert.equal(document.activeElement.textContent,'Back to original skill');
  await app.click('Back to original skill');
  assert.match(dialog().querySelector('.za-skill-reader-content').textContent,/Original instructions/);
  assert.equal(dialog().querySelector('.za-skill-reader-availability'),null);
  assert.deepEqual(reads,[[pkg.id,2],[pkg.id,2]]);
  await app.click('Close skill details');
  assert.equal(returns,1);
  assert.deepEqual(app.calls,[]);
 });
 await t.test('an unreadable pinned member has no reinstall shortcut', async t => {
  const app=await mount(t,{
   locale:'en-US',location:{route:{page:'skills'},reader:{id:pkg.id,skillName:'missing',revision:2,returnToChat:true}},
   catalog:{version:4,packages:[{...pkg,installed:false}]},
   read:async()=>({version:4,revision:{...revision,number:2}}),
  });
  const dialog=document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent,/This skill revision is unavailable/);
  assert.doesNotMatch(dialog.textContent,/Manage skill|Install skill/);
  assert.deepEqual(app.calls,[]);
 });
});

test('a pinned skill can retry its own revision with the directory unavailable',async t=>{
 const oldSkill={...skill,name:'old-review',display_name:'Archived review'};
 const reads=[];let returned=0;
 const app=await mount(t,{
  locale:'en-US',catalog:null,error:'offline',
  location:{route:{page:'skills'},reader:{id:pkg.id,skillName:'old-review',revision:2,returnToChat:true}},
  async read(id,signal,number){
   reads.push([id,number]);assert.ok(signal);
   if(reads.length===1)throw Error('internal transport');
   return {version:4,revision:{...revision,number:2,skills:[oldSkill]}};
  },
  onBack(){returned++;},
 });
 const dialog=document.querySelector('[role="dialog"]');
 assert.match(dialog.textContent,/Unable to load the skill/);
 assert.doesNotMatch(dialog.textContent,/internal transport|Try in chat|Install skill/);
 await app.click('Retry');
 assert.equal(document.querySelector('[role="dialog"]'),dialog);
 assert.equal(document.activeElement.textContent,'Skill instructions');
 assert.match(dialog.textContent,/Archived review|# Private workflow/);
 assert.match(dialog.querySelector('.za-skill-reader-content').textContent,/# Private workflow/);
 assert.doesNotMatch(dialog.textContent,/Try in chat|Install skill/);
 await app.setDirectory(catalog);
 assert.equal(document.querySelector('[role="dialog"]'),dialog);
 assert.deepEqual(reads,[[pkg.id,2],[pkg.id,2]]);
 await app.click('Close skill details');
 assert.equal(returned,1);
 assert.equal(document.querySelector('[role="dialog"]'),null);
});

test('an unpinned missing catalogue entry offers a directory retry, not a guessed version',async t=>{
 let reads=0;
 const app=await mount(t,{
  locale:'en-US',catalog:null,error:'offline',
  location:{route:{page:'skills'},reader:{id:pkg.id}},
  async read(){reads++;return {version:4,revision};},
 });
 assert.match(document.querySelector('[role="dialog"]').textContent,/Could not load skill information/);
 await app.click('Retry directory');
 assert.deepEqual(app.calls,[{refresh:true}]);
 assert.equal(reads,0);
 await app.setDirectory(catalog);
 assert.match(document.querySelector('[role="dialog"]').textContent,/# Private workflow/);
 assert.equal(reads,1);
});

test('a fixed built-in skill uses localized presentation even without a catalogue',async t=>{
 const entry={...skill,name:'index',description:'Authentic release description'};
 const app=await mount(t,{
  catalog:null,error:'offline',
  location:{route:{page:'skills'},reader:{id:'product-design',skillName:'index',revision:5}},
  async read(){return {version:6,revision:{...revision,number:5,skills:[entry],files:{'SKILL.md':'# Product Design\nOriginal instructions.'}}};},
 });
 const dialog=document.querySelector('[role="dialog"]');
 assert.equal(dialog.querySelector('h2').textContent,'产品设计');
 assert.match(dialog.querySelector('.za-skill-reader-content').textContent,/Original instructions/);
 assert.deepEqual(app.calls,[]);
 const {builtinSkillPresentation}=loader.loadModule('@liveagent/ui/lib/extensions/presentation.ts');
 assert.equal(builtinSkillPresentation('constructor','index','zh-CN'),undefined);
 assert.equal(builtinSkillPresentation('product-design','constructor','zh-CN'),undefined);
});

test('device action checks the fixed skill revision and keeps its reader after incompatibility',async t=>{
 const paths=[];let status=422;
 const transport=createWebModuleLoader({mocks:{[fileURLToPath(new URL('../src/lib/accountRequest.ts',import.meta.url))]:{
  captureAccountRequestGuard:()=>()=>{},
  accountFetch:async(path,{signal})=>{paths.push(path);assert.ok(signal);return new Response(null,{status});},
 }}});
 const {prepareDeviceSkillMention}=transport.loadModule('src/lib/cloudExtensions.ts');
 const mentions=[];
 const app=await mount(t,{
  location:{route:{page:'skills'},reader:{id:pkg.id,skillName:skill.name,revision:2}},
  read:async()=>({version:4,revision:{...revision,number:2}}),
  onTryOnDevice:async(item,entry,number,signal)=>{
   mentions.push(await prepareDeviceSkillMention(item,entry,number,'zh-CN',signal));
  },
 });
 const reader=document.querySelector('[role="dialog"]');
 await app.click('在此电脑中使用');
 assert.match(reader.querySelector('[role="alert"]').textContent,/此电脑无法使用/);
 assert.match(reader.textContent,/# Private workflow/);
 assert.deepEqual(mentions,[]);
 status=204;
 await app.click('在此电脑中使用');
 assert.equal(reader.querySelector('[role="alert"]'),null);
 assert.equal(mentions[0].skillFile,'zeroagent-skill:abc/2/weekly-review');
 assert.equal(paths.length,2);
 assert.ok(paths.every(path=>path==='/api/web-chat/extensions/device-compatibility/abc?revision=2&skill=weekly-review'));
 assert.deepEqual(app.calls,[]);
});

test('the skill tree opens nested scripts and copies the entire unmodified source',async t=>{
 const script='#!/usr/bin/env python3\r\ntext = """\r\n```markdown\r\n"""\r\n';
 const app=await mount(t,{
  read:async()=>({version:4,revision:{...revision,files:{...revision.files,'scripts/python/init_skill.py':script}}}),
 });
 const clipboard=[];
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>clipboard.push(text)}});
 await app.click('技能');await app.click('个人');await app.click('weekly-reviewReview a week');await app.flush();
 const tree=document.querySelector('nav[aria-label="技能文件"]');
 assert.equal(tree.querySelector('[aria-current="true"]').textContent,'SKILL.md');
 await app.click('python');await app.click('init_skill.py');
 assert.equal(tree.querySelector('[aria-current="true"]').textContent,'init_skill.py');
 assert.match(document.querySelector('.za-skill-source-card header').textContent,/Python/);
 await app.click('复制文件内容');
 assert.deepEqual(clipboard,[script]);
 await app.click('SKILL.md');
 assert.match(document.querySelector('[role="dialog"]').textContent,/# Private workflow/);
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

test('a bundled skill opens its own body and keeps sibling skills out of the supporting file menu',async t=>{
 const audit=publicPlugin.skills[1];
 const app=await mount(t,{
  catalog:{version:4,packages:[publicPlugin]},
  read:async()=>({version:4,revision:{...revision,skills:publicPlugin.skills,files:{...revision.files,[audit.entry]:'# Audit workflow\nCollect the evidence.'}}}),
 });
 await app.click('产品设计');
 await app.env.act(async()=>{[...document.querySelectorAll('.za-extension-skill-link')].find(link=>link.textContent.includes(audit.name)).click();await tick();});
 const dialog=document.querySelector('[role="dialog"]');
 assert.match(dialog.textContent,/技能正文.*Audit workflow/s);
 assert.doesNotMatch(dialog.textContent,/Private workflow/);
 await app.click('浏览技能文件');
 const files=document.querySelector('[role="menu"]');
 const options=[...files.querySelectorAll('[role="menuitemradio"]')];
 assert.deepEqual(options.map(option=>option.getAttribute('aria-label')),['技能正文','references/notes.md']);
 assert.match(options[0].textContent,/audit\.md/);
 assert.doesNotMatch(files.textContent,/SKILL\.md/);
});

test('closing a linked skill without an opener focuses the current skills directory', async t => {
 const route = {page: 'skills'};
 const app = await mount(t, {
  locale: 'en-US',
  catalog: {version: 4, packages: [publicSkill]},
  location: {route, reader: {id: publicSkill.id}},
 });
 assert.ok(document.querySelector('[role="dialog"]'));
 await app.click('Close skill details');
 await app.env.act(async () => { await new Promise(window.requestAnimationFrame); });
 assert.equal(document.querySelector('[role="dialog"]'), null);
 assert.equal(document.activeElement, document.querySelector('.za-extensions-main h1'));
});

test('browser Back from a bundled skill restores its original row and detail scroll', async t => {
 const skills = Array.from({length: 6}, (_, index) => ({
  name: `workflow-${index}`, description: `Workflow ${index}`, entry: `skills/workflow-${index}/SKILL.md`,
 }));
 const plugin = {...publicPlugin, skills};
 const route = {page: 'plugin', id: plugin.id};
 const app = await mount(t, {
  locale: 'en-US',
  catalog: {version: 4, packages: [plugin]},
  location: {route},
 });
 await app.click('Show 1 more');
 const viewport = document.querySelector('.za-extensions-main [data-scroll-viewport]');
 const opener = [...viewport.querySelectorAll('.za-extension-skill-link')].at(-1);
 viewport.scrollTop = 360;
 await app.env.act(async () => { opener.click(); await tick(); });
 assert.ok(document.querySelector('[role="dialog"]'));
 viewport.scrollTop = 340;
 await app.setContext(app.adapter.scope, {route});
 await app.env.act(async () => { await new Promise(window.requestAnimationFrame); });
 assert.equal(document.querySelector('[role="dialog"]'), null);
 assert.equal(document.activeElement, opener);
 assert.equal(viewport.scrollTop, 360);
 assert.equal(viewport.querySelector('.za-extension-show-skills').getAttribute('aria-expanded'), 'true');
});

test('reading linked files keeps the exact revision, follows keyboard focus, and returns within the reader',async t=>{
 const first={name:'check',description:'Check a design',entry:'skills/check/SKILL.md'};
 const second={name:'other',description:'Another skill',entry:'skills/other/SKILL.md'};
 const plugin={...publicPlugin,id:'fixture-plugin',name:'Fixture Plugin',builtin:false,skills:[first,second],version:4};
 const files={
  [first.entry]:'## Read the source',
  [second.entry]:'## Sibling skill',
  'references/quality notes.md':'## Quality checks',
  'references/followup.py':'# Follow-up details\nprint("report")\n',
 };
 const reads=[];
 const app=await mount(t,{
  locale:'en-US',catalog:{version:1,packages:[plugin]},
  location:{route:{page:'plugin',id:plugin.id},reader:{id:plugin.id,skillName:first.name,revision:3}},
  read:async(id,_signal,revision)=>{reads.push([id,revision]);return {version:1,revision:{number:3,name:plugin.name,description:plugin.description,skills:[first,second],files}};},
  renderMarkdown(React,{content,componentOverrides,preserveRelativeUrls}) {
   assert.equal(preserveRelativeUrls,true);
   const a=(label,href)=>React.createElement(componentOverrides.a,{href,key:label},label);
   const code=(label)=>React.createElement(componentOverrides.code,{key:label},label);
   return React.createElement('div',null,content,content.includes('Read the source')?[
    a('Quality notes','../../references/quality%20notes.md'),
    code('references/quality notes.md'),
    a('External','https://example.invalid/references/quality%20notes.md'),
    a('Sibling','../other/SKILL.md'),
    a('Escape','../../../references/quality%20notes.md'),
   ]:content.includes('Quality checks')?[a('Follow-up','./followup.py')]:null);
  },
 });
 const reader=document.querySelector('[role="dialog"]');
 const viewport=()=>reader.querySelector('.za-skill-reader-document [data-scroll-viewport]');
 assert.ok(reader.querySelector('nav[aria-label="Skill files"]'));
 assert.deepEqual([...reader.querySelectorAll('.za-skill-inline-reference')].map(el=>el.textContent),['Quality notes','references/quality notes.md']);
 viewport().scrollTop=140;
 await app.click('references/quality notes.md');
 assert.match(reader.textContent,/Quality checks/);
 assert.equal(document.activeElement.textContent,'references/quality notes.md');
 assert.equal(viewport().scrollTop,0);
 viewport().scrollTop=87;
 await app.click('Follow-up');
 assert.equal(document.activeElement.textContent,'references/followup.py');
 assert.equal(viewport().getAttribute('aria-label'),'Read references/followup.py');
 assert.equal(viewport().tabIndex,0);
 assert.match(reader.querySelector('.za-skill-source-card').textContent,/print\("report"\)/);
 await app.click('Back to previous file');
 assert.match(reader.textContent,/Quality checks/);
 assert.equal(viewport().scrollTop,87);
 assert.equal(document.activeElement.textContent,'Follow-up');
 await app.click('Back to skill instructions');
 assert.equal(document.activeElement.textContent,'references/quality notes.md');
 assert.equal(viewport().scrollTop,140);
 assert.match(reader.textContent,/Read the source/);
 assert.deepEqual(reads,[[plugin.id,3]]);
 assert.deepEqual(app.calls,[]);
});

test('kind, source and installation filters are independent and bundled skills stay in their plugin',async t=>{
 const uninstalled={...pkg,id:'uninstalled',name:'uninstalled-review',installed:false};
 const app=await mount(t,{catalog:{version:4,packages:[publicPlugin,publicSkill,pkg,uninstalled]}});
 const directory=()=>[...document.querySelectorAll('.za-extension-directory')].map(node=>node.textContent).join(' ');
 assert.match(directory(),/产品设计/);assert.doesNotMatch(directory(),/bundled-audit|weekly-review|创建技能/);
 await app.click('技能');assert.match(directory(),/创建技能/);assert.doesNotMatch(directory(),/bundled-audit|产品设计/);
 await app.click('个人');assert.match(directory(),/weekly-review/);assert.match(directory(),/uninstalled-review/);
 const sections=[...document.querySelectorAll('.za-extension-directory-section')];
 assert.deepEqual(sections.map(section=>section.querySelector('h2').textContent),['已安装','未安装']);
 assert.match(sections[0].textContent,/weekly-review/);assert.doesNotMatch(sections[0].textContent,/uninstalled-review/);
 await app.click('安装状态');await app.click('未安装');assert.doesNotMatch(directory(),/weekly-review/);assert.match(directory(),/uninstalled-review/);
 assert.notEqual(document.querySelector('button[aria-label="安装状态"]').getAttribute('aria-expanded'),'true');
 const source=()=>document.querySelector('.za-extension-source-tabs [aria-selected="true"]').textContent;
 const installation=()=>document.querySelector('button[aria-label="安装状态"]').textContent.trim();
 await app.click('插件');
 assert.equal(source(),'公开');assert.equal(installation(),'全部');assert.match(directory(),/产品设计/);
 await app.click('管理已安装插件');await app.fill('搜索插件','产品设计');
 assert.equal(installation(),'已安装');
 await app.click('技能');
 assert.equal(source(),'个人');assert.equal(installation(),'未安装');assert.match(directory(),/uninstalled-review/);
 await app.click('插件');
 assert.equal(source(),'公开');assert.equal(installation(),'已安装');
 assert.equal(document.querySelector('[aria-label="搜索插件"]').value,'产品设计');
 await app.click('技能');
 await app.click('安装 uninstalled-review');assert.equal(app.calls.at(-1).input.action,'install');assert.equal(app.calls.at(-1).input.id,'uninstalled');
});

test('public actions allow disable and uninstall without edit or download',async t=>{
 const app=await mount(t,{catalog:{version:4,packages:[publicPlugin]}});
 await app.click('产品设计的操作');
 const menu=document.querySelector('[role="menu"]');assert.ok(menu);
 assert.doesNotMatch(menu.textContent,/编辑|下载/);assert.match(menu.textContent,/停用/);assert.match(menu.textContent,/卸载/);
 await app.click('停用');assert.equal(app.calls.at(-1).input.action,'enable');assert.equal(app.calls.at(-1).input.enabled,false);
});

test('search reveals matches filtered by installation or source without losing the query', async t => {
 const publicMatch={...publicPlugin,id:'public-searchable',name:'Public audit',description:'Public workflow',installed:false,builtin:false};
 const privateMatch={...publicMatch,id:'private-searchable',name:'Private audit',description:'Private workflow',visibility:'personal',owned:true};
 const privateInstalled={...privateMatch,id:'private-installed',name:'Private guidelines',installed:true};
 const app=await mount(t,{locale:'en-US',catalog:{version:4,packages:[publicMatch,privateMatch,privateInstalled,publicSkill]}});
 const query=()=>document.querySelector('[aria-label="Search plugins"]').value;
 const source=()=>document.querySelector('.za-extension-source-tabs [aria-selected="true"]').textContent;
 const installation=()=>document.querySelector('[aria-label="Installation status"]').textContent.trim();
 const empty=()=>document.querySelector('.za-extension-empty');
 const recover=async()=>app.env.act(async()=>{const button=empty().querySelector('button');button.focus();button.click();await tick();});
 await app.click('Installation status');await app.click('Installed');
 await app.fill('Search plugins','Public audit');
 assert.match(empty().textContent,/Matches are available under another installation status/);
 assert.match(empty().textContent,/Show all installation statuses/);
 await recover();
 assert.equal(source(),'Public');assert.equal(installation(),'All');assert.equal(query(),'Public audit');
 assert.equal(document.activeElement.dataset.extensionOpen,publicMatch.id);
 await app.click('Installation status');await app.click('Installed');
 await app.fill('Search plugins','Private audit');
 assert.match(empty().textContent,/Matches are in Personal/);
 assert.match(empty().textContent,/View Personal · All statuses/);
 await recover();
 assert.equal(source(),'Personal');assert.equal(installation(),'All');assert.equal(query(),'Private audit');
 assert.equal(document.activeElement.dataset.extensionOpen,privateMatch.id);
 await app.click('Public');await app.click('Installation status');await app.click('Installed');
 await app.fill('Search plugins','Private guidelines');
 assert.equal(empty().querySelector('button').textContent,'View Personal');
 await recover();
 assert.equal(source(),'Personal');assert.equal(installation(),'Installed');assert.equal(query(),'Private guidelines');
 assert.equal(document.activeElement.dataset.extensionOpen,privateInstalled.id);
 await app.fill('Search plugins','Unknown workflow');
 assert.match(empty().textContent,/No matching results/);
 assert.equal(empty().querySelector('button'),null);
 assert.deepEqual(app.calls,[]);
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

test('ZeroAgent native examples localize the visible card and the text prepared for chat', async t => {
 const nativeDesign={...publicPlugin,native:true,examples:[
  'Audit this product flow using my screenshots',
  'Explore three directions for this feature',
  'Build an interactive prototype from this reference',
  'Untranslated fixture example',
 ]};
 const creator={...publicPlugin,id:'plugin-creator',native:true,examples:['Create a plugin for a task I do often']};
 const skillCreator={...publicSkill,native:true,examples:['Turn my instructions into a reusable skill']};
 const app=await mount(t,{catalog:{version:4,packages:[nativeDesign,creator,skillCreator]}});
 await app.click('产品设计');
 const examples=[...document.querySelectorAll('.za-extension-starters button')];
 assert.deepEqual(examples.map(button=>button.querySelector('strong + span').textContent),[
  '根据我的截图审查这个产品流程',
  '为这项功能探索三种设计方向',
  '根据这份参考实现可交互原型',
  'Untranslated fixture example',
 ]);
 await app.env.act(async()=>{examples[0].focus();examples[0].click();await tick();});
 assert.deepEqual(app.calls.at(-1).try,[nativeDesign,nativeDesign.skills[0],'根据我的截图审查这个产品流程']);
 await app.click('插件');await app.click('添加');await app.click('通过聊天创建');
 assert.deepEqual(app.calls.at(-1).try,[creator,creator.skills[0],'为我经常做的一项任务创建插件']);
 await app.click('技能');await app.click('添加');await app.click('通过聊天创建');
 assert.deepEqual(app.calls.at(-1).try,[skillCreator,skillCreator.skills[0],'把我的说明整理成可复用的技能']);
 const {extensionStarterPrompts}=loader.loadModule('@liveagent/ui/lib/extensions/presentation.ts');
 assert.deepEqual(extensionStarterPrompts(nativeDesign,'en-US'),nativeDesign.examples);
 assert.deepEqual(extensionStarterPrompts({...nativeDesign,native:false,publisher:'OpenAI'},'zh-CN'),nativeDesign.examples);
 assert.deepEqual(extensionStarterPrompts({...nativeDesign,builtin:false,visibility:'personal'},'zh-CN'),nativeDesign.examples);
 assert.deepEqual(extensionStarterPrompts({...nativeDesign,examples:[]},'zh-CN'),[]);
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
 assert.equal(display.extensionDescription({...publicPlugin,builtin:false,visibility:'personal',description:'Authored description'},'zh-CN'),'Authored description');
 assert.match(display.extensionSearchText(publicPlugin),/产品设计/);assert.match(display.extensionSearchText(publicPlugin),/product design/);
 assert.match(display.extensionSearchText(publicPlugin),/研究产品问题.*research, design/);
 const mention=cloudComposerSkills({version:4,packages:[publicPlugin]})[0];
 assert.equal(mention.name,'product-design');assert.equal(mention.skillFile,'zeroagent-skill:product-design/3/product-design');assert.equal(mention.displayName,'产品设计');
 assert.match(mention.searchText,/product design/);
});

test('English directory localizes ownership and lifecycle actions, keeping public packages read-only',async t=>{
 const app=await mount(t,{locale:'en-US',catalog:{version:4,packages:[publicPlugin,pkg]}});
 assert.equal(document.querySelector('.za-extensions-header h1').textContent,'Plugins');
 assert.deepEqual([...document.querySelectorAll('[role="tab"]')].map(el=>el.textContent),['Public','Personal']);
 assert.ok(document.querySelector('[aria-label="Installation status"]'));
 assert.equal(document.querySelector('.za-extension-row-state').textContent,'Installed');
 await app.click('Actions for Product Design');
 const options=[...document.querySelectorAll('[role^="menuitem"]')].map(el=>el.textContent.trim());
 assert.deepEqual(options,['Use in chat','Manage','Disable','Uninstall']);
 await app.click('Uninstall');
 assert.match(document.querySelector('[role="dialog"]').textContent,/Uninstall Product Design\?/);
 await app.click('Cancel');
 assert.deepEqual(app.calls,[]);
});

test('an unconfirmed uninstall rechecks the exact item and cannot repeat after it is absent', async t => {
  const initial = {version:4, packages:[publicPlugin]};
  const writes = [];
  let unknown = false, fail;
  const app = await mount(t, {locale:'en-US', catalog:initial, mutate:async (version, input) => {
    writes.push({version,input});
    return new Promise((_resolve, reject) => {
      fail = () => { unknown = true; reject(new Error('uncertain fixture receipt')); };
    });
  }});
  Object.defineProperty(app.adapter, 'writeUnconfirmed', {get:() => unknown});
  await app.click('Actions for Product Design');
  await app.click('Uninstall');
  const dialog = document.querySelector('[role="dialog"]');
  const action = [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Uninstall');
  const press = async () => app.env.act(async () => { action.click(); await tick(); });
  action.focus();
  await press();
  assert.equal(action.textContent, 'Uninstalling…');
  assert.equal(action.getAttribute('aria-disabled'), 'true');
  assert.equal(document.activeElement, action);
  await press();
  assert.equal(writes.length, 1);
  await app.env.act(async () => { fail(); await tick(); });
  assert.equal(action.textContent, 'Refresh directory to check');
  assert.match(dialog.textContent, /uninstall result is unconfirmed/);
  await press();
  await app.setDirectory(initial, {loading:true});
  assert.equal(action.textContent, 'Checking…');
  assert.equal(document.activeElement, action);
  await press();
  assert.deepEqual(app.calls, [{refresh:true}]);
  await app.setDirectory(initial, {error:'offline'});
  assert.match(dialog.textContent, /Couldn't check the uninstall result/);
  assert.equal(action.textContent, 'Refresh directory to check');
  assert.equal(writes.length, 1);

  await press();
  unknown = false;
  await app.setDirectory(initial);
  assert.equal(action.textContent, 'Refresh directory to check');
  await app.setDirectory({version:5, packages:[publicPlugin]});
  assert.match(dialog.textContent, /still installed/);
  assert.equal(action.textContent, 'Uninstall');
  assert.equal(writes.length, 1);
  await press();
  await app.env.act(async () => { fail(); await tick(); });
  await press();
  unknown = false;
  await app.setDirectory({version:6, packages:[{...publicPlugin,installed:false}]});
  assert.match(dialog.textContent, /Uninstalled\. Existing chats and results are kept/);
  assert.match(dialog.textContent, /Product Design uninstalled/);
  assert.equal(action.textContent, 'Done');
  assert.equal(document.activeElement, action);
  await press();
  assert.deepEqual(writes, [
    {version:4,input:{action:'uninstall',id:publicPlugin.id}},
    {version:5,input:{action:'uninstall',id:publicPlugin.id}},
  ]);
});

test('English extension details and manage preserve authored text and announce directory controls', async t => {
 const personal = {
  ...publicPlugin,
  id: 'personal-design',
  name: '我的设计工具',
  visibility: 'personal',
  owned: true,
  builtin: false,
  overview: '作者写的介绍',
  examples: ['作者写的示例'],
  unavailable_apps: [{name: '设计应用', description: '作者写的应用说明'}],
  skills: Array.from({length: 6}, (_, index) => ({
   name: `workflow-${index}`, description: '作者写的技能说明', entry: 'SKILL.md',
  })),
 };
 const app = await mount(t, {locale: 'en-US', catalog: {version: 4, packages: [publicPlugin, personal]}});
 const [publicTab, personalTab] = document.querySelectorAll('.za-extension-source-tabs [role="tab"]');
 const publicPanel = document.getElementById(publicTab.getAttribute('aria-controls'));
 const personalPanel = document.getElementById(personalTab.getAttribute('aria-controls'));
 assert.equal(publicPanel.getAttribute('role'), 'tabpanel');
 assert.equal(personalPanel.getAttribute('aria-labelledby'), personalTab.id);
 assert.equal(personalPanel.hidden, true);
 await app.env.act(async () => {
  publicTab.focus();
  publicTab.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, cancelable: true}));
  await tick();
 });
 assert.equal(document.activeElement, personalTab);
 assert.equal(personalTab.getAttribute('aria-selected'), 'true');
 assert.equal(publicPanel.hidden, true);
 assert.equal(personalPanel.hidden, false);
 const filter = document.querySelector('[aria-label="Installation status"]');
 const filterValue = document.getElementById(filter.getAttribute('aria-describedby'));
 assert.equal(filterValue.textContent, 'All');
 await app.click('Installation status');
 await app.click('Installed');
 assert.equal(filterValue.textContent, 'Installed');
 await app.env.act(async () => {
  personalPanel.querySelector('[data-extension-open="personal-design"]').click();
  await tick();
 });
 const content = document.querySelector('.za-extension-detail-content');
 assert.match(content.textContent, /我的设计工具.*作者写的示例.*作者写的介绍/);
 assert.match(content.textContent, /Apps 1.*作者写的应用说明.*Skills 6.*作者写的技能说明/);
 assert.match(content.textContent, /Plugin files.*Download.*Edit plugin.*Information.*Publisher.*Personal content/);
 await app.click('Show 1 more');
 assert.equal(content.querySelectorAll('.za-extension-skills .za-extension-skill-link').length, 6);
 await app.click('Manage');
 assert.ok(document.querySelector('[role="switch"][aria-label="Enable plugin 我的设计工具"]'));
 assert.ok(document.querySelector('[role="switch"][aria-label="Enable skill workflow-0"]'));
 assert.match(document.querySelector('.za-extension-detail-content').textContent, /Use in chat.*Uninstall/);
 assert.deepEqual(app.calls, []);
});

test('directory installation keeps the original action focused until a confirmed result replaces it', async t => {
 const first = {...publicPlugin, id:'install-first', name:'First workflow', installed:false, builtin:false};
 const second = {...first, id:'install-second', name:'Second workflow'};
 let packages = [first, second];
 let finish, writes = 0;
 const app = await mount(t, {locale:'en-US', catalog:{version:4,packages}, mutate:async (_version,input) => {
  writes++;
  return new Promise((resolve,reject) => {
   finish = success => {
    if (!success) return reject(new Error('Installation was rejected'));
    packages = packages.map(item => item.id === input.id ? {...item, installed:true} : item);
    resolve({version:4+writes,packages});
   };
  });
 }});
 await app.fill('Search plugins', 'workflow');
 const findInstall = name => document.querySelector(`[aria-label="Install ${name} workflow"]`);
 const submit = async button => app.env.act(async () => {button.focus();button.click();await tick();});
 const settle = async success => app.env.act(async () => {finish(success);await tick();});
 const firstButton = findInstall('First');
 await submit(firstButton);
 assert.equal(document.activeElement, firstButton);
 assert.equal(firstButton.getAttribute('aria-disabled'), 'true');
 assert.equal(firstButton.getAttribute('aria-busy'), 'true');
 await app.env.act(async () => {firstButton.click();await tick();});
 assert.equal(writes, 1);
 await settle(false);
 assert.equal(document.activeElement, firstButton);
 assert.equal(firstButton.hasAttribute('aria-disabled'), false);
 assert.match(document.querySelector('[role="alert"]').textContent, /Installation was rejected/);
 await submit(firstButton);
 await settle(true);
 assert.equal(document.activeElement.dataset.extensionOpen, first.id);
 assert.match(document.querySelector('[role="status"].za-extension-saved').textContent, /First workflow installed/);
 await app.click('Installation status');
 await app.click('Not installed');
 await submit(findInstall('Second'));
 await settle(true);
 assert.equal(document.activeElement.getAttribute('aria-label'), 'Installation status');
 assert.equal(document.activeElement.textContent.trim(), 'Not installed');
 assert.equal(document.querySelector('[aria-label="Search plugins"]').value, 'workflow');
 assert.equal(writes, 3);
});

test('returning from extension details restores directory search, scroll, and keyboard focus', async t => {
 const app = await mount(t, {
  locale: 'en-US',
  location: {route: {page: 'plugins'}},
  catalog: {version: 4, packages: [publicPlugin, publicSkill]},
 });
 const viewport = () => document.querySelector('.za-extensions-main [data-scroll-viewport]');
 const heading = () => document.querySelector('.za-extensions-main h1');
 const openRow = () => document.querySelector('[data-extension-open="product-design"]');
 const search = kind => document.querySelector(`[aria-label="Search ${kind}"]`);
 const scrollTo = async value => app.env.act(async () => {
  viewport().scrollTop = value;
  viewport().dispatchEvent(new Event('scroll', {bubbles: true}));
  await tick();
 });
 await app.fill('Search plugins', 'Design');
 await scrollTo(180);
 await app.env.act(async () => {
  openRow().focus();
  openRow().click();
  await tick();
 });
 assert.equal(document.activeElement, heading());
 assert.equal(viewport().scrollTop, 0, 'details start at the top');
 await app.click('Manage');
 const breadcrumb = document.querySelector('.za-extension-breadcrumb');
 assert.equal(breadcrumb.querySelector('[aria-current="page"]').textContent,'Manage');
 await app.click('View details for Product Design');
 assert.equal(document.activeElement,heading());
 assert.equal(breadcrumb.querySelector('[aria-current="page"]').textContent,'Product Design');
 await app.env.act(async () => {
  document.querySelector('.za-extension-breadcrumb button').click();
  await tick();
 });
 assert.equal(search('plugins').value, 'Design');
 assert.equal(viewport().scrollTop, 180);
 assert.equal(document.activeElement, openRow());
 await app.click('Skills');
 assert.equal(search('skills').value, '');
 assert.equal(viewport().scrollTop, 0);
 await app.fill('Search skills', 'Creator');
 await scrollTo(62);
 await app.click('Plugins');
 assert.equal(search('plugins').value, 'Design');
 assert.equal(viewport().scrollTop, 180);
 await app.click('Skills');
 assert.equal(search('skills').value, 'Creator');
 assert.equal(viewport().scrollTop, 62);
 await app.env.act(async () => {
  const installedPlugin = [...document.querySelectorAll('.za-extension-nav')]
   .find(element => element.textContent.trim() === 'Product Design');
  assert.ok(installedPlugin);
  installedPlugin.focus();
  installedPlugin.click();
  await tick();
 });
 assert.equal(document.activeElement, heading());
 await app.env.act(async () => {
  document.querySelector('.za-extension-breadcrumb button').click();
  await tick();
 });
 assert.equal(document.activeElement, heading(), 'an external entry falls back to the directory heading');
});

test('extension directories restore tab-local filters and scroll for the same account only', async t => {
 const owner='cloud:owner-a', other='cloud:owner-b';
 const key=scope=>`zeroagent:extensions-browse:${encodeURIComponent(scope)}`;
 const app=await mount(t,{scope:owner,location:{route:{page:'plugins'}},catalog:{version:4,packages:[publicPlugin,publicSkill]}});
 const viewport=()=>document.querySelector('.za-extensions-main [data-scroll-viewport]');
 const source=()=>document.querySelector('.za-extension-source-tabs [aria-selected="true"]').textContent;
 const installation=()=>document.querySelector('button[aria-label="安装状态"]').textContent.trim();
 const writes=[];
 const storage=window.sessionStorage, storagePrototype=Object.getPrototypeOf(storage), setItem=storagePrototype.setItem;
 storagePrototype.setItem=function(name,value){if(name.startsWith('zeroagent:extensions-browse:'))writes.push(name);return setItem.call(this,name,value);};
 t.after(()=>{storagePrototype.setItem=setItem;});

 await app.click('个人');await app.click('安装状态');await app.click('未安装');
 await app.fill('搜索插件','待查看');
 await app.env.act(async()=>{
  for(const offset of [72,144]){viewport().scrollTop=offset;viewport().dispatchEvent(new Event('scroll',{bubbles:true}));}
 });
 await app.click('技能');await app.click('安装状态');await app.click('已安装');
 await app.fill('搜索技能','创建');viewport().scrollTop=61;
 assert.deepEqual(writes,[],'scroll and filter changes stay in memory while browsing');
 await app.env.act(async()=>{window.dispatchEvent(new Event('pagehide'));window.dispatchEvent(new Event('pagehide'));});
 assert.deepEqual(writes,[key(owner)]);
 assert.deepEqual(JSON.parse(storage.getItem(key(owner))),{
  plugin:{query:'待查看',source:'personal',installation:'uninstalled',scrollTop:144},
  skill:{query:'创建',source:'public',installation:'installed',scrollTop:61},
 });

 storage.setItem(key(other),JSON.stringify({skill:{source:'invalid',installation:'invalid',query:42,scrollTop:-80}}));
 await app.setContext(other,{route:{page:'skills'}});
 assert.equal(source(),'公开');assert.equal(installation(),'全部');
 assert.equal(document.querySelector('[aria-label="搜索技能"]').value,'');assert.equal(viewport().scrollTop,0);
 await app.setContext(owner,{route:{page:'plugin',id:'product-design'}});
 assert.equal(document.querySelector('.za-extension-detail-header h1').textContent,'产品设计');
 assert.equal(viewport().scrollTop,0);
 await app.env.act(async()=>{document.querySelector('.za-extension-breadcrumb button').click();await tick();});
 assert.equal(source(),'个人');assert.equal(installation(),'未安装');
 assert.equal(document.querySelector('[aria-label="搜索插件"]').value,'待查看');assert.equal(viewport().scrollTop,144);
 await app.click('技能');
 assert.equal(source(),'公开');assert.equal(installation(),'已安装');
 assert.equal(document.querySelector('[aria-label="搜索技能"]').value,'创建');assert.equal(viewport().scrollTop,61);
});

test('English names and descriptions cover current and archived built-in skills while personal metadata stays authored',()=>{
 const display=loader.loadModule('@liveagent/ui/lib/extensions/presentation.ts');
 const native={...publicPlugin,native:true};
 const current={name:'audit',description:'Audit a real product flow.',entry:'skills/audit/SKILL.md'};
 const archived={name:'design-verify',display_name:'旧版核验',description:'核对视觉和交互。'};
 assert.equal(display.extensionSkillDisplayName(native,current,'en-US'),'Experience audit');
 assert.equal(display.extensionSkillDescription(native,current,'en-US'),current.description);
 assert.equal(display.extensionSkillDisplayName(native,archived,'en-US'),'Design QA');
 assert.equal(display.extensionSkillDescription(native,archived,'en-US'),'Verify visuals, interaction, accessibility, and viewport states.');
 assert.match(display.extensionSearchText(native,current),/审查体验.*experience audit/);
 const personal={...pkg,description:'我的说明'};
 assert.equal(display.extensionDescription(personal,'en-US'),personal.description);
 assert.equal(display.extensionSkillDisplayName(personal,archived,'en-US'),archived.display_name);
 assert.equal(display.extensionSkillDescription(personal,archived,'en-US'),archived.description);
});

test('rendering a saved reference preserves its label, target and surrounding text until the host supplies a locale',async t=>{
 const env=await createWebDomTestEnv();t.after(()=>env.cleanup());
 const {createSkillMentionChip,collectDraftSegments}=env.loadModule('@liveagent/ui/components/chat/MentionComposerInternals.tsx');
 const mention={name:'product-design',displayName:'Product Design',description:'Design',baseDir:'cloud',skillFile:'zeroagent-skill:product-design/2/product-design'};
 const editor=document.createElement('div');editor.append('Existing draft ',createSkillMentionChip(mention),' remains');
 const segments=collectDraftSegments(editor,new Map());assert.equal(editor.textContent,'Existing draft Product Design remains');
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

test('plugin details explain which disabled control prevents trial and recover after enabling it', async t => {
 const primary={name:'workflow-audit',display_name:'Audit workflow',description:'Review a project',entry:'SKILL.md'};
 const item={...publicPlugin,id:'trial-fixture',name:'Project tools',builtin:false,visibility:'personal',owned:true,
  skills:[primary],examples:['Review this project'],disabled_skills:[primary.name]};
 const writes=[];
 const app=await mount(t,{locale:'en-US',location:{route:{page:'plugin',id:item.id}},catalog:{version:4,packages:[item]},
  mutate:async(version,input)=>{writes.push({version,input});return {version:5,packages:[{...item,disabled_skills:[]}]};}});
 const status=()=>document.querySelector('[data-extension-trial-status]');
 const action=name=>[...document.querySelectorAll('.za-extension-detail-header button')].find(button=>button.textContent===name);
 const example=()=>document.querySelector('.za-extension-starters button');
 assert.match(status()?.textContent??'',/primary skill “Audit workflow” is disabled/);
 assert.equal(action('Manage').getAttribute('aria-describedby'),status().id);
 assert.equal(action('Try in chat').disabled,true);
 assert.equal(example().disabled,true);
 assert.match(example().textContent,/Review this project/);
 await app.click('Manage');
 assert.equal(document.querySelector('[role="switch"][aria-label="Enable plugin Project tools"]').getAttribute('aria-checked'),'true');
 const toggle=document.querySelector('[role="switch"][aria-label="Enable skill Audit workflow"]');
 assert.equal(toggle.getAttribute('aria-checked'),'false');
 await app.env.act(async()=>{toggle.click();await tick();});
 assert.deepEqual(writes,[{version:4,input:{action:'skill',id:item.id,skill:primary.name,enabled:true}}]);
 await app.click('Details');
 assert.equal(status(),null);
 assert.equal(action('Try in chat').disabled,false);
 assert.equal(example().disabled,false);
 await app.setDirectory({version:6,packages:[{...item,enabled:false,disabled_skills:[]}]});
 assert.match(status().textContent,/This plugin is disabled/);
 assert.doesNotMatch(status().textContent,/Audit workflow/);
 assert.equal(action('Manage').disabled,false);
 assert.equal(example().disabled,true);
 assert.deepEqual(app.calls,[]);
});

test('long plugin details progressively disclose skills without losing the rest of the list',async t=>{
 const many={...publicPlugin,skills:Array.from({length:8},(_,i)=>({name:`workflow-${i}`,description:`Workflow ${i}`,entry:'SKILL.md'}))};
 const app=await mount(t,{catalog:{version:4,packages:[many]}});await app.click('产品设计');
 assert.equal(document.querySelectorAll('.za-extension-skill-link').length,5);
 await app.click('查看其余 3 项技能');assert.equal(document.querySelectorAll('.za-extension-skill-link').length,8);
 await app.click('收起技能');assert.equal(document.querySelectorAll('.za-extension-skill-link').length,5);
});


test('configuring images keeps the selected skill reader mounted behind the settings modal',async t=>{
 let opened=0;
 const image={...publicSkill,id:'imagegen',name:'imagegen',skills:[{name:'imagegen',description:'Generate images',entry:'SKILL.md'}]};
 const app=await mount(t,{catalog:{version:4,packages:[image]},onConfigureImages:()=>opened++});
 await app.click('技能');
 await app.env.act(async()=>{document.querySelector('[data-extension-open="imagegen"]').click();await tick();});
 const reader=document.querySelector('[role="dialog"]');assert.ok(reader);
 await app.click('配置生图模型');
 assert.equal(opened,1);
 assert.equal(document.querySelector('[role="dialog"]'),reader,'the reader and its current file must survive advanced settings');
 assert.ok(reader.querySelector('[data-extension-configure-images]'));
});


test('the installed sidebar search is independent of discovery and opens the shared management menu',async t=>{
 const creator={...publicPlugin,id:'plugin-creator',name:'Plugin Creator'};
 const available={...publicPlugin,id:'available',name:'Available design',installed:false};
 const app=await mount(t,{catalog:{version:4,packages:[publicPlugin,creator,available]}});
 await app.click('搜索已安装的插件');await app.fill('筛选已安装的插件','Plugin Creator');
 const rail=document.querySelector('.za-extensions-sidebar-container');
 assert.match(rail.textContent,/创建插件/);assert.doesNotMatch(rail.textContent,/产品设计|Available design/);
 assert.match(document.querySelector('.za-extension-directory').textContent,/Available design/);
 await app.click('已安装插件 创建插件的操作');
 assert.match(document.querySelector('[role="menu"]').textContent,/管理.*停用.*卸载/);
 assert.doesNotMatch(document.querySelector('[role="menu"]').textContent,/编辑插件|下载插件包/);
 await app.click('管理');assert.match(document.querySelector('nav[aria-label="当前位置"]').textContent,/创建插件.*管理/);
});

test('a plugin app opens the real editor without executing the plugin or making a write',async t=>{
 const creator={...publicPlugin,id:'plugin-creator',name:'Plugin Creator'};
 const app=await mount(t,{catalog:{version:4,packages:[creator,publicPlugin]}});
 const openPackage=async id=>app.env.act(async()=>{document.querySelector(`[data-extension-open="${id}"]`).click();await tick();});
 await openPackage('product-design');assert.equal(document.querySelector('.za-extension-apps'),null);
 await app.click('插件');await openPackage('plugin-creator');
 const appSection=document.querySelector('.za-extension-apps');
 assert.equal(appSection.querySelector('h2').textContent,'应用 1');
 assert.ok(appSection.compareDocumentPosition(document.querySelector('.za-extension-skills')) & 4);
 await app.click('打开');assert.ok(document.querySelector('[aria-label="编辑插件文件"]'));
 await app.click('返回插件');assert.match(document.querySelector('nav[aria-label="当前位置"]').textContent,/创建插件/);
 assert.deepEqual(app.calls,[]);
});

test('original Codex metadata survives the catalog, plugin detail, and composer',async t=>{
 const original={...publicPlugin,id:'plugin-creator',version:4,publisher:'OpenAI',
  name:'Plugin Creator',description:'Create and edit plugins',overview:'Create a reusable workflow.',
  examples:['Create a plugin for a task I do often'],
  skills:[{name:'create-plugin',display_name:'Create Plugin',description:'Create local or cloud plugins.',entry:'skills/create-plugin/SKILL.md'}],
  unavailable_apps:[{name:'Plugin Creator',description:'Create and improve plugins.'}]};
 const payload=parseExtensionCatalog({version:4,packages:[original]});
 const [mention]=cloudComposerSkills(payload);
 assert.equal(mention.displayName,'创建插件');
 assert.match(mention.description,/工作流程整理成个人插件/);
 assert.equal(cloudComposerSkills(payload,'en-US')[0].displayName,'Plugin Creator');
 assert.equal(cloudComposerSkills(payload,'en-US')[0].description,'Create local or cloud plugins.');
 const {extensionOverview}=loader.loadModule('@liveagent/ui/lib/extensions/presentation.ts');
 assert.equal(extensionOverview(payload.packages[0],'en-US'),original.overview);
 assert.equal(mention.skillFile,'zeroagent-skill:plugin-creator/4/create-plugin');
 const app=await mount(t,{catalog:payload});
 await app.env.act(async()=>{document.querySelector('[data-extension-open="plugin-creator"]').click();await tick();});
 assert.match(document.querySelector('.za-extension-intro').textContent,/把经常重复的一组工作整理成个人插件/);
 assert.match(document.querySelector('.za-extension-skills .za-extension-skill-link').textContent,/工作流程整理成个人插件/);
 assert.match(document.querySelector('.za-extension-starters').textContent,/Create a plugin for a task I do often/);
 const apps=document.querySelector('.za-extension-apps');
 assert.match(apps.textContent,/Plugin Creator.*托管应用未连接/);
 await app.env.act(async()=>{apps.querySelector('button').click();await tick();});
 assert.match(document.querySelector('[role="dialog"]').textContent,/Create and improve plugins.*托管应用未连接/);
 assert.deepEqual(app.calls,[]);
 assert.equal(document.querySelector('[role="dialog"]').querySelector('button:not([aria-label])')?.textContent,'关闭');
 const {createSkillMentionChip}=app.env.loadModule('@liveagent/ui/components/chat/MentionComposerInternals.tsx');
 assert.equal(createSkillMentionChip(mention).textContent,'创建插件');
});

test('prepared plugin opens for review and saves only on an explicit action',async t=>{
 const id='36e2b5c0-8c13-4f81-825c-f5d8a9a1d021';
 const child={name:'check-output',description:'Check output',entry:'skills/check-output/SKILL.md'};
 const app=await mount(t,{
  openPackage:{id,key:1,draft:true},
  readDraft:async observed=>{
   assert.equal(observed,id);
   return {kind:'plugin',revision:{...revision,files:{...revision.files,[child.entry]:'---\nname: check-output\ndescription: Check output\n---\nReview the result.'},skills:[skill,child]}};
  },
 });
 assert.match(document.querySelector('.za-skill-editor h1').textContent,/审阅草稿/);
 assert.equal(app.calls.length,0);
 await app.click(child.entry);
 assert.match(document.querySelector('textarea').value,/Review the result/);
 await app.click('保存');
 assert.equal(app.calls.length,1);
 assert.equal(app.calls[0].input.draft_id,id);
 assert.equal(app.calls[0].input.kind,'plugin');
 assert.equal(app.calls[0].input.revision.skills.length,2);
});
