import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";

async function setup(t, options = {}) {
  const env = await createWebDomTestEnv();
  let resize, width = 600, height = 500, retired = false;
  Object.defineProperty(env.dom.window.HTMLElement.prototype, "clientWidth", {configurable:true,get(){return width;}});
  Object.defineProperty(env.dom.window.HTMLElement.prototype, "clientHeight", {configurable:true,get(){return height;}});
  globalThis.ResizeObserver = class { constructor(callback){resize=callback;} observe(){} disconnect(){retired=true;} };
  const Player = env.loadModule("@liveagent/ui/components/resource-preview/ResourceImagePreview.tsx").default;
  const { PreviewIdentityContext, PreviewToolbarMount } = env.loadModule("@liveagent/ui/components/resource-preview/PreviewChrome.tsx");
  const host = document.body.appendChild(document.createElement("div")), root = env.createRoot(host);
  const errors=[]; let mounted=true;
  const props = {name:"图像.png",url:"blob:image-one",dimensions:{width:1200,height:800},assertCurrent(){},onError(value){errors.push(value);},...options};
  const render = async(extra={},inspector=false,workspace=false,workspaceImageActions) => env.act(async()=>root.render(
    env.React.createElement(env.React.StrictMode,null,
      env.React.createElement(PreviewToolbarMount.Provider,{value:workspace?{target:host,workspaceTab:true}:inspector?{target:null,inspectorOpen:true}:null},
        env.React.createElement(PreviewIdentityContext.Provider,
          {value:{name:props.name,mime:"image/png",workspaceImageActions}},
          env.React.createElement(Player,{...props,...extra}),
        ),
      ),
    ),
  ));
  const click = async(label)=>env.act(async()=>host.querySelector(`button[aria-label="${label}"]`).click());
  const decode = async()=>env.act(async()=>host.querySelector("img,iframe").dispatchEvent(new Event("load")));
  const pointer = async(type,id,x,y,pointerType="mouse")=>env.act(async()=>{
    const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0});
    Object.defineProperties(event,{pointerId:{value:id},pointerType:{value:pointerType}});
    host.querySelector(".za-image-canvas").dispatchEvent(event);
  });
  const unmount = async()=>{if(mounted){await env.act(async()=>root.unmount());mounted=false;}};
  t.after(async()=>{await unmount();host.remove();env.cleanup();});
  await render();
  return {env,host,render,decode,click,pointer,errors,unmount,get retired(){return retired;},async resize(w,h){width=w;height=h;await env.act(async()=>resize());}};
}

test("image decoder loading is stable, native-pixel zoom and rotation share a centered fit canvas",async t=>{
  const app=await setup(t);
  assert.ok(app.host.querySelector(".za-image-loading"));
  assert.equal(app.host.querySelector('[aria-label="放大图像"]').disabled,true);
  await app.decode();
  assert.equal(app.host.querySelector(".za-image-loading"),null);
  assert.ok(Math.abs(parseFloat(app.host.querySelector("img").style.width)-552)<.001);
  assert.match(app.host.querySelector("img").style.transform,/translate\(-50%, -50%\) translate\(0px, 0px\)/);
  await app.click("放大图像");
  assert.ok(parseFloat(app.host.querySelector("img").style.width)>552);
  await app.env.act(async()=>app.host.querySelector(".za-image-canvas").dispatchEvent(new KeyboardEvent("keydown",{key:"1",bubbles:true,cancelable:true})));
  assert.equal(app.host.querySelector("img").style.width,"1200px");
  await app.click("旋转图像");
  assert.match(app.host.querySelector("img").style.transform,/rotate\(90deg\)/);
  assert.equal(app.host.querySelector("img").style.width,"1200px");
  await app.click("重置图像视图");
  assert.match(app.host.querySelector("img").style.transform,/rotate\(0deg\)/);
  assert.ok(Math.abs(parseFloat(app.host.querySelector("img").style.width)-552)<.001);
});

