import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../../agent-gateway/test/helpers/dom-test-env.mjs";

async function fixture(t, expiresIn = 60_000) {
  const events = { reset: 0, ephemeral: [], invalid: [] };
  const env = await createWebDomTestEnv({ mocks: {
    "@/lib/gatewaySocket": { GATEWAY_SELECTION_INVALID_EVENT: "zeroagent:gateway-selection-invalid", resetGatewayWebSocketClient: () => { events.reset++; } },
    "@/lib/storage": { setEphemeralCredential: (value) => events.ephemeral.push(value) },
    "@/lib/relay/client": { getRelayCurrentUser: () => assert.fail("desktop must use its verified Native owner rather than Cookie login"), loginRelay: () => assert.fail("unexpected browser login"), logoutRelay: () => assert.fail("unexpected browser logout") },
  } });
  const { installDesktopRemoteHost } = env.loadModule("src/lib/desktopRemoteHost.ts");
  const { useGatewaySession } = env.loadModule("src/app/hooks/useGatewaySession.ts");
  const environment = { runtime_kind: "device_agent", device_id: "device-a", agent_id: "device-a", name: "Synthetic A", online: true, workspaces: [] };
  const host = {
    sessionHandle: "opaque-native-session", accountScope: "verified-account-a", gatewayOrigin: "http://127.0.0.1:5174",
    accountUser: { id: 7, email: "synthetic@example.invalid", status: "active" }, environment, environments: [environment],
    selection: { runtime_kind: "device_agent", device_id: "device-a", selection_lease: "lease-device-a", workspace_id: "", scope: "device", expires_at: new Date(Date.now() + expiresIn).toISOString() },
    request: () => assert.fail("session setup does not need an account HTTP request"), isCurrent: () => true,
    onSelectionInvalid: (reason) => events.invalid.push(reason),
  };
  const release = installDesktopRemoteHost(host);
  let state;
  function Probe() {
    state = useGatewaySession(null);
    return env.React.createElement("div", { "data-device": state.selection?.device_id }, state.token ? "connected" : "blocked");
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    release();
    await env.act(async () => root.unmount());
    container.remove();
  };
  t.after(async () => { await unmount(); env.cleanup(); });
  await env.act(async () => root.render(env.React.createElement(Probe)));
  return { env, host, events, state: () => state, container, unmount };
}

test("the complete remote session uses the verified Native identity and preserves device-scoped workspace selection", async (t) => {
  const f = await fixture(t);
  const current = f.state();
  assert.equal(current.accountUser.id, 7);
  assert.equal(current.authInitializing, false);
  assert.equal(current.selection.device_id, "device-a");
  assert.match(current.token, /^selection\./);
  assert.equal(current.environments.length, 1);
  const selected = await current.switchExecutionTarget(f.host.environment, { id: "another-workspace", name: "Another" });
  assert.equal(selected.selection_lease, "lease-device-a");
  await assert.rejects(current.switchExecutionTarget({ ...f.host.environment, device_id: "device-b" }, { id: "remote-b" }), /设备切换入口/);
  await assert.rejects(current.login("ignored", "ignored"), /桌面账号入口/);
  await f.unmount();
  assert.equal(f.events.ephemeral.at(-1), null, "unmount clears the module's credential capability");
  assert.ok(f.events.reset >= 1, "unmount disposes the previous module's Gateway client");
});

test("an offline presence push blocks the remote session while retaining the exact selected target", async (t) => {
  const f = await fixture(t);
  await f.env.act(async () => f.state().applyExecutionPresence([{ agent_id: "device-b", online: false }]));
  assert.match(f.state().token, /^selection\./, "another device cannot invalidate this mount");
  await f.env.act(async () => f.state().applyExecutionPresence([{ agent_id: "device-a", online: false }]));
  assert.equal(f.state().token, "");
  assert.equal(f.state().selection.device_id, "device-a");
  assert.equal(f.state().selection.runtime_kind, "device_agent");
  assert.equal(f.container.textContent, "blocked");
  assert.equal(f.events.invalid.length, 1);
  assert.equal(f.events.ephemeral.at(-1), "");
  await f.env.act(async () => window.dispatchEvent(new Event("zeroagent:gateway-selection-invalid")));
  assert.equal(f.events.invalid.length, 1, "the same failure does not repeatedly reset the desktop target");
});

test("lease expiry blocks future work without changing the remote selection to cloud or local", async (t) => {
  const f = await fixture(t, 200);
  await f.env.act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
  assert.equal(f.state().token, "");
  assert.equal(f.state().selection.device_id, "device-a");
  assert.equal(f.state().selection.runtime_kind, "device_agent");
  assert.match(f.state().authError, /控制权限已过期/);
  assert.equal(f.events.invalid.length, 1);
  assert.ok(f.events.reset >= 1);
});

test("Native logout failures retain the current connection and permit a successful retry", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  f.host.logout = async () => {
    if (++attempts === 1) throw Error("synthetic vault failure");
  };
  const initialToken = f.state().token;
  const resets = f.events.reset;
  await f.env.act(async () => {
    await assert.rejects(f.state().clearSession(true), /synthetic vault failure/);
  });
  assert.equal(f.state().token, initialToken, "unconfirmed logout cannot discard the active capability");
  assert.equal(f.state().selection.device_id, "device-a");
  assert.equal(f.events.reset, resets);
  assert.deepEqual(f.events.invalid, []);
  await f.env.act(async () => f.state().clearSession(true));
  assert.equal(attempts, 2);
  assert.equal(f.state().token, "");
  assert.equal(f.state().selection.device_id, "device-a", "logout does not silently select a local/cloud target");
  assert.equal(f.events.invalid.length, 1);
  assert.ok(f.events.reset > resets);
});
