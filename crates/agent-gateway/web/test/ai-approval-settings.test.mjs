import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

test("WebUI AI approval settings preserve backend ownership and active model catalog", async()=>{
 let doc={computer:{},aiApproval:{mode:"off"},customProviders:[{id:"p",models:[{id:"small"},{id:"disabled"}],activeModels:["small"]}]};
 const updates=[];
 const client={getSettings:async()=>doc,updateSettings:async(update)=>{updates.push(update);doc={...doc,...update};}};
 const loader=createWebModuleLoader({rootDir:fileURLToPath(new URL("../",import.meta.url)),mocks:{
  "../lib/gatewaySocket":{getGatewayWebSocketClient:()=>client},
  "../lib/storage":{loadToken:()=>"fixture"},
  "../pages/settings/DevicesSection":{DevicesSection:()=>null},
  "@liveagent/ui/components/IconSet":{MonitorSmartphone:()=>null},
  "@liveagent/ui/lib/resourceHost":{configureResourceHostCapabilities(){},nativeResourceHostCapabilities:{}},
 }});
 const {settingsHostAdapter}=loader.loadModule("src/agent-ui-adapters/settingsExtension.tsx");
 const initial=await settingsHostAdapter.kbrain.getSettings();
 assert.deepEqual(initial.models,[{provider:"p",id:"small",name:"small"}]);
 for(const mode of ["risk_only","auto","off"]){
  const next=await settingsHostAdapter.kbrain.updateSettings({aiApproval:{mode,provider:"p",model:"small"}});
  assert.equal(next.aiApproval.mode,mode);
  assert.deepEqual(Object.keys(updates.at(-1)),["aiApproval"]);
 }
});

test("Native device settings editors keep their own read versions",async()=>{
 const make=(version)=>({settingsSyncProtocol:"zeroagent.settings-sync.v1",configurationRevision:`za-config-v1-${version}`,
  uiPreferencesRevision:`za-ui-v1-${version}`,customProviders:[],aiApproval:{mode:"off"},computer:{}});
 let doc=make("first");
 const updates=[];
 const client={getSettings:async()=>doc,updateSettings:async(update)=>{updates.push(update);}};
 const loader=createWebModuleLoader({rootDir:fileURLToPath(new URL("../",import.meta.url)),mocks:{
  "../lib/gatewaySocket":{getGatewayWebSocketClient:()=>client},"../lib/storage":{loadToken:()=>"fixture"},
  "../pages/settings/DevicesSection":{DevicesSection:()=>null},"@liveagent/ui/components/IconSet":{MonitorSmartphone:()=>null},
  "@liveagent/ui/lib/resourceHost":{configureResourceHostCapabilities(){},nativeResourceHostCapabilities:{}},
 }});
 const adapter=loader.loadModule("src/agent-ui-adapters/settingsExtension.tsx").settingsHostAdapter.kbrain;
 const first=await adapter.getSettings();
 doc=make("second");
 const second=await adapter.getSettings();
 await adapter.updateSettings({aiApproval:{mode:"off"}},first);
 assert.equal(updates[0].configurationRevision,"za-config-v1-first");
 assert.equal(updates[0].uiPreferencesRevision,"za-ui-v1-first");
 await adapter.updateSettings({computer:{}},second);
 assert.equal(updates[1].configurationRevision,"za-config-v1-second");
});
