import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";

const streamdown = await import(new URL("../../../agent-ui/node_modules/streamdown/dist/index.js", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK0cAAAAASUVORK5CYII=", "base64");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const descriptor = (bytes = png, extra = {}) => ({ identity: "owner-a:file:1", name: "图片.png", mime: "image/png", size: bytes.length, sha256: sha(bytes), ...extra });
async function flush() { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); }

async function chooseZoom(app,label,itemText) {
 await app.env.act(async()=>{app.host.querySelector(`button[aria-label="${label}"]`).dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));await flush();});
 const item=[...document.querySelectorAll('[role="menuitemradio"]')].find(el=>el.textContent===itemText);assert.ok(item,`${itemText}: ${[...document.querySelectorAll("[role=menuitemradio]")].map(el=>el.textContent).join(",")} / ${app.host.querySelector(`button[aria-label="${label}"]`).outerHTML}`);
 await app.env.act(async()=>{item.click();await flush();});
}

async function mount(t, resource, load, options = {}) {
  let env;
  env = await createWebDomTestEnv({ resolveDynamicImports: true, mocks: { "../../lib/monacoNls": {preparePreferredMonacoNlsLocale:async()=>{},lockMonacoNlsLocale(){}}, "./ResourceSourceEditor": { __esModule: true, default: props => env.React.createElement("pre", {"data-source-ready":"true"}, props.text) }, streamdown, "@streamdown/code": {code:undefined}, "@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url": "/fixture.wasm", "../IconSet": new Proxy({}, {get: () => () => null}), ...options.mocks } });
  options.setup?.(env);
  const { ResourcePreview } = env.loadModule("@liveagent/ui/components/resource-preview/ResourcePreview.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host); let downloads = 0;
  const state = () => {
    const unavailable = host.querySelector(".za-preview-unavailable");
    if (unavailable) return /已取消/.test(unavailable.textContent) ? "paused" : "error";
    // JSDOM does not decode images. Decoder states are exercised explicitly by image tests.
    if (host.querySelector(".za-image-content,.za-image-cover-content,.za-thumbnail-fallback")) return "loaded";
    const loading = host.querySelector(".za-preview-loading");
    if (loading) return /正在准备预览/.test(loading.textContent) ? "preparing" : "parsing";
    if (host.querySelector('[aria-busy="true"]')) return "parsing";
    if (host.querySelector("img,iframe,pre,table,.za-preview-markdown,audio,video,.za-preview-archive")) return "loaded";
    return "mounting";
  };
  const waitFor = async (expected = "settled") => {
    const matches = () => typeof expected === "function"
      ? expected(host)
      : expected === "settled"
        ? ["loaded", "error", "paused"].includes(state())
        : state() === expected;
    const deadline = Date.now() + 5000;
    while (!matches() && Date.now() < deadline) {
      // A new act flushes updates after the actual digest/parse promise completes.
      // Fixed event-loop turns cannot guarantee that WebCrypto has returned under load.
      await env.act(async () => new Promise(resolve => setTimeout(resolve, 10)));
    }
    assert.ok(matches(), `preview did not reach ${String(expected)}; current state: ${state()}; content: ${host.textContent}`);
  };
  const render = async (next = resource, reader = load, expected = "settled") => {
    await env.act(async () => {
      root.render(env.React.createElement(ResourcePreview, { resource: next, load: reader, variant: options.variant, onDownload: () => downloads++ }));
    });
    await waitFor(expected);
  };
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); });
  await render(resource, load, options.waitFor ?? "settled");
  return { env, host, render, waitFor, get downloads() { return downloads; }, async click(label, expected = "settled") {
    const button = [...host.querySelectorAll("button")].find(item => item.textContent === label);
    assert.ok(button, `missing ${label}`);
    await env.act(async () => { button.click(); });
    await waitFor(expected);
  }};
}

