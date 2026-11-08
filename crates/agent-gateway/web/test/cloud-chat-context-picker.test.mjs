import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settleFocus(env) { await env.act(async()=>{ await new Promise(resolve=>setTimeout(resolve,250)); }); }
const file=(id,name,state='ready')=>({id,name,state,mime:'text/markdown',size:10,text_bytes:10,workspace_loadable:true});
const resource=(id,name,kind='file',target_id=id)=>({id,kind,target_id,name,state:'ready',mime:'text/markdown'});
const library=(items=[],next_cursor='')=>({items,next_cursor});
async function mount(t,overrides={}){
  const env=await createWebDomTestEnv({mocks:{'@liveagent/ui/components/IconSet':new Proxy({},{get:()=>()=>null})}});
  window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host);
  const anchor=document.body.appendChild(document.createElement('button'));anchor.textContent='文件';anchor.focus();
  const events={attached:[],projects:[],closed:0,focused:0,uploads:0,browsed:[]};
  let revision=0;
  const captureGuard=()=>{const at=revision;return()=>{if(at!==revision)throw new Error('retired account');};};
  let props={extensions:[],onTryExtension(){},onCustomize(){},kind:'files',anchor,mobile:false,scope:'one',revision:0,projectsClient:{listProjects:async()=>({items:[],next_before_id:''})},filesClient:{list:async()=>({files:[],nextCursor:''})},spaceClient:{list:async()=>library()},captureGuard,attachedIds:[],disabled:false,onSelectProject:async project=>events.projects.push(project),onAttach:item=>events.attached.push(item.id),onAttachResource:async item=>events.attached.push(item.site_version_id ?? item.target_id),onUpload:()=>events.uploads++,onBrowse:kind=>events.browsed.push(kind),onCreateProject(){},onFocusComposer:()=>events.focused++,...overrides};
  const {CloudChatContextPicker}=env.loadModule('src/components/cloudchat/CloudChatContextPicker.tsx');
  const render=async()=>env.act(async()=>{root.render(env.React.createElement(CloudChatContextPicker,{...props,onClose:()=>{events.closed++;props={...props,kind:null};root.render(env.React.createElement(CloudChatContextPicker,{...props,onClose(){}}));}}));await tick();});
  t.after(async()=>{await env.act(async()=>root.unmount());host.remove();anchor.remove();env.cleanup();});
  await render();
  return {env,events,anchor,async update(next){props={...props,...next};await render();},retire(){revision++;},async flush(){await env.act(async()=>{await tick();});},async click(text){const el=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text);assert.ok(el,text);await env.act(async()=>{el.click();await tick();});}};
}

test('file picker distinguishes ready, processing and already attached files and returns focus after selection',async t=>{
  const app=await mount(t,{fileReview:{name:'',files:[file('one','notes.md'),file('two','report.pdf','processing'),file('three','attached.md')],nextCursor:''},attachedIds:['three']});
  const rows=[...document.querySelectorAll('[data-picker-entry]')];
  assert.equal(rows[0].disabled,false);assert.equal(rows[1].disabled,true);assert.equal(rows[2].disabled,true);
  await app.env.act(async()=>{rows[0].click();await tick();});assert.deepEqual(app.events.attached,['one']);assert.equal(app.events.closed,1);await settleFocus(app.env);assert.equal(app.events.focused,1);
});

test('an empty file picker can upload directly or browse the library when uploads are blocked',async t=>{
  const app=await mount(t);
  await app.click('上传文件');
  await settleFocus(app.env);
  assert.equal(app.events.uploads,1);
  assert.equal(app.events.closed,1);
  assert.equal(app.events.focused,1);
  assert.deepEqual(app.events.attached,[]);

  await app.update({kind:'files',uploadDisabledReason:'请先移除附件'});
  assert.ok([...document.querySelectorAll('[role="status"]')].some(status=>status.textContent.includes('请先移除附件')));
  await app.click('上传文件');
  assert.equal(app.events.uploads,1);
  assert.equal(app.events.closed,1);
  await app.click('浏览资料空间');
  assert.deepEqual(app.events.browsed,['files']);
});

