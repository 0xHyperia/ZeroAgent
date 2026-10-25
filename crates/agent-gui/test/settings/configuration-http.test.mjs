import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

async function fixture(run) {
  const previousStorage=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
  const values=new Map();
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value))}});
  const document={settings:{version:"kbrain.agent.v1",mode:"kbrain",providers:[],models:[]},
    mcp:{settings:{servers:[{id:"m",enabled:false,transport:"stdio",command:"node",args:[],url:"",timeoutMs:60000}],selected:[]}},
    prompts:{revision:0,globalTemplates:[],projectPrompts:{}}};
  let revision=0;
  const calls=[];
  const tag=resource=>`"${resource}-${revision}"`;
  const server=createServer(async(request,response)=>{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
    calls.push({path:request.url,method:request.method,headers:request.headers,body});
    const resource=request.url.split("/").at(-1);
    response.setHeader("content-type","application/json");
    response.setHeader("x-zeroagent-configuration","zeroagent.configuration.v1");
    if(request.method==="PUT") {
      if(!request.headers["if-match"]) {response.writeHead(428);response.end(JSON.stringify({error:"ZEROAGENT_CONFIGURATION_VERSION_REQUIRED"}));return;}
      if(request.headers["if-match"]!==tag(resource)) {response.writeHead(412);response.end(JSON.stringify({error:"ZEROAGENT_CONFIGURATION_CHANGED"}));return;}
      const update=request.url==="/v1/configuration"?body:{settings:body};
      if(update.settings) document.settings={...document.settings,...update.settings};
      if(update.mcp) document.mcp.settings=structuredClone(update.mcp);
      if(update.templates) document.prompts.globalTemplates=structuredClone(update.templates);
      for(const project of update.projects??[]) document.prompts.projectPrompts["hashed-project-id"]={...project};
      revision++;
    }
    response.setHeader("etag",tag(resource));
    response.end(JSON.stringify(request.url==="/v1/configuration"?document:document.settings));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const loader=createTsModuleLoader({mocks:{
    [new URL("../../src/lib/host.ts",import.meta.url).pathname]:{isKBrainBrowserHost:()=>true,isKBrainBackendEnabled:()=>true,isTauriHost:()=>false,kBrainOwnedDesktopCommand:()=>false},
    "@tauri-apps/api/core":{invoke:()=>assert.fail("Native HTTP browser must not invoke Tauri")},
  }});
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({baseUrl:`http://127.0.0.1:${server.address().port}`,token:"fixture",protocolVersion:"kbrain.agent.v1"});
  const storage=loader.loadModule("src/lib/settings/storage.ts");
  try {await run({loader,storage,calls,values,document,tag,changeElsewhere:()=>{revision++;}});}
  finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));if(previousStorage)Object.defineProperty(globalThis,"localStorage",previousStorage);else delete globalThis.localStorage;}
}

test("Native HTTP browser reads one complete document and saves MCP/templates/projects once",async()=>fixture(async f=>{
  const before=await f.storage.loadPersistedSettings();
  assert.equal(before.backendConfigurationVersion,'"configuration-0"');
  assert.deepEqual(f.calls.map(call=>call.path),["/v1/settings","/v1/configuration"]);
  const next={...before,mcp:{...before.mcp,servers:before.mcp.servers.map(server=>({...server,description:"Edited MCP"}))},
    agents:[{id:"prompt",name:"Prompt",description:"",prompt:"New instructions",enabled:true}],
    system:{...before.system,workspaceResourceSettings:{"/fixture":{projectPrompt:"Project instructions",projectPromptStrategy:"replace"}}}};
  const result=await f.storage.persistSettings(before,next);
  const writes=f.calls.filter(call=>call.method==="PUT");
  assert.equal(writes.length,1);assert.equal(writes[0].path,"/v1/configuration");
  assert.equal(writes[0].headers["if-match"],before.backendConfigurationVersion);
  assert.deepEqual(Object.keys(writes[0].body).sort(),["mcp","projects","templates"]);
  assert.equal(result.backendConfigurationVersion,'"configuration-1"');
  assert.equal(result.mcp.servers[0].description,"Edited MCP");
  const reloaded=await f.storage.loadPersistedSettings();
  assert.equal(reloaded.system.workspaceResourceSettings["/fixture"].projectPrompt,"Project instructions");
}));

test("SDK writes carry the supplied document's version rather than the newest read",async()=>fixture(async f=>{
  const client=f.loader.loadModule("src/lib/kbrain/client.ts").createKBrainClient();
  const old=await client.getSettings();
  assert.equal(old.configurationVersion,'"settings-0"');
  assert.equal(JSON.stringify(old).includes("configurationVersion"),false,"read metadata is not serialized as configuration");
  f.changeElsewhere();
  const fresh=await client.getSettings();assert.notEqual(old.configurationVersion,fresh.configurationVersion);
  await assert.rejects(client.updateSettings({},old.configurationVersion),error=>error.status===412);
  assert.equal(f.calls.at(-1).headers["if-match"],old.configurationVersion);
  await assert.rejects(client.updateSettings({}),error=>error.status===428);
  const saved=await client.updateSettings({},fresh.configurationVersion);
  assert.equal(saved.configurationVersion,'"settings-2"');
}));

test("managed input modalities backfill is versioned and re-reads its committed snapshot",async()=>fixture(async f=>{
  Object.assign(f.document.settings,{defaultProvider:"relay-key-1",defaultModel:"gpt-4o",providers:[{
    id:"relay-key-1",name:"Managed",type:"codex",api:"openai-responses",baseUrl:"https://managed.invalid/v1",
    models:[{id:"gpt-4o",name:"GPT-4o",contextWindow:128000,maxOutputToken:16384}]
  }]});
  const loaded=await f.storage.loadPersistedSettings();
  const write=f.calls.find(call=>call.method==="PUT");
  assert.equal(write.path,"/v1/configuration");
  assert.equal(write.headers["if-match"],'"configuration-0"');
  assert.equal(write.body.settings.providers[0].models[0].inputModalities.includes("image"),true);
  assert.equal(loaded.backendConfigurationVersion,'"configuration-1"');
  assert.equal(f.calls.at(-1).method,"GET");
  assert.equal(f.calls.at(-1).path,"/v1/configuration");
}));

test("queued HTTP edits inherit only an exact successful baseline; failures still save UI preferences",async()=>fixture(async f=>{
  const before=await f.storage.loadPersistedSettings();
  const first={...before,agents:[{id:"one",name:"One",description:"",prompt:"First",enabled:true}]};
  const second={...first,mcp:{...first.mcp,servers:first.mcp.servers.map(server=>({...server,description:"Second"}))}};
  await f.storage.persistSettings(before,first);await f.storage.persistSettings(first,second);
  assert.deepEqual(f.calls.filter(call=>call.method==="PUT").map(call=>call.headers["if-match"]),['"configuration-0"','"configuration-1"']);
  f.changeElsewhere();await f.storage.loadPersistedSettings();
  const stale={...before,theme:"dark",agents:[{id:"old",name:"Old",description:"",prompt:"Stale",enabled:true}]};
  await assert.rejects(f.storage.persistSettings(before,stale),error=>error.code==="native_settings_changed");
  assert.equal(f.calls.at(-1).headers["if-match"],before.backendConfigurationVersion);
  assert.equal(JSON.parse([...f.values.values()].at(-1)).theme,"dark");
  assert.equal(f.document.prompts.globalTemplates[0].id,"one");
}));
