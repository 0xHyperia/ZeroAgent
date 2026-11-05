import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {createWebDomTestEnv} from '../../test/helpers/dom-test-env.mjs';

test('cloud title edits survive navigation by account and uncertain writes require read-only reconciliation',async()=>{
 let preferences={version:0,title:{enabled:false,provider_key_id:0,model:'',reasoning_effort:'low',max_output_tokens:512,prompt:'中文标题'}};
 let failWrite=false,writes=0;
 const path=(relative)=>fileURLToPath(new URL(relative,import.meta.url));
 let React;
 const env=await createWebDomTestEnv({mocks:{
  [path('../src/lib/cloudGenerationSettings.ts')]:{cloudGenerationSettings:async(update)=>{
   if(update){writes++;preferences={version:preferences.version+1,title:structuredClone(update.title)};if(failWrite)throw Error('response lost');}
   return structuredClone(preferences);
  }},
  [path('../src/lib/relay/client.ts')]:{listRelayApiKeys:async()=>[],getRelayProviderModels:async()=>({data:[]})},
  [path('../src/lib/accountRequest.ts')]:{captureAccountRequestGuard:()=>()=>{}},
  '@liveagent/ui/pages/settings/ProvidersSection':{ModelPreferencesContent:props=>React.createElement('main',null,props.generationModels,props.requestPreferences)},
  './CloudImageSettingsSection':{CloudImageSettingsSection:()=>null},
 }});
 React=env.React;
 const {CloudModelPreferencesSection}=env.loadModule('src/pages/settings/CloudModelPreferencesSection.tsx');
 const host=document.body.appendChild(document.createElement('div')),root=env.createRoot(host);
 const flush=()=>env.act(async()=>{await new Promise(resolve=>setImmediate(resolve));});
 const render=async ownerId=>{await env.act(async()=>root.render(React.createElement(CloudModelPreferencesSection,{key:ownerId,ownerId,settings:{},setSettings(){}})));await flush();};
 const click=async text=>{const button=[...host.querySelectorAll('button')].find(item=>item.textContent===text);assert.ok(button,text);await env.act(async()=>button.click());await flush();};
 try {
  await render(7);
  assert.doesNotMatch(host.textContent,/模型参数|标题参数与偏好|最大输出 Token/);
  const toggle=host.querySelector('[role="switch"]');assert.ok(toggle);
  await env.act(async()=>toggle.click());await flush();
  assert.match(host.textContent,/有未保存的修改/);assert.equal(writes,0);
  assert.ok(window.sessionStorage.getItem('zeroagent.cloud-title-draft:v1:7'));
  await render(8);assert.equal(host.querySelector('[role="switch"]').getAttribute('aria-checked'),'false');
  await render(7);assert.equal(host.querySelector('[role="switch"]').getAttribute('aria-checked'),'true');assert.match(host.textContent,/已恢复未保存/);
  failWrite=true;await click('保存标题设置');assert.equal(writes,1);assert.match(host.textContent,/response lost/);
  assert.equal(preferences.title.reasoning_effort,'low');assert.equal(preferences.title.max_output_tokens,512);assert.equal(preferences.title.prompt,'中文标题');
  const save=[...host.querySelectorAll('button')].find(item=>item.textContent==='保存标题设置');assert.equal(save.disabled,true);
  await click('重新读取并核对');assert.equal(writes,1);assert.equal(host.querySelector('[role="switch"]').getAttribute('aria-checked'),'true');
  // The read confirms that the first write reached the account; no second write is necessary.
  assert.equal(window.sessionStorage.getItem('zeroagent.cloud-title-draft:v1:7'),null);
  assert.equal(save.disabled,true);
  await env.act(async()=>host.querySelector('[role="switch"]').click());await flush();
  await render(8);preferences.version++;
  await render(7);assert.equal(host.querySelector('[role="switch"]').getAttribute('aria-checked'),'false');
  assert.match(host.textContent,/账户设置已更新/);
  assert.equal(host.querySelector('[role="switch"]').getAttribute('aria-disabled'),'true');
  await click('重新读取并核对');assert.equal(host.querySelector('[role="switch"]').getAttribute('aria-checked'),'false');assert.equal(writes,1);
 } finally {await env.act(async()=>root.unmount());env.cleanup();}
});
