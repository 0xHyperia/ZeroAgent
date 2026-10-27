import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  parseTypeScriptSource,
  transpileTypeScriptModule,
  walkSyntaxTree,
} from "../../../../scripts/typescript-source-tools.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const state = loader.loadModule("src/lib/relay/remoteDeviceState.ts");

test("remote device project state is isolated by device", () => {
  assert.equal(state.remoteProjectStorageKey("device-a"), "zeroagent.remote-project:device-a");
  assert.notEqual(
    state.remoteProjectStorageKey("device-a"),
    state.remoteProjectStorageKey("device-b"),
  );
});

test("remote conversation state is isolated by device and project", () => {
  const plainA = state.remoteConversationStorageKey("device-a", null);
  const plainB = state.remoteConversationStorageKey("device-b", null);
  const projectA = state.remoteConversationStorageKey("device-a", "project-a");
  const projectB = state.remoteConversationStorageKey("device-a", "project-b");

  assert.equal(plainA, "zeroagent.remote-conversation:device-a:plain-chat");
  assert.notEqual(plainA, plainB);
  assert.notEqual(plainA, projectA);
  assert.notEqual(projectA, projectB);
});

const local = { runtime_kind: "device_agent", device_id: "local", name: "Local", online: true, workspaces: [] };
const remote = { ...local, device_id: "remote", name: "Remote", workspaces: [{ id: "remote-project", path: "/remote-project" }] };
const selectedRemote = () => state.selectDesktopExecutionState(state.localDesktopExecutionState([local, remote], local.device_id), remote);

test("a failed refresh preserves the explicitly selected remote device offline", () => {
  const next = state.unavailableDesktopExecutionState(selectedRemote(), [{ ...local, device_id: state.LOCAL_ONLY_DEVICE_ID }]);
  assert.equal(next.selectedDeviceId, remote.device_id);
  assert.equal(next.localDeviceId, local.device_id);
  const selected = next.environments.find(item => item.device_id === next.selectedDeviceId);
  assert.equal(selected.online, false);
  assert.deepEqual(selected.workspaces, remote.workspaces);
});

test("a successful directory without the selected device retains its offline target and can recover it", () => {
  const missing = state.refreshDesktopExecutionState(selectedRemote(), [local], local.device_id);
  assert.equal(missing.selectedDeviceId, remote.device_id);
  assert.equal(missing.environments.find(item => item.device_id === remote.device_id).online, false);
  const recovered = state.refreshDesktopExecutionState(missing, [local, remote], local.device_id);
  assert.equal(recovered.selectedDeviceId, remote.device_id);
  assert.equal(recovered.environments.find(item => item.device_id === remote.device_id).online, true);
});

test("first use and an explicit local choice remain local across failures and identity registration", () => {
  const empty = { environments: [], localDeviceId: "", selectedDeviceId: "" };
  const fallback = state.unavailableDesktopExecutionState(empty, [{ ...local, device_id: state.LOCAL_ONLY_DEVICE_ID }]);
  assert.equal(fallback.selectedDeviceId, state.LOCAL_ONLY_DEVICE_ID);
  assert.equal(state.refreshDesktopExecutionState(fallback, [local, remote], local.device_id).selectedDeviceId, local.device_id);
  const explicit = state.selectDesktopExecutionState(selectedRemote(), local);
  assert.equal(state.refreshDesktopExecutionState(explicit, [local, remote], local.device_id).selectedDeviceId, local.device_id);
  assert.equal(state.unavailableDesktopExecutionState(explicit, [{ ...local, device_id: state.LOCAL_ONLY_DEVICE_ID }]).selectedDeviceId, state.LOCAL_ONLY_DEVICE_ID);
});

const appFile = new URL("../../src/App.tsx", import.meta.url);
const appSource = readFileSync(appFile, "utf8");
const appAst = parseTypeScriptSource(appSource, appFile.pathname);
const declarations = [];
const resultCallbacks = [];
walkSyntaxTree(appAst, node => {
  if (node.type === "VariableDeclarator" || node.type === "FunctionDeclaration") declarations.push(node);
  if (node.type === "ArrowFunctionExpression" && node.params[0]?.name === "result" && appSource.slice(node.start, node.end).includes("setExecutionState")) resultCallbacks.push(node);
});
const extract = (name, predicate = () => true) => {
  const matches = declarations.filter(node => node.id?.name === name && predicate(node));
  assert.equal(matches.length, 1, name);
  const node = matches[0].type === "VariableDeclarator" ? matches[0].init : matches[0];
  return appSource.slice(node.start, node.end);
};

