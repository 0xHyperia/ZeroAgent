import assert from 'node:assert/strict';
import test from 'node:test';
import {createWebDomTestEnv} from '../../test/helpers/dom-test-env.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const pkg=(id,skills,extra={})=>({id,kind:'plugin',visibility:'public',owned:false,name:id,description:`Use ${id}`,publisher:'ZeroAgent',version:2,installed:true,enabled:true,builtin:true,disabled_skills:[],examples:[],updated_at:'',skills:skills.map(name=>({name,description:`Workflow ${name}`,entry:name==='product-design'?'SKILL.md':`${name}.md`})),...extra});
const catalog={version:3,packages:[pkg('product-design',['product-design','design-audit','skill-creator']),pkg('plugin-creator',['plugin-creator','update-plugin']),pkg('skill-creator',['skill-creator'],{kind:'skill'}),pkg('private-package',['my-main','my-child'],{visibility:'personal',owned:true,builtin:false,name:'我的方法'})]};

async function mount(t,overrides={}){
 const env=await createWebDomTestEnv();
 window.HTMLElement.prototype.scrollIntoView=()=>{};
 window.Range.prototype.getClientRects=()=>[];
 window.Range.prototype.getBoundingClientRect=()=>({left:0,top:0,right:0,bottom:0,width:0,height:0});
 const {MentionComposer}=env.loadModule('@liveagent/ui/components/chat/MentionComposer.tsx');
 const {cloudComposerSkills,cloudComposerExtensions}=env.loadModule('src/lib/cloudExtensions.ts');
 const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host),ref=env.React.createRef();
 let sent=0,actions=0,anchor;
 let props={workdir:'',enabledSkills:cloudComposerSkills(catalog),mentionExtensions:cloudComposerExtensions(catalog),mentionActions:[{id:'library',name:'从资料库添加',description:'引用已保存文件',icon:'library',onSelect(value){actions++;anchor=value;}}],onSend(){sent++;},...overrides};
 const flush=()=>env.act(async()=>{await tick();});
 const render=()=>env.act(async()=>{root.render(env.React.createElement(MentionComposer,{...props,ref}));await tick();});
 await render();
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 const editor=host.querySelector('[contenteditable="true"]');
 async function input(text,{append=false}={}){
  await env.act(async()=>{
   editor.focus();if(!append)editor.replaceChildren();const node=document.createTextNode(text);editor.append(node);
   const range=document.createRange();range.setStart(node,text.length);range.collapse(true);window.getSelection().removeAllRanges();window.getSelection().addRange(range);
   editor.dispatchEvent(new Event('input',{bubbles:true}));await tick();
  });await flush();
 }
 async function key(key){await env.act(async()=>{editor.dispatchEvent(new KeyboardEvent('keydown',{key,code:key,bubbles:true,cancelable:true}));await tick();});}
 return {env,editor,ref,input,key,flush,cloudComposerExtensions,get sent(){return sent;},get actions(){return actions;},get anchor(){return anchor;},async update(next){props={...props,...next};await render();},async choose(name){const item=[...document.querySelectorAll('[role="option"]')].find(el=>el.textContent.includes(name));assert.ok(item,name);await env.act(async()=>{item.click();await tick();});}};
}