test('loaded-page filtering and pagination do not duplicate resources or parse file names as markup',async t=>{
  const original=file('one','<img onerror=attack>.md');
  const app=await mount(t,{fileReview:{name:'',files:[original],nextCursor:'next'},filesClient:{list:async()=>({files:[original,file('two','other.md')],nextCursor:''})}});
  assert.equal(document.querySelector('img'),null);
  assert.equal(document.querySelector('input').getAttribute('aria-label'),'筛选文件');
  await app.click('加载更多');assert.equal(document.querySelectorAll('[data-picker-entry]').length,2);
  const input=document.querySelector('input');
  await app.env.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'other');input.dispatchEvent(new window.Event('input',{bubbles:true}));await tick();});
  assert.equal(document.querySelectorAll('[data-picker-entry]').length,1);assert.match(document.querySelector('[data-picker-entry]').textContent,/other/);
});

test('late list results cannot populate a different view or account',async t=>{
  let release,calls=0;
  const app=await mount(t,{spaceClient:{list:()=>++calls===1?new Promise(resolve=>{release=resolve;}):Promise.resolve(library([resource('new','current.md')]))}});
  app.retire();await app.update({scope:'two'});
  await app.env.act(async()=>{release({files:[file('old','retired-private.md')],nextCursor:''});await tick();});
  assert.match(document.body.textContent,/current.md/);assert.doesNotMatch(document.body.textContent,/retired-private/);
});

test('failed listing retries explicitly without leaking internal errors or selecting a resource',async t=>{
  let calls=0;
  const app=await mount(t,{spaceClient:{list:async()=>{if(++calls===1)throw new Error('private backend diagnostic');return library([resource('one','recovered.md')]);}}});
  assert.match(document.body.textContent,/加载失败/);assert.doesNotMatch(document.body.textContent,/private backend/);
  await app.click('重试');assert.match(document.body.textContent,/recovered.md/);assert.deepEqual(app.events.attached,[]);assert.equal(calls,2);
});

test("account library search loads older files and artifacts and retries only the failed page", async (t) => {
  const pages = [];
  const app = await mount(t, { mobile: true, spaceClient: { async list(location, query, _sort, cursor) {
    assert.deepEqual(location, { category: 'recent', scope: 'all', folder: '' });
    pages.push([query, cursor]);
    if (!query) return library([resource('unrelated', 'Notes.md')]);
    if (!cursor) return library([resource('first', 'Brief draft.md')], 'older');
    if (pages.length === 3) throw new Error('private transport diagnostic');
    return library([resource('family', 'Brief final.md', 'artifact', 'version-7')]);
  } } });
  const input = document.querySelector('input');
  assert.equal(input.getAttribute('aria-label'), '搜索资料');
  await app.env.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'brief');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settleFocus(app.env);
  const rows = () => [...document.querySelectorAll('[data-picker-entry]')].map(row => row.textContent);
  await app.click('加载更多');
  assert.match(document.querySelector('[role="alert"]').textContent, /已加载的条目仍可使用/);
  assert.deepEqual(rows(), ['Brief draft.md']);
  assert.equal(input.value, 'brief');
  assert.doesNotMatch(document.body.textContent, /private transport diagnostic/);
  [...document.querySelectorAll('button')].find(button => button.textContent === '重试加载更多').focus();
  await app.click('重试加载更多');
  assert.deepEqual(pages, [['', ''], ['brief', ''], ['brief', 'older'], ['brief', 'older']]);
  assert.deepEqual(rows(), ['Brief draft.md', 'Brief final.md成果']);
  assert.equal(input.value, 'brief');
  assert.equal(document.activeElement?.dataset.pickerEntry, 'version-7');
  await app.click('Brief final.md成果');
  assert.deepEqual(app.events.attached, ['version-7']);
});

