import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
function fixture(t) {
 const previous={window:globalThis.window,localStorage:globalThis.localStorage};t.after(()=>Object.assign(globalThis,previous));
 const values=new Map();globalThis.window=new EventTarget();globalThis.localStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const summary={sessionHandle:"za-session-"+"a".repeat(64),user:{id:7,email:"user7@example.test"},authKind:"oauth",expiresAtMs:Date.now()+3600000,accountScope:"https://usa0.top|user:7"};
 const loader=createTsModuleLoader({mocks:{"@tauri-apps/api/core":{invoke:async()=>summary},"@tauri-apps/api/event":{listen:async()=>()=>{}},"./installation":{getInstallationID:()=>"fixture"}}});
 return {client:loader.loadModule("src/lib/relay/client.ts"),native:loader.loadModule("src/lib/relay/nativeSession.ts"),summary,values};
}
test("native profile proof uses the verified handle despite stale browser token mutations",async t=>{
 const f=fixture(t);const proof=await f.client.getNativeProfileCredential();
 assert.deepEqual(proof,{sessionHandle:f.summary.sessionHandle});
 f.values.set("zeroagent.relay.access-token","arbitrary-token");f.values.set("zeroagent.relay.auth-kind","password");
 assert.equal(f.client.nativeProfileCredentialMatches(proof),true);
 assert.equal(f.client.getRelayAccessToken(),f.summary.sessionHandle);
 assert.equal(f.client.requiresWebsiteAccountSecurity(),true);
});
test("an old profile rejection cannot clear a newly verified account",async t=>{
 const f=fixture(t);const old=await f.client.getNativeProfileCredential();
 f.native.acceptNativeSession({...f.summary,sessionHandle:"za-session-"+"b".repeat(64),user:{id:8,email:"user8@example.test"},accountScope:"https://usa0.top|user:8"});
 assert.equal(f.client.rejectNativeProfileCredential(old),false);
 assert.equal(f.client.hasStoredRelaySession(),true);
 const active=await f.client.getNativeProfileCredential();
 assert.equal(f.client.rejectNativeProfileCredential(active),true);
 assert.equal(f.client.hasStoredRelaySession(),false);
});
