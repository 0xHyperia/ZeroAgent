import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const env = await createWebDomTestEnv({ resolveDynamicImports: true, mocks: { streamdown, "@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url": "/fixture.wasm", "../IconSet": new Proxy({}, {get: () => () => null}), ...options.mocks } });
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
  await chooseZoom(app,"表格缩放","150%");
  assert.equal(app.host.querySelector('button[aria-label="表格缩放"]').textContent,"150%");
  await app.click("空表");
  assert.deepEqual(requests,["sheet-source","sheet","sheet"]);
  assert.match(app.host.querySelector('[role="grid"]').getAttribute("aria-label"),/空表/);
  assert.doesNotMatch(app.host.textContent,/服务器/);
  assert.equal(app.host.querySelector('.za-preview-sheets button[aria-pressed="true"]').textContent,"空表");
});

test("slides fit both pane dimensions and keep page navigation after zooming", async t => {
  const bytes=Buffer.from([0x50,0x4b,3,4]), created=[], revoked=[];
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL;
  const globals=new Map(["DOMParser","XMLSerializer"].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  URL.createObjectURL=()=>{const url=`blob:slide-${created.length}`;created.push(url);return url;};
  URL.revokeObjectURL=url=>revoked.push(url);
  t.after(()=>{URL.createObjectURL=create;URL.revokeObjectURL=revoke;for(const [key,value] of globals){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
  const app=await mount(t,descriptor(bytes,{name:"演示.pptx",mime:"application/octet-stream"}),async()=>({blob:new Blob([bytes]),assertCurrent(){}}),{
    waitFor: host => Boolean(host.querySelector("img")),
    setup(env){
      globalThis.DOMParser=env.dom.window.DOMParser;globalThis.XMLSerializer=env.dom.window.XMLSerializer;
      Object.defineProperty(env.dom.window.HTMLElement.prototype,"clientWidth",{configurable:true,get(){return this.classList.contains("za-preview-slide-scroll")?640:0;}});
      Object.defineProperty(env.dom.window.HTMLElement.prototype,"clientHeight",{configurable:true,get(){return this.classList.contains("za-preview-slide-scroll")?300:0;}});
    },
    mocks:{"./previewWorkerClient":{createResourcePreviewWorker:()=>({dispose(){},async request(input){return {slideCount:2,svg:`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><text x="20" y="40">第${input.index??0}页</text></svg>`};}})}},
  });
  assert.ok(app.host.querySelector(".za-preview-frame-pending"),"decoded bytes retain feedback until the image has painted");
  await app.env.act(async()=>app.host.querySelector("img").dispatchEvent(new Event("load")));
  assert.equal(app.host.querySelector(".za-preview-frame-pending"),null);
  const fittedWidth=parseFloat(app.host.querySelector("img").style.width);
  assert.ok(Math.abs(fittedWidth-268*16/9)<0.01);
  await chooseZoom(app,"幻灯片缩放","200%");
  assert.equal(parseFloat(app.host.querySelector("img").style.width),3200);
  await app.env.act(async()=>{app.host.querySelector('button[aria-label="下一页"]').click();await flush();});
  assert.match(app.host.querySelector("img").alt,/第 2 页/);
  assert.equal(app.host.querySelector('input[aria-label="页码"]').value,"2");
  assert.equal(app.host.querySelector('button[aria-label="幻灯片缩放"]').textContent,"200%");
  assert.equal(app.host.querySelector('button[aria-label="下一页"]').disabled,true);
  assert.deepEqual(revoked,["blob:slide-0"]);
});

test("cover read and image decode share the cover ring, while plain text covers skip reading the original", async t => {
  let finish, reads=0;
  const app=await mount(t,descriptor(),async signal=>{reads++;await new Promise(resolve=>{finish=resolve;});return {blob:new Blob([png]),assertCurrent:()=>signal.throwIfAborted()};},{variant:"thumbnail",waitFor:"preparing"});
  assert.equal(app.host.querySelector(".za-preview-loading").dataset.loadingVariant,"thumbnail");
  assert.ok(app.host.querySelector(".za-preview-cover-ring"));
  assert.equal(app.host.querySelector(".za-preview-file-loading"),null);
  await app.env.act(async()=>{finish();await flush();});
  await app.waitFor(host=>Boolean(host.querySelector("img")));
  assert.equal(app.host.querySelector(".za-preview-loading").dataset.loadingVariant,"thumbnail","the decode stage must not change to the reader glyph");
  await app.env.act(async()=>app.host.querySelector("img").dispatchEvent(new Event("load")));
  assert.equal(app.host.querySelector(".za-preview-loading"),null);
  await app.render(descriptor(Buffer.from("text"),{name:"说明.md",mime:"text/markdown"}),async()=>{reads++;throw new Error("generic covers do not read bytes");});
  assert.ok(app.host.querySelector(".za-thumbnail-fallback"));
  assert.equal(reads,1);
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
  await app.click("返回预览");
  assert.equal(app.host.querySelector("iframe").getAttribute("sandbox"),"");
});