test('@ lists one primary per package, including personal and independent content, without bundled child skills',async t=>{
 const app=await mount(t);await app.input('@');
 const text=document.querySelector('[role="listbox"]').textContent;
 assert.match(text,/产品设计/);assert.match(text,/创建插件/);assert.match(text,/创建技能/);assert.match(text,/我的方法/);
 assert.doesNotMatch(text,/审查体验|完善插件|my-child|文件和文件夹/);
 assert.equal(document.querySelectorAll('[role="option"]').length,5);assert.equal(app.sent,0);
});
test('@ searches original aliases and selecting with Enter inserts only a fixed plugin reference',async t=>{
 const app=await mount(t);await app.input('先保留这些文字 @Plugin');
 assert.equal(document.querySelectorAll('[role="option"]').length,1);await app.key('Enter');
 assert.equal(app.ref.current.getDraft().skillMentions[0].skillFile,'zeroagent-skill:plugin-creator/2/plugin-creator');
 assert.match(app.editor.textContent,/创建插件 $/);
 assert.equal(app.ref.current.getDraft().skillMentions.length,1);assert.match(app.editor.textContent,/先保留这些文字/);assert.equal(app.sent,0);
});
test('@ action removes only its query, preserves surrounding draft and invokes its host instead of sending',async t=>{
 const app=await mount(t);await app.input('保留原需求 @资料');await app.choose('从资料库添加');
 assert.equal(app.actions,1);assert.ok(app.anchor instanceof HTMLElement);assert.equal(app.editor.textContent,'保留原需求 ');assert.equal(app.sent,0);
});
test('@ does not replace or duplicate an existing reference pinned to an older package release',async t=>{
 const app=await mount(t);await app.env.act(async()=>app.ref.current.insertSkillMention({name:'plugin-creator',displayName:'创建插件',description:'old',skillFile:'zeroagent-skill:plugin-creator/1/plugin-creator',baseDir:'cloud'}));
 await app.input(' @创建插件',{append:true});await app.key('Enter');
 const selected=app.ref.current.getDraft().skillMentions;assert.equal(selected.length,1);assert.equal(selected[0].skillFile,'zeroagent-skill:plugin-creator/1/plugin-creator');assert.equal(app.sent,0);
});
test('catalog changes remove unavailable @ candidates while slash can still explicitly select bundled workflows',async t=>{
 const app=await mount(t);await app.input('@产品');await app.update({mentionExtensions:[]});assert.equal(document.querySelectorAll('[role="option"]').length,0);
 await app.input('/审查体验');await app.key('Enter');assert.equal(app.ref.current.getDraft().skillMentions[0].name,'design-audit');assert.equal(app.sent,0);
});
test('primary disabled, uninstalled and disabled packages never enter @, and default device @ remains available',async t=>{
 const app=await mount(t,{mentionExtensions:undefined,mentionActions:undefined});
 assert.equal(app.cloudComposerExtensions({version:1,packages:[pkg('product-design',['product-design','design-audit'],{disabled_skills:['product-design']}),pkg('imagegen',['imagegen'],{installed:false}),pkg('plugin-creator',['plugin-creator'],{enabled:false})]}).length,0);
 await app.input('@');assert.match(document.querySelector('[role="listbox"]').textContent,/文件和文件夹/);assert.doesNotMatch(document.querySelector('[role="listbox"]').textContent,/产品设计/);
 await app.update({mentionExtensions:[],mentionActions:[{id:'project',name:'选择项目',description:'unavailable',icon:'project',disabled:true,onSelect(){throw new Error('disabled action invoked');}}]});await app.input('@');assert.equal(document.querySelectorAll('[role="option"]').length,0);
});

test('plain @ paste stays a query, while a copied old cloud reference keeps its pinned release and rejects another package or future release',async t=>{
 const app=await mount(t);
 const internals=app.env.loadModule('@liveagent/ui/components/chat/MentionComposerInternals.tsx');
 const current={name:'plugin-creator',skillFile:'zeroagent-skill:plugin-creator/2/plugin-creator',baseDir:'cloud',description:'current'};
 const old={...current,skillFile:'zeroagent-skill:plugin-creator/1/plugin-creator'};
 assert.equal(internals.normalizeClipboardSkill(old,[current]).skill.skillFile,old.skillFile);
 assert.equal(internals.normalizeClipboardSkill({...old,skillFile:'zeroagent-skill:another-package/1/plugin-creator'},[current]).type,'text');
 assert.equal(internals.normalizeClipboardSkill({...old,skillFile:'zeroagent-skill:plugin-creator/3/plugin-creator'},[current]).type,'text');
 assert.equal(internals.normalizeClipboardSkill(old,[]).type,'text');
 await app.input('');
 const inserted=[];document.execCommand=(command,_ui,text)=>{if(command==='insertText'||command==='insertHTML'){inserted.push(text);const node=document.createTextNode(text);app.editor.append(node);const r=document.createRange();r.setStart(node,text.length);r.collapse(true);window.getSelection().removeAllRanges();window.getSelection().addRange(r);}return true;};
 await app.env.act(async()=>{const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='text/plain'?'@Plugin':'',files:[],items:[]}});app.editor.dispatchEvent(event);await tick();});
 assert.deepEqual(inserted,['@Plugin']);assert.equal(app.editor.querySelector('[data-mention-path]'),null);assert.match(document.querySelector('[role="listbox"]').textContent,/创建插件/);assert.equal(app.sent,0);
});