test("workspace image uses the full reading canvas and keeps actions in the shared file toolbar", async (t) => {
  const app = await setup(t);
  await app.render({}, false, true);
  assert.ok(app.host.querySelector('[data-skeleton-kind="media"]'));
  await app.decode();
  assert.equal(app.host.querySelector(".za-image-workspace").dataset.workspaceImage, "raster");
  assert.equal(app.host.querySelector(".za-image-dock-position"), null);
  assert.equal(app.host.querySelector("img").style.width, "576px");
  const tools = app.host.querySelector(".za-preview-toolbar-tools");
  assert.equal(tools.querySelectorAll("button").length, 2);
  const menu = tools.querySelector('button[aria-label="图像操作"],button[aria-label="Image actions"]');
  assert.ok(menu);
  await app.env.act(async () => {
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  });
  const rotate = [...document.querySelectorAll('[role="menuitem"]')].find(
    (item) => /^(向右旋转|Rotate right)/.test(item.textContent),
  );
  assert.ok(rotate);
  await app.env.act(async () => rotate.click());
  assert.match(app.host.querySelector("img").style.transform, /rotate\(90deg\)/);
});

test("workspace image actions are reachable by tapping the toolbar inside a reader sheet", async (t) => {
  let valid = true;
  const actions = [];
  const app = await setup(t, {
    assertCurrent() { if (!valid) throw new Error("expired"); },
    onDownload() { actions.push("download"); },
  });
  app.host.dataset.slot = "sheet-popup";
  await app.render({}, false, true, {
    sizeBytes: 64,
    onCopy: async () => { actions.push("copy"); },
    onCopyRelativePath: async () => { actions.push("path"); },
  });
  await app.decode();
  const trigger = app.host.querySelector(".za-image-actions-trigger");
  async function openMenu() {
    await app.env.act(async () => trigger.click());
    const menu = app.host.querySelector('[role="menu"]');
    assert.ok(menu);
    return menu;
  }
  async function choose(pattern) {
    const menu = await openMenu();
    const item = [...menu.querySelectorAll('[role="menuitem"]')].find(({ textContent }) =>
      pattern.test(textContent),
    );
    assert.ok(item, String(pattern));
    await app.env.act(async () => item.click());
  }
  await choose(/^(向左旋转|Rotate left)/);
  assert.match(app.host.querySelector("img").style.transform, /rotate\(-90deg\)/);
  await choose(/^(复制图片|Copy image)$/);
  await choose(/下载\/另存为|Download \/ Save as/);
  await choose(/图片信息|Image information/);
  const info = app.host.querySelector("aside");
  assert.match(info.textContent, /1200 × 800/);
  await app.env.act(async () => info.querySelector("button").click());
  assert.equal(app.host.querySelector("aside"), null);
  valid = false;
  await choose(/^(复制图片|Copy image)$/);
  assert.deepEqual(actions, ["copy", "download"]);
  assert.match(app.errors.at(-1), /此预览已失效/);
});

test("workspace image right-click executes the menu item without restarting the canvas", async (t) => {
  const app = await setup(t);
  const originalDOMRect = Object.getOwnPropertyDescriptor(globalThis, "DOMRect");
  globalThis.DOMRect = app.env.dom.window.DOMRect;
  t.after(() => {
    if (originalDOMRect) Object.defineProperty(globalThis, "DOMRect", originalDOMRect);
    else delete globalThis.DOMRect;
  });
  const actions = [];
  await app.render({}, false, true, {
    sizeBytes: 64,
    onCopy: async () => { actions.push("copy"); },
  });
  await app.decode();
  const canvas = app.host.querySelector(".za-image-canvas");
  const { act } = app.env;
  async function selectItem(label) {
    await act(async () => canvas.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2, clientX: 90, clientY: 90,
    })));
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (entry) => label.test(entry.textContent),
    );
    assert.ok(item, String(label));
    await act(async () => {
      item.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      item.click();
    });
    assert.equal(app.host.querySelector(".za-image-canvas"), canvas);
  }
  await selectItem(/向右旋转|Rotate right/);
  assert.match(canvas.querySelector("img").style.transform, /rotate\(90deg\)/);
  await selectItem(/复制图片|^Copy image$/);
  assert.deepEqual(actions, ["copy"]);
});

