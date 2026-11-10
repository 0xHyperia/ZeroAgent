import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";

const loader = createWebModuleLoader();
const { prepareDocxOutline, createDocxOutline, DOCX_OUTLINE_LIMITS } = loader.loadModule("@liveagent/ui/components/resource-preview/docxOutline.ts");
const { createDocxPageNavigation } = loader.loadModule("@liveagent/ui/components/resource-preview/docxPageNavigation.ts");
const requireFromUI = createRequire(new URL("../../../agent-ui/package.json", import.meta.url));
const requireFromWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { JSDOM } = requireFromWeb("jsdom");
const { zipSync, strToU8 } = requireFromUI("fflate");
const paragraph = properties => ({ type: "paragraph", children: [], ...properties });

test("region annotations only quote known same-page anchors and reject forged geometry or recursive payloads", () => {
 const {checkedDocumentSelection}=loader.loadModule("@liveagent/ui/components/resource-preview/docxReaderDocument.ts");
 const blocks=[{id:'a',page:1,text:'真实标题'},{id:'b',page:1,text:'原始摘要'},{id:'c',page:2,text:'第二页'}];
 const region={left:.1,top:.2,width:.6,height:.1};
 const payload={id:'forged',start:0,end:1,x:20,y:90,region,quote:'attacker',anchors:[{id:'a',start:0,end:4},{id:'b',start:1,end:4}]};
 const selected=checkedDocumentSelection(payload,blocks);
 assert.equal(selected.page,1);assert.equal(selected.quote,'真实标题\n始摘要');assert.equal(selected.id,'a');
 for(const bad of [
  {...payload,region:{...region,left:Infinity}},
  {...payload,region:{...region,width:1}},
  {...payload,anchors:[{id:'a',start:0,end:2},{id:'c',start:0,end:2}]},
  {...payload,anchors:[{id:'a',start:0,end:2},{id:'a',start:2,end:4}]},
  {...payload,anchors:[{id:'unknown',start:0,end:1}]},
  {...payload,anchors:[]},
  {...payload,anchors:Array(21).fill({id:'a',start:0,end:1})},
 ])assert.equal(checkedDocumentSelection(bad,blocks),null);
 const nested={id:'a',start:0,end:4};nested.anchors=[nested];
 assert.equal(checkedDocumentSelection({...payload,anchors:[nested]},blocks).quote,'真实标题','nested fields have no authority and cannot recurse');
});

test("Word page annotations accept genuine blank points and regions without inventing a quote", () => {
 const { checkedDocumentSelection } = loader.loadModule("@liveagent/ui/components/resource-preview/docxReaderDocument.ts");
 const point = { left: 0.9, top: 0.1, width: 0, height: 0 };
 const target = { id: "za-reader-page-2", start: 0, end: 0, x: 720, y: 900, quote: "untrusted", region: point };
 const selected = checkedDocumentSelection(target, [], 2);
 assert.equal(selected.page, 2);
 assert.equal(selected.quote, "");
 assert.deepEqual(selected.region, point);
 assert.deepEqual(checkedDocumentSelection({ ...target, region: { ...point, width: 0.05, height: 0.1 } }, [], 2).region, { ...point, width: 0.05, height: 0.1 });
 assert.equal(checkedDocumentSelection(target, [], 1), null);
 assert.equal(checkedDocumentSelection({ ...target, end: 1 }, [], 2), null);
 assert.equal(checkedDocumentSelection({ ...target, region: { ...point, left: 1.2 } }, [], 2), null);
});
const model = (paragraphs, styles = []) => ({ documentPart: { body: { type: "document", children: paragraphs } }, stylesPart: { styles } });

