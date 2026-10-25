import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function fixture() {
  const loader = createTsModuleLoader();
  const {getDefaultSettings,normalizeSettings} = loader.loadModule("src/lib/settings/index.ts");
  const sync = loader.loadModule("../agent-ui/src/lib/settings/sync.ts");
  const {GatewaySettingsSaveLineage} = loader.loadModule("../agent-ui/src/lib/settings/gatewaySettingsSaveLineage.ts");
  const before=normalizeSettings({...getDefaultSettings(),settingsSyncProtocol:"zeroagent.settings-sync.v1",
    configurationRevision:"za-config-v1-read",uiPreferencesRevision:"za-ui-v1-read"});
  const receipt=(settings,version="committed")=>({protocol:"zeroagent.settings-sync.v1",configurationRevision:`za-config-v1-${version}`,
    uiPreferencesRevision:`za-ui-v1-${version}`,snapshot:sync.buildGatewaySettingsSyncPayload({...settings,
      configurationRevision:`za-config-v1-${version}`,uiPreferencesRevision:`za-ui-v1-${version}`})});
  return {before,sync,queue:new GatewaySettingsSaveLineage(),receipt};
}

test("device updates retain the actual read versions and omit metadata-only writes",()=>{
  const {before,sync,queue}=fixture();
  assert.deepEqual(Object.keys(queue.prepare(before,before,"device-a")),[]);
  const update=queue.prepare(before,{...before,theme:"dark"},"device-a");
  assert.equal(update.configurationRevision,before.configurationRevision);
  assert.equal(update.uiPreferencesRevision,before.uiPreferencesRevision);
  assert.equal(update.settingsSyncProtocol,"zeroagent.settings-sync.v1");
  const hydrated=sync.applyGatewaySettingsSyncPayload(before,{configurationRevision:"new-read",uiPreferencesRevision:"new-ui"});
  assert.equal(hydrated.configurationRevision,"new-read");
  assert.equal(hydrated.theme,before.theme);
  const standalone=sync.applyGatewaySettingsSyncPayload(before,sync.buildGatewaySettingsSyncPayload({...before,settingsSyncProtocol:undefined}));
  assert.equal(standalone.settingsSyncProtocol,undefined);
  assert.equal(standalone.configurationRevision,undefined);
});

test("only the exact queued predecessor may inherit versions from a durable receipt",()=>{
  const {before,queue,receipt}=fixture();
  const first={...before,theme:"dark"};
  queue.accept(before,first,"device-a",receipt(first));
  const update=queue.prepare(first,{...first,locale:first.locale==="zh-CN"?"en-US":"zh-CN"},"device-a");
  assert.equal(update.configurationRevision,"za-config-v1-committed");
  assert.equal(update.uiPreferencesRevision,"za-ui-v1-committed");
  assert.equal(queue.prepare(before,{...before,theme:before.theme === "dark" ? "light" : "dark"},"device-a").configurationRevision,before.configurationRevision);
  assert.equal(queue.prepare(first,{...first,theme:"light"},"device-b").configurationRevision,before.configurationRevision);
  const fresh={...first,configurationRevision:"za-config-v1-other-window"};
  assert.equal(queue.prepare(fresh,{...fresh,theme:"light"},"device-a").configurationRevision,fresh.configurationRevision);
  queue.clear();
  assert.equal(queue.prepare(first,{...first,theme:"light"},"device-a").configurationRevision,before.configurationRevision);
});

test("a normalized or unavailable receipt cannot lend its version to optimistic data",()=>{
  const {before,queue,receipt}=fixture();
  const intended={...before,theme:"dark"};
  queue.accept(before,intended,"device-a",receipt({...intended,theme:"light"}));
  assert.equal(queue.prepare(intended,{...intended,theme:"system"},"device-a").configurationRevision,before.configurationRevision);
  queue.accept(before,intended,"device-a",{...receipt(intended),snapshot:null});
  assert.equal(queue.prepare(intended,{...intended,theme:"light"},"device-a").configurationRevision,before.configurationRevision);
});