test("shared raster reader validates bytes, reports decoding failure and releases one owned Blob on retry/close", async t => {
  const created = [], revoked = [];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => { assert.equal(blob.type, "image/png"); const url = `blob:owned-${created.length}`; created.push(url); return url; };
  URL.revokeObjectURL = url => revoked.push(url);
  t.after(() => { URL.createObjectURL = create; URL.revokeObjectURL = revoke; });
  let requests = 0;
  const app = await mount(t, descriptor(), async signal => { requests++; signal.throwIfAborted(); return { blob: new Blob([png]), assertCurrent() {} }; });
  assert.equal(app.host.querySelector("img").src, "blob:owned-0");
  assert.equal(app.host.querySelector(".za-preview-caption"),null,"reading does not reserve a permanent implementation caption");
  await app.env.act(async () => app.host.querySelector("img").dispatchEvent(new Event("error")));
  assert.equal(app.host.querySelector("img"), null);
  assert.match(app.host.textContent, /图片未能解码/);
  await app.click("下载原件"); assert.equal(app.downloads, 1);
  await app.click("重试预览");
  assert.equal(requests, 2); assert.ok(app.host.querySelector("img"));
  assert.deepEqual(revoked, ["blob:owned-0"]);
  await app.render(descriptor(png, { name: "旧文档.doc", mime: "application/msword" }));
  assert.deepEqual(revoked, created);
  assert.match(app.host.textContent, /暂不支持在线预览/);
  assert.equal(requests, 2);
});

test("cancel aborts a pending read; a late completion cannot replace the resumed resource", async t => {
  let release, firstSignal, reads = 0;
  const app = await mount(t, descriptor(), async signal => {
    reads++;
    if (reads === 1) { firstSignal = signal; await new Promise(resolve => { release = resolve; }); }
    return { blob: new Blob([png]), assertCurrent: () => signal.throwIfAborted() };
  }, {waitFor:"preparing"});
  await app.click("取消读取");
  assert.equal(firstSignal.aborted, true);
  assert.match(app.host.textContent, /已取消/); assert.equal(app.host.querySelector("img"), null);
  await app.click("重试预览"); assert.ok(app.host.querySelector("img"));
  await app.env.act(async () => { release(); await flush(); });
  assert.ok(app.host.querySelector("img")); assert.doesNotMatch(app.host.textContent, /失败|已取消/);
});

test("reusing a logical ID with a newer descriptor never paints an old pending file", async t => {
  let release, firstSignal;
  const app = await mount(t, descriptor(), async signal => {
    firstSignal = signal; await new Promise(resolve => { release = resolve; });
    return { blob: new Blob([png]), assertCurrent() {} };
  }, {waitFor:"preparing"});
  const text = Buffer.from("新版本中文");
  await app.render(descriptor(text, { name: "原件.txt", mime: "text/plain" }), async () => ({ blob: new Blob([text]), assertCurrent() {} }));
  assert.equal(firstSignal.aborted, true); assert.match(app.host.textContent, /新版本中文/);
  await app.env.act(async () => { release(); await flush(); });
  assert.equal(app.host.querySelector("img"), null); assert.match(app.host.textContent, /新版本中文/);
});

test("digest, account lifetime and size failures expose recovery actions without rendering untrusted bytes", async t => {
  const app = await mount(t, descriptor(png, { sha256: "f".repeat(64) }), async () => ({ blob: new Blob([png]), assertCurrent() {} }));
  assert.match(app.host.textContent, /完整性校验失败/); assert.equal(app.host.querySelector("img,iframe"), null);
  await app.render(descriptor(), async () => ({ blob: new Blob([png]), assertCurrent() { throw new DOMException("账户已切换", "AbortError"); } }));
  await app.click("重试预览");
  assert.match(app.host.textContent, /账户已切换/); assert.equal(app.host.querySelector("img,iframe"), null);
  let reads = 0;
  await app.render(descriptor(png, { size: 33 * 1024 * 1024 }), async () => { reads++; throw new Error("should not read"); });
  assert.equal(reads, 0); assert.match(app.host.textContent, /超出预览范围/);
  await app.click("下载原件"); assert.equal(app.downloads, 1);
});

