import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return {promise,resolve}; }
const cloud = (owner) => [{runtime_kind:"web_chat",name:owner,online:true,workspaces:[{id:`cloud-${owner}`,name:owner}]}];

async function mountSession(t, {initialUser=Promise.resolve({id:1}), environments=async()=>cloud("b"), selection=async()=>null, logout=async()=>{}}={}) {
  const tokens=[];
  const env=await createWebDomTestEnv({mocks:{
    "@/lib/relay/client":{getRelayCurrentUser:()=>initialUser,loginRelay:async()=>({user:{id:2}}),loginRelay2FA:async()=>({user:{id:2}}),registerRelay:async()=>({user:{id:2}}),logoutRelay:logout},
    "@/lib/executionTargets":{canReuseDeviceSelection:()=>false,encodeSelectionCredential:(value)=>`lease:${value.device_id}`,getExecutionEnvironments:environments,mergeExecutionPresence:(items)=>items,publishExecutionPresence:()=>{},selectExecutionTarget:selection,validateExecutionSelection:async()=>true},
    "@/lib/gatewaySocket":{GATEWAY_SELECTION_INVALID_EVENT:"selection-invalid",resetGatewayWebSocketClient:()=>{}},
    "@/lib/storage":{setEphemeralCredential:(value)=>tokens.push(value)},
  }});
  const {useGatewaySession}=env.loadModule("src/app/hooks/useGatewaySession.ts");
  let current;
  function Probe(){ current=useGatewaySession(null); return null; }
  const host=document.body.appendChild(document.createElement("div"));const root=env.createRoot(host);
  t.after(async()=>{await env.act(async()=>root.unmount());host.remove();env.cleanup();});
  await env.act(async()=>root.render(env.React.createElement(Probe)));
  return {env,tokens,get current(){return current;}};
}

test("a previous account's delayed environment response cannot replace a new login",async(t)=>{
  const old=deferred();let requests=0;
  const app=await mountSession(t,{environments:()=>++requests===1?old.promise:Promise.resolve(cloud("b"))});
  assert.equal(app.current.accountUser.id,1);
  await app.env.act(async()=>app.current.clearSession());
  await app.env.act(async()=>assert.equal(await app.current.login("b@example.test","fixture"),"authenticated"));
  await app.env.act(async()=>{old.resolve(cloud("a"));await old.promise;});
  assert.equal(app.current.accountUser.id,2);
  assert.equal(app.current.environments[0].name,"b");
  assert.equal(app.current.selection.workspace_id,"cloud-b");
});

test("a delayed bootstrap identity cannot replace the user authenticated after it",async(t)=>{
  const old=deferred();const app=await mountSession(t,{initialUser:old.promise});
  await app.env.act(async()=>{await app.current.login("b@example.test","fixture");});
  await app.env.act(async()=>{old.resolve({id:1});await old.promise;});
  assert.equal(app.current.accountUser.id,2);
  assert.equal(app.current.authInitializing,false);
});

test("a device selection completed after logout cannot activate the old lease",async(t)=>{
  const old=deferred();const app=await mountSession(t,{selection:()=>old.promise});
  const pending=app.current.switchExecutionTarget({device_id:"a",runtime_kind:"device_agent"},{id:"a-workspace"}).catch((error)=>error);
  await app.env.act(async()=>app.current.clearSession());
  await app.env.act(async()=>{await app.current.login("b@example.test","fixture");});
  let result;
  await app.env.act(async()=>{old.resolve({runtime_kind:"device_agent",device_id:"a",selection_lease:"a-secret-lease"});result=await pending;});
  assert.match(result.message,/已变更/);
  assert.equal(app.current.accountUser.id,2);
  assert.equal(app.current.selection.runtime_kind,"web_chat");
  assert.ok(app.tokens.every((value)=>!value.includes("lease:a")));
  assert.equal(window.history.state.zeroagentExecutionSelection,undefined);
});

test("an expired tab clears locally without logging out the browser's current account", async (t) => {
  let logouts = 0;
  const app = await mountSession(t, {logout:async()=>{logouts++;}});
  // The transport test covers the server cookie; here the hook must still clear every lease.
  await app.env.act(async () => app.current.clearSession(false));
  assert.equal(app.current.accountUser, null);
  assert.equal(app.current.selection, null);
  assert.equal(app.current.token, "");
  assert.equal(logouts, 0);
  await app.env.act(async () => app.current.login("b@example.test", "fixture"));
  await app.env.act(async () => app.current.clearSession());
  assert.equal(logouts, 1, "explicit logout still revokes its own session");
});