test("DOCX page navigation uses original pages, bounded inert covers and unique native destinations", () => {
 const dom=new JSDOM('<div id="root"><i id="za-docx-page-1"></i><div class="docx-wrapper"><section class="docx"><p id="bookmark"><a href="https://example.test">真实第一页</a></p></section><section class="docx"><p>真实第二页</p></section></div></div>');
 const root=dom.window.document.querySelector('#root'),nav=createDocxPageNavigation(root,null);root.prepend(nav);
 assert.equal(nav.open,false);assert.match(nav.querySelector('summary').textContent,/2/);
 const links=[...nav.querySelectorAll('.za-docx-page-list>a')];assert.equal(links.length,2);
 for(const link of links){const id=link.getAttribute('href').replace('about:srcdoc#','');assert.ok(root.querySelector(`[id="${id}"]`));assert.ok(link.querySelector('[inert][aria-hidden="true"]'));assert.equal(link.querySelector('.za-docx-page-thumb [id],.za-docx-page-thumb [href]'),null);}
 assert.match(links[0].textContent,/真实第一页/);assert.equal(root.querySelectorAll('#bookmark').length,1);
 assert.equal(nav.querySelector('script,iframe'),null);
 dom.window.close();
});

test("DOCX outline uses paragraph levels and localized style inheritance, with explicit body text overriding a heading style", () => {
  const values = [paragraph({ outlineLevel: 0, className: "original" }), paragraph({ styleName: "正文带编号" }), paragraph({ styleName: "章标题" }), paragraph({ outlineLevel: 9, styleName: "章标题" }), paragraph({ styleName: "Heading1" })];
  const result = prepareDocxOutline(model(values, [
    { id: "正文带编号", target: "p", basedOn: "节标题" },
    { id: "章标题", target: "p", paragraphProps: { outlineLevel: 0 } },
    { id: "节标题", target: "p", basedOn: "章标题", paragraphProps: { outlineLevel: 2 } },
    { id: "Heading1", name: "Heading 1", target: "p" },
  ]));
  assert.deepEqual(result.map(entry => entry.level), [0, 2, 0]);
  assert.match(values[0].className, /^original za-docx-outline-mark-1$/);
  assert.equal(values[3].className, undefined);
  assert.equal(values[4].className, undefined);
});

test("DOCX outline bounds style inheritance and detects recursive or oversized document models", () => {
  const cycle = [{ id: "甲", target: "p", basedOn: "乙" }, { id: "乙", target: "p", basedOn: "甲" }];
  assert.deepEqual(prepareDocxOutline(model([paragraph({ styleName: "甲" })], cycle)), []);
  const chain = Array.from({ length: DOCX_OUTLINE_LIMITS.styleDepth + 1 }, (_, index) => ({ id: String(index), target: "p", basedOn: String(index + 1), ...(index === DOCX_OUTLINE_LIMITS.styleDepth ? { paragraphProps: { outlineLevel: 0 } } : {}) }));
  assert.deepEqual(prepareDocxOutline(model([paragraph({ styleName: "0" })], chain)), []);
  const recursive = paragraph({ outlineLevel: 0 }); recursive.children.push(recursive);
  assert.throws(() => prepareDocxOutline(model([recursive])), /文档结构较复杂/);
  let deep = paragraph({});
  for (let index = 0; index < DOCX_OUTLINE_LIMITS.depth + 1; index++) deep = { type: "table", children: [deep] };
  assert.throws(() => prepareDocxOutline(model([deep])), /文档结构较复杂/);
  assert.throws(() => prepareDocxOutline(model(Array.from({ length: DOCX_OUTLINE_LIMITS.nodes }, () => paragraph({})))), /文档内容较多/);
  assert.throws(() => prepareDocxOutline(model([], Array.from({ length: DOCX_OUTLINE_LIMITS.styles + 1 }, () => ({})))), /文档样式较多/);
  assert.equal(prepareDocxOutline(model(Array.from({ length: DOCX_OUTLINE_LIMITS.headings + 1 }, () => paragraph({ outlineLevel: 0 })))).length, DOCX_OUTLINE_LIMITS.headings);
});

