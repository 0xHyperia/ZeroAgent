import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../../agent-gateway/test/helpers/load-web-module.mjs";

test("desktop account logout propagates Native failure without clearing browser state or emitting session events", async (t) => {
  const loader = createWebModuleLoader();
  const api = loader.loadModule("src/lib/desktopRemoteHost.ts");
  const relay = loader.loadModule("src/lib/relay/client.ts");
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  let events = 0;
  let storageChanges = 0;
  let attempts = 0;
  globalThis.window = { dispatchEvent() { events++; } };
  globalThis.localStorage = { removeItem() { storageChanges++; }, setItem() { storageChanges++; } };
  t.after(() => { globalThis.window = originalWindow; globalThis.localStorage = originalStorage; });
  const { host } = fixture({
    request: () => assert.fail("desktop logout must not enter Cookie/Gateway account APIs"),
    logout: async () => { if (++attempts === 1) throw Error("synthetic Native vault failure"); },
  });
  const dispose = api.installDesktopRemoteHost(host);
  t.after(dispose);
  await assert.rejects(relay.logoutRelay(), /synthetic Native vault failure/);
  assert.equal(api.requireCurrentDesktopRemoteHost(), host);
  await relay.logoutRelay();
  assert.equal(attempts, 2);
  assert.equal(events, 0, "Native owns successful account lifecycle notifications");
  assert.equal(storageChanges, 0, "the WebUI cannot clear Native or browser session persistence");
});

function fixture(overrides = {}) {
  const api = createWebModuleLoader().loadModule("src/lib/desktopRemoteHost.ts");
  let current = true;
  const requests = [];
  const invalid = [];
  const host = {
    sessionHandle: "opaque-native-session",
    accountScope: "verified-account-a",
    gatewayOrigin: "http://127.0.0.1:5174",
    accountUser: { id: 7, email: "synthetic@example.invalid", status: "active" },
    environment: { runtime_kind: "device_agent", device_id: "device-a", name: "Synthetic A", online: true, workspaces: [] },
    environments: [],
    selection: { selection_lease: "lease-a", runtime_kind: "device_agent", device_id: "device-a", workspace_id: "", scope: "device", expires_at: new Date(Date.now() + 60_000).toISOString() },
    async request(path, init) { requests.push({ path, init }); return new Response('{"ok":true}', { headers: { "content-type": "application/json" } }); },
    isCurrent: () => current,
    onSelectionInvalid: (reason) => invalid.push(reason),
    ...overrides,
  };
  return { api, host, requests, invalid, changeAccount: () => { current = false; } };
}

test("desktop remote host rejects cross-origin or mismatched device capabilities before installation", () => {
  for (const overrides of [
    { gatewayOrigin: "https://user:secret@example.invalid" },
    { gatewayOrigin: "https://example.invalid/api/" },
    { gatewayOrigin: "file:///api" },
    { accountScope: "" },
    { sessionHandle: "" },
    { accountUser: { id: 0 } },
    { selection: { runtime_kind: "web_chat", device_id: "device-a", selection_lease: "lease" } },
    { selection: { runtime_kind: "device_agent", device_id: "different-device", selection_lease: "lease" } },
  ]) {
    const { api, host } = fixture(overrides);
    assert.throws(() => api.installDesktopRemoteHost(host), /Invalid desktop remote host/);
    assert.equal(api.getDesktopRemoteHost(), undefined);
  }
});

