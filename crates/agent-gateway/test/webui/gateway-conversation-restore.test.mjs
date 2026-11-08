import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const restore = loader.loadModule("src/app/gatewayConversationRestore.ts");
const { readCloudChatRoute } = loader.loadModule("src/lib/cloudChatRoute.ts");
const { createOpenConversationInitial } = loader.loadModule(
  "src/app/gatewayHistoryWindowActions.ts",
);
const { createConversationOpenController } = loader.loadModule(
  "@liveagent/ui/lib/sidebar/openController.ts",
);

function installSessionStorage() {
  const values = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem(key) {
        return values.has(key) ? values.get(key) : null;
      },
      setItem(key, value) {
        values.set(key, String(value));
      },
    },
  };
  return values;
}

test("conversation restore selections are isolated by agent", () => {
  installSessionStorage();

  restore.saveGatewayConversationSelection("agent-a", "conversation-a", 7);
  restore.saveGatewayConversationSelection("agent-b", "conversation-b", 7);

  assert.equal(restore.loadGatewayConversationSelection("agent-a", 7), "conversation-a");
  assert.equal(restore.loadGatewayConversationSelection("agent-b", 7), "conversation-b");
  assert.equal(restore.loadGatewayConversationSelection("agent-c", 7), "");
});

test("reassigned devices never inherit the previous account's restore pointer", () => {
  const values = installSessionStorage();
  values.set("liveagent.gateway.selectedConversation.v2", '{"same-agent":"unscoped-history"}');
  restore.saveGatewayConversationSelection("same-agent", "account-a-history", 7);
  restore.saveGatewayConversationSelection("same-agent", "account-b-history", 8);
  assert.equal(restore.loadGatewayConversationSelection("same-agent", 9), "");
  assert.equal(restore.loadGatewayConversationSelection("same-agent", 7), "account-a-history");
  restore.clearGatewayConversationSelection("same-agent", 7);
  assert.equal(restore.loadGatewayConversationSelection("same-agent", 7), "");
  assert.equal(restore.loadGatewayConversationSelection("same-agent", 8), "account-b-history");
});

test("restore targets prefer backend identity and retain durable active aliases", () => {
  assert.equal(
    restore.resolveGatewayConversationRestoreTarget({
      conversationId: "relay-alias",
      historyConversationId: "relay-alias",
      historySessionId: " backend-session-1 ",
    }),
    "backend-session-1",
  );
  assert.equal(
    restore.resolveGatewayConversationRestoreTarget({
      conversationId: "relay-alias",
      historyConversationId: "other-alias",
      historySessionId: "backend-session-1",
      sidebarSessionId: "backend-session-2",
    }),
    "backend-session-2",
  );
  assert.equal(
    restore.resolveGatewayConversationRestoreTarget({ conversationId: "relay-alias" }),
    "relay-alias",
  );
});

test("invalid stored values and storage failures fall back safely", () => {
  const values = installSessionStorage();
  values.set("liveagent.gateway.selectedConversation.v3:account:7", "not-json");
  assert.equal(restore.loadGatewayConversationSelection("agent-a", 7), "");

  globalThis.window.sessionStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(restore.loadGatewayConversationSelection("agent-a", 7), "");
  assert.doesNotThrow(() => restore.saveGatewayConversationSelection("agent-a", "conversation-a", 7));
});

test("clearing one agent does not affect another selection", () => {
  installSessionStorage();
  restore.saveGatewayConversationSelection("agent-a", "conversation-a", 7);
  restore.saveGatewayConversationSelection("agent-b", "conversation-b", 7);

  restore.clearGatewayConversationSelection("agent-a", 7);

  assert.equal(restore.loadGatewayConversationSelection("agent-a", 7), "");
  assert.equal(restore.loadGatewayConversationSelection("agent-b", 7), "conversation-b");
});

