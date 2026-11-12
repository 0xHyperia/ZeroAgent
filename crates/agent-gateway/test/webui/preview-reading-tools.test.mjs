import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";

const streamdown = await import(new URL("../../../agent-ui/node_modules/streamdown/dist/index.js", import.meta.url));
async function flush() { for (let i=0;i<5;i++) await new Promise(resolve=>setImmediate(resolve)); }

test("document navigation keeps the hover path open, follows the active anchor and leaves pinned navigation open",async t=>{
 const app=await setup(t),h=app.env.React.createElement;
 const {DocumentNavigation}=app.env.loadModule("@liveagent/ui/components/resource-preview/DocumentNavigation.tsx");
 const scrolled=[];window.HTMLElement.prototype.scrollIntoView=function(){scrolled.push(this.textContent)};
 function View({current=1}){const [pinned,setPinned]=app.env.React.useState(false);return h(DocumentNavigation,{label:'文档导航',pinned,onPinned:setPinned,count:3,current,title:'目录'},[1,2,3].map(n=>h('button',{key:n,'aria-current':n===current?'page':undefined},`第${n}页`)));}
 await app.render(h(View,{}));
 const zone=app.host.querySelector('.za-document-navigation-zone'),rail=zone.querySelector('button');
 const mouse=(target,type,relatedTarget)=>{const event=new window.MouseEvent(type,{bubbles:true,relatedTarget});Object.defineProperty(event,'pointerType',{value:'mouse'});target.dispatchEvent(event);};
 await app.env.act(async()=>mouse(rail,'pointerover',document.body));
 const panel=app.host.querySelector('aside');assert.ok(panel);assert.equal(zone.dataset.pinned,'false');
 await app.env.act(async()=>mouse(rail,'pointerout',panel.querySelector('button')));
 assert.equal(app.host.querySelector('aside'),panel,'moving into the panel keeps the same preview mounted');
 await app.env.act(async()=>mouse(zone,'pointerout',document.body));assert.equal(app.host.querySelector('aside'),null);
 await app.env.act(async()=>rail.focus());
 assert.equal(document.activeElement,rail);
 assert.equal(app.host.querySelector('aside'),null);
 await app.env.act(async()=>rail.click());
 assert.equal(document.activeElement.textContent,'第1页');
 await app.render(h(View,{current:3}));assert.equal(scrolled.at(-1),'第3页');
 await app.env.act(async()=>zone.dispatchEvent(new window.MouseEvent('pointerout',{bubbles:true,relatedTarget:document.body})));
 assert.ok(app.host.querySelector('aside'));assert.equal(zone.dataset.pinned,'true');
 await app.key(document.activeElement,'Escape');
 assert.equal(app.host.querySelector('aside'),null);
 assert.equal(document.activeElement,rail);
 await app.env.act(async()=>rail.click());
 assert.equal(document.activeElement.textContent,'第3页');
 await app.env.act(async()=>app.host.querySelector('[aria-label="收起文档导航"]').click());assert.equal(app.host.querySelector('aside'),null);
 assert.equal(document.activeElement,rail);
});

test("unsent region comments retain their anchors when cancelling discard and clear only after explicit discard",async t=>{
 const app=await setup(t),h=app.env.React.createElement;let choose;
 const {ResourceDocumentComments}=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourceDocumentComments.tsx");
 function Reader(){const [selection,setSelection]=app.env.React.useState(null),[enabled,setEnabled]=app.env.React.useState(true);choose=setSelection;return h(ResourceDocumentComments,{enabled,onEnabled:setEnabled,selection,onSelection:setSelection,onNavigate(){},onMarks(){}});}
 await app.render(h(Reader));
 const region={left:.1,top:.2,width:.5,height:.2},anchors=[{id:'a',start:0,end:2},{id:'b',start:0,end:2}];
 await app.env.act(async()=>choose({id:'a',start:0,end:2,page:1,quote:'标题\n摘要',x:10,y:90,region,anchors}));
 await app.input('修改建议','精简选中区域');await app.env.act(async()=>app.host.querySelector('[aria-label="添加批注"]').click());
 const clickText=async text=>app.env.act(async()=>{[...document.querySelectorAll('button')].find(e=>e.textContent===text).click();await flush();});
 await clickText('取消');assert.match(document.querySelector('[role="alertdialog"]').textContent,/要舍弃批注吗/);
 await clickText('保留批注');assert.match(app.host.textContent,/这 1 条批注/);
 await app.env.act(async()=>app.host.querySelector('[aria-label="查看 1 条批注"]').click());
 await app.env.act(async()=>document.querySelector('[aria-label="编辑第 1 条批注"]').click());
 assert.equal(app.host.querySelector('[aria-label="修改建议"]').value,'精简选中区域');
 await clickText('取消');await clickText('放弃');assert.equal(app.host.querySelector('fieldset'),null);
});

