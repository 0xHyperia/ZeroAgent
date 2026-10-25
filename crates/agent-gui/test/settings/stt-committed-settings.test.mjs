import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("STT save and clear accept Native results without submitting another settings write", async () => {
  const env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    "@liveagent/ui/assets/stt/alibaba-cloud.ico": { default: "alibaba.ico" },
    "@liveagent/ui/assets/stt/baidu-cloud.ico": { default: "baidu.ico" },
    "@liveagent/ui/assets/stt/tencent-cloud.ico": { default: "tencent.ico" },
    "@liveagent/ui/assets/stt/volcengine.png": { default: "volcengine.png" },
    "@liveagent/ui/components/ui/confirm-dialog": { useConfirmDialog: () => ({ confirm: async () => true, dialog: null }) },
    "@liveagent/ui/components/ui/toast-manager": { toast: { error() {}, success() {}, dismiss() {} } },
  } });
  const { getDefaultSettings } = env.loadModule("src/lib/settings/index.ts");
  const { SttSection } = env.loadModule("@liveagent/ui/pages/settings/SttSection.tsx");
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  let current = getDefaultSettings();
  current.stt.nativeConfigurationRevision = "native-opened";
  let selected = "tencent_cloud";
  const updates = [];
  const accepted = [];
  const service = {
    get: async () => assert.fail("must use the displayed snapshot"),
    update: async stt => {
      updates.push(stt);
      const provider = { ...stt.providers[stt.provider], configured: !stt.providers[stt.provider].clearSecrets };
      delete provider.clearSecrets;
      return { ...stt, providers: { ...stt.providers, [stt.provider]: provider }, nativeConfigurationRevision: `native-${updates.length}` };
    },
    test: async () => ({ result: "connected" }),
    acceptPersisted: stt => { accepted.push(stt); current = { ...current, stt }; render(); },
  };
  const render = () => root.render(env.React.createElement(SttSection, {
    settings: current, selectedProvider: selected, service,
    setSettings: () => assert.fail("already committed STT data must not be written again"),
    onSelectedProviderChange: provider => { selected = provider; render(); },
  }));
  const click = async text => {
    const button = [...document.querySelectorAll("button")].find(node => node.textContent.includes(text));
    assert.ok(button, `missing button: ${text}`);
    await env.act(async () => button.click());
  };
  try {
    await env.act(async () => render());
    await click("设置服务");
    await click("腾讯云实时语音识别");
    current = { ...current, stt: { ...current.stt, nativeConfigurationRevision: "native-newer-read" } };
    await env.act(async () => render());
    await click("保存并测试连接");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].nativeConfigurationRevision, "native-opened", "a newer host snapshot cannot replace an open form's version");
    assert.equal(accepted[0].nativeConfigurationRevision, "native-1");
    await click("清空");
    assert.equal(updates.length, 2);
    assert.equal(updates[1].providers.tencent_cloud.clearSecrets, true);
    assert.equal(accepted[1].nativeConfigurationRevision, "native-2");
  } finally {
    await env.act(async () => root.unmount());
    env.cleanup();
  }
});