test('expired library paging keeps previous rows and explicitly reloads the current search', async (t) => {
  let CloudSpaceError;
  const reads = [];
  const app = await mount(t, { spaceClient: { async list(_location, query, _sort, cursor) {
    reads.push([query, cursor]);
    if (cursor) throw new CloudSpaceError('private cursor diagnostic', 409);
    return reads.length === 1
      ? library([resource('old', 'Earlier result.md')], 'old-page')
      : library([resource('current', 'Current result.md')]);
  } } });
  ({ CloudSpaceError } = app.env.loadModule('src/lib/cloudSpace.ts'));
  await app.click('加载更多');
  assert.match(document.body.textContent, /Earlier result\.md/);
  assert.doesNotMatch(document.body.textContent, /private cursor diagnostic/);
  [...document.querySelectorAll('button')].find(button => button.textContent === '重新读取').focus();
  await app.click('重新读取');
  assert.deepEqual(reads, [['', ''], ['', 'old-page'], ['', '']]);
  assert.equal(document.activeElement?.dataset.pickerEntry, 'current');
  assert.doesNotMatch(document.body.textContent, /Earlier result\.md/);
});

test('project paging leaves focus on the search when the user moves there during the request', async (t) => {
  let finish;
  const app = await mount(t, { kind: 'projects', projectsClient: { listProjects(before) {
    if (!before) return Promise.resolve({items: [{id:'existing', name:'Existing project'}], next_before_id:'last'});
    return new Promise(resolve => { finish = resolve; });
  } } });
  const search = document.querySelector('input');
  [...document.querySelectorAll('button')].find(button => button.textContent === '加载更多').focus();
  await app.click('加载更多');
  search.focus();
  await app.env.act(async () => {
    finish({items: [{id:'new', name:'New project'}], next_before_id:''});
    await tick();
  });
  assert.ok(document.querySelector('[data-picker-entry="new"]'));
  assert.equal(document.activeElement, search);
});

test("a stale search and a dismissed attachment check cannot change the active picker", async (t) => {
  let oldSearch, releaseAttachment, attachmentSignal;
  const app = await mount(t, { mobile: true, spaceClient: { list(_location, query) {
    if (query === 'old') return new Promise(resolve => { oldSearch = resolve; });
    return Promise.resolve(library(query ? [resource('current', 'Current.docx')] : []));
  } }, onAttachResource: (_item, signal) => {
    attachmentSignal = signal;
    return new Promise(resolve => { releaseAttachment = resolve; });
  } });
  const input = document.querySelector('input');
  const search = query => app.env.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, query);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await search('old');
  await settleFocus(app.env);
  await search('current');
  assert.doesNotMatch(document.body.textContent, /Old\.docx/);
  await settleFocus(app.env);
  await app.env.act(async () => { oldSearch(library([resource('old', 'Old.docx')])); await tick(); });
  assert.match(document.body.textContent, /Current\.docx/);
  assert.doesNotMatch(document.body.textContent, /Old\.docx/);
  await app.click('Current.docx');
  assert.match(document.querySelector('[data-picker-entry]').textContent, /正在添加/);
  assert.equal(input.readOnly, true);
  await app.env.act(async () => document.querySelector('button[aria-label="关闭添加文件"]').click());
  assert.ok(attachmentSignal.aborted);
  await app.env.act(async () => { releaseAttachment(); await tick(); });
  assert.equal(app.events.closed, 1);
});

test('mobile picker uses the shared modal sheet and does not summon the keyboard on open',async t=>{
  const app=await mount(t,{mobile:true});
  await settleFocus(app.env);
  assert.ok(document.querySelector('[data-slot="sheet-backdrop"]'));
  assert.ok(document.activeElement===document.querySelector('[data-slot="sheet-popup"]'));
  assert.ok(document.activeElement!==document.querySelector('input'));
  const close=document.querySelector('button[aria-label="关闭添加文件"]');assert.ok(close);
  await app.env.act(async()=>{close.click();await tick();});await settleFocus(app.env);assert.equal(app.events.closed,1);assert.ok(document.activeElement===app.anchor);
});

