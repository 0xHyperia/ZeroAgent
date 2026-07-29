import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  rootDir: fileURLToPath(new URL("..", import.meta.url)),
});
const targets = loader.loadModule("src/lib/executionTargets.ts");

const environments = [
  {
    runtime_kind: "web_chat",
    name: "Web chat",
    online: true,
    workspaces: [{ id: "cloud", name: "Cloud" }],
    capabilities: ["chat"],
  },
  {
    runtime_kind: "device_agent",
    device_id: "device-a",
    name: "Office PC",
    online: true,
    workspaces: [
      { id: "workspace-a", name: "Alpha", path: "C:\\code\\alpha" },
      { id: "workspace-b", name: "Beta", path: "C:\\code\\beta" },
    ],
    capabilities: ["agent", "terminal"],
  },
];

test("device selection resolves its active workspace independently", () => {
  const selection = {
    selection_lease: "lease-1",
    runtime_kind: "device_agent",
    device_id: "device-a",
    workspace_id: "",
    scope: "device",
    target_fingerprint: "device_agent:device-a:",
    conversation_id: "conversation-1",
    expires_at: "",
  };

  const resolved = targets.resolveExecutionTarget(environments, selection, "workspace-b");
  assert.equal(resolved.environment.name, "Office PC");
  assert.deepEqual(resolved.workspace, {
    id: "workspace-b",
    name: "Beta",
    path: "C:\\code\\beta",
  });
});

test("device selection credentials do not bind a remote workspace", () => {
  const selection = {
    selection_lease: "lease-2",
    runtime_kind: "device_agent",
    device_id: "device-a",
    workspace_id: "",
    scope: "device",
    target_fingerprint: "device_agent:device-a:",
    conversation_id: "conversation-2",
    expires_at: "",
  };

  const credential = targets.encodeSelectionCredential(selection);
  assert.deepEqual(targets.decodeSelectionCredential(credential), {
    lease: "lease-2",
    runtimeKind: "device_agent",
    deviceId: "device-a",
    agentId: "device-a",
    workspaceId: "",
  });
});

test("selecting a device requests a device-scoped lease", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  try {
    globalThis.fetch = async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        json: async () => ({
          selection_lease: "lease-device",
          runtime_kind: "device_agent",
          device_id: "device-a",
          workspace_id: "",
          scope: "device",
          target_fingerprint: "device_agent:device-a:",
          conversation_id: "conversation-device",
          expires_at: "",
        }),
      };
    };
    await targets.selectExecutionTarget(environments[1], environments[1].workspaces[0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(request.url, "/api/execution-target/select");
  assert.deepEqual(JSON.parse(request.init.body), {
    runtime_kind: "device_agent",
    device_id: "device-a",
    workspace_id: "",
    scope: "device",
    target_fingerprint: "device_agent:device-a:",
  });
});

test("a valid device lease is reusable across workspaces on the same device", () => {
  const selection = {
    selection_lease: "lease-reuse",
    runtime_kind: "device_agent",
    device_id: "device-a",
    workspace_id: "",
    scope: "device",
    target_fingerprint: "device_agent:device-a:",
    conversation_id: "conversation-reuse",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.equal(targets.canReuseDeviceSelection(selection, environments[1]), true);
  assert.equal(
    targets.canReuseDeviceSelection(selection, { ...environments[1], device_id: "device-b" }),
    false,
  );
  assert.equal(
    targets.canReuseDeviceSelection(
      { ...selection, expires_at: new Date(Date.now() - 60_000).toISOString() },
      environments[1],
    ),
    false,
  );
});

test("selection restoration is accepted only when the gateway validates the lease", async () => {
  const selection = {
    selection_lease: "lease-3",
    runtime_kind: "device_agent",
    device_id: "device-a",
    workspace_id: "",
    scope: "device",
    target_fingerprint: "device_agent:device-a:",
    conversation_id: "conversation-3",
    expires_at: "",
  };
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return { ok: requests.length === 1 };
    };
    assert.equal(await targets.validateExecutionSelection(selection), true);
    assert.equal(await targets.validateExecutionSelection(selection), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests[0].url, "/api/status");
  assert.equal(requests[0].init.credentials, "include");
  assert.match(requests[0].init.headers.Authorization, /^Bearer selection\./);
});
