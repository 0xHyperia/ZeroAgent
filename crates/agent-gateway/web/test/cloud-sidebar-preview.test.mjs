import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test("hover preview hands off to the pane, holds for menus, and resets without handling touch",async()=>{
 const env=await createWebDomTestEnv();
 const {React,act,createRoot}=env;
 const {useCloudSidebarPreview}=env.loadModule('src/components/cloudchat/useCloudSidebarPreview.ts');
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container);
 let preview;
 function Harness({enabled=true,owner=1}){preview=useCloudSidebarPreview(enabled,owner);return React.createElement('div',{ref:preview.rootRef},React.createElement('button',{'data-rail-item':'chat'},'Home'),React.createElement('div',{'data-sidebar-preview-region':''},'Pane'));}
 const render=props=>act(async()=>root.render(React.createElement(Harness,props)));
 const pointer=async(selector,pointerType='mouse')=>act(async()=>{const event=new Event('pointerover',{bubbles:true});Object.defineProperty(event,'pointerType',{value:pointerType});document.querySelector(selector).dispatchEvent(event);});
 const settle=ms=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms));});
 try{
  await render();
  await pointer('[data-rail-item]','touch');await settle(150);assert.equal(preview.open,false);
  await pointer('[data-rail-item]');await settle(150);assert.equal(preview.open,true);
  await pointer('[data-sidebar-preview-region]');await settle(250);assert.equal(preview.open,true);
  const menu=document.body.appendChild(document.createElement('div'));menu.setAttribute('role','menu');
  await pointer('body');await settle(250);assert.equal(preview.open,true);
  await act(async()=>menu.setAttribute('data-closed',''));await settle(250);assert.equal(preview.open,false,'a closing animation is no longer an open menu');
  await act(async()=>menu.remove());
  await pointer('[data-rail-item]');await settle(150);assert.equal(preview.open,true);
  await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));assert.equal(preview.open,false);
  await pointer('[data-rail-item]');await settle(150);assert.equal(preview.open,false,'Escape stays closed while the pointer remains on the hover edge');
  await pointer('body');
  await pointer('[data-rail-item]');await render({enabled:false});await settle(150);assert.equal(preview.open,false);
  await render();await pointer('[data-rail-item]');await settle(150);assert.equal(preview.open,true);
  await render({owner:2});assert.equal(preview.open,false);
  await pointer('[data-rail-item]');await settle(150);assert.equal(preview.open,true);
  await pointer('body');
  for(let i=0;i<4;i++){
   await act(async()=>{const output=document.body.appendChild(document.createElement('span'));output.textContent='stream delta';});
   await settle(80);
  }
  assert.equal(preview.open,false,'stream rendering cannot keep restarting the close delay');
 }finally{await act(async()=>root.unmount());container.remove();env.cleanup();}
});

test('navigation previews only open while collapsed and pinning cancels visible and pending previews',async()=>{
 const env=await createWebDomTestEnv(),{React,act,createRoot}=env;
 const {useCloudSidebarPreview}=env.loadModule('src/components/cloudchat/useCloudSidebarPreview.ts');
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container);
 let preview;
 function Harness({pinnedOpen=true,destination='chat'}){preview=useCloudSidebarPreview(true,1,{pinnedOpen,destination});return React.createElement('div',{ref:preview.rootRef},...['chat','library','devices','cron-hub','customize'].map(id=>React.createElement('button',{key:id,'data-rail-item':id},id)),React.createElement('div',{'data-sidebar-preview-region':''},'Preview'));}
 const render=props=>act(async()=>root.render(React.createElement(Harness,props)));
 const hover=async(id,wait=150)=>act(async()=>{const event=new Event('pointerover',{bubbles:true});Object.defineProperty(event,'pointerType',{value:'mouse'});container.querySelector(`[data-rail-item="${id}"]`).dispatchEvent(event);if(wait)await new Promise(resolve=>setTimeout(resolve,wait));});
 try{
  await render();
  for(const id of ['chat','library','devices','cron-hub','customize']){await hover(id);assert.equal(preview.open,false,'an expanded sidebar must not show hover previews');}
  await render({pinnedOpen:false});
  await hover('library');assert.equal(preview.open,true);assert.equal(preview.destination,'library');
  await hover('devices');assert.equal(preview.open,true);assert.equal(preview.destination,'devices');
  await hover('cron-hub');assert.equal(preview.open,true);assert.equal(preview.destination,'cron-hub');
  await hover('customize');assert.equal(preview.open,true);assert.equal(preview.destination,'customize');
  await render({pinnedOpen:true,destination:'library'});assert.equal(preview.open,false);
  await hover('chat');assert.equal(preview.open,false);
  await render({pinnedOpen:false,destination:'library'});await hover('chat');assert.equal(preview.destination,'chat');assert.equal(preview.open,true);
  await render({pinnedOpen:true,destination:'library'});assert.equal(preview.open,false);
  await render({pinnedOpen:false,destination:'library'});await hover('devices',0);
  await render({pinnedOpen:true,destination:'library'});await hover('devices');assert.equal(preview.open,false,'pinning must cancel a pending hover timer');
 }finally{await act(async()=>root.unmount());container.remove();env.cleanup();}
});

test('crossing the collapsed edge into a context preview retains that sidebar until it closes',async()=>{
 const env=await createWebDomTestEnv(),{React,act,createRoot}=env;
 const {useCloudSidebarPreview}=env.loadModule('src/components/cloudchat/useCloudSidebarPreview.ts');
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container);
 let preview;
 function Harness(){preview=useCloudSidebarPreview(true,1,{destination:'cron-hub'});return React.createElement('div',{ref:preview.rootRef},...['chat','library','devices','cron-hub','customize'].map(id=>React.createElement('button',{key:id,'data-rail-item':id},id)),React.createElement('div',{'data-cloud-sidebar-hover-edge':''},'Edge'),React.createElement('div',{'data-sidebar-preview-region':''},React.createElement('button',{'data-preview-row':''},'Preview row')));}
 const point=selector=>act(async()=>{const event=new Event('pointerover',{bubbles:true});Object.defineProperty(event,'pointerType',{value:'mouse'});document.querySelector(selector).dispatchEvent(event);});
 const settle=ms=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms));});
 try{
  await act(async()=>root.render(React.createElement(Harness)));
  for(const destination of ['chat','library','devices','customize']){
   await point(`[data-rail-item="${destination}"]`);await settle(150);
   assert.equal(preview.destination,destination);assert.equal(preview.open,true);
   await point('[data-cloud-sidebar-hover-edge]');await settle(150);
   await point('[data-preview-row]');await settle(250);
   assert.equal(preview.open,true);assert.equal(preview.destination,destination,'the handoff edge must not replace the visible preview with chat');
   await point('body');await settle(250);assert.equal(preview.open,false);
   await point('[data-cloud-sidebar-hover-edge]');await settle(150);
   assert.equal(preview.open,true);assert.equal(preview.destination,'cron-hub','a fresh edge entry still opens the selected task workspace');
  }
 }finally{await act(async()=>root.unmount());container.remove();env.cleanup();}
});
