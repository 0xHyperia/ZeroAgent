import assert from "node:assert/strict";
import test from "node:test";
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