test("DOCX directory reads rendered text, creates collision-free same-srcdoc anchors and preserves existing bookmarks", t => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>"); t.after(() => dom.window.close());
  const doc = dom.window.document, root = doc.createElement("div");
  root.innerHTML = '<span id="za-docx-section-1"></span><p id="原有书签" class="za-docx-outline-mark-1"></p><p class="za-docx-outline-mark-2"></p><p class="za-docx-outline-mark-3">  </p>';
  root.querySelector("p").textContent = '<img src=x onerror="alert(1)"> 同名标题';
  root.querySelectorAll("p")[1].textContent = "同名标题";
  const navigation = createDocxOutline(root, [{ marker: "za-docx-outline-mark-1", level: 0 }, { marker: "za-docx-outline-mark-2", level: 2 }, { marker: "za-docx-outline-mark-3", level: 1 }]);
  assert.ok(navigation); assert.equal(navigation.open, true);
  assert.equal(navigation.querySelectorAll("a").length, 2);
  assert.equal(navigation.querySelector("img,script"), null);
  assert.match(navigation.textContent, /<img src=x onerror="alert\(1\)"> 同名标题/);
  assert.ok(root.querySelector('[id="原有书签"]'));
  const destinations = [...navigation.querySelectorAll("a")].map(link => link.getAttribute("href"));
  assert.deepEqual(destinations, ["about:srcdoc#za-docx-section-1-2", "about:srcdoc#za-docx-section-2"]);
  for (const destination of destinations) assert.equal(root.querySelectorAll(`[id="${destination.split("#")[1]}"]`).length, 1);
  assert.equal(createDocxOutline(root, []), null);
});

function docxFixture() {
  return zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/_rels/document.xml.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    "word/styles.xml": strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="中文标题"><w:name w:val="章标题"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="继承标题"><w:basedOn w:val="中文标题"/></w:style></w:styles>'),
    "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="继承标题"/></w:pPr><w:r><w:t>实际中文章节</w:t></w:r></w:p><w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>独立三级标题</w:t></w:r></w:p><w:p><w:r><w:t>正文不会进入目录。</w:t></w:r></w:p></w:body></w:document>'),
  });
}

async function adapter(t, mocks = {}) {
  const env = await createWebDomTestEnv({ resolveDynamicImports: true, mocks });
  const parser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
  globalThis.DOMParser = env.dom.window.DOMParser;
  const host = document.body.appendChild(document.createElement("div")), root = env.createRoot(host);
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); if (parser) Object.defineProperty(globalThis, "DOMParser", parser); else delete globalThis.DOMParser; });
  const Component = env.loadModule("@liveagent/ui/components/resource-preview/ResourceDOCXPreview.tsx").default;
  const Identity=env.loadModule("@liveagent/ui/components/resource-preview/PreviewChrome.tsx").PreviewIdentityContext;
  const mount = async props => env.act(async () => root.render(env.React.createElement(Identity.Provider,{value:{name:props.name,mime:"",onRequestRevision:props.onRequestRevision}},env.React.createElement(Component, props))));
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await env.act(async () => new Promise(resolve => setTimeout(resolve, 10)));
    assert.ok(predicate(), host.textContent);
  };
  return { env, host, root, mount, waitFor };
}

