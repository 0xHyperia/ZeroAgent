import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";
import { createDomTestEnv } from "../../../agent-gui/test/helpers/dom-test-env.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const iconMocks = new Proxy({}, { get: () => () => null });

test("mode switch keeps one selected tab, supports arrows/Home/End, and never activates on focus", async t => {
  const env = await createWebDomTestEnv({mocks:{"@liveagent/ui/components/IconSet":iconMocks}});
  const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host);
  t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
  const {CloudChatModeSwitch}=env.loadModule('src/components/cloudchat/CloudChatComposerMenu.tsx');
  const changes=[];
  function Harness(){const [value,setValue]=env.React.useState('work');return env.React.createElement(CloudChatModeSwitch,{value,onChange:next=>{changes.push(next);setValue(next);}});}
  await env.act(async()=>root.render(env.React.createElement(Harness)));
  const [chat,work]=host.querySelectorAll('button');
  await env.act(async()=>{chat.focus();await tick();});assert.deepEqual(changes,[]);
  assert.equal(work.getAttribute('aria-pressed'),'true');
  await env.act(async()=>{work.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await tick();});
  assert.deepEqual(changes,['chat']);assert.equal(document.activeElement,chat);assert.equal(chat.tabIndex,0);assert.equal(work.tabIndex,-1);
  await env.act(async()=>{chat.dispatchEvent(new window.KeyboardEvent('keydown',{key:'End',bubbles:true}));await tick();});
  assert.equal(document.activeElement,work);assert.equal(work.getAttribute('aria-pressed'),'true');
  await env.act(async()=>{work.click();await tick();});assert.deepEqual(changes,['chat','work'],'clicking the selected tab is a no-op');
});

test("shape motion reverses from its current height and respects reduced motion", async t => {
  const env=await createWebDomTestEnv();
  const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host);
  let natural=54,live=54,active=false,reduced=false,cancelled=0;
  window.matchMedia=()=>({matches:reduced,addEventListener(){},removeEventListener(){}});
  const originalRect=window.HTMLElement.prototype.getBoundingClientRect;
  const originalAnimate=window.HTMLElement.prototype.animate;
  const calls=[];
  window.HTMLElement.prototype.getBoundingClientRect=function(){return {height:active?live:natural};};
  window.HTMLElement.prototype.animate=function(frames,options){calls.push({frames,options});active=true;return {cancel(){active=false;cancelled++;},onfinish:null};};
  t.after(async()=>{await env.act(async()=>root.unmount());window.HTMLElement.prototype.getBoundingClientRect=originalRect;window.HTMLElement.prototype.animate=originalAnimate;host.remove();env.cleanup();});
  const {useComposerShapeMotion}=env.loadModule('../../agent-ui/src/components/chat/useComposerShapeMotion.ts');
  function Harness({shape}){const ref=env.React.useRef(null);useComposerShapeMotion(ref,true,shape);return env.React.createElement('div',{ref});}
  const render=async shape=>env.act(async()=>{root.render(env.React.createElement(Harness,{shape}));await tick();});
  await render('chat');natural=128;await render('work');
  assert.deepEqual(calls[0].frames,[{height:'54px'},{height:'128px'}]);assert.equal(calls[0].options.duration,300);
  live=86;natural=54;await render('chat-again');
  assert.deepEqual(calls[1].frames,[{height:'86px'},{height:'54px'}]);assert.equal(cancelled,1);
  reduced=true;natural=128;await render('reduced-work');assert.equal(calls.length,2);assert.equal(cancelled,2);
});

