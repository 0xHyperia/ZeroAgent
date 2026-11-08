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
  await hover('devices');assert.equal(preview.destination,'library','devices no longer open a sidebar preview');
  await hover('cron-hub');assert.equal(preview.open,true);assert.equal(preview.destination,'cron-hub');
  await hover('customize');assert.equal(preview.open,true);assert.equal(preview.destination,'customize');
  await render({pinnedOpen:true,destination:'library'});assert.equal(preview.open,false);
  await hover('chat');assert.equal(preview.open,false);
  await render({pinnedOpen:false,destination:'library'});await hover('chat');assert.equal(preview.destination,'chat');assert.equal(preview.open,true);
  await render({pinnedOpen:true,destination:'library'});assert.equal(preview.open,false);
  await render({pinnedOpen:false,destination:'library'});await hover('customize',0);
  await render({pinnedOpen:true,destination:'library'});await hover('customize');assert.equal(preview.open,false,'pinning must cancel a pending hover timer');
 }finally{await act(async()=>root.unmount());container.remove();env.cleanup();}
});

test('crossing the collapsed edge into a context preview retains that sidebar until it closes',async()=>{
 const env=await createWebDomTestEnv(),{React,act,createRoot}=env;
 const {useCloudSidebarPreview}=env.loadModule('src/components/cloudchat/useCloudSidebarPreview.ts');
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container);
 let preview;
 function Harness(){preview=useCloudSidebarPreview(true,1,{destination:'cron-hub'});return React.createElement('div',{ref:preview.rootRef},...['chat','library','cron-hub','customize'].map(id=>React.createElement('button',{key:id,'data-rail-item':id},id)),React.createElement('div',{'data-cloud-sidebar-hover-edge':''},'Edge'),React.createElement('div',{'data-sidebar-preview-region':''},React.createElement('button',{'data-preview-row':''},'Preview row')));}
 const point=selector=>act(async()=>{const event=new Event('pointerover',{bubbles:true});Object.defineProperty(event,'pointerType',{value:'mouse'});document.querySelector(selector).dispatchEvent(event);});
 const settle=ms=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms));});
 try{
  await act(async()=>root.render(React.createElement(Harness)));
  for(const destination of ['chat','library','customize']){
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

test("the collapsed rail previews another sidebar from the keyboard and returns to its trigger", async () => {
 const env = await createWebDomTestEnv();
 const {React, act, createRoot} = env;
 const {useCloudSidebarPreview} = env.loadModule("src/components/cloudchat/useCloudSidebarPreview.ts");
 const {ApplicationRail} = env.loadModule("@liveagent/ui/application/ApplicationRail.tsx");
 const container = document.body.appendChild(document.createElement("div"));
 const root = createRoot(container);
 const selected = [];
 let preview;
 function Harness({pinnedOpen = false}) {
  preview = useCloudSidebarPreview(true, 1, {pinnedOpen, destination: "chat"});
  return React.createElement("div", {ref: preview.rootRef},
   React.createElement(ApplicationRail, {
    activeId: "chat",
    previewId: preview.open ? preview.destination : undefined,
    previewableIds: preview.previewableIds,
    items: ["chat", "library", "customize"].map(id => ({
     id, label: id, icon: id, onSelect() { selected.push(id); },
    })),
   }),
   React.createElement("div", {hidden: true, "data-sidebar-preview-region": ""},
    React.createElement("button", null, "Hidden pane")),
   preview.open && React.createElement("div", {"data-sidebar-preview-region": ""},
    React.createElement("button", {disabled: true}, "Unavailable item"),
    React.createElement("button", {"data-preview-row": ""}, preview.destination)));
 }
 const render = pinnedOpen => act(async () => root.render(React.createElement(Harness, {pinnedOpen})));
 const railItem = id => container.querySelector(`[data-rail-item="${id}"]`);
 const key = async (element, value) => {
  const event = new KeyboardEvent("keydown", {key: value, bubbles: true, cancelable: true});
  await act(async () => element.dispatchEvent(event));
  return event.defaultPrevented;
 };
 try {
  await render(false);
  const library = railItem("library");
  assert.equal(library.getAttribute("aria-keyshortcuts"), "ArrowRight");
  assert.equal(library.getAttribute("aria-expanded"), "false");
  await act(async () => library.focus());
  assert.equal(preview.open, false, "ordinary tab focus leaves the workspace unchanged");
  assert.equal(await key(library, "ArrowRight"), true);
  assert.equal(preview.destination, "library");
  assert.equal(preview.open, true);
  assert.equal(library.getAttribute("aria-expanded"), "true");
  const row = container.querySelector("[data-preview-row]");
  assert.equal(document.activeElement, row);
  assert.equal(railItem("chat").getAttribute("aria-current"), "page");
  assert.deepEqual(selected, [], "preview never selects a destination");

  await act(async () => {
   const pointer = new Event("pointerover", {bubbles: true});
   Object.defineProperty(pointer, "pointerType", {value: "mouse"});
   railItem("customize").dispatchEvent(pointer);
   await new Promise(resolve => setTimeout(resolve, 150));
  });
  assert.equal(document.activeElement, row);
  assert.equal(preview.destination, "library", "hover does not replace a focused keyboard preview");
  assert.equal(await key(row, "Escape"), true);
  assert.equal(preview.open, false);
  assert.equal(document.activeElement, library);
  assert.equal(library.getAttribute("aria-expanded"), "false");

  await render(true);
  assert.equal(library.hasAttribute("aria-keyshortcuts"), false);
  assert.equal(await key(library, "ArrowRight"), false);
  assert.equal(preview.open, false);
 } finally {
  await act(async () => root.unmount());
  container.remove();
  env.cleanup();
 }
});

test("choosing an existing conversation from a keyboard preview keeps focus in the workbench", async (t) => {
 const env = await createWebDomTestEnv();
 const { React, act, createRoot } = env;
 const { useCloudSidebarPreview } = env.loadModule("src/components/cloudchat/useCloudSidebarPreview.ts");
 const container = document.body.appendChild(document.createElement("div"));
 const root = createRoot(container);
 t.after(async () => { await act(() => root.unmount()); container.remove(); env.cleanup(); });
 let preview;
 function Harness() {
  const [destination, setDestination] = React.useState("cron-hub");
  const composer = React.useRef(null);
  preview = useCloudSidebarPreview(true, 1, { destination });
  return React.createElement("div", { ref: preview.rootRef, "data-destination": destination },
   React.createElement("button", { "data-rail-item": "chat" }, "Conversations"),
   React.createElement("section", { "data-sidebar-preview-region": "", inert: !preview.open },
    React.createElement("button", {
     "data-history-row": "",
     onClick() { setDestination("chat"); },
    }, "Open existing conversation"),
    React.createElement("button", {
     "data-open-and-focus": "",
     onClick() { preview.dismiss(); composer.current.focus(); },
    }, "Continue writing")),
   React.createElement("textarea", { ref: composer, defaultValue: "Keep this draft" }));
 }
 await act(() => root.render(React.createElement(Harness)));
 const rail = container.querySelector("[data-rail-item]");
 const historyRow = container.querySelector("[data-history-row]");
 const focusComposer = container.querySelector("[data-open-and-focus]");
 const draft = container.querySelector("textarea");
 draft.setSelectionRange(2, 7);
 const openPreview = () => act(() => {
  rail.focus();
  rail.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
 });

 await openPreview();
 assert.ok(document.activeElement === historyRow, "keyboard preview enters the existing conversation row");
 await act(() => historyRow.click());
 assert.equal(container.firstElementChild.dataset.destination, "chat");
 assert.equal(preview.open, false);
 assert.ok(document.activeElement === rail, "focus returns to the same rail entry");
 assert.ok(container.querySelector("textarea") === draft, "the composer remains mounted");
 assert.equal(draft.value, "Keep this draft");
 assert.deepEqual([draft.selectionStart, draft.selectionEnd], [2, 7]);

 await openPreview();
 await act(() => { focusComposer.focus(); focusComposer.click(); });
 assert.equal(preview.open, false);
 assert.ok(document.activeElement === draft, "an explicit navigation focus takes precedence");
});
