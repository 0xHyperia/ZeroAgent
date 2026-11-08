import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../../agent-gateway/test/helpers/load-web-module.mjs";
import { createGatewayV2Codec } from "../../../agent-gateway/test/helpers/gateway-v2.mjs";
import { createDesktopRemoteGatewayFixture } from "./fixtures/desktop-remote-gateway-fixture.mjs";

function installRuntime(t) {
  const originals = new Map(["window", "document", "localStorage", "location", "SharedWorker"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const window = new EventTarget();
  const document = new EventTarget();
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  Object.assign(window, { location: { origin: "http://must-not-use-local-ui.invalid", href: "http://must-not-use-local-ui.invalid/" }, localStorage: storage, WebSocket, setTimeout, clearTimeout, setInterval, clearInterval });
  Object.assign(document, { visibilityState: "visible", hidden: false });
  for (const [key, value] of Object.entries({ window, document, localStorage: storage, location: window.location, SharedWorker: undefined })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}

async function fixture(t) {
  installRuntime(t);
  const loader = createWebModuleLoader();
  const codec = createGatewayV2Codec(loader);
  const server = await createDesktopRemoteGatewayFixture(codec);
  const { GatewayWebSocketClient } = loader.loadModule("src/lib/gatewaySocket.ts");
  const { encodeSelectionCredential } = loader.loadModule("src/lib/executionTargets.ts");
  const clients = new Set();
  const connect = (agent) => {
    const selection = { selection_lease: `lease-${agent}`, runtime_kind: "device_agent", device_id: agent, agent_id: agent, workspace_id: "", scope: "device" };
    const client = new GatewayWebSocketClient(encodeSelectionCredential(selection), {
      origin: server.origin, desktopAccessToken: "opaque-native-session", clientName: "desktop-controller",
    });
    client.setActiveAgent(agent);
    clients.add(client);
    return client;
  };
  t.after(async () => {
    for (const client of clients) client.dispose();
    await server.close();
    server.assertHealthy();
  });
  return { server, connect };
}

test("desktop remote uses the production binary Gateway client for device-bound settings and selected model", { timeout: 15_000 }, async (t) => {
  const { server, connect } = await fixture(t);
  const client = connect("device-a");
  assert.equal((await client.getStatus()).agent_id, "device-a");
  const before = await client.getSettings();
  assert.equal(before.customProviders[0].id, "relay-device-a");
  const changed = before.customProviders.map((provider) => ({ ...provider, promptCacheHintMode: "none", models: provider.models.map((model) => ({ ...model, contextWindow: 48000 })) }));
  await client.updateSettings({ configurationVersion: before.configurationVersion, customProviders: changed });
  const after = await client.getSettings();
  assert.notEqual(after.configurationVersion, before.configurationVersion);
  assert.equal(after.customProviders[0].promptCacheHintMode, "none");
  assert.equal(after.customProviders[0].models[0].contextWindow, 48000);
  await assert.rejects(client.updateSettings({ configurationVersion: before.configurationVersion, customProviders: before.customProviders }), /configuration_changed/);
  const accepted = await client.chatCommand({
    type: "chat.submit", message: "Local synthetic remote request", conversationId: "conversation-a", clientRequestId: "owned-request-a",
    selectedModel: { customProviderId: "relay-device-a", providerType: "codex", model: "model-device-a" },
    systemSettings: { executionMode: "tools", workdir: "/synthetic/device-a" },
  });
  assert.equal(accepted.conversationId, "conversation-a");
  const sent = server.frames.find((frame) => frame.case === "chatCommand").json;
  assert.equal(sent.agent_id, "device-a");
  assert.deepEqual(sent.chat_command.request.selected_model, { custom_provider_id: "relay-device-a", model: "model-device-a", provider_type: "codex" });
  assert.equal(sent.chat_command.request.workdir, "/synthetic/device-a");
  assert.equal(server.executedRuns.size, 1);
  server.assertHealthy();
});

test("remote approval allow and reject preserve exact device, conversation and tool identity", { timeout: 15_000 }, async (t) => {
  const { server, connect } = await fixture(t);
  const client = connect("device-a");
  await client.chatQueueToolApproval("conversation-a", "write-a", JSON.stringify({ decision: "approve" }));
  await client.chatQueueToolApproval("conversation-b", "write-b", JSON.stringify({ decision: "deny" }));
  const approvals = server.frames.filter((frame) => frame.json.agent_request?.chat_queue).map((frame) => ({ agent: frame.json.agent_id, ...frame.json.agent_request.chat_queue }));
  assert.deepEqual(approvals, [
    { agent: "device-a", action: "tool_approval", conversation_id: "conversation-a", item_id: "write-a", request_json: '{"decision":"approve"}' },
    { agent: "device-a", action: "tool_approval", conversation_id: "conversation-b", item_id: "write-b", request_json: '{"decision":"deny"}' },
  ]);
  server.assertHealthy();
});

test("lost settings acknowledgement does not replay a mutation and both device snapshots stay isolated", { timeout: 15_000 }, async (t) => {
  const { server, connect } = await fixture(t);
  const first = connect("device-a");
  const before = await first.getSettings();
  server.dropAfterMutation("settings_update");
  await assert.rejects(first.updateSettings({ configurationVersion: before.configurationVersion, customProviders: [{ ...before.customProviders[0], promptCacheHintMode: "none" }] }));
  const applied = await first.getSettings();
  assert.equal(applied.customProviders[0].promptCacheHintMode, "none", "the acknowledgement loss does not undo the confirmed remote write");
  assert.equal(server.frames.filter((frame) => frame.json.agent_request?.settings_update).length, 1);
  first.dispose();
  const second = connect("device-b");
  const isolated = await second.getSettings();
  assert.equal(isolated.customProviders[0].id, "relay-device-b");
  assert.equal(isolated.customProviders[0].promptCacheHintMode, "auto");
  assert.equal((await second.getStatus()).agent_id, "device-b");
  second.dispose();
  const restored = connect("device-a");
  assert.equal((await restored.getSettings()).customProviders[0].promptCacheHintMode, "none");
  await assert.rejects(first.chatCommand({ type: "chat.submit", message: "stale client", conversationId: "must-not-run" }), /The active device changed/);
  assert.equal(server.executedRuns.size, 0);
  server.assertHealthy();
});

test("expired remote selection rejects reconnect instead of selecting another device", { timeout: 15_000 }, async (t) => {
  const { server, connect } = await fixture(t);
  const first = connect("device-a");
  assert.equal((await first.getStatus()).agent_id, "device-a");
  first.dispose();
  server.expireLease("lease-device-a");
  const expired = connect("device-a");
  await assert.rejects(expired.getStatus(), /selection lease expired/);
  assert.equal(server.frames.filter((frame) => frame.json.agent_id === "device-b").length, 0);
  assert.equal(server.executedRuns.size, 0);
  server.assertHealthy();
});

test("lost chat acknowledgement reuses the existing idempotency identity for exactly one remote run", { timeout: 15_000 }, async (t) => {
  const { server, connect } = await fixture(t);
  const client = connect("device-a");
  await client.getStatus();
  server.dropAfterMutation("chat_command");
  const accepted = await client.chatCommand({ type: "chat.submit", message: "local synthetic only", conversationId: "retry-conversation" });
  assert.equal(accepted.conversationId, "retry-conversation");
  const commands = server.frames.filter((frame) => frame.case === "chatCommand");
  assert.equal(commands.length, 2, "the lost acknowledgement is recovered over a real new connection");
  assert.notEqual(commands[0].peer, commands[1].peer);
  assert.equal(commands[0].json.chat_command.request.client_request_id, commands[1].json.chat_command.request.client_request_id);
  assert.equal(server.executedRuns.size, 1, "recovery cannot start a second model/tool run");
  server.assertHealthy();
});

test("lost tool approval acknowledgement is surfaced without resubmitting a tool decision", { timeout: 15_000 }, async (t) => {
  const { server, connect } = await fixture(t);
  const client = connect("device-a");
  await client.getStatus();
  server.dropAfterMutation("tool_approval");
  await assert.rejects(client.chatQueueToolApproval("approval-conversation", "write-once", '{"decision":"approve"}'));
  await client.getStatus();
  const approvals = server.frames.filter((frame) => frame.json.agent_request?.chat_queue?.action === "tool_approval");
  assert.equal(approvals.length, 1, "an unknown approval result is reconciled, never silently replayed");
  server.assertHealthy();
});