test("desktop remote HTTP binds API paths to the captured Gateway and keeps Request bodies intact", async () => {
  const { api, host, requests } = fixture();
  api.installDesktopRemoteHost(host);
  const payload = new TextEncoder().encode("synthetic multipart or binary data");
  const request = new Request("http://127.0.0.1:5174/api/files/import?workdir=synthetic", {
    method: "POST", headers: { "content-type": "application/octet-stream" }, body: payload,
  });
  assert.deepEqual(await (await api.desktopRemoteFetch(request)).json(), { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/api/files/import?workdir=synthetic");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.get("content-type"), "application/octet-stream");
  assert.deepEqual(new Uint8Array(requests[0].init.body), payload);
  assert.equal(api.gatewayOrigin(), host.gatewayOrigin);
  for (const bad of ["https://foreign.invalid/api/status", "//foreign.invalid/api/status", "/outside-api", "/api/../outside-api"]) {
    await assert.rejects(api.desktopRemoteFetch(bad), /outside the configured Gateway/);
  }
  assert.equal(requests.length, 1, "blocked paths never reach the host request capability");
});

test("account, Gateway and selected device each isolate remote persisted state", () => {
  const key = (overrides = {}) => {
    const { api, host } = fixture(overrides);
    api.installDesktopRemoteHost(host);
    return api.desktopStorageKey("composer-draft");
  };
  const original = key();
  assert.equal(key(), original, "reopening the same account and device restores its own state");
  assert.notEqual(key({ accountScope: "verified-account-b" }), original);
  assert.notEqual(key({ gatewayOrigin: "http://127.0.0.1:6174" }), original);
  assert.notEqual(key({ environment: { runtime_kind: "device_agent", device_id: "device-b", online: true }, selection: { runtime_kind: "device_agent", device_id: "device-b", selection_lease: "lease-b" } }), original);
});

test("offline, expired and invalid-epoch remote hosts block new requests without using browser or local APIs", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("an invalid remote request must never fall back to browser fetch");
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const overrides of [
    { environment: { runtime_kind: "device_agent", device_id: "device-a", online: false } },
    { selection: { runtime_kind: "device_agent", device_id: "device-a", selection_lease: "lease-a", expires_at: new Date(Date.now() - 1000).toISOString() } },
    { selection: { runtime_kind: "device_agent", device_id: "device-a", selection_lease: "lease-a", expires_at: "invalid" } },
    { isCurrent: () => false },
  ]) {
    const { api, host, requests, invalid } = fixture(overrides);
    api.installDesktopRemoteHost(host);
    await assert.rejects(api.desktopRemoteFetch("/api/status"), /no longer authorized/);
    await assert.rejects(api.desktopRemoteFetch("/api/status"), /no longer authorized/);
    assert.equal(requests.length, 0);
    assert.equal(invalid.length, 1, "a failing host notifies the desktop once");
  }
});

test("disposed host modules retain a tombstone, reject late work and cannot borrow a new target", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("disposed remote modules cannot fall back to browser fetch");
  t.after(() => { globalThis.fetch = originalFetch; });
  const { api, host, requests, invalid } = fixture();
  const dispose = api.installDesktopRemoteHost(host);
  dispose();
  assert.equal(api.getDesktopRemoteHost(), host);
  await assert.rejects(api.desktopRemoteFetch("/api/status"), /no longer authorized/);
  assert.throws(() => api.installDesktopRemoteHost({ ...host, accountScope: "new-account" }), /cannot be reused across targets/);
  assert.equal(requests.length, 0);
  assert.equal(invalid.length, 0, "ordinary unmount does not emit an authorization error");
});

test("a response settling after an account change or disposal cannot enter the next device UI", async () => {
  for (const change of ["account", "dispose"]) {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const f = fixture({ request: () => pending });
    const dispose = f.api.installDesktopRemoteHost(f.host);
    const result = f.api.desktopRemoteFetch("/api/desktop/environments");
    await Promise.resolve();
    if (change === "account") f.changeAccount();
    else dispose();
    finish(new Response('{"device":"old-device"}'));
    await assert.rejects(result, /no longer authorized/);
  }
});

test("aborted remote requests reject both before dispatch and after a pending response", async () => {
  const f = fixture();
  f.api.installDesktopRemoteHost(f.host);
  const first = new AbortController();
  first.abort(Error("cancelled-before-dispatch"));
  await assert.rejects(f.api.desktopRemoteFetch("/api/status", { signal: first.signal }), /cancelled-before-dispatch/);
  assert.equal(f.requests.length, 0);
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  f.host.request = () => pending;
  const second = new AbortController();
  const result = f.api.desktopRemoteFetch("/api/status", { signal: second.signal });
  await Promise.resolve();
  second.abort(Error("cancelled-after-dispatch"));
  finish(new Response("{}"));
  await assert.rejects(result, /cancelled-after-dispatch/);
});
