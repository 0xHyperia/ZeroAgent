import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("manual import merges double clicks, publishes results, notifies history and remains retryable", async () => {
  let calls = 0;
  let resolve;
  let fail = false;
  const loader = createTsModuleLoader({ mocks: {
    "../host": { isTauriHost: () => true },
    "./historyMigration": { migrateLegacyHistoryOnce: async () => {
      calls++;
      if (fail) throw new Error("offline");
      return new Promise(r => { resolve = r; });
    } },
  } });
  const api = loader.loadModule("src/lib/kbrain/manualHistoryImport.ts");
  let changed = 0;
  const unsubscribe = api.subscribeHistoryImported(() => changed++);
  const first = api.importOldConversations();
  assert.equal(api.getHistoryImportState().running, true);
  assert.equal(first, api.importOldConversations());
  assert.equal(calls, 1);
  resolve({results:[{source_id:"old",backend_id:"old",status:"imported",checkpoint:"not_found"}],failures:[{sourceId:"bad",error:"invalid"}],complete:false});
  await first;
  assert.equal(changed, 1);
  assert.equal(api.getHistoryImportState().result.failures.length, 1);
  fail = true;
  await api.importOldConversations();
  assert.equal(api.getHistoryImportState().running, false);
  assert.equal(api.getHistoryImportState().error, "offline");
  assert.equal(changed, 1);
  fail = false;
  const retry = api.importOldConversations();
  resolve({results:[],failures:[],complete:true});
  await retry;
  assert.equal(api.getHistoryImportState().error, undefined);
  assert.equal(calls, 3);
  unsubscribe();
});

test("browser cannot report a successful native import", async () => {
  const loader = createTsModuleLoader({ mocks: {
    "../host": { isTauriHost: () => false },
    "./historyMigration": { migrateLegacyHistoryOnce: () => { throw new Error("must not run"); } },
  } });
  const api = loader.loadModule("src/lib/kbrain/manualHistoryImport.ts");
  await assert.rejects(api.importOldConversations(), /desktop app/);
  assert.equal(api.getHistoryImportState().result, undefined);
});

test("switching the target cancels the old import and never publishes its result in the new space", async () => {
  let listener;
  let connection = { baseUrl: "http://account-a.invalid", token: "a", storageId: "a" };
  const calls = [];
  const loader = createTsModuleLoader({ mocks: {
    "../host": { isTauriHost: () => true },
    "./runtimeConnection": {
      getConfiguredKBrainConnection: () => connection,
      subscribeKBrainRuntimeConnection: callback => { listener = callback; return () => {}; },
    },
    "./historyMigration": { migrateLegacyHistoryOnce: options => new Promise(resolve => calls.push({ options, resolve })) },
  } });
  const api = loader.loadModule("src/lib/kbrain/manualHistoryImport.ts");
  let notifications = 0;
  api.subscribeHistoryImported(() => notifications++);
  const first = api.importOldConversations();
  connection = { baseUrl: "http://account-b.invalid", token: "b", storageId: "b" };
  listener();
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(api.getHistoryImportState().result, undefined);
  const second = api.importOldConversations();
  const result = id => ({ results: [{ source_id: id, backend_id: id }], failures: [], complete: true });
  calls[0].resolve(result("old-account"));
  await first;
  assert.equal(api.getHistoryImportState().running, true);
  assert.equal(api.importOldConversations(), second);
  assert.equal(notifications, 0);
  calls[1].resolve(result("current-account"));
  await second;
  assert.equal(api.getHistoryImportState().result.results[0].source_id, "current-account");
  assert.equal(notifications, 1);
  assert.equal(calls[0].options.connection.storageId, "a");
  assert.equal(calls[1].options.connection.storageId, "b");
});
