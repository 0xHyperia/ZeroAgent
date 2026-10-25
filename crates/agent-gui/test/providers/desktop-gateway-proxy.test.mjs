import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
const settings={remote:{enabled:true,gatewayUrl:"https://agent.usa0.top",gatewayPort:443,agentId:"frontend-config-is-not-authority"}};
async function fixture(t,handler) {
 const previous={fetch:globalThis.fetch,navigator:Object.getOwnPropertyDescriptor(globalThis,"navigator")};t.after(()=>{globalThis.fetch=previous.fetch;if(previous.navigator)Object.defineProperty(globalThis,"navigator",previous.navigator);else delete globalThis.navigator;});
 Object.defineProperty(globalThis,"navigator",{configurable:true,value:{platform:"Win32"}});globalThis.fetch=()=>{throw Error("native control requests must not use fetch");};
 let handle="za-session-"+"a".repeat(64);const calls=[];
 const loader=createTsModuleLoader({mocks:{"@tauri-apps/api/core":{invoke:async(command,args)=>{calls.push({command,args});return handler?.(command,args);}},"./nativeSession":{requireNativeSession:async()=>({sessionHandle:handle}),nativeSessionHandle:()=>handle},"./client":{RELAY_ORIGIN:"https://usa0.top"},"./installation":{getInstallationID:()=>"stable-installation"}}});
 return {calls,changeAccount:()=>handle="za-session-"+"b".repeat(64),execution:loader.loadModule("src/lib/relay/desktopExecution.ts"),registration:loader.loadModule("src/lib/relay/deviceRegistration.ts"),request:loader.loadModule("src/lib/relay/desktopRequest.ts").desktopRequest};
}
test("desktop APIs preserve query parameters while device tokens stay native",async t=>{
 const f=await fixture(t,(command,args)=>{
  if(command==="account_device_identity")return {agentId:"owned-device"};
  if(command==="account_gateway_http")return {status:200,body:args.request.path.includes("environments?")?{environments:[]}:{conversations:[]}};
  if(command==="account_device_register")return {id:"owned-device"};
 });
 await f.execution.getDesktopEnvironments(settings);await f.execution.getDesktopConversationRoutes(settings,"remote-device");await f.registration.registerDesktopDevice(settings);await f.registration.rotateDesktopAgentToken(settings,"owned-device");
 const requests=f.calls.filter(c=>c.command==="account_gateway_http").map(c=>c.args.request);
 assert.deepEqual(requests.map(r=>r.path),["/api/desktop/environments?local_agent_id=owned-device&local_device_id=owned-device","/api/desktop/conversation-routes?device_id=remote-device"]);
 assert.ok(requests.every(r=>r.origin==="https://agent.usa0.top"&&r.sessionHandle.startsWith("za-session-")&&!r.headers));
 const registration=f.calls.find(c=>c.command==="account_device_register").args.request;
 assert.equal(registration.installationId,"stable-installation");assert.equal(registration.agentId,undefined);assert.equal(registration.token,undefined);assert.equal(registration.accountScope,undefined);
 assert.equal(f.calls.some(c=>c.command.startsWith("device_credential_")),false);
});
test("changing accounts reuses installation identity and passes the new native handle",async t=>{
 const f=await fixture(t,()=>({id:"native-owned-device"}));await f.registration.registerDesktopDevice(settings);f.changeAccount();await f.registration.registerDesktopDevice(settings);
 const [a,b]=f.calls.map(c=>c.args.request);assert.equal(a.installationId,b.installationId);assert.notEqual(a.sessionHandle,b.sessionHandle);assert.equal(b.agent_id,undefined);
});
test("native control errors are surfaced without a frontend token refresh or raw proxy fallback",async t=>{
 const f=await fixture(t,()=>({status:401,body:{error:"Native authorization rejected"}}));await assert.rejects(f.request(settings,"/api/desktop/environments"),/Native authorization rejected/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].command,"account_gateway_http");
});
test("aborted and stale desktop responses are not delivered",async t=>{
 let finish;const pending=new Promise(resolve=>finish=resolve);const f=await fixture(t,()=>pending);
 const aborted=new AbortController();aborted.abort(Error("cancelled"));await assert.rejects(f.request(settings,"/api/desktop/environments",{signal:aborted.signal}),/cancelled/);assert.equal(f.calls.length,0);
 const old=f.request(settings,"/api/desktop/environments");await new Promise(resolve=>setImmediate(resolve));f.changeAccount();finish({status:200,body:{environments:[]}});await assert.rejects(old,/session changed/);
});
test("device registration responses are discarded after switching accounts",async t=>{
 let finish;const pending=new Promise(resolve=>finish=resolve);const f=await fixture(t,()=>pending);const old=f.registration.registerDesktopDevice(settings);await new Promise(resolve=>setImmediate(resolve));f.changeAccount();finish({id:"old-account-device"});await assert.rejects(old,/session changed/);
});
test("disabled remote registration does not call native account APIs",async t=>{
 const f=await fixture(t);assert.equal(await f.registration.registerDesktopDevice({remote:{...settings.remote,enabled:false}}),null);assert.equal(f.calls.length,0);
});