test("an explicit device address takes precedence and reads the exact history through the normal loader", async () => {
  const calls = [];
  const applied = [];
  const state = {
    conversationId: "",
    selectedHistoryId: "",
    selectedHistory: null,
    revision: 0,
  };
  const historyLoadSequenceRef = { current: 0 };
  const visibleConversationRevisionRef = { current: 0 };
  const openInitial = createOpenConversationInitial({
    api: {
      async getHistory(conversationId) {
        calls.push(conversationId);
        return { conversation_id: conversationId, messages_json: "[]" };
      },
    },
    conversationIdRef: { current: "" },
    conversationWorkdirsRef: { current: new Map() },
    getDisplayedConversationId: () => state.conversationId,
    historyLoadSequenceRef,
    historyWindowStatesRef: { current: new Map() },
    invalidateHistoryLoad: () => {
      historyLoadSequenceRef.current += 1;
      return historyLoadSequenceRef.current;
    },
    localeErrorMessage: "open failed",
    markVisibleConversationRevision: () => {
      state.revision += 1;
      visibleConversationRevisionRef.current = state.revision;
      return state.revision;
    },
    pendingDisplayedConversationAutoBottomRef: { current: null },
    protectedConversationRef: { current: "" },
    selectedHistoryIdRef: { current: "" },
    setChatError() {},
    setConversationId(value) {
      state.conversationId = value;
    },
    setSelectedHistory(value) {
      state.selectedHistory = value;
    },
    setSelectedHistoryId(value) {
      state.selectedHistoryId = value;
    },
    transcriptStoreRegistry: {
      get() {
        return {
          applyHistorySnapshot(entries, options) {
            applied.push({ entries, options });
          },
        };
      },
      peek() {
        return undefined;
      },
    },
    visibleConversationRevisionRef,
  });

  const route = { page: "chat", id: "conversation-a", deviceId: "agent-a" };
  assert.equal(restore.resolveGatewayConversationLanding({
    route, activeDeviceId: "agent-b", savedConversationId: "previous",
  }), null);
  assert.deepEqual(restore.resolveGatewayConversationLanding({
    route: { ...route, id: "" }, activeDeviceId: "agent-a", savedConversationId: "previous",
  }), { conversationId: "", explicit: true });
  const landing = restore.resolveGatewayConversationLanding({
    route, activeDeviceId: "agent-a", savedConversationId: "previous",
  });
  await openInitial(landing.conversationId);

  assert.deepEqual(calls, ["conversation-a"]);
  assert.equal(state.conversationId, "conversation-a");
  assert.equal(state.selectedHistoryId, "conversation-a");
  assert.deepEqual(applied, [{ entries: [], options: { mode: "replace" } }]);
});

test("history response for a different id is rejected for restore fallback", async () => {
  const openInitial = createOpenConversationInitial({
    api: {
      async getHistory() {
        return { conversation_id: "deleted-or-other", messages_json: "[]" };
      },
    },
    conversationIdRef: { current: "" },
    conversationWorkdirsRef: { current: new Map() },
    getDisplayedConversationId: () => "",
    historyLoadSequenceRef: { current: 0 },
    historyWindowStatesRef: { current: new Map() },
    invalidateHistoryLoad: () => 1,
    localeErrorMessage: "open failed",
    markVisibleConversationRevision: () => 1,
    pendingDisplayedConversationAutoBottomRef: { current: null },
    protectedConversationRef: { current: "" },
    selectedHistoryIdRef: { current: "" },
    setChatError() {},
    setConversationId() {},
    setSelectedHistory() {},
    setSelectedHistoryId() {},
    transcriptStoreRegistry: { get() { return { applyHistorySnapshot() {} }; } },
    visibleConversationRevisionRef: { current: 0 },
  });

  await assert.rejects(() => openInitial("conversation-a"), /missing the requested conversation/);
});

