import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";

const streamdown = await import(new URL("../../../agent-ui/node_modules/streamdown/dist/index.js", import.meta.url));
async function flush() { for (let i=0;i<5;i++) await new Promise(resolve=>setImmediate(resolve)); }
async function setup(t, mocks={}) {
  const env=await createWebDomTestEnv({resolveDynamicImports:true,mocks:{streamdown,"../IconSet":{ChevronRight:()=>null},...mocks}});
  const extra=new Map(["DOMParser","XMLSerializer"].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for(const name of extra.keys()) globalThis[name]=env.dom.window[name];
  const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
  t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();for(const [name,value] of extra){if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];}});
  return {env,host,async render(node){await env.act(async()=>{root.render(node);await flush();});},async wait(predicate){
    const deadline=Date.now()+3000;
    while(!predicate()&&Date.now()<deadline)await env.act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
    assert.ok(predicate(),host.textContent);
  },async input(label,value){const el=host.querySelector(`input[aria-label="${label}"]`);assert.ok(el,label);await env.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));});return el;},async key(el,key){await env.act(async()=>{el.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));await flush();});}};
}

test("reading geometry distinguishes true percent, width and whole-page fit and retains pixel budgets",async t=>{
  const app=await setup(t);
  const {previewScale,boundedPreviewScale,parseSheetCoordinate}=app.env.loadModule("@liveagent/ui/components/resource-preview/previewGeometry.ts");
  const content={width:1600,height:900},pane={width:640,height:300};
  assert.equal(previewScale(200,content,pane),2);
  assert.equal(previewScale("fit-width",content,pane),608/1600);
  assert.equal(previewScale("fit-page",content,pane),268/900);
  const scale=boundedPreviewScale(3,{width:5000,height:5000});
  assert.ok(5000*scale<=4096);assert.ok((5000*scale)**2<=12_000_000+0.001);
  assert.deepEqual(parseSheetCoordinate(" cb500 ",500,80),{row:499,column:79,name:"CB500"});
  for(const value of ["A0","CC1","A501","=A1","A1:B2","<img>"])assert.equal(parseSheetCoordinate(value,500,80),null);
});

test("snapshot store is limited to twenty recent resources and rejects unbounded values",async t=>{
  const app=await setup(t),{createReadingSnapshotStore}=app.env.loadModule("@liveagent/ui/components/resource-preview/readingSession.tsx");
  const store=createReadingSnapshotStore();for(let i=0;i<20;i++)store.write(String(i),"pdfPage",i+1);
  store.read("0");store.write("20","pdfPage",21);
  assert.equal(store.read("1"),undefined);assert.equal(store.read("0").pdfPage,1);
  store.write("bad","sheetName","x".repeat(129));assert.equal(store.read("bad"),undefined);
});

test("page entry validates Enter, restores an unfinished edit on blur and keeps Escape local",async t=>{
  const app=await setup(t),{PreviewPageControls}=app.env.loadModule("@liveagent/ui/components/resource-preview/PreviewToolbar.tsx"),pages=[];
  await app.render(app.env.React.createElement(PreviewPageControls,{page:2,count:12,busy:true,onPage:value=>pages.push(value)}));
  assert.equal(app.host.querySelector('button[aria-label="下一页"]').disabled,false);
  await app.key(await app.input("页码","9"),"Enter");assert.deepEqual(pages,[9]);
  await app.key(await app.input("页码","999"),"Enter");assert.equal(app.host.querySelector("input").value,"2");
  const input=await app.input("页码","4");await app.key(input,"Escape");assert.equal(input.value,"2");
  await app.input("页码","7");await app.env.act(async()=>{input.focus();input.blur();});assert.equal(input.value,"2");
});

