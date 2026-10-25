import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function fixture({native = true} = {}) {
  const loader = createTsModuleLoader();
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({baseUrl:"http://fixture",token:"public-fixture",protocolVersion:"kbrain.agent.v1"});
  const calls = [];
  let revision = 1;
  let missingReceiptVersion = false;
  const scopes = new Map();
  const state = scope => scopes.get(scope) ?? {enabled:true,selected:[]};
  const version = scope => JSON.stringify(scope + ":" + revision);
  const fetchImpl = async (input,init) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : null;
    const scope = body?.workdir ?? url.searchParams.get("workdir") ?? "";
    const call = {method:init.method ?? "GET",scope,body,headers};
    calls.push(call);
    const send = (document,status=200,withVersion=true) => new Response(JSON.stringify(document), {status,headers:{"Content-Type":"application/json",...(native?{"x-zeroagent-configuration":"zeroagent.configuration.v1",...(withVersion?{etag:version(scope)}:{})}:{})}});
    if(call.method === "PUT") {
      if(native && !headers.has("if-match")) return send({error:"version required"},428);
      if(native && headers.get("if-match") !== version(scope)) return send({error:"configuration changed"},412);
      scopes.set(scope,{...body});revision++;
      return send({revision,settings:state(scope),...(missingReceiptVersion?{warning:"saved; read again"}:{})},200,!missingReceiptVersion);
    }
    return send({rootDir:"fixture",skills:[],revision,settings:state(scope)});
  };
  const adapter = loader.loadModule("src/agent-ui-adapters/kbrainSkills.ts").createKbrainSkillsAdapter(fetchImpl);
  return {adapter,calls,advance:()=>revision++,loseReceiptVersion:()=>{missingReceiptVersion=true;}};
}

test("Skills resource adapter sends only the actual editor baseline, including workspace scopes",async()=>{
  const f=fixture();
  const original=await f.adapter.list("/project a");
  assert.equal(Object.getOwnPropertyDescriptor(original,"configurationVersion").enumerable,false);
  assert.equal(Object.getOwnPropertyDescriptor(original,"configurationVersion").writable,false);
  assert.equal(JSON.stringify(original).includes("configurationVersion"),false);
  f.advance();
  const fresh=await f.adapter.list("/project a");
  const body={workdir:"/project a",enabled:true,selected:[],mode:"custom",skillNames:["workspace-skill"]};
  let count=f.calls.length;
  await assert.rejects(f.adapter.settings(body,original),error=>error.status===412);
  assert.equal(f.calls.length,count+1,"saving must not silently read the latest version first");
  assert.equal(f.calls.at(-1).headers.get("if-match"),original.configurationVersion);
  await assert.rejects(f.adapter.settings(body),error=>error.status===428);
  const other=await f.adapter.list("/project-b");
  await assert.rejects(f.adapter.settings(body,other),error=>error.status===412);
  const committed=await f.adapter.settings(body,fresh);
  assert.notEqual(committed.configurationVersion,fresh.configurationVersion);
  assert.deepEqual(committed.settings.skillNames,["workspace-skill"]);
  assert.equal(f.calls.at(-1).body.mode,"custom");
  const second=await f.adapter.settings({...body,mode:"off"},committed);
  assert.equal(f.calls.at(-1).headers.get("if-match"),committed.configurationVersion);
  assert.notEqual(second.configurationVersion,committed.configurationVersion);
  await f.adapter.list("/project a");
  await assert.rejects(f.adapter.settings(body,fresh),error=>error.status===412,"a later GET cannot promote an old editor");
  assert.ok(f.calls.every(call=>call.headers.get("authorization")==="Bearer public-fixture"));
});

test("acknowledged Skills save without a refreshed version does not lend one to the next edit",async()=>{
  const f=fixture();const read=await f.adapter.list();f.loseReceiptVersion();
  const saved=await f.adapter.settings({enabled:false,selected:[]},read);
  assert.equal(saved.configurationVersion,undefined);
  assert.equal(saved.warning,"saved; read again");
  const count=f.calls.length;
  await assert.rejects(f.adapter.settings({enabled:true,selected:[]},saved),error=>error.status===428);
  assert.equal(f.calls.length,count+1);
});

test("standalone Go Skills settings keep their existing unversioned protocol",async()=>{
  const f=fixture({native:false});const read=await f.adapter.list();
  assert.equal(read.configurationVersion,undefined);
  const saved=await f.adapter.settings({enabled:false,selected:["standalone-skill"]},read);
  assert.equal(saved.settings.enabled,false);
  assert.equal(f.calls.at(-1).headers.has("if-match"),false);
});
