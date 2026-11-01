import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const icons=new Proxy({},{get:()=>()=>null});
async function setup(t){
 const env=await createWebDomTestEnv({resolveDynamicImports:true,mocks:{"../IconSet":icons,"@liveagent/ui/components/IconSet":icons}});
 const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
 t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
 const render=async node=>env.act(async()=>{root.render(node);await tick();});
 return {env,host,render};
}
test("attachment cover, preview and removal have separate targets; removal never invokes preview",async t=>{
 const app=await setup(t),{ComposerAttachmentCard}=app.env.loadModule("../../agent-ui/src/components/chat/ComposerAttachmentCard.tsx");let opened=0,removed=0;
 await app.render(app.env.React.createElement(ComposerAttachmentCard,{fileName:"计划.docx",pathTitle:"计划.docx",disabled:false,fallbackIcon:null,removeLabel:"移除",onOpen:()=>opened++,onRemove:()=>removed++,previewContent:app.env.React.createElement("div",null,"真实封面")}));
 assert.equal(app.host.querySelectorAll('button button').length,0);
 await app.env.act(async()=>app.host.querySelector('[aria-label="移除 计划.docx"]').click());assert.equal(removed,1);assert.equal(opened,0);
 await app.env.act(async()=>app.host.querySelector('[aria-label="预览 计划.docx"]').click());assert.equal(opened,1);
});
test("offscreen attachment thumbnails do not read bytes; leaving the viewport aborts their pending read",async t=>{
 const original=globalThis.IntersectionObserver;let callback,reads=0,aborted=false;
 globalThis.IntersectionObserver=class{constructor(cb){callback=cb;}observe(){}disconnect(){}};t.after(()=>{if(original===undefined)delete globalThis.IntersectionObserver;else globalThis.IntersectionObserver=original;});
 const app=await setup(t),{ResourceThumbnail}=app.env.loadModule("../../agent-ui/src/components/resource-preview/ResourcePreview.tsx");
 const bytes=Buffer.from("document");const resource={identity:"account-a:immutable",name:"document.txt",mime:"text/plain",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
 await app.render(app.env.React.createElement(ResourceThumbnail,{resource,load:signal=>{reads++;signal.addEventListener("abort",()=>aborted=true);return new Promise(()=>{});}}));
 assert.equal(reads,0);assert.ok(app.host.querySelector('[inert][aria-hidden="true"]'));
 await app.env.act(async()=>{callback([{isIntersecting:true}]);await tick();});assert.equal(reads,1);
 await app.env.act(async()=>{callback([{isIntersecting:false}]);await tick();});assert.equal(aborted,true);assert.equal(app.host.querySelector('.za-resource-preview'),null);
});
test("large cover previews retain a format card without loading or parsing the original",async t=>{
 const app=await setup(t),{ResourcePreview}=app.env.loadModule("../../agent-ui/src/components/resource-preview/ResourcePreview.tsx");let reads=0;
 await app.render(app.env.React.createElement(ResourcePreview,{variant:"thumbnail",resource:{identity:"a:large",name:"大文件.docx",mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",size:5*1024*1024,sha256:"0".repeat(64)},load:async()=>{reads++;throw Error("must not read");}}));
 assert.equal(reads,0);assert.match(app.host.textContent,/DOCX/);assert.equal(app.host.querySelector("iframe"),null);
});

test("original deletion is an explicit dialog decision; cancellation preserves the file",async t=>{
 const app=await setup(t),{ResourceDeleteDialog}=app.env.loadModule("../../agent-ui/src/components/resource-preview/ResourceReaderDetails.tsx");let removed=0,cancelled=0;
 await app.render(app.env.React.createElement(ResourceDeleteDialog,{open:true,busy:false,name:"计划.docx",description:"已有引用将失效",confirmLabel:"确认删除",onConfirm:()=>removed++,onCancel:()=>cancelled++}));
 assert.ok(document.querySelector('[role="alertdialog"]'));assert.equal(removed,0);
 await app.env.act(async()=>[...document.querySelectorAll('button')].find(node=>node.textContent==="保留文件").click());assert.equal(cancelled,1);assert.equal(removed,0);
 await app.env.act(async()=>[...document.querySelectorAll('button')].find(node=>node.textContent==="确认删除").click());assert.equal(removed,1);
});