test('choosing a plugin notifies the host with its completed draft even without subsequent typing',async t=>{
 const app=await mount(t);await app.input('@Plugin');
 const captured=[];app.editor.parentElement.addEventListener('input',()=>captured.push(app.ref.current.getDraft()),{capture:true});
 await app.key('Enter');
 assert.equal(captured.length,1);assert.equal(captured[0].skillMentions[0].skillFile,'zeroagent-skill:plugin-creator/2/plugin-creator');
 assert.match(captured[0].segments.at(-1).text,/ $/);assert.equal(app.sent,0);
});

test('structured paste and atomic deletion notify the host, while draft hydration stays silent',async t=>{
 const app=await mount(t);const captured=[];
 app.editor.parentElement.addEventListener('input',()=>captured.push(app.ref.current.getDraft()),{capture:true});
 const old={name:'plugin-creator',displayName:'创建插件',description:'old',skillFile:'zeroagent-skill:plugin-creator/1/plugin-creator',baseDir:'cloud'};
 const segments=[{type:'skillMention',skill:old}];
 await app.env.act(async()=>{const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:type=>type==='application/x-liveagent-composer-draft+json'?JSON.stringify({version:1,segments}):'',files:[],items:[]}});app.editor.dispatchEvent(event);await tick();});
 assert.equal(captured.length,1);assert.equal(captured[0].skillMentions[0].skillFile,old.skillFile);
 const pasted=app.ref.current.getDraft();
 await app.env.act(async()=>{app.ref.current.setText('server draft');app.ref.current.setDraft(pasted);await tick();});
 assert.equal(captured.length,1,'applying a saved/server draft must not mark it dirty');
 const internals=app.env.loadModule('@liveagent/ui/components/chat/MentionComposerInternals.tsx');
 internals.placeCaretAfterChip(app.editor.querySelector('[data-skill-file]'));
 await app.key('Backspace');assert.equal(captured.length,2);assert.equal(captured[1].isEmpty,true);assert.equal(app.sent,0);
});


test('renamed manifest entries retain only explicitly archived clipboard references without advertising retired workflows',async t=>{
 const app=await mount(t); const internals=app.env.loadModule('@liveagent/ui/components/chat/MentionComposerInternals.tsx');
 const currentCatalog={version:4,packages:[pkg('product-design',['index','audit'],{version:3,legacy_skills:[{name:'product-design',description:'Old main',version:2},{name:'skill-creator',description:'Old bundled skill',version:2}]})]};
 const {cloudComposerSkills,cloudComposerExtensions}=app.env.loadModule('src/lib/cloudExtensions.ts');
 const skills=cloudComposerSkills(currentCatalog);
 assert.deepEqual(skills.map(skill=>skill.name),['index','audit']);
 assert.equal(cloudComposerExtensions(currentCatalog)[0].skillFile,'zeroagent-skill:product-design/3/index');
 for(const name of ['product-design','skill-creator']) {
  const old={name,skillFile:`zeroagent-skill:product-design/2/${name}`,baseDir:'cloud',description:'old'};
  const restored=internals.normalizeClipboardSkill(old,skills);
  assert.equal(restored.type,'skillMention');assert.equal(restored.skill.name,name);assert.equal(restored.skill.skillFile,old.skillFile);
  assert.equal(internals.normalizeClipboardSkill({...old,skillFile:`zeroagent-skill:product-design/3/${name}`},skills).type,'text');
  assert.equal(internals.normalizeClipboardSkill({...old,skillFile:`zeroagent-skill:foreign/2/${name}`},skills).type,'text');
 }
 assert.equal(internals.normalizeClipboardSkill({name:'not-archived',description:'unavailable',baseDir:'cloud',skillFile:'zeroagent-skill:product-design/2/not-archived'},skills).type,'text');
 const disabled=cloudComposerSkills({...currentCatalog,packages:currentCatalog.packages.map(p=>({...p,enabled:false}))});
 assert.notEqual(internals.normalizeClipboardSkill({name:'product-design',skillFile:'zeroagent-skill:product-design/2/product-design'},disabled)?.type,'skillMention');
});
