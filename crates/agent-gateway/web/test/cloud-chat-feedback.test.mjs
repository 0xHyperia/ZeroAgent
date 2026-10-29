import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test('feedback preserves explicit recovery, truthful urgency and optional dismissal without rendering message markup',async()=>{
 let env;
 env=await createWebDomTestEnv({mocks:{
  '@liveagent/ui/components/IconSet':new Proxy({},{get:()=>()=>null}),
  '@liveagent/ui/components/ui/tooltip-button':{TooltipButton:props=>env.React.createElement('button',{'aria-label':props['aria-label'],onClick:props.onClick},props.children)},
 }});
 const {React,act,createRoot}=env;
 const {CloudChatFeedback}=env.loadModule('src/components/cloudchat/CloudChatFeedback.tsx');
 const host=document.body.appendChild(document.createElement('div')),root=createRoot(host);
 let recoveries=0,dismissals=0;
 const render=props=>act(async()=>root.render(React.createElement(CloudChatFeedback,props)));
 try{
  await render({tone:'warning',message:'提交结果尚未确认',description:'<img src=x onerror=alert(1)>',actions:React.createElement('button',{onClick:()=>recoveries++},'核对提交状态')});
  assert.equal(host.querySelector('[role="status"]')?.textContent.includes('提交结果尚未确认'),true);
  assert.equal(host.querySelector('img'),null);assert.match(host.textContent,/<img src=x/);
  assert.equal(host.querySelector('[aria-label="关闭提示"]'),null);assert.equal(recoveries,0);
  await act(async()=>host.querySelector('button').click());assert.equal(recoveries,1);
  await render({tone:'error',message:'文件暂不可用'});assert.match(host.querySelector('[role="alert"]').textContent,/文件暂不可用/);
  await render({compact:true,message:'项目已更新',onDismiss:()=>dismissals++});assert.equal(dismissals,0);
  await act(async()=>host.querySelector('[aria-label="关闭提示"]').click());assert.equal(dismissals,1);assert.equal(recoveries,1);
 }finally{await act(async()=>root.unmount());host.remove();env.cleanup();}
});