test("floating comment position clamps to the reader when the pane narrows or a drag leaves its boundaries",async t=>{
 const app=await setup(t),{constrainReaderPosition}=app.env.loadModule("@liveagent/ui/components/resource-preview/useReaderFloatingPosition.ts");
 assert.deepEqual(constrainReaderPosition({x:-400,y:-20},{width:440,height:800},{width:300,height:44}),{x:8,y:64});
 assert.deepEqual(constrainReaderPosition({x:1000,y:1000},{width:440,height:800},{width:300,height:44}),{x:132,y:748});
 assert.deepEqual(constrainReaderPosition({x:100,y:150},{width:440,height:800},{width:300,height:44}),{x:100,y:150});
});
async function setup(t, mocks={}) {
  const env=await createWebDomTestEnv({resolveDynamicImports:true,mocks:{streamdown,"../IconSet":new Proxy({},{get:()=>()=>null}),...mocks}});
  const extra=new Map(["DOMParser","XMLSerializer"].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  for(const name of extra.keys()) globalThis[name]=env.dom.window[name];
  const host=document.body.appendChild(document.createElement("div")),root=env.createRoot(host);
  t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();for(const [name,value] of extra){if(value)Object.defineProperty(globalThis,name,value);else delete globalThis[name];}});
  return {env,host,async render(node){await env.act(async()=>{root.render(node);await flush();});},async wait(predicate){
    const deadline=Date.now()+3000;
    while(!predicate()&&Date.now()<deadline)await env.act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
    assert.ok(predicate(),host.textContent);
  },async zoom(label,percent){await env.act(async()=>{host.querySelector(`button[aria-label="${label}"]`).click();await flush();});const item=[...document.querySelectorAll('[role="menuitemradio"]')].find(el=>el.textContent===`${percent}%`);assert.ok(item,document.body.textContent);await env.act(async()=>{item.click();await flush();});},async input(label,value){const el=host.querySelector(`input[aria-label="${label}"]`);assert.ok(el,label);await env.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));});return el;},async key(el,key){await env.act(async()=>{el.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));await flush();});}};
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
  const markdownPosition = { block: 70, progress: 0.32, top: 15609 };
  store.write("0", "markdownPosition", markdownPosition);
  store.write("0", "markdownPosition", { ...markdownPosition, progress: 2 });
  assert.deepEqual(store.read("0").markdownPosition, markdownPosition);
});

test("PDF comment anchors survive glyph span splits and reject changed originals or invalid offsets",async t=>{
  const app=await setup(t),{pdfTextRange}=app.env.loadModule("@liveagent/ui/components/resource-preview/pdfTextRange.ts");
  const layer=document.createElement('div');layer.innerHTML='<span>Cloud</span><span>Chat 文档</span><br><span>第二行</span>';
  assert.equal(pdfTextRange(layer,3,10,'udChat ').toString(),'udChat ');
  assert.equal(pdfTextRange(layer,10,14,'文档第二').toString(),'文档第二');
  for(const [start,end,quote] of [[0,5,'changed'],[-1,4,'Cloud'],[0,999,'Cloud'],[4,3,''],[0,2001,'x']])assert.equal(pdfTextRange(layer,start,end,quote),null);
  layer.innerHTML='<span>Cl</span><span>oudChat 文档</span><span>第二行</span>';
  assert.equal(pdfTextRange(layer,3,10,'udChat ').toString(),'udChat ');
});

test("reading snapshots retain typed revision targets and zero-area document points", async (t) => {
  const app = await setup(t);
  const { createReadingSnapshotStore } = app.env.loadModule("@liveagent/ui/components/resource-preview/readingSession.tsx");
  const store = createReadingSnapshotStore();
  const base = { id: "comment", page: 1, block: "file-target", start: 0, end: 0, quote: "", comment: "Revise here" };
  const point = { left: 0.25, top: 0.5, width: 0, height: 0 };
  const dimensions = { pageCount: 2, pageWidth: 816, pageHeight: 1056 };
  const cases = [
    { ...base, target: { kind: "sheet", sheet: "Sales", range: "A1:C5", anchor: "A1" } },
    { ...base, region: point, target: { kind: "slide", slide: 1, slideId: "ppt/slides/slide1.xml", point: { x: 0.25, y: 0.5 }, element: { id: "8", name: "Title", kind: "shape", rotation: 10 } } },
    { ...base, region: point, pdf: { ...dimensions, kind: "point" } },
    { ...base, region: { ...point, height: 0.05 }, pdf: { ...dimensions, kind: "region" } },
    { ...base, document: dimensions },
  ];
  for (const [index, item] of cases.entries()) {
    store.write(String(index), "documentComments", [item]);
    assert.deepEqual(store.read(String(index))?.documentComments, [item]);
  }
  store.write("invalid", "documentComments", [{ ...base, region: { ...point, left: 1.2 }, pdf: { ...dimensions, kind: "point" } }]);
  assert.equal(store.read("invalid"), undefined);
  store.write("invalid", "documentComments", [{ ...base, target: { kind: "sheet", sheet: "Sales", range: "=SUM(A1)" } }]);
  assert.equal(store.read("invalid"), undefined);
});

