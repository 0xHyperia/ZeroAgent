import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function fixture(handler) {
  const calls = [];
  let handle = "za-session-" + "a".repeat(64);
  const session = { sessionHandle: handle, user: { id: 7, email: "synthetic@example.invalid", status: "active" }, authKind: "oauth", accountScope: "http://127.0.0.1:5173|user:7" };
  const selection = { runtime_kind: "device_agent", device_id: "device-a", agent_id: "device-a", selection_lease: "lease-device-a", workspace_id: "", scope: "device", expires_at: new Date(Date.now() + 60_000).toISOString() };
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (handler) return handler(command, args, { selection });
    if (command === "account_remote_open") return { bridgeId: "captured-bridge-a", selection };
    if (command === "account_remote_http") return { status: 200, headers: { "content-type": "application/json" }, bodyBase64: Buffer.from('{"device":"device-a"}').toString("base64") };
    if (command === "account_remote_close") return;
    if (command === "workbench_browser_loopback") return;
    assert.fail(`unexpected Native command ${command}`);
  };
  const loader = createTsModuleLoader({ mocks: {
    "@tauri-apps/api/core": { invoke },
    "./client": { revealRelayApiKey: async () => assert.fail("key reveal is outside this transport fixture") },
    "./nativeSession": { requireNativeSession: async () => session, nativeSessionHandle: () => handle },
  } });
  const api = loader.loadModule("src/lib/relay/desktopRemoteHost.ts");
  const abort = new AbortController();
  const input = {
    settings: { remote: { enabled: true, gatewayUrl: "http://127.0.0.1", gatewayPort: 5174 } },
    environment: { runtime_kind: "device_agent", device_id: "device-a", name: "Synthetic A", online: true, workspaces: [] },
    environments: [], selectionLease: selection.selection_lease, expiresAt: Date.now() + 60_000,
    signal: abort.signal, onSelectionInvalid() {},
  };
  const dependencies = { invoke, session: async () => session, currentSession: () => handle, accountRequest: async () => new Response('{"account":"synthetic"}') };
  return { api, input, dependencies, calls, abort, changeAccount: () => { handle = "za-session-" + "b".repeat(64); } };
}

test("Native desktop remote host captures the verified session and exact device lease", async () => {
  const f = fixture();
  const { host, dispose } = await f.api.createDesktopRemoteHost(f.input, f.dependencies);
  try {
    assert.equal(host.gatewayOrigin, "http://127.0.0.1:5174");
    assert.equal(host.sessionHandle, f.calls[0].args.request.sessionHandle);
    assert.equal(host.accountUser.id, 7);
    assert.equal(host.environment.device_id, "device-a");
    assert.equal(host.selection.device_id, "device-a");
    assert.equal(host.isCurrent(), true);
    assert.deepEqual(f.calls[0], { command: "account_remote_open", args: { request: {
      sessionHandle: "za-session-" + "a".repeat(64), origin: "http://127.0.0.1:5174", deviceId: "device-a", selectionLease: "lease-device-a",
    } } });
    assert.equal("access_token" in host, false);
    assert.equal("refresh_token" in host, false);
  } finally { dispose(); }
  assert.equal(host.isCurrent(), false);
  assert.equal(f.calls.at(-1).command, "account_remote_close");
  dispose();
  assert.equal(f.calls.filter((call) => call.command === "account_remote_close").length, 1);
});

test("Native remote HTTP preserves bytes and only passes controlled headers to the bridge", async () => {
  const f = fixture();
  const { host, dispose } = await f.api.createDesktopRemoteHost(f.input, f.dependencies);
  try {
    const payload = new Uint8Array([0, 1, 127, 128, 255]);
    const result = await host.request("/api/files/import?workdir=%2Fsynthetic", {
      method: "POST", body: payload,
      headers: { "Content-Type": "application/octet-stream", Authorization: "Bearer selection.synthetic", Cookie: "must-not-forward", "X-Untrusted": "must-not-forward" },
    });
    assert.deepEqual(await result.json(), { device: "device-a" });
    const request = f.calls.find((call) => call.command === "account_remote_http").args.request;
    assert.equal(request.bridgeId, "captured-bridge-a");
    assert.equal(request.path, "/api/files/import?workdir=%2Fsynthetic");
    assert.deepEqual(request.headers, { "content-type": "application/octet-stream", authorization: "Bearer selection.synthetic" });
    assert.deepEqual(new Uint8Array(Buffer.from(request.bodyBase64, "base64")), payload);
    for (const path of ["https://foreign.invalid/api/status", "/non-api", "//foreign.invalid/api/status"]) await assert.rejects(host.request(path), /超出已配置 Gateway/);
    assert.equal(f.calls.filter((call) => call.command === "account_remote_http").length, 1);
  } finally { dispose(); }
});

test("private browser navigation uses the selected native bridge and expires with it", async () => {
  const f = fixture();
  const { host, dispose, openPrivateBrowserPort } = await f.api.createDesktopRemoteHost(f.input, f.dependencies);
  const address = "http://localhost:5173/app";
  assert.equal("openPrivateBrowserPort" in host, false);
  await openPrivateBrowserPort("tab-1", address);
  assert.deepEqual(f.calls.at(-1), {
    command: "workbench_browser_loopback",
    args: { id: "tab-1", request: { action: "openGateway", bridgeId: "captured-bridge-a", url: address } },
  });
  dispose();
  await assert.rejects(openPrivateBrowserPort("tab-1", address), /已失效/);
  assert.equal(f.calls.filter((call) => call.command === "workbench_browser_loopback").length, 1);
});