function appHarness(request) {
  let current = selectedRemote();
  let leases = new Map([[remote.device_id, { lease: "fixture-lease", expiresAt: Date.now() + 60000 }]]);
  const epoch = { current: 0 };
  const context = vm.createContext({
    ...state, remote, executionSessionEpochRef: epoch, sessionEpoch: 0, cancelled: false,
    settings: { system: { workspaceProjects: [], archivedWorkspaceProjectPaths: [], missingWorkspaceProjectPaths: [] } },
    navigator: { platform: "test" }, localDeviceId: local.device_id, remoteSelectionLeases: leases,
    console: { warn() {} }, getDesktopEnvironments: request, registerDesktopDevice: async () => {},
    getValidRelayAccessToken: async () => {}, switchDesktopDevice: request,
    setExecutionState(next) { current = typeof next === "function" ? next(current) : next; },
    setRemoteSelectionLeases(next) { leases = typeof next === "function" ? next(leases) : next; },
    setRelayReady() {}, setRelayUser() {}, setRelayStats() {}, closeSettingsOverlay() {},
  });
  const code = `${extract("buildLocalOnlyEnvironment")}\n${extract("isRemoteLeaseValid")}\nconst refresh=${extract("refresh", node => appSource.slice(node.init.start, node.init.end).includes("getDesktopEnvironments(settings)"))};\nconst handleSessionChanged=${extract("handleSessionChanged")};\n${extract("handleExecutionSwitch")}`;
  vm.runInContext(transpileTypeScriptModule(code, "desktop-route-fixture.ts"), context);
  return { context, current: () => current, leases: () => leases, epoch, changed: () => vm.runInContext("handleSessionChanged()", context) };
}

test("the actual refresh callback keeps a remote route on rejection and missing-device success", async () => {
  for (const request of [async () => { throw Error("temporary list failure"); }, async () => ({ environments: [local], localDeviceId: local.device_id })]) {
    const harness = appHarness(request);
    await vm.runInContext("refresh()", harness.context);
    assert.equal(harness.current().selectedDeviceId, remote.device_id);
    assert.equal(harness.current().environments.find(item => item.device_id === remote.device_id).online, false);
  }
});

test("account changes clear routes and leases before old refresh results or failures settle", async () => {
  for (const fails of [false, true]) {
    let finish;
    const pending = new Promise((resolve, reject) => { finish = fails ? reject : resolve; });
    const harness = appHarness(() => pending);
    const refresh = vm.runInContext("refresh()", harness.context);
    harness.changed();
    finish(fails ? Error("old account failure") : { environments: [local, remote], localDeviceId: local.device_id });
    await refresh;
    assert.deepEqual(JSON.parse(JSON.stringify(harness.current())), { environments: [], localDeviceId: "", selectedDeviceId: "" });
    assert.equal(harness.leases().size, 0);
  }
  assert.equal(resultCallbacks.length, 2);
  for (const callback of resultCallbacks) {
    const harness = appHarness(async () => null);
    harness.changed();
    vm.runInContext(`(${appSource.slice(callback.start, callback.end)})({environments:[remote],localDeviceId:'local'})`, harness.context);
    assert.equal(harness.current().environments.length, 0);
  }
});

test("an old account's pending explicit remote selection cannot restore its route or lease", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const harness = appHarness(() => pending);
  harness.context.remoteSelectionLeases = new Map();
  const switching = vm.runInContext("handleExecutionSwitch(remote)", harness.context);
  await new Promise(resolve => setImmediate(resolve));
  harness.changed();
  finish({ selection_lease: "old-lease", expires_at: new Date(Date.now() + 60000).toISOString() });
  await assert.rejects(switching, /账号已变更/);
  assert.equal(harness.current().selectedDeviceId, "");
  assert.equal(harness.leases().size, 0);
});

test("offline and expired-lease remote targets are blocked before mounting the complete workbench", () => {
  const host = loader.loadModule("src/lib/relay/desktopRemoteHost.ts");
  const now = 1000;
  assert.equal(host.isDesktopRemoteTargetAuthorized(remote, "lease", now + 1, now), true);
  for (const [environment, lease, expiresAt] of [
    [{ ...remote, online: false }, "lease", now + 1],
    [remote, "lease", now], [remote, "lease", now - 1],
    [remote, "", now + 1], [remote, "lease", NaN],
  ]) assert.equal(host.isDesktopRemoteTargetAuthorized(environment, lease, expiresAt, now), false);
  assert.doesNotMatch(appSource, /\?\?\s*desktopEnvironments\.find/);
  assert.doesNotMatch(appSource, /RemoteDeviceChatPage/);
  assert.match(appSource, /RemoteDeviceWorkbench/);
});