test("real DOCX bytes are inspected before parse/render and produce an opaque nonce-only reader and separate semantic navigation", async t => {
  const calls = [];
  const real = requireFromUI("docx-preview");
  const { inspectPreviewArchive } = loader.loadModule("@liveagent/ui/components/resource-preview/previewArchive.ts");
  const app = await adapter(t, {
    "./previewWorkerClient": { createResourcePreviewWorker: () => ({ dispose() {}, async request(input) { calls.push("inspect"); return { entries: inspectPreviewArchive(input.bytes) }; } }) },
    "docx-preview": { async parseAsync(...args) { calls.push("parse"); return real.parseAsync(...args); }, async renderDocument(...args) { calls.push("render"); return real.renderDocument(...args); } },
  });
  const holdFrameLoad=event=>{if(event.target?.tagName==="IFRAME")event.stopImmediatePropagation();};
  app.env.dom.window.document.addEventListener("load",holdFrameLoad,true);
  await app.mount({ bytes: docxFixture(), name: "中文文档.docx", assertCurrent() {} });
  await app.waitFor(() => app.host.querySelector("iframe") || app.host.querySelector(".za-preview-unavailable"));
  assert.deepEqual(calls, ["inspect", "parse", "render"]);
  const frame = app.host.querySelector("iframe"); assert.ok(frame, app.host.textContent);
  assert.equal(frame.dataset.ready,"false");
  assert.ok(app.host.querySelector(".za-preview-frame-pending"),"parsed DOCX retains feedback until the isolated frame is loaded");
  app.env.dom.window.document.removeEventListener("load",holdFrameLoad,true);
  await app.env.act(async()=>frame.dispatchEvent(new Event("load")));
  assert.equal(frame.dataset.ready,"true");
  assert.equal(app.host.querySelector(".za-preview-frame-pending"),null);
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
  assert.doesNotMatch(frame.getAttribute("sandbox"),/allow-same-origin|allow-forms|allow-popups/);
  assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
  assert.match(frame.srcdoc, /script-src 'nonce-[a-f0-9]+'; connect-src 'none'/);
  assert.match(frame.srcdoc, /base-uri 'none'/);
  const rendered = new JSDOM(frame.srcdoc); t.after(() => rendered.window.close());
  assert.equal(app.host.querySelector('aside[aria-label="文档导航"]'), null);
  await app.env.act(async () => app.host.querySelector('[aria-label="展开文档导航"]').click());
  const navigation=app.host.querySelector('aside[aria-label="文档导航"] nav');
  assert.ok(navigation);
  assert.deepEqual([...navigation.querySelectorAll("button")].map(item=>item.textContent),["实际中文章节","独立三级标题"]);
  assert.equal(rendered.window.document.querySelectorAll("script").length,1);
  assert.equal(rendered.window.document.querySelector("h1,h2,h3"),null);
  assert.equal(rendered.window.document.querySelector("nav"),null);
  const before=frame;
  await app.env.act(async()=>app.host.querySelector('[aria-label="切换为页面缩略图"]').click());
  assert.equal(app.host.querySelector('iframe.za-preview-document'),before);
  assert.ok(app.host.querySelector('button[aria-label="第 1 页"] iframe[sandbox=""]'));

});

test("retiring a DOCX adapter while parsing disposes its worker and never renders a late model", async t => {
  let release, disposed = false, rendered = false, signal;
  const app = await adapter(t, {
    "./previewWorkerClient": { createResourcePreviewWorker: current => { signal = current; return { dispose() { disposed = true; }, async request() { return { entries: [{ name: "word/document.xml", size: 1, directory: false }] }; } }; } },
    "docx-preview": { parseAsync: () => new Promise(resolve => { release = resolve; }), async renderDocument() { rendered = true; return []; } },
  });
  await app.mount({ bytes: docxFixture(), name: "慢文档.docx", assertCurrent() {} });
  await app.waitFor(() => Boolean(release));
  await app.env.act(async () => app.root.unmount());
  assert.equal(disposed, true); assert.equal(signal.aborted, true);
  await app.env.act(async () => release(model([paragraph({ outlineLevel: 0 })])));
  assert.equal(rendered, false); assert.equal(app.host.querySelector("iframe"), null);
});


