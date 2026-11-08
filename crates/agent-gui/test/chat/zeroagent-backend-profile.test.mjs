import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("backend profile derives from verified user and origin, never an unverified fallback", async () => {
  const profile = createTsModuleLoader().loadModule("src/lib/kbrain/profile.ts");
  const options = { origin: "https://usa0.top/", hasSession: () => true, getCurrentUser: async () => ({ id: 7 }) };
  assert.equal(await profile.resolveBackendProfileScope(options), "https://usa0.top|user:7");
  assert.equal(await profile.resolveBackendProfileScope({ ...options, hasSession: () => false,
    getCurrentUser: () => { throw new Error("must not read an account"); } }), null);
  await assert.rejects(profile.resolveBackendProfileScope({ ...options,
    getCurrentUser: async () => { throw new Error("network unavailable"); } }), /network unavailable/);
  for (const id of [0, -1, NaN, 1.5]) assert.throws(() => profile.accountStorageScope(options.origin, id));
  profile.setBootProfileScope(null);
  assert.equal(profile.backendProfileMatchesAccount(options.origin, 7), false);
  profile.setBootProfileScope("https://usa0.top|user:7");
  assert.equal(profile.backendProfileMatchesAccount(options.origin, 7), true);
  assert.equal(profile.backendProfileMatchesAccount(options.origin, 8), false);
  assert.equal(profile.backendProfileMatchesAccount("https://other.example", 7), false);
  assert.equal(profile.nativeProfileOriginMatches(null, options.origin), true);
  assert.equal(profile.nativeProfileOriginMatches("https://usa0.top|user:7", options.origin), true);
  assert.equal(profile.nativeProfileOriginMatches("http://127.0.0.1:5173|user:7", options.origin), false);
  assert.equal(profile.nativeProfileOriginMatches("https://usa0.top:5173|user:7", options.origin), false);
});

test("a mismatched account stays in the login gate and reconnects without reloading", async () => {
  let accountId = 8;
  const actions = [];
  const elements = (tag) => ({ children, variant, size, ...props }) =>
    env.React.createElement(tag, props, children);
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
      "@liveagent/ui/components/ui/button": { Button: elements("button") },
      "@liveagent/ui/components/ui/input": { Input: elements("input") },
      "@liveagent/ui/components/ui/label": { Label: elements("label") },
      "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US" }) },
      "../../lib/relay/client": {
        RELAY_ORIGIN: "https://usa0.top",
        getRelayPublicSettings: async () => ({}),
        hasStoredRelaySession: () => true,
        getRelayCurrentUser: async () => ({ id: accountId }),
        listRelayApiKeys: async () => { actions.push("keys"); return [{ id: 1 }]; },
        listRelayGroups: async () => { actions.push("groups"); return []; },
      },
      "../../lib/relay/deviceRegistration": {
        registerDesktopDevice: async () => { actions.push("device"); },
      },
      "../../lib/relay/providers": {
        bindRelayKeysToSettings: async (settings) => settings,
      },
      "../AppUpdateButton": { AppUpdateButton: () => null },
      "../CodeFlowBackground": { CodeFlowBackground: () => null },
      "./GroupMultiSelect": { GroupMultiSelect: () => null },
      "./ZeroAgentLogo": { ZeroAgentLogo: () => null },
    },
  });
  const previousVersion = globalThis.__LIVEAGENT_APP_VERSION__;
  globalThis.__LIVEAGENT_APP_VERSION__ = "0.0.0-test";
  const { RelayAccessGate } = env.loadModule("src/components/relay/RelayAccessGate.tsx");
  env.loadModule("src/lib/kbrain/profile.ts").setBootProfileScope("https://usa0.top|user:7");
  const document = env.dom.window.document;
  const container = document.createElement("div");
  document.body.append(container);
  const root = env.createRoot(container);
  try {
    await env.act(async () => root.render(env.React.createElement(RelayAccessGate, {
      appUpdate: {},
      settings: {},
      setSettings: () => actions.push("settings"),
      onReady: (user) => actions.push(user.id),
    })));
    assert.match(container.querySelector("[role=alert]").textContent, /account does not match/);
    assert.deepEqual(actions, []);
    const reconnect = [...container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("Reconnect"),
    );
    assert.ok(reconnect);
    accountId = 7;
    await env.act(async () => reconnect.click());
    assert.equal(container.querySelector("[role=alert]"), null);
    assert.deepEqual(actions, ["keys", "groups", "settings", "device", 7]);
  } finally {
    await env.act(async () => root.unmount());
    if (previousVersion === undefined) delete globalThis.__LIVEAGENT_APP_VERSION__;
    else globalThis.__LIVEAGENT_APP_VERSION__ = previousVersion;
    env.cleanup();
  }
});

test("native storage identity isolates identical session IDs across accounts and survives port rotation", () => {
  const previous = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    get length() { return values.size; }, key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
  };
  const loader = createTsModuleLoader();
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  const mapping = loader.loadModule("src/lib/kbrain/mapping.ts");
  const connect = (storageId, port) => runtime.setKBrainRuntimeConnection({
    baseUrl: `http://127.0.0.1:${port}`, token: "test-secret", protocolVersion: "kbrain.agent.v1", managedLocal: true, storageId,
  });
  try {
    connect("account-a", 40001); mapping.setKBrainSessionId("same-local-id", "session-a");
    connect("account-b", 40001); assert.equal(mapping.getKBrainSessionId("same-local-id"), undefined);
    mapping.setKBrainSessionId("same-local-id", "session-b");
    connect("account-a", 40002); assert.equal(mapping.getKBrainSessionId("same-local-id"), "session-a");
    connect("account-b", 40003); assert.equal(mapping.getKBrainSessionId("same-local-id"), "session-b");
    assert.doesNotMatch([...values.values()].join(""), /test-secret|40001|40002|40003/);
  } finally { runtime.clearKBrainRuntimeConnection(); globalThis.localStorage = previous; }
});