test("PDF page rendering ignores an older page resolution after a newer jump and uses actual percent",async t=>{
  const pending=new Map(),renders=[],cancelled=[];
  const pdfPage=number=>({getViewport:({scale})=>({width:600*scale,height:800*scale}),render:({viewport})=>{renders.push({number,width:viewport.width});return {promise:Promise.resolve(),cancel(){cancelled.push(number);}};}});
  const document={numPages:3,getPage:number=>number===1?Promise.resolve(pdfPage(1)):new Promise(resolve=>pending.set(number,()=>resolve(pdfPage(number))))};
  const app=await setup(t,{"pdfjs-dist":{GlobalWorkerOptions:{},version:"test",getDocument:()=>({promise:Promise.resolve(document),destroy:async()=>{}})},"pdfjs-dist/build/pdf.worker.min.mjs?url":"worker","./pdfPreviewAssets":{pdfPreviewAssetsURL:()=>"http://localhost/resource-preview/pdf/test/"}});
  Object.defineProperty(window.HTMLElement.prototype,"clientWidth",{configurable:true,get(){return this.classList.contains("za-preview-pdf")?640:0;}});
  Object.defineProperty(window.HTMLElement.prototype,"clientHeight",{configurable:true,get(){return this.classList.contains("za-preview-pdf")?300:0;}});
  const Reader=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourcePDFPreview.tsx").default;
  await app.render(app.env.React.createElement(Reader,{bytes:new Uint8Array([1]),assertCurrent(){}}));await app.wait(()=>renders.length===1);
  const zoom=app.host.querySelector("select");await app.env.act(async()=>{zoom.value="200";zoom.dispatchEvent(new Event("change",{bubbles:true}));await flush();});
  assert.equal(renders.at(-1).width,1600);
  await app.key(await app.input("页码","1"),"Enter");assert.equal(app.host.querySelector(".za-preview-pdf").getAttribute("aria-busy"),"false");
  await app.key(await app.input("页码","3"),"Enter");await app.key(await app.input("页码","2"),"Enter");
  await app.env.act(async()=>{pending.get(2)();await flush();});assert.equal(app.host.querySelector("canvas").getAttribute("aria-label"),"PDF 第 2 页");
  await app.env.act(async()=>{pending.get(3)();await flush();});assert.equal(renders.at(-1).number,2);assert.ok(!renders.some(item=>item.number===3));assert.ok(cancelled.includes(1));
});

test("PDF keeps its canvas across a failed page so another page can recover without reopening",async t=>{
  const page={getViewport:({scale})=>({width:600*scale,height:800*scale}),render:()=>({promise:Promise.resolve(),cancel(){}})};
  const document={numPages:3,getPage:number=>number===2?Promise.reject(new Error("bad page")):Promise.resolve(page)};
  const app=await setup(t,{"pdfjs-dist":{GlobalWorkerOptions:{},version:"test",getDocument:()=>({promise:Promise.resolve(document),destroy:async()=>{}})},"pdfjs-dist/build/pdf.worker.min.mjs?url":"worker","./pdfPreviewAssets":{pdfPreviewAssetsURL:()=>"http://localhost/resource-preview/pdf/test/"}});
  const Reader=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourcePDFPreview.tsx").default;
  await app.render(app.env.React.createElement(Reader,{bytes:new Uint8Array([1]),assertCurrent(){}}));await app.wait(()=>app.host.querySelector(".za-preview-pdf").getAttribute("aria-busy")==="false");
  const canvas=app.host.querySelector("canvas");await app.key(await app.input("页码","2"),"Enter");await app.wait(()=>/此页未能渲染/.test(app.host.textContent));
  await app.key(await app.input("页码","3"),"Enter");await app.wait(()=>app.host.querySelector(".za-preview-pdf").getAttribute("aria-busy")==="false");
  assert.equal(app.host.querySelector("canvas"),canvas);assert.equal(canvas.style.display,"");assert.doesNotMatch(app.host.textContent,/此页未能渲染/);
});