test("bad PDF signatures and invalid UTF-8 show format-specific feedback with the original retained", async t => {
  const bytes = Buffer.from("not a PDF");
  const app = await mount(t, descriptor(bytes, { name: "损坏.pdf", mime: "application/pdf" }), async () => ({ blob: new Blob([bytes]), assertCurrent() {} }));
  assert.match(app.host.textContent, /PDF 文件头无效/); assert.equal(app.host.querySelector("canvas,iframe"), null);
  const binary = new Uint8Array([0xff, 0xff]);
  await app.render(descriptor(binary, { name: "二进制.txt", mime: "text/plain" }), async () => ({ blob: new Blob([binary]), assertCurrent() {} }));
  assert.match(app.host.textContent, /UTF-8/);
  await app.click("下载原件"); assert.equal(app.downloads, 1);
  await app.render(descriptor(binary, { name: "损坏.md", mime: "text/markdown" }), async () => ({ blob: new Blob([binary]), assertCurrent() {} }));
  assert.match(app.host.textContent, /UTF-8/);
  const empty=Buffer.from("\n\n");
  await app.render(descriptor(empty, {name:"空白.md",mime:"text/markdown"}),async()=>({blob:new Blob([empty]),assertCurrent(){}}));
  assert.match(app.host.textContent,/暂无可显示的内容/);
});

test("image fit follows its actual reading pane and original-size zoom remains available", async t => {
  // A valid GIF can have a large logical canvas with a smaller image frame.
  const gif = Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex");
  gif.writeUInt16LE(1600, 6); gif.writeUInt16LE(900, 8);
  let paneWidth = 260, notifyResize, disconnected = false;
  const app = await mount(t, descriptor(gif, {name:"画布.gif",mime:"image/gif"}), async () => ({blob:new Blob([gif]),assertCurrent(){}}), {setup(env) {
    Object.defineProperty(env.dom.window.HTMLElement.prototype, "clientWidth", {configurable:true,get(){return this.classList.contains("za-image-workspace") ? paneWidth : 0;}});
    Object.defineProperty(env.dom.window.HTMLElement.prototype, "clientHeight", {configurable:true,get(){return this.classList.contains("za-image-workspace") ? 480 : 0;}});
    globalThis.ResizeObserver = class { constructor(callback){this.callback=callback;} observe(element){if(element.classList.contains("za-image-workspace")){notifyResize=this.callback;this.reader=true;}} disconnect(){if(this.reader)disconnected=true;} };
  }});
  assert.ok(Math.abs(parseFloat(app.host.querySelector("img").style.width)-228)<0.01);
  assert.match(app.host.textContent, /1600 × 900/);
  await chooseZoom(app,"图像缩放","100%");
  assert.equal(app.host.querySelector("img").style.width, "1600px");
  paneWidth = 180;
  await app.env.act(async () => notifyResize());
  await chooseZoom(app,"图像缩放","缩放至适合窗口");
  assert.equal(app.host.querySelector("img").style.width, "148px");
  await app.render(descriptor(gif, {name:"旧格式.doc",mime:"application/msword"}));
  assert.equal(disconnected, true);
});

test("compatible spreadsheet coordinates, zoom and worksheet switching use one read-only canvas", async t => {
  const bytes=Buffer.from("test spreadsheet bytes"), requests=[];
  const sheetNames=["预算", "空表"];
  const first=Array.from({length:28},(_,index)=>index===0?"项目":index===27?"最末列":"");
  const model = (name, rows) => ({name,widths:Array(28).fill(100),heights:rows.map(()=>24),merges:[],styles:[{}],cells:rows.flatMap((row,r)=>row.map((text,column)=>({row:r,column,text,style:0}))) });
  const app=await mount(t,descriptor(bytes,{name:"预算.xlsx",mime:"application/octet-stream"}),async()=>({blob:new Blob([bytes]),assertCurrent(){}}),{mocks:{"./previewWorkerClient":{createResourcePreviewWorker:()=>({
    dispose(){},async request(input){requests.push(input.kind??input.type);return input.kind==="sheet-source"?{sheetFallback:true}:{sheetNames,sheet:model(input.name??"预算",input.type==="sheet"?[[""]]:[first,["服务器", "120"]])};},
  })}}});
  assert.equal(app.host.querySelectorAll(".za-preview-toolbar").length,1);
  assert.equal(app.host.querySelector('[role="grid"]').getAttribute("aria-colcount"),"28");
  assert.ok(app.host.querySelector(".za-sheet-canvas"));
  await chooseZoom(app,"表格缩放","200%");
  assert.equal(app.host.querySelector('button[aria-label="表格缩放"]').textContent,"200%");
  await app.click("空表");
  assert.deepEqual(requests,["sheet-source","sheet","sheet"]);
  assert.match(app.host.querySelector('[role="grid"]').getAttribute("aria-label"),/空表/);
  assert.doesNotMatch(app.host.textContent,/服务器/);
  assert.equal(app.host.querySelector('.za-preview-sheets button[aria-pressed="true"]').textContent,"空表");
});