test("Word bridge strips document authority and accepts only validated original-text anchors",t=>{
 const dom=new JSDOM('<div><script nonce="attacker">top.location="x"</script><iframe src="https://evil.test"></iframe><div class="docx-wrapper"><section class="docx"><p onclick="alert(1)" data-reader-block="spoof">真实文本</p><img src="https://evil.test/track" onerror="alert(1)"><a href="https://evil.test">link</a></section></div></div>');t.after(()=>dom.window.close());
 const api=loader.loadModule("@liveagent/ui/components/resource-preview/docxReaderDocument.ts");
 const resource=api.prepareReaderDocument(dom.window.document.querySelector('div'),[]),rendered=new JSDOM(resource.source);t.after(()=>rendered.window.close());
 assert.equal(rendered.window.document.querySelectorAll('script').length,1);
 assert.match(resource.source,/connect-src 'none'/);assert.match(resource.source,/default-src 'none'/);
 assert.equal(rendered.window.document.querySelector('iframe,[onclick],[onerror],[href],img[src]'),null);
 assert.equal(resource.blocks[0].text,'真实文本');
 assert.equal(api.checkedDocumentSelection({id:resource.blocks[0].id,start:0,end:2,x:10,y:20},resource.blocks).quote,'真实');
 for(const payload of [{id:'spoof',start:0,end:2,x:0,y:0},{id:resource.blocks[0].id,start:-1,end:2,x:0,y:0},{id:resource.blocks[0].id,start:0,end:1000,x:0,y:0},{id:resource.blocks[0].id,start:0,end:2,x:Infinity,y:0}])assert.equal(api.checkedDocumentSelection(payload,resource.blocks),null);
});

test("embedded Word images have trusted anchors and ordinary-reading shortcuts use the guarded revision path",async t=>{
 const {inspectPreviewArchive}=loader.loadModule("@liveagent/ui/components/resource-preview/previewArchive.ts");
 let sends=0;
 const app=await adapter(t,{"./previewWorkerClient":{createResourcePreviewWorker:()=>({dispose(){},async request(input){return {entries:inspectPreviewArchive(input.bytes)}}})},"docx-preview":{async parseAsync(){return model([])},async renderDocument(){const root=document.createElement('div');root.innerHTML='<div class="docx-wrapper"><section class="docx"><p>图示说明</p><p><img alt="交付流程" src="data:image/png;base64,aA=="></p></section></div>';return [root]}}});
 await app.mount({bytes:docxFixture(),name:'图片方案.docx',assertCurrent(){},onRequestRevision:async()=>{sends++;return true}});
 await app.waitFor(()=>app.host.querySelector('iframe.za-preview-document'));
 const frame=app.host.querySelector('iframe.za-preview-document'),token=frame.srcdoc.match(/nonce="([a-f0-9]+)"/)[1];
 const rendered=new JSDOM(frame.srcdoc);t.after(()=>rendered.window.close());
 const image=rendered.window.document.querySelector('[data-reader-kind="image"]');assert.ok(image);
 const api=loader.loadModule("@liveagent/ui/components/resource-preview/docxReaderDocument.ts");
 const blocks=[{id:image.dataset.readerBlock,page:1,text:image.dataset.readerText,kind:'image'}];
 const value={token,type:'image-shortcut',id:blocks[0].id,start:0,end:blocks[0].text.length,x:250,y:150,quote:'伪造说明'};
 assert.equal(api.checkedDocumentSelection(value,blocks).quote,'图片 1：交付流程');
 const deliver=async(source,origin,data)=>app.env.act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source,origin,data})));
 await deliver(window,'null',value);assert.equal(app.host.querySelector('.za-document-image-shortcut'),null);
 await deliver(frame.contentWindow,'null',{...value,id:'spoof'});assert.equal(app.host.querySelector('.za-document-image-shortcut'),null);
 await deliver(frame.contentWindow,'null',value);assert.ok(app.host.querySelector('.za-document-image-shortcut'));
 assert.equal(app.host.querySelector('[aria-label="修改建议"]'),null,'reading does not open a comment form');
 await app.env.act(async()=>app.host.querySelector('.za-document-image-shortcut button').click());
 assert.equal(app.host.querySelector('.za-request-revision').getAttribute('aria-pressed'),'true');
 assert.ok(app.host.querySelector('[aria-label="修改建议"]'));assert.equal(sends,0,'neither selecting nor entering modification submits a run');
});