test("pan bounds, anchored wheel and two-finger pinch do not steal browser or composer gestures",async t=>{
  const app=await setup(t); await app.decode();
  const canvas=app.host.querySelector(".za-image-canvas");
  await app.env.act(async()=>canvas.dispatchEvent(new KeyboardEvent("keydown",{key:"1",bubbles:true})));
  await app.pointer("pointerdown",1,300,250);
  await app.pointer("pointermove",1,5000,5000);
  assert.match(app.host.querySelector("img").style.transform,/translate\(316px, 216px\)/);
  await app.pointer("pointerup",1,5000,5000);
  await app.click("重置图像视图");
  const wheel=new app.env.dom.window.WheelEvent("wheel",{bubbles:true,cancelable:true,ctrlKey:true,clientX:300,clientY:250,deltaY:-100});
  await app.env.act(async()=>canvas.dispatchEvent(wheel));
  assert.equal(wheel.defaultPrevented,true);
  const outside=new app.env.dom.window.WheelEvent("wheel",{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-100});
  document.body.dispatchEvent(outside);assert.equal(outside.defaultPrevented,false);
  await app.click("重置图像视图");
  await app.pointer("pointerdown",1,200,250,"touch");await app.pointer("pointerdown",2,400,250,"touch");
  await app.pointer("pointermove",2,600,250,"touch");
  assert.ok(Math.abs(parseFloat(app.host.querySelector("img").style.width)-1104)<.001);
  await app.pointer("pointerup",2,600,250,"touch");
  await app.pointer("pointermove",1,220,250,"touch");
  assert.equal(app.host.querySelector(".za-image-workspace").dataset.moving,"true");
  await app.pointer("pointercancel",1,220,250,"touch");
  assert.equal(app.host.querySelector(".za-image-workspace").dataset.moving,"false");
});

test("fit responds to pane/inspector width while small images stay at original size; authority blocks actions",async t=>{
  let valid=true;
  const app=await setup(t,{assertCurrent(){if(!valid)throw new Error("expired");}}); await app.decode();
  await app.resize(900,900);
  await app.render({},true);
  assert.equal(app.host.querySelector(".za-image-workspace").style.getPropertyValue("--za-image-side-inset"),"288px");
  assert.equal(app.host.querySelector("img").style.width,"580px");
  await app.resize(320,740);
  assert.equal(app.host.querySelector("img").style.width,"288px");
  valid=false;await app.click("放大图像");
  assert.match(app.errors.at(-1),/此预览已失效/);
  assert.equal(app.host.querySelector("img").style.width,"288px");
  await app.unmount();assert.equal(app.retired,true);
  const env=await createWebDomTestEnv();t.after(()=>env.cleanup());
  const {imageViewGeometry}=env.loadModule("@liveagent/ui/components/resource-preview/resourceImageGeometry.ts");
  assert.equal(imageViewGeometry({width:40,height:30},{width:800,height:600},0).fit,1);
});

test("thumbnail is inert, contains no nested scroll/tools and reports decode failures",async t=>{
  const app=await setup(t,{thumbnail:true});
  assert.equal(app.host.querySelector("button,input,.za-image-canvas"),null);
  assert.ok(app.host.querySelector(".za-image-cover-content"));
  await app.decode();assert.equal(app.host.querySelector(".za-image-loading"),null);
  await app.env.act(async()=>app.host.querySelector("img").dispatchEvent(new Event("error")));
  assert.match(app.errors.at(-1),/图片未能解码/);
});

test("SVG uses bounded metadata and the same image tools behind its original scriptless network boundary",async t=>{
  const app=await setup(t,{url:undefined,document:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"/>'});
  const frame=app.host.querySelector("iframe");assert.equal(frame.getAttribute("sandbox"),"");
  assert.equal(frame.getAttribute("referrerpolicy"),"no-referrer");
  await app.decode();await app.click("旋转图像");assert.match(frame.style.transform,/90deg/);
  const previous=Object.getOwnPropertyDescriptor(globalThis,"DOMParser");globalThis.DOMParser=app.env.dom.window.DOMParser;
  t.after(()=>{if(previous)Object.defineProperty(globalThis,"DOMParser",previous);else delete globalThis.DOMParser;});
  const {previewSVGDimensions}=app.env.loadModule("@liveagent/ui/components/resource-preview/previewImageDimensions.ts");
  const {isolatedPreviewDocument}=app.env.loadModule("@liveagent/ui/components/resource-preview/previewPolicy.ts");
  const source='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"><script>window.parent.test=true</script><image href="https://invalid.test/private.png"/></svg>';
  assert.deepEqual(previewSVGDimensions(source),{width:800,height:400});
  assert.throws(()=>previewSVGDimensions('<html xmlns="http://www.w3.org/1999/xhtml"/>'),/无效/);
  assert.throws(()=>previewSVGDimensions('<svg xmlns="http://www.w3.org/2000/svg" width="9000" height="800"/>'),/尺寸/);
  assert.match(isolatedPreviewDocument(source,"image"),/script-src 'none'; connect-src 'none'; img-src data:/);
  assert.match(isolatedPreviewDocument(source,"image"),/html,body\{width:100%;height:100%/);
});