test("leaving device tasks creates a refresh-safe device chat address immediately", () => {
  installSessionStorage();
  restore.saveGatewayConversationSelection("agent-a", "recent-a", 7);
  restore.saveGatewayConversationSelection("agent-b", "recent-b", 7);
  restore.saveGatewayConversationSelection("agent-a", "other-owner", 8);
  const url = new URL("https://gateway.example/tasks/task-x?task_target=device-a&task_device=1&task_run=run-x");
  const base = {
    url, deviceId: "device-a", restoredHere: false,
    recentConversationId: restore.loadGatewayConversationSelection("agent-a", 7),
  };
  assert.equal(restore.gatewayDeviceTaskChatReturnHref(base), "/c/recent-a?device=device-a");
  const visible = {
    ...base, restoredHere: true,
    visibleConversation: { conversationId: "displayed-alias", historyConversationId: "displayed-alias", historySessionId: "verified-session" },
  };
  const href = restore.gatewayDeviceTaskChatReturnHref(visible);
  assert.equal(href, "/c/verified-session?device=device-a");
  const refresh = readCloudChatRoute(new URL(href, url));
  assert.deepEqual(restore.resolveGatewayConversationLanding({ route: refresh, activeDeviceId: "device-a", savedConversationId: "recent-a" }), { conversationId: "verified-session", explicit: true });
  assert.equal(restore.gatewayDeviceTaskChatReturnHref({ ...visible, requestedId: "task-result-session" }), "/c/task-result-session?device=device-a");
  assert.equal(restore.gatewayDeviceTaskChatReturnHref({ ...base, restoredHere: true }), "/?device=device-a");
  assert.equal(restore.gatewayDeviceTaskChatReturnHref({ ...base, deviceId: "device-b" }), undefined);
  assert.equal(restore.gatewayDeviceTaskChatReturnHref({ ...base, url: new URL("/tasks?task_target=device-a", url) }), undefined);
});

test("a visible sidebar history failure preserves confirmed context and retries the same open", async () => {
  const conversationId = "sidebar-conversation";
  const previous = {
    conversation_id: conversationId,
    conversation: { id: conversationId, cwd: "D:/verified", session_id: "saved-session" },
    messages_json: "[]",
  };
  let selected = previous;
  let error = null;
  const workdirs = { current: new Map([[conversationId, "D:/verified"]]) };
  const historyLoadSequenceRef = { current: 0 };
  const visibleConversationRevisionRef = { current: 0 };
  const requests = [], committed = [];
  let scopeCurrent = true;
  let attempt;
  const load = createOpenConversationInitial({
    api: { async getHistory(id) {
      requests.push(id);
      if (requests.length === 1) throw Error("Temporary read failure");
      return previous;
    } },
    conversationIdRef: { current: conversationId },
    conversationWorkdirsRef: workdirs,
    getDisplayedConversationId: () => conversationId,
    historyLoadSequenceRef,
    historyWindowStatesRef: { current: new Map() },
    invalidateHistoryLoad: () => ++historyLoadSequenceRef.current,
    localeErrorMessage: "open failed",
    markVisibleConversationRevision: () => ++visibleConversationRevisionRef.current,
    pendingDisplayedConversationAutoBottomRef: { current: null },
    protectedConversationRef: { current: conversationId },
    selectedHistoryIdRef: { current: conversationId },
    setChatError(value) { error = value; },
    setConversationId() {},
    setSelectedHistory(value) { selected = value; },
    setSelectedHistoryId() {},
    transcriptStoreRegistry: { get() { return { applyHistorySnapshot() {} }; } },
    visibleConversationRevisionRef,
  });
  const controller = createConversationOpenController({
    onStateChange() {},
    openInitial(id, options) {
      attempt = { conversationId: id, options, isCurrent: () => scopeCurrent };
      return load(id, options);
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  controller.open(conversationId, { afterCommit: () => committed.push(workdirs.current.get(conversationId)) });
  await settle();
  assert.equal(controller.getState().phase, "failed");
  assert.equal(error, "Temporary read failure");
  assert.equal(selected, previous, "a failure cannot erase the last verified details");
  assert.deepEqual(committed, []);
  const target = restore.failedVisibleGatewayHistoryOpen(controller.getState(), conversationId, attempt);
  assert.equal(target, attempt);
  assert.equal(restore.failedVisibleGatewayHistoryOpen(controller.getState(), "other-session", attempt), undefined);
  assert.equal(restore.failedVisibleGatewayHistoryOpen(controller.getState(), conversationId, { ...attempt, options: { source: "search" } }), undefined);
  scopeCurrent = false;
  assert.equal(target.isCurrent(), false);
  scopeCurrent = true;
  controller.open(target.conversationId, target.options);
  await settle();
  assert.deepEqual(requests, [conversationId, conversationId]);
  assert.deepEqual(committed, ["D:/verified"]);
  assert.equal(controller.getState().phase, "ready");
});
