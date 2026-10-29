import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test('page settings keeps real section navigation, mobile list/detail and nested Escape behavior',async()=>{
 const env=await createWebDomTestEnv({mocks:{
  '@liveagent/ui/components/IconSet':new Proxy({},{get:()=>()=>null}),
  '../../i18n':{useLocale:()=>({t:key=>key})},
 }});
 const {React,act,createRoot}=env;
 const {SettingsShell}=env.loadModule('@liveagent/ui/pages/settings/SettingsShell.tsx');
 const host=document.body.appendChild(document.createElement('div')),root=createRoot(host);
 let backs=0,section;
 const definition=id=>({id,labelKey:id,groupKey:'general',groupOrder:0,order:id==='system'?0:1,render:()=>React.createElement('p',null,`${id} content`)});
 const props={registry:{surface:'web',services:{},slots:{},settingsSections:[definition('system'),definition('account')]},context:null,saveState:{status:'saved'},onBack:()=>backs++,onSectionChange:id=>section=id};
 try{
  await act(async()=>root.render(React.createElement(SettingsShell,{...props,presentation:'page'})));
  assert.equal(document.activeElement,host.querySelector('h1'));
  assert.equal(host.querySelector('[data-settings-presentation]').dataset.mobileDetail,'false');
  await act(async()=>host.querySelector('[data-settings-nav-id="account"]').click());
  assert.equal(section,'account');assert.match(host.querySelector('main').textContent,/account content/);
  assert.equal(host.querySelector('[data-settings-presentation]').dataset.mobileDetail,'true');
  await act(async()=>host.querySelector('.settings-mobile-back').click());
  assert.equal(host.querySelector('[data-settings-presentation]').dataset.mobileDetail,'false');
  const consume=event=>event.preventDefault();document.addEventListener('keydown',consume);
  await act(async()=>host.querySelector('main').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
  assert.equal(backs,0);document.removeEventListener('keydown',consume);
  await act(async()=>host.querySelector('main').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
  assert.equal(backs,1);
  await act(async()=>root.render(React.createElement(SettingsShell,props)));
  assert.equal(host.querySelector('[data-settings-presentation]').dataset.settingsPresentation,'workbench');
  assert.equal(host.querySelector('.settings-page-title'),null);
  assert.equal(host.querySelector('.settings-mobile-back'),null);
 }finally{await act(async()=>root.unmount());host.remove();env.cleanup();}
});
