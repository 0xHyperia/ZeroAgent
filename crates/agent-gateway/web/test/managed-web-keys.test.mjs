import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

test("managed-key reveal binds ID and password and rejects a late JSON response", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const requests = [];
  let completeJSON;
  let parsing;
  const entered = new Promise((resolve) => { parsing = resolve; });
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, json: () => { parsing(); return new Promise((resolve) => { completeJSON = resolve; }); } };
  };
  const loader = createTsModuleLoader({ rootDir });
  const account = loader.loadModule("src/lib/accountRequest.ts");
  const client = loader.loadModule("src/lib/relay/client.ts");
  account.bindAccountRequests(7);
  const pending = client.revealRelayApiKey(11, " proof-password ");
  await entered;
  account.bindAccountRequests(8);
  completeJSON({ key: "one-operation-key" });
  await assert.rejects(pending, /Account changed/);
  assert.equal(requests[0].url, "/api/managed-provider-keys/11/reveal");
  assert.equal(new Headers(requests[0].init.headers).get("X-ZeroAgent-Account-ID"), "7");
  assert.equal(requests[0].init.credentials, "include");
  assert.deepEqual(JSON.parse(requests[0].init.body), { password: " proof-password " });
  await assert.rejects(client.revealRelayApiKey(0, "proof"), (error) => error.status === 400);
  assert.equal(requests.length, 1);
});

test("managed-key summaries and provider settings never retain the response credential", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const group = { id: 3, name: "group", platform: "openai", status: "active", rate_multiplier: 1 };
  const key = { id: 11, key: "private-fixture-key", name: "fixture", group_id: 3, status: "active", quota: 0, quota_used: 0, created_at: "2026-10-29" };
  globalThis.fetch = async () => Response.json({ code: 0, data: { items: [key] } });
  const loader = createWebModuleLoader({ rootDir, mocks: {
    "./client": { RELAY_ORIGIN: "https://usa0.top", getRelayProviderModels: async () => [{ id: "fixture-model" }] },
  } });
  const client = loader.loadModule("src/lib/relay/client.ts");
  const summaries = await client.listRelayApiKeys();
  assert.equal(summaries[0].key, "••••••••");
  assert.equal(summaries[0].key_configured, true);
  assert.ok(!JSON.stringify(summaries).includes(key.key));
  const providers = loader.loadModule("src/lib/relay/providers.ts");
  const settings = await providers.bindRelayKeysToSettings({ customProviders: [] }, summaries, [group], true);
  assert.equal(settings.customProviders.length, 1);
  assert.equal(settings.customProviders[0].apiKey, "");
  assert.equal(settings.customProviders[0].apiKeyConfigured, true);
  assert.equal(settings.selectedModel.customProviderId, "relay-key-11");
  const constrained = providers.enforceRelayProviderConstraint({ customProviders: [{ ...settings.customProviders[0], apiKey: key.key }] });
  assert.equal(constrained.customProviders[0].apiKey, "");
});

test("logout failure leaves the cookie session and Android credentials available for retry", async (t) => {
  const previous = { fetch: globalThis.fetch, window: globalThis.window, localStorage: globalThis.localStorage };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.window = new EventTarget();
  globalThis.localStorage = { getItem: () => null, setItem: () => assert.fail("failed logout published success"), removeItem: () => assert.fail("failed logout cleared the account") };
  globalThis.fetch = async () => Response.json({ error: "remote cleanup unavailable" }, { status: 502 });
  let cleared = 0;
  const loader = createTsModuleLoader({ rootDir, mocks: {
    "../mobileRuntime": { isEmbeddedMobileRuntime: () => true, clearEmbeddedMobileGatewaySession: async () => { cleared++; } },
  } });
  const client = loader.loadModule("src/lib/relay/client.ts");
  await assert.rejects(client.logoutRelay(), (error) => error.status === 502);
  assert.equal(cleared, 0);
});