test("PPT rapid page jumps preserve only the newest result while navigation stays usable",async t=>{
  const pending=new Map(),svg=number=>`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><text>第${number}页</text></svg>`;
  const app=await setup(t,{"./previewWorkerClient":{createResourcePreviewWorker:()=>({dispose(){},request:input=>input.type==="load"?Promise.resolve({slideCount:3,svg:svg(1)}):new Promise(resolve=>pending.set(input.index+1,()=>resolve({slideCount:3,svg:svg(input.index+1)})))})}});
  const Reader=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourceSlidesPreview.tsx").default;
  await app.render(app.env.React.createElement(Reader,{bytes:new Uint8Array([1]),name:"演示.pptx",assertCurrent(){}}));await app.wait(()=>!!app.host.querySelector("img"));
  const canvas=app.host.querySelector(".za-preview-slide-scroll");canvas.focus();
  await app.key(canvas,"End");assert.equal(app.host.querySelector(".za-preview-slide-scroll"),canvas);assert.equal(document.activeElement,canvas);
  await app.key(canvas,"ArrowLeft");assert.equal(document.activeElement,canvas);
  await app.env.act(async()=>{pending.get(2)();await flush();});await app.wait(()=>!!app.host.querySelector("img"));
  await app.env.act(async()=>{pending.get(3)();await flush();});assert.match(app.host.querySelector("img").alt,/第 2 页/);
  const zoom=app.host.querySelector('select[aria-label="幻灯片缩放"]');await app.env.act(async()=>{zoom.value="300";zoom.dispatchEvent(new Event("change",{bubbles:true}));});
  assert.equal(parseFloat(app.host.querySelector("img").style.width),4096);assert.equal(zoom.selectedOptions[0].textContent,"256%（上限）");
});

test("read-only sheet snapshots restore a reopened immutable resource and retire on descriptor or account changes",async t=>{
  const requests=[],bytes=Buffer.from("synthetic sheet"),resource={identity:"file:1",name:"预算.xlsx",mime:"application/octet-stream",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
  const app=await setup(t,{"./previewWorkerClient":{createResourcePreviewWorker:()=>({dispose(){},async request(input){requests.push(input);return {sheetNames:["预算","实际"],rows:[["项目","数值"],["服务器","120"]]};}})}});
  const {ResourcePreview,ResourcePreviewReadingSession}=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourcePreview.tsx");
  const load=async()=>({blob:new Blob([bytes]),assertCurrent(){}});
  const render=async(scope="account-a",shown=true,descriptor=resource)=>{await app.render(app.env.React.createElement(ResourcePreviewReadingSession,{scope},shown?app.env.React.createElement(ResourcePreview,{resource:descriptor,load}):null));if(shown)await app.wait(()=>!!app.host.querySelector("table"));};
  await render();await app.env.act(async()=>{[...app.host.querySelectorAll(".za-preview-sheets button")].find(item=>item.textContent==="实际").click();await flush();});
  await app.wait(()=>!!app.host.querySelector("table"));await app.input("定位单元格","B2");
  await app.env.act(async()=>{app.host.querySelector('.za-preview-coordinate button[type="submit"]').click();await flush();});
  assert.equal(app.host.querySelector('[data-cell="B2"]').getAttribute("aria-selected"),"true");
  const zoom=app.host.querySelector('select[aria-label="表格缩放"]');await app.env.act(async()=>{zoom.value="1.5";zoom.dispatchEvent(new Event("change",{bubbles:true}));[...app.host.querySelectorAll("button")].find(item=>item.textContent==="换行").click();});
  assert.equal(app.host.querySelector("table").getAttribute("aria-readonly"),"true");assert.equal(app.host.querySelector("[contenteditable]"),null);
  await render("account-a",false);await render();
  assert.equal(app.host.querySelector('.za-preview-sheets [aria-pressed="true"]').textContent,"实际");assert.equal(app.host.querySelector('input[aria-label="定位单元格"]').value,"B2");assert.equal(app.host.querySelector("table").style.zoom,"1.5");assert.equal(app.host.querySelector("table").dataset.wrap,"false");
  assert.ok(requests.some(item=>item.type==="sheet"&&item.name==="实际"));
  await render("account-a",true,{...resource,name:"另一名称.xlsx"});assert.equal(app.host.querySelector('input[aria-label="定位单元格"]').value,"A1");
  await render("account-b");assert.equal(app.host.querySelector('select[aria-label="表格缩放"]').value,"1");
  await render("account-a");assert.equal(app.host.querySelector('.za-preview-sheets [aria-pressed="true"]').textContent,"预算");
});
