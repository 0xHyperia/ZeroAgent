import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const script=readFileSync(new URL("../../internal/account/cloud_site_preview.js",import.meta.url),"utf8");
const appOrigin="https://app.example.net",channel="11111111-1111-4111-8111-111111111111";
function preview(t){
 const dom=new JSDOM('<!doctype html><html><head><title>Test</title></head><body><section><h1>Title</h1><p>Original paragraph</p></section></body></html>',{url:"https://site.example.net/v/test-token/pages/index.html",runScripts:"outside-only",pretendToBeVisual:true});
 const w=dom.window,messages=[],parent={postMessage(data,origin){messages.push({data,origin});}};
 Object.defineProperty(w,"parent",{value:parent});w.ResizeObserver=class{observe(){}};
 w.eval(`(${script})(${JSON.stringify(appOrigin)})`);
 const command=(command,extra={},origin=appOrigin,source=parent)=>w.dispatchEvent(new w.MessageEvent("message",{data:{type:"zeroagent-site-command",channel,command,...extra},origin,source}));
 command("init");t.after(()=>w.close());
 return {w,messages,command,click(selector){w.document.querySelector(selector).dispatchEvent(new w.MouseEvent("click",{bubbles:true,cancelable:true}));}};
}
test("site bridge accepts only its parent origin and never sends the access token",t=>{
 const p=preview(t);p.command("mode",{enabled:true},"https://other.invalid");p.click("h1");assert.equal(p.messages.filter(m=>m.data.event==="selection").length,0);
 p.command("mode",{enabled:true},appOrigin,p.w);p.click("h1");assert.equal(p.messages.filter(m=>m.data.event==="selection").length,0);
 p.command("mode",{enabled:true});p.click("h1");assert.equal(p.messages.at(-1).data.event,"selection");assert.equal(p.messages.at(-1).origin,appOrigin);assert.ok(!JSON.stringify(p.messages).includes("test-token"));
});
test("site element locators survive reload and independent selection order",t=>{
 const a=preview(t),b=preview(t);a.command("mode",{enabled:true});b.command("mode",{enabled:true});
 a.click("p");const original=a.messages.at(-1).data.id;b.click("h1");b.click("p");assert.equal(b.messages.at(-1).data.id,original);
 assert.match(original,/^site:[a-z0-9]+:\d{1,10}$/);
});
test("site drag selection describes the common page block and preserves normal clicks outside modification mode",t=>{
 const p=preview(t);let clicks=0;p.w.document.querySelector("h1").addEventListener("click",()=>clicks++);p.click("h1");assert.equal(clicks,1);
 p.command("mode",{enabled:true});
 p.w.document.querySelector("h1").dispatchEvent(new p.w.MouseEvent("pointerdown",{bubbles:true,button:0,clientX:10,clientY:10}));
 p.w.document.querySelector("p").dispatchEvent(new p.w.MouseEvent("pointermove",{bubbles:true,clientX:100,clientY:100}));
 p.w.document.querySelector("p").dispatchEvent(new p.w.MouseEvent("pointerup",{bubbles:true,button:0}));
 const selection=p.messages.find(m=>m.data.event==="selection").data;assert.match(selection.selector,/section/);assert.match(selection.quote,/Title/);assert.match(selection.quote,/Original paragraph/);
});