test("the real inline composer retains its editor, selection and single model control across modes and toolbar placement", async t => {
  let env,mounts=0,modelMounts=0;
  let sendFromEditor;
  const noop=()=>{};
  const mocks={
    '@liveagent/ui/components/IconSet':iconMocks,
    '@liveagent/ui/components/chat/fileTypeIcons':iconMocks,
    '@liveagent/ui/components/chat/ComposerModelControls':{ComposerModelControls:()=>{env.React.useEffect(()=>{modelMounts++;},[]);return env.React.createElement('button',{'data-model':''},'model');}},
    '@liveagent/ui/components/chat/CommandSafetyModeSelector':{CommandSafetyModeSelector:()=>env.React.createElement('button',{'data-safety':''},'safety')},
    '@liveagent/ui/components/git/GitBranchSelector':{GitBranchSelector:()=>env.React.createElement('button',{'data-git':''},'git')},
    '@liveagent/ui/components/chat/MentionComposer':{MentionComposer:props=>{
      sendFromEditor=props.onSend;
      const ref=env.React.useRef(null);
      env.React.useEffect(()=>{mounts++;props.onEmptyChange?.(false);},[]);
      env.React.useImperativeHandle(props.ref,()=>({getDraft:()=>({text:ref.current.value,textWithoutLargePastes:ref.current.value,segments:[{type:'text',text:ref.current.value}],largePastes:[],isEmpty:!ref.current.value}),focus:()=>ref.current.focus()}));
      return env.React.createElement('textarea',{ref,className:'mention-composer',defaultValue:'保留这个草稿',disabled:props.disabled});
    }},
  };
  env=await createDomTestEnv({mocks});
  window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host);
  t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
  const {ChatComposerBar}=env.loadModule('@liveagent/ui/pages/chat/ChatComposerBar.tsx');
  const {LocaleContext}=env.loadModule('@liveagent/ui/i18n/LocaleContext.tsx');
  const composerRef={current:null};
  let sends=0;
  const props={surface:'web',layout:'inline',conversationId:'one',composerRef,isSending:false,isUploadingFiles:false,isInputDisabled:false,inputPlaceholder:'询问 ZeroAgent',workdir:'',enabledSkills:[],executionMode:'text',hasModels:true,currentModelLabel:'m',modelOptions:[],chatRuntimeControls:{},reasoningOptions:[],thinkingAlwaysOn:false,onSend:()=>sends++,onStop:noop,onComposerBusyChange:noop,onSelectModel:noop,onSelectExecutionMode:noop,onChatRuntimeControlsChange:noop,onPickReadableFiles:noop,onPickWorkspaceFolder:noop,onPasteFiles:noop,pendingUploadedFiles:[],onRemovePendingUpload:noop,queuedTurns:[],onRunQueuedTurnNow:noop,onMoveQueuedTurnUp:noop,onEditQueuedTurn:noop,onRemoveQueuedTurn:noop,showGitControls:false,contextBar:env.React.createElement('div',null,'上下文'),capabilityMenu:env.React.createElement('button',null,'添加')};
  const render=async expanded=>env.act(async()=>{root.render(env.React.createElement(LocaleContext.Provider,{value:{locale:'zh-CN',t:key=>key}},env.React.createElement(ChatComposerBar,{...props,expandedInput:expanded,contextBarPosition:expanded?'above':'below'})));await tick();});
  await render(false);const editor=host.querySelector('textarea');editor.focus();editor.setSelectionRange(2,5);
  for(const mode of [true,false,true,false]){await render(mode);assert.equal(host.querySelector('textarea'),editor);assert.equal(editor.value,'保留这个草稿');assert.equal(editor.selectionStart,2);assert.equal(editor.selectionEnd,5);assert.equal(host.querySelectorAll('[data-model]').length,1);}
  assert.equal(mounts,1);assert.equal(modelMounts,1);assert.equal(sends,0);assert.equal(host.querySelector('.composer-control-deck'),null);
  props.feedback=env.React.createElement('p',{role:'status'},'提交结果尚未确认');
  await render(false);assert.match(host.querySelector('[data-composer-feedback]').textContent,/提交结果尚未确认/);
  assert.equal(host.querySelector('textarea'),editor);assert.equal(editor.selectionStart,2);assert.equal(editor.selectionEnd,5);
  props.feedback=null;await render(false);assert.equal(host.querySelector('[data-composer-feedback]'),null);
  assert.equal(host.querySelector('textarea'),editor);assert.equal(mounts,1);assert.equal(sends,0);
  editor.value='第一行\n第二行';await env.act(async()=>{editor.dispatchEvent(new window.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,40));});
  assert.equal(host.querySelector('.composer-glass-card').getAttribute('data-composer-single-line'),'false');
  props.isSubmissionDisabled=true;
  await render(true);
  assert.equal(host.querySelector('textarea'),editor);
  assert.equal(editor.disabled,false);
  assert.equal(host.querySelector('[data-composer-primary-action="send"]').disabled,true);
  await env.act(async()=>sendFromEditor());
  assert.equal(sends,0);
  let stops=0;props.onStop=()=>stops++;props.isSending=true;props.allowQueueWhileSending=true;
  await render(true);const stop=host.querySelector('[data-composer-primary-action="stop"]');assert.ok(stop);
  await env.act(async()=>stop.click());assert.equal(stops,1);assert.equal(sends,0);assert.equal(host.querySelector('textarea'),editor);
  props.isSending=false;props.isSubmissionDisabled=false;await render(true);assert.equal(host.querySelector('[data-composer-primary-action="send"]'),stop,'the same action button changes state');
  props.layout='standard';props.executionMode='tools';props.showGitControls=true;props.commandSafetyMode='auto';props.onCommandSafetyModeChange=noop;
  await render(false);
  const deck=host.querySelector('[data-desktop-device-composer] .composer-device-runtime');assert.ok(deck);
  assert.equal(host.querySelector('.composer-control-deck'),null);
  assert.ok(deck.closest('.composer-actions-row').querySelector('[data-composer-primary-action]'));
  const safety=deck.querySelector('[data-safety]'),model=deck.querySelector('[data-model]'),git=deck.querySelector('[data-git]');
  assert.ok(safety);assert.ok(model);assert.ok(git);assert.ok(safety.compareDocumentPosition(model)&4);assert.ok(model.compareDocumentPosition(git)&4);
  assert.equal(host.querySelectorAll('[data-model]').length,1);assert.equal(sends,0);
  const {CLOUD_COMPOSER_CAPABILITIES,DEVICE_COMPOSER_CAPABILITIES}=env.loadModule('@liveagent/ui/contracts/composerPresentation.ts');
  // The host can vary geometry or supported controls without replacing the draft owner.
  const retainedEditor=host.querySelector('textarea'),retainedModelMounts=modelMounts;retainedEditor.focus();retainedEditor.setSelectionRange(1,3);
  props.presentation='pane';props.capabilities=DEVICE_COMPOSER_CAPABILITIES;
  await render(false);assert.equal(host.querySelector('textarea'),retainedEditor);
  assert.equal(modelMounts,retainedModelMounts);
  props.presentation='column';props.capabilities=CLOUD_COMPOSER_CAPABILITIES;
  await render(false);
  assert.equal(host.querySelector('[data-safety]'),null,'cloud capabilities suppress device execution controls even if callbacks exist');
  assert.equal(host.querySelector('[data-git]'),null,'a cloud host cannot expose local Git by requesting its visibility');
  assert.equal(host.querySelector('textarea'),retainedEditor);assert.equal(retainedEditor.selectionStart,1);assert.equal(retainedEditor.selectionEnd,3);
  props.capabilities=DEVICE_COMPOSER_CAPABILITIES;
  await render(false);assert.ok(host.querySelector('[data-safety]'));assert.ok(host.querySelector('[data-git]'));
  assert.equal(host.querySelector('textarea'),retainedEditor);assert.equal(mounts,1);assert.equal(host.querySelectorAll('[data-model]').length,1);assert.equal(sends,0);

  window.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});
  props.layout='inline';props.executionMode='text';props.capabilities=CLOUD_COMPOSER_CAPABILITIES;
  await render(true);
  const mobileDeck=host.querySelector('[data-mobile-composer] .composer-control-deck');
  assert.ok(mobileDeck);
  assert.equal(host.querySelectorAll('[data-composer-context-bar]').length,1);
  assert.ok(mobileDeck.querySelector('[data-composer-context-bar]'));
  assert.ok(mobileDeck.querySelector('[data-model]'));
  assert.equal(host.querySelector('textarea'),retainedEditor);
  assert.equal(retainedEditor.value,'第一行\n第二行');
});
