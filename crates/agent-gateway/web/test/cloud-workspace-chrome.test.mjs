import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('title editing validates, cancels, keeps failed text and submits only once while saving',async()=>{
 const env=await createWebDomTestEnv({mocks:{'@liveagent/ui/components/IconSet':new Proxy({},{get:()=>()=>null})}});
 const {React,act,createRoot}=env,{CloudConversationTitle}=env.loadModule('src/components/cloudchat/CloudConversationTitle.tsx');
 const host=document.body.appendChild(document.createElement('div')),root=createRoot(host),calls=[];
 let finish;
 function Harness(){const[title,setTitle]=React.useState('原始标题');return React.createElement(CloudConversationTitle,{title,onRename:async value=>{calls.push(value);await new Promise((resolve,reject)=>finish={resolve,reject});setTitle(value);}});}
 const click=()=>act(async()=>host.querySelector('.cloud-title-trigger').click());
 const input=()=>host.querySelector('input');
 const text=value=>act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input(),value);input().dispatchEvent(new Event('input',{bubbles:true}));});
 const key=key=>act(async()=>{input().dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));await tick();});
 try{
  await act(async()=>root.render(React.createElement(Harness)));
  await click();assert.equal(document.activeElement,input());await text('不保存');await key('Escape');assert.equal(input(),null);assert.equal(calls.length,0);assert.equal(document.activeElement,host.querySelector('button'));
  await click();await text('  ');await key('Enter');assert.match(host.textContent,/标题不能为空/);assert.equal(calls.length,0);
  await text(' 新的标题 ');await key('Enter');assert.equal(input().disabled,true);
  await act(async()=>input().dispatchEvent(new Event('focusout',{bubbles:true})));assert.equal(calls.length,1);
  await act(async()=>{finish.reject(new Error('保存失败'));await tick();});assert.equal(input().value,' 新的标题 ');assert.match(host.textContent,/保存失败/);
  await key('Enter');assert.equal(calls.length,2);assert.equal(calls[1],'新的标题');
  await act(async()=>{finish.resolve();await tick();});assert.equal(input(),null);assert.match(host.querySelector('button').textContent,/新的标题/);assert.equal(document.activeElement,host.querySelector('button'));
  await click();await text('失焦保存');
  await act(async()=>{input().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));await tick();});assert.equal(calls.length,2);
  await act(async()=>{input().blur();await tick();});assert.equal(calls.length,3);
  await act(async()=>{finish.resolve();await tick();});assert.match(host.querySelector('button').textContent,/失焦保存/);
 }finally{await act(async()=>root.unmount());host.remove();env.cleanup();}
});

test('context sidebar shows account files and actual devices, cancels stale reads, and does not execute on hover',async()=>{
 let env;
 env=await createWebDomTestEnv({mocks:{
  '@liveagent/ui/components/IconSet':new Proxy({},{get:()=>()=>null}),
  '@liveagent/ui/components/ui/sidebar':{Sidebar:props=>env.React.createElement('aside',{'aria-label':props.label},props.children),SidebarHeader:props=>env.React.createElement('header',null,props.children),SidebarTrigger:props=>env.React.createElement('button',{onClick:props.onClick},'固定')},
 }});
 const {React,act,createRoot}=env,{CloudContextSidebar}=env.loadModule('src/components/cloudchat/CloudContextSidebar.tsx');
 const host=document.body.appendChild(document.createElement('div')),root=createRoot(host),actions=[],reads=[];
 let finish;
 const props={preview:true,files:{list:({signal})=>{reads.push(signal);return new Promise(resolve=>finish=resolve);}},environments:[{runtime_kind:'web_chat',name:'Web',online:true},{runtime_kind:'device_agent',device_id:'d1',name:'办公电脑',online:false}],onOpenResource:id=>actions.push(id),onOpenFile:id=>actions.push(id),onOpenDevices:()=>actions.push('devices'),onPin:()=>actions.push('pin')};
 const render=destination=>act(async()=>root.render(React.createElement(CloudContextSidebar,{...props,destination})));
 try{
  await render('library');assert.equal(actions.length,0);
  await act(async()=>{finish({files:[{id:'f1',name:'实际文件.pdf',state:'ready'}]});await tick();});assert.match(host.textContent,/实际文件.pdf/);
  await act(async()=>[...host.querySelectorAll('button')].find(e=>e.textContent==='实际文件.pdf').click());assert.deepEqual(actions,['f1']);
  await render('devices');assert.equal(reads[0].aborted,true);assert.match(host.textContent,/办公电脑/);assert.match(host.textContent,/离线/);assert.doesNotMatch(host.textContent,/实际文件.pdf/);assert.deepEqual(actions,['f1']);
  await render('library');await render('devices');assert.equal(reads.at(-1).aborted,true);
  await act(async()=>{finish({files:[{id:'f2',name:'迟到的旧列表',state:'ready'}]});await tick();});assert.doesNotMatch(host.textContent,/迟到的旧列表/);
 }finally{await act(async()=>root.unmount());host.remove();env.cleanup();}
});