test("account guards reject even a switch away and back to the same user", () => {
  const account = createTsModuleLoader({ rootDir }).loadModule("src/lib/accountRequest.ts");
  account.bindAccountRequests(7);
  const requireCurrent = account.captureAccountRequestGuard();
  account.bindAccountRequests(8);
  account.bindAccountRequests(7);
  assert.throws(requireCurrent, /Account changed/);
});

async function mountCopySection(t, { host = null, reveal = async () => "one-operation-key" } = {}) {
  const writes = [];
  let copyDialog;
  let view;
  let epoch = 0;
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": { CheckCircle2: () => null },
    "@liveagent/ui/pages/settings/ManagedProvidersView": { ManagedProvidersView: (props) => { view = props; return null; } },
    "@liveagent/ui/pages/settings/ProviderModal": { ProviderModal: () => null },
    "@liveagent/ui/pages/settings/ProvidersSection": { ProviderSettingsDialog: () => null },
    "@/components/relay/RelayKeyCopyDialog": { RelayKeyCopyDialog: (props) => { copyDialog = props; return null; } },
    "@/lib/accountRequest": { captureAccountRequestGuard: () => { const start = epoch; return () => { if (start !== epoch) throw new Error("Account changed"); }; } },
    "@/lib/desktopRemoteHost": { getDesktopRemoteHost: () => host, requireCurrentDesktopRemoteHost: () => { if (epoch !== 0) throw new Error("Desktop account changed"); return host; } },
    "@/lib/relay/client": {
      getRelayCurrentUser: async () => ({ id: 7, email: "a@example.test" }),
      listRelayApiKeys: async () => [{ id: 11, name: "fixture", key: "••••••••", key_configured: true, group_id: 3, status: "active" }],
      listRelayGroups: async () => [{ id: 3, name: "group", platform: "openai", status: "active" }],
      revealRelayApiKey: reveal,
      verifyRelayPassword: () => assert.fail("copy used a renderer password boolean"),
    },
    "@/lib/relay/providers": {
      bindRelayKeysToSettings: async (settings) => settings,
      relayProviderId: (id) => `relay-key-${id}`,
      relayProviderTypeForPlatform: () => "codex",
    },
  } });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (key) => { writes.push(key); } } });
  const { RelayProvidersSection } = env.loadModule("src/pages/settings/RelayProvidersSection.tsx");
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  t.after(async () => { await env.act(async () => root.unmount()); env.cleanup(); });
  await env.act(async () => root.render(env.React.createElement(RelayProvidersSection, { settings: { customProviders: [] }, setSettings: () => {} })));
  assert.equal(view.keys[0].maskedKey, "••••••••");
  await env.act(async () => view.onCopy(11));
  return { env, writes, confirm: (password) => copyDialog.onConfirm(password), changeAccount: () => { epoch++; } };
}

test("copy asks Gateway for the selected key and never copies a preloaded mask", async (t) => {
  const calls = [];
  const app = await mountCopySection(t, { reveal: async (...args) => { calls.push(args); return "one-operation-key"; } });
  await app.env.act(async () => app.confirm("proof-password"));
  assert.deepEqual(calls, [[11, "proof-password"]]);
  assert.deepEqual(app.writes, ["one-operation-key"]);
});

test("a key returned after an account change never reaches clipboard", async (t) => {
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const app = await mountCopySection(t, { reveal: () => pending });
  const copy = app.confirm("proof-password");
  app.changeAccount();
  complete("old-account-key");
  await assert.rejects(copy, /Account changed/);
  assert.deepEqual(app.writes, []);
});

test("desktop-host copy continues through Native reveal instead of the Cookie API", async (t) => {
  const calls = [];
  const app = await mountCopySection(t, { host: { revealKey: async (...args) => { calls.push(args); return "native-one-operation-key"; } }, reveal: () => assert.fail("Native copy called Cookie reveal") });
  await app.env.act(async () => app.confirm("proof-password"));
  assert.deepEqual(calls, [[11, "proof-password"]]);
  assert.deepEqual(app.writes, ["native-one-operation-key"]);
});
