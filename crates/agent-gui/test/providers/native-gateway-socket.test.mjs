import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,connect) {
 const previous={window:globalThis.window,CloseEvent:globalThis.CloseEvent};t.after(()=>Object.assign(globalThis,previous));
 globalThis.crypto??=webcrypto;
 globalThis.CloseEvent=class extends Event{constructor(type,options){super(type);Object.assign(this,options);}};
 class BrowserSocket {constructor(...args){this.args=args;}}
 globalThis.window={WebSocket:BrowserSocket,location:{href:"http://localhost/"}};
 let handle="za-session-"+"a".repeat(64);let notify;const calls=[];
 const loader=createTsModuleLoader({mocks:{"@tauri-apps/api/core":{invoke:async(command,args)=>{calls.push({command,args});if(command==="account_gateway_socket_connect")return connect?.(args);}},"@tauri-apps/api/event":{listen:async(name,callback)=>{assert.equal(name,"account-gateway-socket");notify=callback;return ()=>{};}},"./nativeSession":{nativeSessionHandle:()=>handle}}});
 await loader.loadModule("src/lib/relay/nativeGatewaySocket.ts").installNativeGatewaySockets();
 return {calls,BrowserSocket,changeAccount:()=>handle="za-session-"+"b".repeat(64),emit:(id,kind,data)=>notify({payload:{id,kind,data}})};
}
test("native gateway sockets use opaque handles, preserve binary frames and keep other sockets unchanged",async t=>{
 const f=await fixture(t);
 const ordinary=new window.WebSocket("wss://example.test/other");assert.ok(ordinary instanceof f.BrowserSocket);
 const socket=new window.WebSocket("wss://agent.usa0.top/ws/v2",["liveagent.v2.pb"]);await tick();
 const request=f.calls[0].args.request;assert.equal(request.origin,"https://agent.usa0.top");assert.equal(request.path,"/ws/v2");assert.match(request.sessionHandle,/^za-session-/);assert.equal("token" in request,false);
 let opened=0;socket.onopen=()=>opened++;f.emit(request.id,"open");assert.equal(opened,1);
 const bytes=new Uint8Array([0,255,16,42]);socket.send(bytes);bytes.fill(7);await tick();
 const sent=f.calls.find(call=>call.command==="account_gateway_socket_send").args.request;
 assert.deepEqual([...Buffer.from(sent.data,"base64")],[0,255,16,42]);assert.equal(sent.sessionHandle,request.sessionHandle);assert.equal(socket.bufferedAmount,0);
 let received;socket.onmessage=event=>received=event.data;f.emit(request.id,"message",Buffer.from([4,3,2,1]).toString("base64"));assert.deepEqual([...new Uint8Array(received)],[4,3,2,1]);
 assert.throws(()=>socket.send("text"),/binary/);
 socket.close();await tick();assert.equal(socket.readyState,3);
});
test("closing before connection dispatch prevents a native socket from starting",async t=>{
 const f=await fixture(t);const socket=new window.WebSocket("wss://agent.usa0.top/ws/v2","liveagent.v2.pb");socket.close();await tick();
 assert.equal(socket.readyState,3);assert.equal(f.calls.filter(call=>call.command==="account_gateway_socket_connect").length,0);
});
test("a connection completing after close is closed again on the native side",async t=>{
 let release;const pending=new Promise(resolve=>release=resolve);const f=await fixture(t,()=>pending);
 const socket=new window.WebSocket("wss://agent.usa0.top/ws/v2","liveagent.v2.pb");await tick();socket.close();await tick();release();await tick();
 assert.equal(socket.readyState,3);assert.equal(f.calls.filter(call=>call.command==="account_gateway_socket_close").length,2);
});
test("events from an old account are discarded before delivery to the new account UI",async t=>{
 const f=await fixture(t);const socket=new window.WebSocket("wss://agent.usa0.top/ws/v2/terminal","liveagent.v2.pb");await tick();const id=f.calls[0].args.request.id;f.emit(id,"open");let messages=0;socket.onmessage=()=>messages++;
 f.changeAccount();f.emit(id,"message",Buffer.from("old-account-frame").toString("base64"));await tick();assert.equal(messages,0);assert.equal(socket.readyState,3);
});
