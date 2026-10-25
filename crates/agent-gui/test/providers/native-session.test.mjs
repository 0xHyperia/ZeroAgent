import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
const session=(name="a",id=7)=>({sessionHandle:"za-session-"+name.repeat(64),user:{id,email:"user"+id+"@example.test",status:"active"},authKind:"oauth",expiresAtMs:Date.now()+3_600_000,accountScope:"https://usa0.top|user:"+id});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(t,handler,initial={}) {
  const previous={localStorage:globalThis.localStorage,window:globalThis.window,fetch:globalThis.fetch};
  t.after(()=>Object.assign(globalThis,previous));
  const values=new Map(Object.entries(initial));
  globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
  globalThis.window=new EventTarget();
  globalThis.fetch=()=>{throw Error("Native account requests must not use frontend fetch");};
  const calls=[],listeners=new Map();
  const loader=createTsModuleLoader({mocks:{"@tauri-apps/api/core":{invoke:async(command,args)=>{calls.push({command,args});return handler(command,args);}},"@tauri-apps/api/event":{listen:async(name,callback)=>{listeners.set(name,callback);return ()=>listeners.delete(name);}},"./installation":{getInstallationID:()=>"fixture-installation"}}});
  return {module:loader.loadModule("src/lib/relay/nativeSession.ts"),loader,values,calls,listeners};
}
test("native bootstrap is single flight and keeps only an opaque summary in memory",async t=>{
  const f=fixture(t,()=>session());
  const [a,b]=await Promise.all([f.module.initializeNativeAccount(),f.module.initializeNativeAccount()]);
  assert.equal(a.sessionHandle,b.sessionHandle);
  assert.equal(f.calls.length,1);
  assert.equal(f.values.size,0);
  const client=f.loader.loadModule("src/lib/relay/client.ts");
  assert.deepEqual(await client.getNativeProfileCredential(),{sessionHandle:a.sessionHandle});
  assert.equal(client.getRelayAccessToken(),a.sessionHandle);
  assert.equal(client.nativeProfileCredentialMatches({sessionHandle:session("b",8).sessionHandle}),false);
});
test("legacy plaintext tokens are imported once then removed after native acceptance",async t=>{
  const initial={"zeroagent.relay.access-token":"legacy-access","zeroagent.relay.refresh-token":"legacy-refresh","zeroagent.relay.auth-kind":"oauth"};
  const f=fixture(t,command=>command==="account_session_bootstrap"?null:session(),initial);
  await f.module.initializeNativeAccount();
  assert.deepEqual(f.calls.map(call=>call.command),["account_session_bootstrap","account_session_import_legacy"]);
  assert.equal(f.calls[1].args.legacy.accessToken,"legacy-access");
  assert.equal(f.values.size,0);
  await f.module.initializeNativeAccount();
  assert.equal(f.calls.length,2);
});
test("a late bootstrap success or failure cannot overwrite or reject a newer login",async t=>{
  for(const mode of ["success","auth-error","network-error"]){
    await t.test(mode,async t=>{
      const pending=deferred();const f=fixture(t,()=>pending.promise);
      const old=f.module.initializeNativeAccount();
      await new Promise(resolve=>setImmediate(resolve));
      const next=session("b",8);f.module.acceptNativeSession(next);
      if(mode==="success")pending.resolve(session());else pending.reject(Error(mode==="auth-error"?"USA_ZERO_PROFILE_AUTH_REQUIRED":"temporary network failure"));
      assert.equal((await old).sessionHandle,next.sessionHandle);
      assert.equal((await f.module.initializeNativeAccount()).sessionHandle,next.sessionHandle);
      assert.equal(f.module.rejectNativeSession(null),false);
      assert.equal(f.module.nativeSessionHandle(),next.sessionHandle);
    });
  }
});
test("late refresh rejection and ended events for account A leave B active",async t=>{
  const pending=deferred();const f=fixture(t,command=>command==="account_session_bootstrap"?session():pending.promise);
  await f.module.initializeNativeAccount();
  const old=f.module.requireNativeSession(true);
  await new Promise(resolve=>setImmediate(resolve));
  f.module.acceptNativeSession(session("b",8));
  pending.reject(Error("USA_ZERO_PROFILE_AUTH_REQUIRED"));
  await assert.rejects(old,/AUTH_REQUIRED/);
  f.listeners.get("account-session-ended")({payload:session().sessionHandle});
  assert.equal(f.module.nativeSessionHandle(),session("b",8).sessionHandle);
  f.listeners.get("account-session-ended")({payload:session("b",8).sessionHandle});
  assert.equal(f.module.nativeSessionHandle(),"");
});
test("native account and key requests carry handles and reject a key response after switching accounts",async t=>{
  const pending=deferred();const f=fixture(t,command=>command==="account_session_bootstrap"?session():command==="account_session_http"?{status:200,body:{success:true,data:{total:1,items:[{id:11,key:"••••••••",key_masked:true}]}}}:pending.promise);
  const result=await f.module.nativeAccountRequest("/app/keys","GET",undefined,true,true);
  assert.equal(result.items[0].key,"••••••••");
  const request=f.calls.find(call=>call.command==="account_session_http").args.request;
  assert.equal(request.sessionHandle,session().sessionHandle);
  assert.equal(request.path,"/api/v1/app/keys");
  const reveal=f.module.nativeRevealKey(11,"fixture-password");
  await new Promise(resolve=>setImmediate(resolve));
  f.module.acceptNativeSession(session("b",8));
  pending.resolve("fixture-private-key");
  await assert.rejects(reveal,/session changed/);
  assert.equal(f.values.size,0);
});
test("failed native logout keeps the handle for retry and successful retry clears it",async t=>{
  let fail=true;const f=fixture(t,command=>{if(command==="account_session_bootstrap")return session();if(fail)throw Error("vault unavailable");});
  await f.module.initializeNativeAccount();
  await assert.rejects(f.module.logoutNativeAccount(),/vault unavailable/);
  assert.equal(f.module.nativeSessionHandle(),session().sessionHandle);
  fail=false;await f.module.logoutNativeAccount();
  assert.equal(f.module.nativeSessionHandle(),"");
});
test("native summaries reject raw token fields",async t=>{
  const f=fixture(t,()=>null);
  assert.throws(()=>f.module.acceptNativeSession({...session(),access_token:"unexpected-token"}),/incompatible/);
  assert.equal(f.module.nativeSessionHandle(),"");
});
test("vault failure during native refresh preserves the handle and retries the same session",async t=>{
  const expired={...session(),expiresAtMs:Date.now()-1};let fail=true;
  const f=fixture(t,command=>{if(command==="account_session_bootstrap")return expired;if(command==="account_session_current"){if(fail)throw Error("Unable to save the platform account vault");return session();}throw Error("unexpected native command");});
  await assert.rejects(f.module.requireNativeSession(),/platform account vault/);
  assert.equal(f.module.nativeSessionHandle(),expired.sessionHandle);
  fail=false;
  assert.equal((await f.module.requireNativeSession()).sessionHandle,expired.sessionHandle);
  assert.deepEqual(f.calls.map(call=>call.command),["account_session_bootstrap","account_session_current","account_session_current"]);
  for(const call of f.calls.slice(1))assert.deepEqual(call.args,{sessionHandle:expired.sessionHandle,forceRefresh:false});
  assert.equal(f.values.size,0);
});
test("failed native restoration retries bootstrap before considering legacy import",async t=>{
  let fail=true;const initial={"zeroagent.relay.access-token":"legacy-access","zeroagent.relay.refresh-token":"legacy-refresh"};
  const f=fixture(t,command=>{assert.equal(command,"account_session_bootstrap");if(fail)throw Error("Unable to save the platform account vault");return session();},initial);
  await assert.rejects(f.module.initializeNativeAccount(),/platform account vault/);
  assert.equal(f.module.nativeSessionHandle(),"");
  assert.equal(f.values.get("zeroagent.relay.access-token"),"legacy-access");
  fail=false;
  assert.equal((await f.module.initializeNativeAccount()).user.id,7);
  assert.deepEqual(f.calls.map(call=>call.command),["account_session_bootstrap","account_session_bootstrap"]);
  assert.equal(f.values.size,0);
});