test('an extension catalog error is local and retry keeps the chooser open without loading files or projects',async t=>{
  let requests=0,retries=0;
  const app=await mount(t,{kind:'tools',extensionsLoading:true,onRetryExtensions:()=>retries++,filesClient:{list(){requests++;}},projectsClient:{listProjects(){requests++;}}});
  assert.match(document.querySelector('[role=status]').textContent,/正在加载插件与技能/);
  await app.update({extensionsLoading:false,extensionsFailed:true});
  assert.match(document.querySelector('[role=alert]').textContent,/暂时无法加载插件与技能/);
  assert.doesNotMatch(document.body.textContent,/还没有启用/);
  await app.click('重试');
  assert.equal(retries,1);assert.equal(requests,0);assert.equal(app.events.closed,0);
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

test('a project beyond the loaded page stays identified while filtering or loading alternatives', async (t) => {
  const current = { id: 'current', name: '我的项目', icon: 'folder', color: 'blue' };
  const other = { id: 'other', name: '另一项目', icon: 'folder', color: 'gray' };
  const app = await mount(t, {
    kind: 'projects', mobile: true, selectedProject: current,
    projectsClient: { async listProjects(before) {
      return before ? { items: [current], next_before_id: '' } : { items: [other], next_before_id: 'older' };
    } },
  });
  const summary = () => document.querySelector('section[aria-label="当前项目"]');
  assert.match(summary()?.textContent ?? '', /我的项目/);
  assert.ok(summary().querySelector('[aria-label="从我的项目移出"]'));
  const input = document.querySelector('input[aria-label="筛选项目"]');
  const filter = (query) => app.env.act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, query);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
  });
  await filter('不匹配');
  assert.match(summary().textContent, /我的项目/);
  await app.click('加载更多');
  await filter('');
  assert.doesNotMatch(document.querySelector('.cloud-context-picker-results').textContent, /我的项目/);
  assert.match(summary().textContent, /我的项目/);
  assert.deepEqual(app.events.projects, []);
  await app.click('管理项目');
  assert.deepEqual(app.events.browsed, ['projects']);
  assert.equal(app.events.closed, 1);
  assert.deepEqual(app.events.projects, []);
  await app.update({ kind: 'projects' });
  await app.env.act(async () => summary().querySelector('[aria-label="从我的项目移出"]').click());
  assert.deepEqual(app.events.projects, [null]);
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

test('the add menu groups the catalog behind one chooser and keeps available image generation and research shortcuts',async t=>{
 const env=await createWebDomTestEnv();t.after(()=>env.cleanup());
 const {CloudChatComposerMenu}=env.loadModule('src/components/cloudchat/CloudChatComposerMenu.tsx');
 const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host),chosen=[];
 const image={id:'imagegen',kind:'skill',builtin:true,visibility:'public',name:'Image Gen',installed:true,enabled:true,disabled_skills:[],skills:[{name:'imagegen',description:'生成',entry:'SKILL.md'}]};
 const plugin={...image,id:'plugin-creator',kind:'plugin',name:'Plugin Creator'};
 let anchor,research=0;
 const props={open:true,disabled:false,researchEnabled:false,onUpload(){},onOpenFiles(){},onOpenProjects(){},onOpenExtensions:value=>{anchor=value;},onToggleResearch:()=>research++,onTryExtension:(pkg,skill)=>chosen.push([pkg.id,skill.name]),extensions:[image,plugin]};
 const render=()=>env.act(async()=>{root.render(env.React.createElement(CloudChatComposerMenu,props));await tick();});
 const option=label=>[...document.querySelectorAll('[role^="menuitem"]')].find(el=>el.textContent.includes(label));
 try{await render();
 assert.equal(option('创建插件'),undefined);
 await env.act(async()=>option('插件与技能').click());
 assert.equal(anchor,host.querySelector('.cloud-composer-add'));
 assert.deepEqual(chosen,[]);
 await env.act(async()=>option('生成图像').click());assert.deepEqual(chosen,[['imagegen','imagegen']]);
 assert.equal(option('公开联网研究').getAttribute('aria-checked'),'false');
 await env.act(async()=>option('公开联网研究').click());assert.equal(research,1);
 props.extensions=[{...image,enabled:false},plugin];await render();assert.equal(option('生成图像'),undefined);
 }finally{await env.act(async()=>root.unmount());host.remove();}
});

test('creating a project from the composer closes the picker and opens creation without page navigation',async t=>{
 let created=0,browsed=0;
 const app=await mount(t,{kind:'projects',onCreateProject:()=>created++,onBrowse:()=>browsed++});
 await app.click('新建项目');assert.equal(created,1);assert.equal(browsed,0);assert.equal(app.events.closed,1);
});