test("comment list locates and edits individual anchors, deletes one, and retains the rest after a rejected send",async t=>{
 const app=await setup(t),h=app.env.React.createElement;
 const {ResourceDocumentComments}=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourceDocumentComments.tsx"),{PreviewIdentityContext}=app.env.loadModule("@liveagent/ui/components/resource-preview/PreviewChrome.tsx");
 const submitted=[],visited=[];let choose;
 function Reader(){const [selection,setSelection]=app.env.React.useState(null),[enabled,setEnabled]=app.env.React.useState(true);choose=setSelection;return h(PreviewIdentityContext.Provider,{value:{name:'draft.pdf',mime:'application/pdf',onRequestRevision:async comments=>{submitted.push(comments);return false}}},h(ResourceDocumentComments,{enabled,onEnabled:setEnabled,selection,onSelection:setSelection,onNavigate:id=>visited.push(id),onMarks(){}}));}
 const click=async label=>app.env.act(async()=>{const button=document.querySelector(`[aria-label="${label}"]`);assert.ok(button,label);button.click();await flush();});
 await app.render(h(Reader));
 for(let i=1;i<=2;i++){await app.env.act(async()=>choose({id:`pdf-page-${i}`,page:i,start:0,end:3,quote:`原文${i}`,x:20,y:100}));await app.input('修改建议',`建议${i}`);await click('添加批注');}
 assert.equal(submitted.length,0);await click('查看 2 条批注');
 assert.match(document.querySelector('[aria-label="批注列表"]').textContent,/原文1.*建议1.*原文2.*建议2/);
 await click('定位第 1 条批注，第 1 页');assert.equal(visited.at(-1),'pdf-page-1');
 await click('查看 2 条批注');await click('编辑第 2 条批注');assert.equal(app.host.querySelector('[aria-label="修改建议"]').value,'建议2');
 await app.input('修改建议','保留第二条的新要求');await click('添加批注');
 await click('查看 2 条批注');await click('移除第 1 条批注');
 assert.match(document.querySelector('[aria-label="批注列表"]').textContent,/保留第二条的新要求/);
 assert.doesNotMatch(document.querySelector('[aria-label="批注列表"]').textContent,/原文1/);
 await app.key(document.querySelector('[aria-label="批注列表"]'),'Escape');
 await app.env.act(async()=>{[...app.host.querySelectorAll('button')].find(button=>button.textContent.includes('发送')).click();await flush();});
 assert.equal(submitted.length,1);assert.equal(submitted[0].length,1);assert.equal(submitted[0][0].block,'pdf-page-2');assert.equal(submitted[0][0].comment,'保留第二条的新要求');
 assert.match(app.host.textContent,/这 1 条批注/);assert.match(app.host.querySelector('[role="alert"]').textContent,/批注已保留/);
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

test("workspace PDF uses a compact pager and changes only the visible paper", async (t) => {
  const paper = {
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
  };
  const pdf = { numPages: 4, getPage: async () => paper };
  const app = await setup(t, {
    "pdfjs-dist": {
      GlobalWorkerOptions: {},
      version: "test",
      getDocument: () => ({ promise: Promise.resolve(pdf), destroy: async () => {} }),
    },
    "pdfjs-dist/build/pdf.worker.min.mjs?url": "worker",
    "./pdfPreviewAssets": { pdfPreviewAssetsURL: () => "http://localhost/resource-preview/pdf/test/" },
  });
  const { PreviewToolbarMount } = app.env.loadModule("@liveagent/ui/components/resource-preview/PreviewChrome.tsx");
  const Reader = app.env.loadModule("@liveagent/ui/components/resource-preview/ResourcePDFPreview.tsx").default;
  const h = app.env.React.createElement;
  await app.render(h(
    PreviewToolbarMount.Provider,
    { value: { workspaceTab: true, target: app.host } },
    h(Reader, { bytes: new Uint8Array([1]), assertCurrent() {} }),
  ));
  const paperSelector = ".za-preview-pdf .za-preview-pdf-page";
  await app.wait(() => app.host.querySelector(paperSelector));
  const pager = app.host.querySelector(".za-pdf-floating-pages nav[data-compact]");
  assert.ok(pager);
  assert.equal(pager.querySelector("input").value, "1");
  assert.equal(pager.querySelector("input").style.width, "1ch");
  await app.env.act(async () => pager.querySelector('[aria-label="下一页"]').click());
  assert.equal(pager.querySelector("input").value, "2");
  await app.key(await app.input("页码", "4"), "Enter");
  assert.equal(pager.querySelector('[aria-label="下一页"]').disabled, true);
  assert.equal(app.host.querySelectorAll(paperSelector).length, 1);
  assert.equal(app.host.querySelector(paperSelector).getAttribute("aria-label"), "第 4 页");
});

test("PDF page rendering ignores an older page resolution after a newer jump and uses actual percent",async t=>{
  const pending=new Map(),renders=[],cancelled=[];
  let firstPaint;
  const pdfPage=number=>({getViewport:({scale})=>({width:600*scale,height:800*scale}),render:({viewport})=>{renders.push({number,width:viewport.width});return {promise:number===1&&!firstPaint?new Promise(resolve=>{firstPaint=resolve;}):Promise.resolve(),cancel(){cancelled.push(number);}};}});
  const document={numPages:3,getPage:number=>number===1?Promise.resolve(pdfPage(1)):new Promise(resolve=>pending.set(number,()=>resolve(pdfPage(number))))};
  const app=await setup(t,{"pdfjs-dist":{GlobalWorkerOptions:{},version:"test",getDocument:()=>({promise:Promise.resolve(document),destroy:async()=>{}})},"pdfjs-dist/build/pdf.worker.min.mjs?url":"worker","./pdfPreviewAssets":{pdfPreviewAssetsURL:()=>"http://localhost/resource-preview/pdf/test/"}});
  Object.defineProperty(window.HTMLElement.prototype,"clientWidth",{configurable:true,get(){return this.classList.contains("za-preview-pdf")?640:0;}});
  Object.defineProperty(window.HTMLElement.prototype,"clientHeight",{configurable:true,get(){return this.classList.contains("za-preview-pdf")?300:0;}});
  const Reader=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourcePDFPreview.tsx").default;
  await app.render(app.env.React.createElement(Reader,{bytes:new Uint8Array([1]),assertCurrent(){}}));await app.wait(()=>renders.length===1);
  assert.equal(app.host.querySelector(".za-preview-pdf").dataset.ready,"false");
  assert.equal(app.host.querySelectorAll(".za-preview-loading").length,1,"one canvas loader remains until first pixels, rather than loaders on empty sheets");
  await app.env.act(async()=>{firstPaint();await flush();});
  assert.equal(app.host.querySelector(".za-preview-pdf").dataset.ready,"true");
  assert.equal(app.host.querySelector(".za-preview-frame-pending"),null);
  await app.zoom("PDF 缩放",200);
  assert.equal(app.host.querySelector('[aria-label="PDF 第 1 页"]').style.visibility,"visible");
  await app.wait(()=>renders.at(-1).width===1600);
  await app.key(await app.input("页码","1"),"Enter");assert.equal(app.host.querySelector(".za-preview-pdf").getAttribute("aria-busy"),"false");
  await app.key(await app.input("页码","3"),"Enter");await app.key(await app.input("页码","2"),"Enter");
  await app.env.act(async()=>{pending.get(2)();await flush();});assert.equal(app.host.querySelector('[aria-label="PDF 第 2 页"]').style.visibility,"visible");
  await app.env.act(async()=>{pending.get(3)();await flush();});assert.equal(renders.at(-1).number,2);assert.ok(!renders.some(item=>item.number===3));assert.ok(cancelled.includes(1));
});

test("PDF document failure leaves the loading canvas and exposes recovery instead of a hidden error",async t=>{
  const app=await setup(t,{"pdfjs-dist":{GlobalWorkerOptions:{},version:"test",getDocument:()=>({promise:Promise.reject(new Error("broken document")),destroy:async()=>{}})},"pdfjs-dist/build/pdf.worker.min.mjs?url":"worker","./pdfPreviewAssets":{pdfPreviewAssetsURL:()=>"http://localhost/resource-preview/pdf/test/"}});
  const Reader=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourcePDFPreview.tsx").default;
  await app.render(app.env.React.createElement(Reader,{bytes:new Uint8Array([1]),assertCurrent(){},onRetry(){},onDownload(){}}));
  await app.wait(()=>app.host.querySelector(".za-preview-unavailable"));
  assert.equal(app.host.querySelector(".za-preview-pdf").dataset.ready,"true");
  assert.equal(app.host.querySelector(".za-preview-loading"),null);
  assert.match(app.host.textContent,/重试预览/);
});

test("PDF continuous pages isolate a failed page so another page can recover without reopening",async t=>{
  const page={getViewport:({scale})=>({width:600*scale,height:800*scale}),render:()=>({promise:Promise.resolve(),cancel(){}})};
  const document={numPages:3,getPage:number=>number===2?Promise.reject(new Error("bad page")):Promise.resolve(page)};
  const app=await setup(t,{"pdfjs-dist":{GlobalWorkerOptions:{},version:"test",getDocument:()=>({promise:Promise.resolve(document),destroy:async()=>{}})},"pdfjs-dist/build/pdf.worker.min.mjs?url":"worker","./pdfPreviewAssets":{pdfPreviewAssetsURL:()=>"http://localhost/resource-preview/pdf/test/"}});
  const Reader=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourcePDFPreview.tsx").default;
  await app.render(app.env.React.createElement(Reader,{bytes:new Uint8Array([1]),assertCurrent(){}}));await app.wait(()=>app.host.querySelector(".za-preview-pdf").getAttribute("aria-busy")==="false");
  const canvas=app.host.querySelector("canvas");await app.key(await app.input("页码","2"),"Enter");await app.wait(()=>/此页未能渲染/.test(app.host.textContent));
  await app.key(await app.input("页码","3"),"Enter");await app.wait(()=>app.host.querySelector('[aria-label="PDF 第 3 页"]').style.visibility==="visible");
  assert.equal(app.host.querySelector("canvas"),canvas);
  assert.equal(app.host.querySelectorAll("[data-pdf-page]").length,3);
  assert.equal(app.host.querySelector('[data-pdf-page="3"] .za-preview-unavailable'),null);
});

test("continuous PDF pages decode only nearby sheets, release offscreen pixels and disconnect on close",async t=>{
  const requests=[], observers=[];
  const page={getViewport:({scale})=>({width:600*scale,height:800*scale}),render:()=>({promise:Promise.resolve(),cancel(){}})};
  const doc={numPages:100,getPage:async number=>{requests.push(number);return page;}};
  const app=await setup(t,{"pdfjs-dist":{GlobalWorkerOptions:{},version:"test",getDocument:()=>({promise:Promise.resolve(doc),destroy:async()=>{}})},"pdfjs-dist/build/pdf.worker.min.mjs?url":"worker","./pdfPreviewAssets":{pdfPreviewAssetsURL:()=>"http://localhost/resource-preview/pdf/test/"}});
  const original=globalThis.IntersectionObserver;
  globalThis.IntersectionObserver=class {
    constructor(callback,options){this.callback=callback;this.options=options;observers.push(this);}
    observe(element){this.element=element;}
    disconnect(){this.closed=true;}
  };
  t.after(()=>{globalThis.IntersectionObserver=original;});
  const Reader=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourcePDFPreview.tsx").default;
  await app.render(app.env.React.createElement(Reader,{bytes:new Uint8Array([1]),assertCurrent(){}}));
  await app.wait(()=>app.host.querySelector('[aria-label="PDF 第 1 页"]').style.visibility==="visible");
  assert.deepEqual(requests,[1]);assert.equal(app.host.querySelectorAll('[data-pdf-page]').length,100);
  assert.equal(app.host.querySelector('[aria-label="PDF 第 80 页"]').width,0);
  const near=observers.find(item=>item.options.rootMargin&&item.element.dataset.pdfPage==="2");
  await app.env.act(async()=>{near.callback([{isIntersecting:true}]);await flush();});
  assert.deepEqual(requests,[1,2]);assert.ok(app.host.querySelector('[aria-label="PDF 第 2 页"]').width>0);
  await app.env.act(async()=>{near.callback([{isIntersecting:false}]);await flush();});
  assert.equal(app.host.querySelector('[aria-label="PDF 第 2 页"]').width,0);
  await app.render(null);assert.ok(observers.every(item=>item.closed));
});

test("PPT rapid page jumps preserve only the newest result while navigation stays usable",async t=>{
  const pending=new Map(),svg=number=>`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><text>第${number}页</text></svg>`;
  const app=await setup(t,{"./previewWorkerClient":{createResourcePreviewWorker:()=>({dispose(){},request:input=>input.type==="load"?Promise.resolve({slideCount:3,svg:svg(1)}):new Promise(resolve=>pending.set(input.index+1,()=>resolve({slideCount:3,svg:svg(input.index+1)})))})}});
  const Reader=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourceSlidesPreview.tsx").default;
  await app.render(app.env.React.createElement(Reader,{bytes:new Uint8Array([1]),name:"演示.pptx",assertCurrent(){}}));await app.wait(()=>!!app.host.querySelector("img"));
  const canvas=app.host.querySelector(".za-preview-slide-scroll");canvas.focus();
  const firstImage=canvas.querySelector("img");
  const firstURL=firstImage.src;
  await app.key(canvas,"End");assert.equal(app.host.querySelector(".za-preview-slide-scroll"),canvas);assert.equal(document.activeElement,canvas);
  assert.equal(canvas.querySelector("img"),firstImage);
  assert.equal(firstImage.src,firstURL);
  assert.equal(canvas.querySelector(".za-preview-loading"),null);
  await app.key(canvas,"ArrowUp");assert.equal(document.activeElement,canvas);
  await app.env.act(async()=>{pending.get(2)();await flush();});await app.wait(()=>!!app.host.querySelector("img"));
  await app.env.act(async()=>{pending.get(3)();await flush();});assert.match(app.host.querySelector("img").alt,/第 2 页/);
  await app.key(canvas,"ArrowLeft");assert.equal(canvas.querySelector("img").src,firstURL);
  await app.zoom("幻灯片缩放",200);
  assert.equal(parseFloat(app.host.querySelector("img").style.width),3200);assert.equal(app.host.querySelector('button[aria-label="幻灯片缩放"]').textContent,"200%");
});

test("read-only sheet snapshots restore a reopened immutable resource and retire on descriptor or account changes",async t=>{
  const requests=[],bytes=Buffer.from("synthetic sheet"),resource={identity:"file:1",name:"预算.xlsx",mime:"application/octet-stream",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
  const app=await setup(t,{"@extend-ai/react-xlsx":{setWasmSource(){}},"@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url":{default:"/test.wasm"},"./previewWorkerClient":{createResourcePreviewWorker:()=>({dispose(){},async request(input){requests.push(input);if(input.kind==="sheet-source")return {sheetFallback:true};return {sheetNames:["预算","实际"],sheet:{name:input.name??"预算",widths:[100,160],heights:[24,24],cells:[{row:0,column:0,text:"项目",style:0},{row:1,column:1,text:"120",style:0}],styles:[{}],merges:[],truncated:false}};}})}});
  const {ResourcePreview,ResourcePreviewReadingSession}=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourcePreview.tsx");
  const load=async()=>({blob:new Blob([bytes]),assertCurrent(){}});
  const render=async(scope="account-a",shown=true,descriptor=resource)=>{await app.render(app.env.React.createElement(ResourcePreviewReadingSession,{scope},shown?app.env.React.createElement(ResourcePreview,{resource:descriptor,load}):null));if(shown)await app.wait(()=>!!app.host.querySelector("table"));};
  await render();await app.env.act(async()=>{[...app.host.querySelectorAll(".za-preview-sheets button")].find(item=>item.textContent==="实际").click();await flush();});
  await app.wait(()=>!!app.host.querySelector("table"));await app.input("定位单元格","B2");
  await app.env.act(async()=>{app.host.querySelector('.za-sheet-formula-bar form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await flush();});
  assert.equal(app.host.querySelector('[data-cell="B2"]').getAttribute("aria-selected"),"true");
  await app.zoom("表格缩放",200);
  assert.equal(app.host.querySelector('[role="grid"]').getAttribute("aria-readonly"),"true");assert.equal(app.host.querySelector("[contenteditable]"),null);
  await render("account-a",false);await render();
  assert.equal(app.host.querySelector('.za-preview-sheets [aria-pressed="true"]').textContent,"实际");assert.equal(app.host.querySelector('input[aria-label="定位单元格"]').value,"B2");assert.equal(app.host.querySelector('button[aria-label="表格缩放"]').textContent,"200%");assert.equal(app.host.querySelector('input[aria-label="公式栏"]').value,"120");
  assert.ok(requests.some(item=>item.type==="sheet"&&item.name==="实际"));
  await render("account-a",true,{...resource,name:"另一名称.xlsx"});assert.equal(app.host.querySelector('input[aria-label="定位单元格"]').value,"A1");
  await render("account-b");assert.equal(app.host.querySelector('button[aria-label="表格缩放"]').textContent,"100%");
  await render("account-a");assert.equal(app.host.querySelector('.za-preview-sheets [aria-pressed="true"]').textContent,"预算");
});

test("slide grid, presentation keyboard and return preserve the reader page and skip hidden slides",async t=>{
 const requests=[],svg=number=>`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><text>${number}</text></svg>`;
 const app=await setup(t,{"./previewWorkerClient":{createResourcePreviewWorker:()=>({dispose(){},async request(input){requests.push(input);return {slideCount:4,hiddenSlides:[3],svg:svg((input.index??0)+1)};}})}});
 const originalObserver=globalThis.IntersectionObserver;
 globalThis.IntersectionObserver=class { observe(){} disconnect(){} };
 t.after(()=>{globalThis.IntersectionObserver=originalObserver;});
 const Reader=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourceSlidesPreview.tsx").default;
 await app.render(app.env.React.createElement(Reader,{bytes:new Uint8Array([1]),name:"deck.pptx",assertCurrent(){}}));
 await app.wait(()=>!!app.host.querySelector("img"));
 await app.zoom("幻灯片缩放",100);
 await app.env.act(async()=>app.host.querySelector('button[aria-label="网格视图"]').click());
 const grid=app.host.querySelector('.za-preview-slide-grid');
 const gridPages=grid.querySelector('.za-preview-slide-grid-pages');
 assert.equal(grid.querySelectorAll('button').length,4);
 assert.equal(gridPages.style.gridTemplateColumns,"repeat(4, minmax(0, 1fr))");
 const fitTransform=gridPages.style.transform;
 await app.zoom("幻灯片缩放",50);
 assert.equal(parseFloat(gridPages.style.width),6760);
 assert.match(gridPages.style.transform,/scale\(0\.5\)$/);
 await app.env.act(async()=>{app.host.querySelector('button[aria-label="幻灯片缩放"]').click();await flush();});
 await app.env.act(async()=>{[...document.querySelectorAll('[role="menuitemradio"]')].find(el=>el.textContent==="适应网格").click();await flush();});
 assert.equal(gridPages.style.transform,fitTransform);
 const tile=grid.querySelector('button[aria-label="选中第 2 页"]');
 await app.env.act(async()=>{tile.click();await flush();});
 assert.equal(tile.getAttribute("aria-pressed"),"true");
 assert.equal(app.host.querySelector('.za-preview-slide-grid'),grid);
 await app.key(tile,"Escape");
 assert.equal(tile.getAttribute("aria-pressed"),"false");
 assert.equal(app.host.querySelector('.za-preview-slide-grid'),grid);
 await app.env.act(async()=>tile.click());
 await app.env.act(async()=>{app.host.querySelector('button[aria-label="网格视图"]').click();await flush();});
 await app.wait(()=>/第 2 页/.test(app.host.querySelector('img')?.alt??""));
 assert.equal(app.host.querySelector('button[aria-label="幻灯片缩放"]').textContent,"100%");
 const play=app.host.querySelector('button[aria-label="播放幻灯片"]');
 play.focus();
 await app.env.act(async()=>{play.click();await flush();});
 const dialog=document.querySelector('[role="dialog"]');assert.ok(dialog);
 await app.key(dialog,"ArrowRight");
 await app.wait(()=>/第 3 张，共 3 张/.test(document.querySelector('.za-slide-playback')?.textContent??""));
 await app.key(dialog,"ArrowLeft");
 await app.wait(()=>/第 2 张/.test(document.querySelector('.za-slide-playback')?.textContent??""));
 await app.env.act(async()=>{document.querySelector('button[aria-label="退出演示模式"]').click();await flush();});
 await app.wait(()=>document.querySelector('[role="dialog"]')===null);
 assert.equal(document.querySelector('[role="dialog"]'),null);
 assert.match(app.host.querySelector('img').alt,/第 2 页/);
 assert.equal(requests.filter(item=>item.type==="load").length,1);
 assert.equal(requests.filter(item=>item.type==="slide"&&item.index===1).length,1);
 assert.equal(requests.filter(item=>item.type==="slide"&&item.index===2).length,0);
});


test("presentation grid mounts next to zoom without modifying the filename menu",async t=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><text x="20" y="40">页</text></svg>';
 const worker={dispose(){},async request(){return {slideCount:2,svg}}};
 const app=await setup(t,{"./previewWorkerClient":{createResourcePreviewWorker:()=>worker}}),h=app.env.React.createElement;
 const Slides=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourceSlidesPreview.tsx").default;
 const {PreviewToolbarMount}=app.env.loadModule("@liveagent/ui/components/resource-preview/PreviewChrome.tsx"),{ResourceTitleMenu}=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourceReaderDetails.tsx");
 const bytes=new Uint8Array([1]),assertCurrent=()=>{};
 function Reader(){const [fileMenu,setFileMenu]=app.env.React.useState(null),[target,setTarget]=app.env.React.useState(null);const value=app.env.React.useMemo(()=>({target,fileMenu,setFileMenu}),[target,fileMenu]);return h(PreviewToolbarMount.Provider,{value},h(ResourceTitleMenu,{name:'演示.pptx',onDownload(){}}),h('div',{ref:setTarget}),h(Slides,{bytes,name:'演示.pptx',assertCurrent}));}
 await app.render(h(Reader));await app.wait(()=>!!app.host.querySelector('.za-preview-slide'));
 await app.env.act(async()=>{app.host.querySelector('[aria-label="文件菜单：演示.pptx"]').click();await flush();});
 assert.equal(document.querySelector('[role="menuitemcheckbox"]'),null);
 await app.key(document.activeElement,"Escape");
 const grid=app.host.querySelector('.za-slide-view-controls button[aria-label="网格视图"]');
 assert.ok(grid.parentElement.querySelector('button[aria-label="幻灯片缩放"]'));
 await app.env.act(async()=>{grid.click();await flush();});assert.ok(app.host.querySelector('[aria-label="幻灯片网格"]'));
 assert.equal(grid.getAttribute("aria-pressed"),"true");
});

test("Escape in a presentation tab preserves the file while loading and after closing the local selection", async (t) => {
  const { env, host, render, key } = await setup(t);
  const { createElement: h, useContext, useLayoutEffect } = env.React;
  const { ConversationReaderPanel } = env.loadModule("@liveagent/ui/components/resource-preview/ConversationReaderPanel.tsx");
  const { PreviewToolbarMount } = env.loadModule("@liveagent/ui/components/resource-preview/PreviewChrome.tsx");
  let closes = 0;
  let selected = true;
  function PresentationCanvas() {
    const chrome = useContext(PreviewToolbarMount);
    useLayoutEffect(() => chrome.registerEscapeHandler(() => {
      const consumed = selected;
      selected = false;
      return consumed;
    }), [chrome]);
    return h("button", { type: "button" }, "幻灯片画布");
  }
  const panel = { tabbed: true, preserveOnEscape: true, title: "演示.pptx", onClose: () => closes++ };
  await render(h(ConversationReaderPanel, panel, h("button", { type: "button" }, "重试")));
  await key(host.querySelector("button"), "Escape");
  assert.equal(closes, 0);
  await render(h(ConversationReaderPanel, panel, h(PresentationCanvas)));
  const canvas = host.querySelector("button");
  await key(canvas, "Escape");
  assert.equal(selected, false);
  await key(canvas, "Escape");
  assert.equal(closes, 0);
});


test("reader zoom consumes only modified gestures inside its own surface and releases listeners",async t=>{
 const app=await setup(t),{bindReaderZoom,nextReaderZoom}=app.env.loadModule("@liveagent/ui/components/resource-preview/readerZoom.ts");
 const surface=app.host.appendChild(document.createElement('div')),outside=document.body.appendChild(document.createElement('div'));t.after(()=>outside.remove());
 const changes=[],dispose=bindReaderZoom(surface,100,300,value=>changes.push(value));
 const wheel=(target,ctrlKey)=>{const event=new window.WheelEvent('wheel',{deltaY:-20,ctrlKey,bubbles:true,cancelable:true});target.dispatchEvent(event);return event.defaultPrevented;};
 assert.equal(wheel(outside,true),false);assert.equal(wheel(surface,false),false);assert.equal(wheel(surface,true),true);assert.ok(changes[0]>100&&changes[0]<125);
 assert.equal(nextReaderZoom(399,-100,400),400);assert.equal(nextReaderZoom(25,100),25);
 const key=new window.KeyboardEvent('keydown',{key:'0',ctrlKey:true,bubbles:true,cancelable:true});surface.dispatchEvent(key);assert.equal(key.defaultPrevented,true);assert.equal(changes.at(-1),'fit-width');
 const field=surface.appendChild(document.createElement('input'));const typing=new window.KeyboardEvent('keydown',{key:'=',ctrlKey:true,bubbles:true,cancelable:true});field.dispatchEvent(typing);assert.equal(typing.defaultPrevented,false);
 dispose();assert.equal(wheel(surface,true),false);
});

test("presentation wheel accumulates vertical movement, ignores zoom gestures and yields to overflow", async (t) => {
  const app = await setup(t);
  const { bindPresentationPageWheel } = app.env.loadModule("@liveagent/ui/components/resource-preview/presentationViewport.ts");
  const { nextReaderZoom } = app.env.loadModule("@liveagent/ui/components/resource-preview/readerZoom.ts");
  const view = app.host.appendChild(document.createElement("div"));
  const pages = [];
  let fits = true;
  const cleanup = bindPresentationPageWheel(view, () => fits, (direction) => pages.push(direction));
  function wheel(timeStamp, init) {
    const event = new window.WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "timeStamp", { value: timeStamp });
    view.dispatchEvent(event);
    return event.defaultPrevented;
  }
  assert.equal(wheel(10, { deltaY: 20 }), true);
  assert.deepEqual(pages, []);
  assert.equal(wheel(20, { deltaY: 21 }), true);
  assert.equal(wheel(30, { deltaY: 80 }), true);
  assert.deepEqual(pages, [1]);
  assert.equal(wheel(50, { deltaY: -3, deltaMode: 1 }), true);
  assert.equal(wheel(60, { deltaY: -80, ctrlKey: true }), false);
  fits = false;
  assert.equal(wheel(70, { deltaY: 60 }), false);
  assert.deepEqual(pages, [1, -1]);
  cleanup();
  assert.equal(nextReaderZoom(100, -50, 1600, 10, "camera"), 200);
  assert.equal(nextReaderZoom(100, -80, 800, 30, "pdf"), 100 * Math.exp(0.1));
  assert.equal(nextReaderZoom(100, -10, 400, 10, "document"), 100 * Math.exp(0.1));
});

test("reader pinch survives React zoom updates and leaves ordinary touch scrolling alone",async t=>{
 const app=await setup(t),h=app.env.React.createElement,{PreviewZoomControl}=app.env.loadModule("@liveagent/ui/components/resource-preview/PreviewToolbar.tsx");
 function Reader(){const [zoom,setZoom]=app.env.React.useState(100);return h('div',{className:'za-resource-preview'},h(PreviewZoomControl,{label:'阅读缩放',value:zoom,onChange:setZoom}));}
 await app.render(h(Reader));const surface=app.host.querySelector('.za-resource-preview');
 const gesture=async(type,points)=>{let event;await app.env.act(async()=>{event=new window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:points.map(([clientX,clientY])=>({clientX,clientY}))});surface.dispatchEvent(event);await flush();});return event.defaultPrevented;};
 assert.equal(await gesture('touchstart',[[0,0]]),false);
 assert.equal(await gesture('touchstart',[[0,0],[100,0]]),true);
 assert.equal(await gesture('touchmove',[[0,0],[150,0]]),true);assert.match(app.host.textContent,/150%/);
 assert.equal(await gesture('touchmove',[[0,0],[200,0]]),true);assert.match(app.host.textContent,/200%/);
 await gesture('touchend',[]);
 assert.equal(await gesture('touchmove',[[0,0]]),false);
});

test("annotation input follows geometry changes without losing its draft and hides only while the anchor is offscreen",async t=>{
 const app=await setup(t),h=app.env.React.createElement,{ResourceDocumentComments}=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourceDocumentComments.tsx");
 const anchor={id:'za-reader-block-1',start:0,end:4,quote:'原文摘要',page:1,x:40,y:100};
 const view=selection=>h(ResourceDocumentComments,{enabled:true,onEnabled(){},selection,onSelection(){},onNavigate(){},onMarks(){}});
 await app.render(view(anchor));await app.input('修改建议','把这一段写得更简洁');
 await app.render(view({...anchor,y:260}));assert.equal(app.host.querySelector('[aria-label="修改建议"]').value,'把这一段写得更简洁');
 await app.render(view({...anchor,y:-80,visible:false}));assert.equal(app.host.querySelector('[aria-label="修改建议"]'),null);
 await app.render(view({...anchor,y:140,visible:true}));assert.equal(app.host.querySelector('[aria-label="修改建议"]').value,'把这一段写得更简洁');
 await app.render(view({...anchor,id:'za-reader-block-2'}));assert.equal(app.host.querySelector('[aria-label="修改建议"]').value,'');
});

test("history groups versions by date on an uncluttered timeline and selection never restores automatically",async t=>{
 const app=await setup(t),h=app.env.React.createElement,{ResourceVersionTimeline}=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourceVersionTimeline.tsx");
 const versions=[{id:'v3',number:3,created_at:'2026-10-31T10:00:00Z'},{id:'v2',number:2,created_at:'2026-10-31T09:00:00Z'},{id:'v1',number:1,created_at:'2026-10-30T08:00:00Z'}],selected=[];
 await app.render(h(ResourceVersionTimeline,{versions,selected:'v2',busy:false,onSelect:id=>selected.push(id)}));
 assert.equal(app.host.querySelectorAll('.za-reader-timeline > section').length,2);
 assert.equal(app.host.querySelector('[aria-current="true"]').dataset.versionId,'v2');
 const latest=app.host.querySelector('[data-version-id="v3"]');
 const original=app.host.querySelector('[data-version-id="v1"]');
 assert.equal(latest.querySelector('span').textContent,'v3 · 最新');
 assert.equal(original.querySelector('span').textContent,'v1 · 初始版本');
 assert.equal(original.getAttribute('aria-label'),'查看版本 v1 · 初始版本');
 assert.doesNotMatch(app.host.textContent,/KB|ready|已保存/);
 await app.env.act(async()=>original.click());
 assert.deepEqual(selected,['v1']);
});


test("sent file cards use the host preview capability without removing the original attachment",async t=>{
 const app=await setup(t),h=app.env.React.createElement,{UserAttachmentCards}=app.env.loadModule("@liveagent/ui/components/chat/UserAttachmentCards.tsx");
 const file={relativePath:'11111111-1111-4111-8111-111111111111',fileName:'示例方案.pdf',kind:'pdf',sizeBytes:2048},opened=[];
 await app.render(h(UserAttachmentCards,{files:[file],onOpen:value=>opened.push(value)}));
 const button=app.host.querySelector('[aria-label="预览 示例方案.pdf"]');assert.ok(button);
 await app.env.act(async()=>button.click());assert.equal(opened[0],file);assert.match(app.host.textContent,/示例方案.pdf/);
 await app.render(h(UserAttachmentCards,{files:[file]}));assert.equal(app.host.querySelector('[aria-label="预览 示例方案.pdf"]'),null,'hosts without preview capabilities retain display-only cards');
});


test("PDF covers never scroll a parent library while full readers retain page restoration",async t=>{
 const pdfPage={getViewport:({scale})=>({width:600*scale,height:800*scale}),render:()=>({promise:Promise.resolve(),cancel(){}})};
 const doc={numPages:1,getPage:async()=>pdfPage};
 const app=await setup(t,{"pdfjs-dist":{GlobalWorkerOptions:{},version:"test",getDocument:()=>({promise:Promise.resolve(doc),destroy:async()=>{}})},"pdfjs-dist/build/pdf.worker.min.mjs?url":"worker","./pdfPreviewAssets":{pdfPreviewAssetsURL:()=>"http://localhost/resource-preview/pdf/test/"}});
 const proto=window.HTMLElement.prototype,original=proto.scrollIntoView;let scrolled=0;
 proto.scrollIntoView=function(){scrolled++;};t.after(()=>{proto.scrollIntoView=original;});
 const Reader=app.env.loadModule("@liveagent/ui/components/resource-preview/ResourcePDFPreview.tsx").default;
 const h=app.env.React.createElement,assertCurrent=()=>{};
 await app.render(h(Reader,{bytes:new Uint8Array([1]),assertCurrent,thumbnail:true}));
 await app.wait(()=>app.host.querySelector('canvas')?.style.visibility==="visible");
 await app.env.act(async()=>{await new Promise(requestAnimationFrame);});
 assert.equal(scrolled,0,"a decoded cover must not jump the outer list to its file row");
 await app.render(h(Reader,{bytes:new Uint8Array([1]),assertCurrent,thumbnail:false}));
 await app.env.act(async()=>{await new Promise(requestAnimationFrame);});
 assert.ok(scrolled>0,"the full reader still restores the visible page after reflow");
});