test("slides fit both pane dimensions and keep page navigation after zooming", async t => {
  const bytes=Buffer.from([0x50,0x4b,3,4]), created=[], revoked=[];
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
  const globals=new Map(["DOMParser","XMLSerializer","IntersectionObserver"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  URL.createObjectURL=()=>{const url=`blob:slide-${created.length}`;created.push(url);return url;};
  URL.revokeObjectURL=url=>revoked.push(url);
  t.after(()=>{URL.createObjectURL=create;URL.revokeObjectURL=revoke;for(const [key,value] of globals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
  const app=await mount(t,descriptor(bytes,{name:"演示.pptx",mime:"application/octet-stream"}),async()=>({blob:new Blob([bytes]),assertCurrent(){}}),{
    waitFor: host => Boolean(host.querySelector("img")),
    setup(env){
      globalThis.DOMParser=env.dom.window.DOMParser;globalThis.XMLSerializer=env.dom.window.XMLSerializer;
      globalThis.IntersectionObserver=class { observe(){} disconnect(){} };
      Object.defineProperty(env.dom.window.HTMLElement.prototype,"clientWidth",{configurable:true,get(){return this.classList.contains("za-preview-slide-scroll")?640:0;}});
      Object.defineProperty(env.dom.window.HTMLElement.prototype,"clientHeight",{configurable:true,get(){return this.classList.contains("za-preview-slide-scroll")?300:0;}});
    },
    mocks:{"./previewWorkerClient":{createResourcePreviewWorker:()=>({dispose(){},async request(input){return {slideCount:2,svg:`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><text x="20" y="40">第${input.index??0}页</text></svg>`};}})}},
  });
  assert.equal(app.host.querySelector("img").dataset.ready,"true");
  assert.equal(app.host.querySelector(".za-preview-frame-pending"),null);
  const fittedWidth=parseFloat(app.host.querySelector("img").style.width);
  assert.ok(Math.abs(fittedWidth-(300-48)*16/9)<0.01);
  await chooseZoom(app,"幻灯片缩放","200%");
  assert.equal(parseFloat(app.host.querySelector("img").style.width),3200);
  await app.env.act(async()=>{app.host.querySelector('.za-preview-slide-scroll').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));await flush();});
  assert.match(app.host.querySelector("img").alt,/第 2 页/);
  assert.equal(app.host.querySelector('[aria-current="page"]').getAttribute("aria-label"),"转到第 2 页");
  assert.equal(app.host.querySelector('button[aria-label="幻灯片缩放"]').textContent,"200%");
  assert.ok(app.host.querySelector('.za-slide-view-controls [aria-label="播放幻灯片"]'));
  assert.deepEqual(revoked,[],"page changes retain the decoded page for back navigation");
  const textBytes=Buffer.from("new resource");
  await app.render(descriptor(textBytes,{identity:"text:2",name:"next.txt",mime:"text/plain"}),async()=>({blob:new Blob([textBytes]),assertCurrent(){}}));
  assert.deepEqual(revoked.sort(),["blob:slide-0","blob:slide-1"]);
});

test("cover read and image decode share the cover ring, while plain text covers skip reading the original", async t => {
  let finish, reads=0;
  const app=await mount(t,descriptor(),async signal=>{reads++;await new Promise(resolve=>{finish=resolve;});return {blob:new Blob([png]),assertCurrent:()=>signal.throwIfAborted()};},{variant:"thumbnail",waitFor:"preparing"});
  assert.equal(app.host.querySelector(".za-preview-loading").dataset.loadingVariant,"thumbnail");
  assert.ok(app.host.querySelector(".za-preview-cover-ring"));
  assert.equal(app.host.querySelector(".za-preview-file-loading"),null);
  await app.env.act(async()=>{finish();await flush();});
  await app.waitFor(host=>Boolean(host.querySelector("img")));
  const imageStyles=document.head.appendChild(document.createElement("style"));
  imageStyles.textContent=readFileSync(new URL("../../../agent-ui/src/components/resource-preview/resource-image-preview.css",import.meta.url),"utf8");
  assert.equal(getComputedStyle(app.host.querySelector("img")).opacity,"0","decoding covers wait before revealing their content");
  assert.equal(app.host.querySelector(".za-preview-loading").dataset.loadingVariant,"thumbnail","the decode stage must not change to the reader glyph");
  await app.env.act(async()=>app.host.querySelector("img").dispatchEvent(new Event("load")));
  assert.equal(app.host.querySelector(".za-preview-loading"),null);
  assert.equal(getComputedStyle(app.host.querySelector("img")).opacity,"1","a decoded cover must become visible, not leave an empty card");
  await app.render(descriptor(Buffer.from("text"),{name:"说明.txt",mime:"text/plain"}),async()=>{reads++;throw new Error("generic covers do not read bytes");});
  assert.ok(app.host.querySelector(".za-thumbnail-fallback"));
  assert.equal(reads,1);
});

test("PPT cover renders the real first slide as an inert image without a reading surface or controls", async t => {
  const bytes = Buffer.from([0x50, 0x4b, 1, 2]);
  const created = [], revoked = [];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  const globals=new Map(["DOMParser","XMLSerializer"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  URL.createObjectURL = blob => { created.push(blob); return "blob:slide-cover"; };
  URL.revokeObjectURL = url => revoked.push(url);
  t.after(() => { URL.createObjectURL = create; URL.revokeObjectURL = revoke; for(const [key,value] of globals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];} });
  const app = await mount(t, descriptor(bytes, {name:"首张封面.pptx",mime:"application/octet-stream"}), async signal => ({blob:new Blob([bytes]),assertCurrent:()=>signal.throwIfAborted()}), {
    variant:"thumbnail",
    setup(env){globalThis.DOMParser=env.dom.window.DOMParser;globalThis.XMLSerializer=env.dom.window.XMLSerializer;},
    mocks:{"./previewWorkerClient":{createResourcePreviewWorker:()=>({dispose(){},async request(){return {slideCount:2,svg:'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><text x="20" y="40">真实第一页</text></svg>'};}})}},
  });
  assert.ok(created[0], app.host.innerHTML);
  assert.match(await created[0].text(), /真实第一页/);
  assert.ok(app.host.querySelector(".za-image-cover-content"));
  assert.equal(app.host.querySelector("button,[data-scroll-viewport],.za-preview-toolbar"),null);
  await app.env.act(async()=>app.host.querySelector("img").dispatchEvent(new Event("load")));
  assert.equal(app.host.querySelector(".za-preview-loading"),null);
});

test("Word cover uses the real first page and a scriptless non-scrolling document", async t => {
  const bytes = Buffer.from([0x50, 0x4b, 1, 2]);
  const app = await mount(t, descriptor(bytes,{name:"首页.docx",mime:"application/octet-stream"}), async signal => ({blob:new Blob([bytes]),assertCurrent:()=>signal.throwIfAborted()}), {
    variant:"thumbnail",
    mocks:{
      "./previewWorkerClient":{createResourcePreviewWorker:()=>({dispose(){},async request(){return {entries:[{name:"word/document.xml"}]};}})},
      "docx-preview":{async parseAsync(){return {documentPart:{body:{children:[]}}};}, async renderDocument(){const body=document.createElement("div");body.innerHTML='<style>.docx{color:black}</style><div class="docx-wrapper"><section class="docx" style="width:600pt"><h1>真实首页</h1></section><section class="docx"><h1>不要显示的第二页</h1></section></div>';return [...body.childNodes];}},
    },
  });
  const frame = app.host.querySelector(".za-docx-thumbnail iframe");
  assert.ok(frame, app.host.innerHTML);
  assert.equal(frame.getAttribute("sandbox"), "");
  assert.match(frame.srcdoc, /真实首页/);
  assert.doesNotMatch(frame.srcdoc, /不要显示的第二页/);
  assert.match(frame.srcdoc, /overflow:hidden!important/);
  assert.equal(frame.style.width,"800px");
});

test("SVG covers fit the full native coordinate space without requiring a viewBox or frame scrollbars", async t => {
  const bytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480"><rect x="600" y="400" width="100" height="60" fill="blue"/></svg>');
  const globals=new Map(["DOMParser"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,value] of globals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
  const app=await mount(t,descriptor(bytes,{name:"坐标.svg",mime:"image/svg+xml"}),async signal=>({blob:new Blob([bytes]),assertCurrent:()=>signal.throwIfAborted()}),{
    variant:"thumbnail",setup(env){globalThis.DOMParser=env.dom.window.DOMParser;},
  });
  const frame=app.host.querySelector(".za-image-cover iframe");
  assert.equal(frame.style.width,"720px");assert.equal(frame.style.height,"480px");
  assert.match(frame.style.transform,/scale\(0\.20833333333333334\)/);
  assert.equal(frame.getAttribute("sandbox"),"");
  assert.match(frame.srcdoc,/overflow:hidden/);
  assert.equal(app.host.querySelector("button,[data-scroll-viewport]"),null);
});

test("Markdown covers render bounded real content without tools, external requests or a scroll viewport", async t => {
  const bytes = Buffer.from('# 实际文档封面\n\n中文正文与 **重点**。\n\n```js\nconst ready = true;\n```\n\n![外部图像](https://example.invalid/track.png)\n\n' + '正文 '.repeat(5000) + '\n\n# 超出封面范围');
  let reads = 0;
  const app = await mount(t, descriptor(bytes, {name:"中文说明.md",mime:"text/markdown"}), async signal => {
    reads++; return {blob:new Blob([bytes]),assertCurrent:()=>signal.throwIfAborted()};
  }, {variant:"thumbnail",mocks:{"@streamdown/code":{code:undefined}}});
  assert.equal(reads,1);
  assert.equal(app.host.querySelector('.za-markdown-cover h1')?.textContent,'实际文档封面');
  assert.match(app.host.textContent,/中文正文与/);
  assert.doesNotMatch(app.host.textContent,/超出封面范围/);
  assert.equal(app.host.querySelector('button,a,img,iframe,[data-scroll-viewport]'),null);
  assert.ok(app.host.querySelector('.za-markdown-cover[inert]'));
});

test("Markdown reader wraps each code block, copies exact code and table cells, and scopes zoom to the reader", async t => {
  const bytes=Buffer.from('# 阅读示例\n\n正文 `inline`。\n\n```js\nconst result = 23;\nconsole.log(result);\n```\n\n```text\nsecond\n```\n\n| 名称 | 值 |\n| --- | --- |\n| **金额** | 23 |\n\n- [x] 已完成\n\n![隔离图片](https://example.invalid/track.png)\n\n<script>alert(1)</script>');
  const copies=[];let current=true;
  const app=await mount(t,descriptor(bytes,{name:"说明.md",mime:"text/markdown"}),async()=>({blob:new Blob([bytes]),assertCurrent(){assert.ok(current,"文件已切换");}}),{
    mocks:{"@streamdown/code":{code:undefined}},
    setup(){Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async writeText(value){copies.push(value);}}});}
  });
  await app.waitFor(host=>host.querySelectorAll('.za-markdown-code pre').length===2);
  const blocks=app.host.querySelectorAll('.za-markdown-code');
  const wrap=blocks[0].querySelector('[aria-label="启用自动换行"]');
  await app.env.act(async()=>wrap.click());
  assert.equal(wrap.getAttribute('aria-pressed'),'true');
  assert.equal(blocks[1].getAttribute('data-wrapped'),'false');
  const copy=blocks[0].querySelector('[aria-label="复制代码"]');
  await app.env.act(async()=>{copy.click();await flush();});
  assert.deepEqual(copies,['const result = 23;\nconsole.log(result);']);
  assert.equal(copy.getAttribute('aria-label'),'已复制');
  await app.env.act(async()=>{app.host.querySelector('[aria-label="复制表格"]').click();await flush();});
  assert.equal(copies[1],'名称\t值\n金额\t23');
  assert.equal(app.host.querySelector('img,script,iframe'),null);
  assert.equal(app.host.querySelector('input[type="checkbox"]').disabled,true);
  const viewport=app.host.querySelector('[aria-label="Markdown 文档正文"]');
  const key=new KeyboardEvent('keydown',{key:'+',ctrlKey:true,bubbles:true,cancelable:true});
  await app.env.act(async()=>viewport.dispatchEvent(key));
  assert.equal(key.defaultPrevented,true);
  assert.ok(Number(app.host.querySelector('.za-markdown-column').style.getPropertyValue('--za-markdown-zoom'))>1);
  current=false;
  await app.env.act(async()=>{copy.click();await flush();});
  assert.equal(copies.length,2,'stale resources cannot copy contents');
  assert.match(app.host.textContent,/复制失败/);
});

test("cancel during format parsing disposes the worker and blocks a late parsed result", async t => {
  const bytes=Buffer.from("test spreadsheet bytes");let finish, signal, disposed=false;
  const app=await mount(t,descriptor(bytes,{name:"慢表格.xlsx",mime:"application/octet-stream"}),async()=>({blob:new Blob([bytes]),assertCurrent(){}}),{waitFor:"parsing",mocks:{"./previewWorkerClient":{createResourcePreviewWorker:currentSignal=>{
    signal=currentSignal;return {dispose(){disposed=true;},request:()=>new Promise(resolve=>{finish=resolve;})};
  }}}});
  assert.match(app.host.textContent,/正在读取工作表/);
  await app.click("取消读取");
  assert.equal(signal.aborted,true);assert.equal(disposed,true);
  await app.env.act(async()=>{finish({sheetNames:["迟到"],rows:[["不能显示"]]});await flush();});
  assert.match(app.host.textContent,/已取消/);assert.doesNotMatch(app.host.textContent,/不能显示/);
});

test("empty text gives an explicit state while HTML preview keeps its sandbox through source switching", async t => {
  const empty=Buffer.from("  \n");
  const app=await mount(t,descriptor(empty,{name:"空文件.txt",mime:"text/plain"}),async()=>({blob:new Blob([empty]),assertCurrent(){}}));
  assert.match(app.host.textContent,/此文件暂无可显示的内容/);
  const html=Buffer.from('<h1>标题</h1><script>window.secret=true</script><img src="https://example.invalid/remote.png">');
  await app.render(descriptor(html,{name:"页面.html",mime:"text/html"}),async()=>({blob:new Blob([html]),assertCurrent(){}}));
  assert.equal(app.host.querySelector("iframe").getAttribute("sandbox"),"");
  assert.match(app.host.querySelector("iframe").srcdoc,/script-src 'none'; connect-src 'none'/);
  await app.click("查看源码");
  assert.equal(app.host.querySelector("iframe"),null);assert.equal(app.host.querySelector("script"),null);
  assert.match(app.host.querySelector("pre").textContent,/window.secret=true/);
  await app.env.act(async()=>{app.host.querySelector('[aria-label="阅读视图"]').dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true,cancelable:true}));await flush();});
  await app.env.act(async()=>{[...document.querySelectorAll('[role="menuitemradio"]')].find(e=>e.textContent==='正文预览').click();await flush();});
  assert.equal(app.host.querySelector("iframe").getAttribute("sandbox"),"");
});