test("offline, expired or missing device authority prevents bridge open and cannot fall back to local execution", async () => {
  for (const override of [
    { environment: { device_id: "device-a", online: false } },
    { environment: { device_id: "", online: true } },
    { selectionLease: "" }, { expiresAt: Date.now() - 1 }, { expiresAt: NaN },
  ]) {
    const f = fixture();
    await assert.rejects(f.api.createDesktopRemoteHost({ ...f.input, ...override }, f.dependencies), /已失效/);
    assert.equal(f.calls.length, 0);
  }
});

test("a bridge that finishes opening after a target abort or account change is closed with its original owner", async () => {
  for (const change of ["abort", "account"]) {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const f = fixture((command) => command === "account_remote_open" ? pending : undefined);
    const opening = f.api.createDesktopRemoteHost(f.input, f.dependencies);
    await new Promise((resolve) => setImmediate(resolve));
    if (change === "abort") f.abort.abort();
    else f.changeAccount();
    finish({ bridgeId: `late-${change}`, selection: { runtime_kind: "device_agent", device_id: "device-a", selection_lease: "lease-device-a" } });
    await assert.rejects(opening, /已失效/);
    const close = f.calls.find((call) => call.command === "account_remote_close");
    assert.equal(close.args.request.bridgeId, `late-${change}`);
    assert.equal(close.args.request.sessionHandle, "za-session-" + "a".repeat(64));
  }
});

test("wrong-device Native authorization response is rejected and its bridge is collected", async () => {
  const f = fixture((command) => command === "account_remote_open" ? { bridgeId: "wrong-device-bridge", selection: { runtime_kind: "device_agent", device_id: "device-b", selection_lease: "lease-device-b" } } : undefined);
  await assert.rejects(f.api.createDesktopRemoteHost(f.input, f.dependencies), /授权响应无效/);
  assert.equal(f.calls.at(-1).command, "account_remote_close");
  assert.equal(f.calls.at(-1).args.request.bridgeId, "wrong-device-bridge");
});

test("late Native HTTP and account responses never enter a new account or disposed target", async () => {
  for (const route of ["/api/status", "/api/auth/me"]) {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const f = fixture((command, _args, { selection }) => command === "account_remote_open" ? { bridgeId: "pending-response", selection } : command === "account_remote_http" ? pending : undefined);
    f.dependencies.accountRequest = () => pending;
    const { host, dispose } = await f.api.createDesktopRemoteHost(f.input, f.dependencies);
    const result = host.request(route);
    await new Promise((resolve) => setImmediate(resolve));
    f.changeAccount();
    finish(route === "/api/status" ? { status: 200, headers: {}, bodyBase64: Buffer.from("{}").toString("base64") } : new Response("{}"));
    await assert.rejects(result, /已失效/);
    dispose();
    await assert.rejects(host.request(route), /已失效/);
  }
});

test("aborting an active remote host closes its Native bridge and blocks subsequent commands", async () => {
  const f = fixture();
  const { host } = await f.api.createDesktopRemoteHost(f.input, f.dependencies);
  f.abort.abort(Error("target was unmounted"));
  assert.equal(host.isCurrent(), false);
  assert.equal(f.calls.at(-1).command, "account_remote_close");
  await assert.rejects(host.request("/api/status"), /已失效/);
  assert.equal(f.calls.filter((call) => call.command === "account_remote_http").length, 0);
});

test("device directory refresh reads current Native Gateway data instead of restoring the captured device name", async () => {
  let name = "Current server name";
  let reads = 0;
  const f = fixture((command, args, { selection }) => {
    if (command === "account_remote_open") return { bridgeId: "directory-bridge", selection };
    if (command === "account_remote_close") return;
    if (command === "account_device_identity") return { agentId: "local-device" };
    if (command === "account_gateway_http") {
      if (args.request.method === "PATCH") {
        assert.equal(args.request.path, "/api/desktop/devices/device-a");
        name = args.request.body.name;
        return { status: 200, body: { device: { id: "device-a", name } } };
      }
      assert.match(args.request.path, /^\/api\/desktop\/environments\?/);
      reads++;
      return { status: 200, body: { environments: [{ runtime_kind: "device_agent", device_id: "device-a", name: "此电脑", device_name: name, online: true, workspaces: [] }] } };
    }
    assert.fail(`unexpected Native directory request ${command}`);
  });
  f.input.environment.name = "Stale captured name";
  f.input.environments = [f.input.environment];
  const { host, dispose } = await f.api.createDesktopRemoteHost(f.input, f.dependencies);
  try {
    const first = await (await host.request("/api/environments?surface=web")).json();
    assert.equal(first.environments[0].name, "Current server name");
    assert.ok(first.environments[0].capabilities.includes("agent"));
    await host.request("/api/devices/device-a", { method: "PATCH", body: JSON.stringify({ name: "Renamed from another device" }) });
    const second = await (await host.request("/api/environments")).json();
    assert.equal(second.environments[0].name, "Renamed from another device");
    assert.equal(reads, 2, "each refresh obtains current server state rather than the entry snapshot");
    assert.equal(f.input.environment.name, "Stale captured name", "the input snapshot is never used to overwrite the server");
  } finally { dispose(); }
});