test("Word annotation bridge rejects foreign frames, origins and channels and never submits on selection",async t=>{
 const real=requireFromUI("docx-preview"),{inspectPreviewArchive}=loader.loadModule("@liveagent/ui/components/resource-preview/previewArchive.ts");
 let sends=0;
 const app=await adapter(t,{"./previewWorkerClient":{createResourcePreviewWorker:()=>({dispose(){},async request(input){return {entries:inspectPreviewArchive(input.bytes)}}})},"docx-preview":real});
 await app.mount({bytes:docxFixture(),name:'批注.docx',assertCurrent(){},onRequestRevision:async()=>{sends++;return true}});
 await app.waitFor(()=>app.host.querySelector('iframe.za-preview-document'));
 const frame=app.host.querySelector('iframe.za-preview-document'),token=frame.srcdoc.match(/nonce="([a-f0-9]+)"/)[1];
 const rendered=new JSDOM(frame.srcdoc);t.after(()=>rendered.window.close());
 const block=rendered.window.document.querySelector('[data-reader-block]'),data={token,type:'selection',id:block.dataset.readerBlock,start:0,end:2,x:100,y:100};
 await app.env.act(async()=>app.host.querySelector('.za-request-revision').click());
 const deliver=async(source,origin,value)=>app.env.act(async()=>window.dispatchEvent(new window.MessageEvent('message',{source,origin,data:value})));
 const surface=app.host.querySelector('.za-docx-zoom-surface');
 const oldHeight=surface.style.height;
 await deliver(window,'null',{token,type:'height',height:4000});
 await deliver(frame.contentWindow,'https://evil.test',{token,type:'height',height:4000});
 for(const height of [Infinity,-1,2000001])await deliver(frame.contentWindow,'null',{token,type:'height',height});
 assert.equal(surface.style.height,oldHeight,'foreign or unbounded measurements cannot change the reading canvas');
 await deliver(frame.contentWindow,'null',{token,type:'height',height:4000});
 assert.equal(frame.style.height,'4000px','the isolated document expands inside the host-owned scroll viewport');
 let destination;
 app.host.querySelector('.za-docx-zoom-viewport').scrollTo=value=>{destination=value;};
 await deliver(frame.contentWindow,'null',{token,type:'navigate',top:500});
 assert.ok(Number.isFinite(destination?.top)&&destination.top>=0,'navigation uses the actual outer reading viewport');
 await deliver(window,'null',data);await deliver(frame.contentWindow,'https://evil.test',data);await deliver(frame.contentWindow,'null',{...data,token:'wrong'});
 assert.equal(app.host.querySelector('[aria-label="修改建议"]'),null);
 await deliver(frame.contentWindow,'null',data);
 assert.ok(app.host.querySelector('[aria-label="修改建议"]'));
 assert.equal(sends,0);
 const input=app.host.querySelector('[aria-label="修改建议"]');
 await app.env.act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'更加简洁');input.dispatchEvent(new window.Event('input',{bubbles:true}));});
 await app.env.act(async()=>app.host.querySelector('[aria-label="添加批注"]').click());
 assert.match(app.host.textContent,/这 1 条批注/);assert.equal(sends,0);
 await app.env.act(async()=>app.host.querySelector('[aria-label="查看 1 条批注"]').click());
 await app.waitFor(()=>document.querySelector('[aria-label="编辑第 1 条批注"]'));
 await app.env.act(async()=>document.querySelector('[aria-label="编辑第 1 条批注"]').click());
 assert.equal(app.host.querySelector('[aria-label="修改建议"]').value,'更加简洁');
 await app.env.act(async()=>app.host.querySelector('[aria-label="修改建议"]').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 await deliver(frame.contentWindow,'null',{...data,start:2,end:4});
 assert.equal(app.host.querySelector('[aria-label="修改建议"]').value,'','a new anchor does not inherit an unfinished edit');
 await app.env.act(async()=>app.host.querySelector('[aria-label="修改建议"]').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 await app.env.act(async()=>app.host.querySelector('[aria-label="查看 1 条批注"]').click());
 await app.waitFor(()=>document.querySelector('[aria-label="移除第 1 条批注"]'));
 await app.env.act(async()=>document.querySelector('[aria-label="移除第 1 条批注"]').click());
 assert.doesNotMatch(app.host.textContent,/这 1 条批注/);assert.equal(sends,0);
});
