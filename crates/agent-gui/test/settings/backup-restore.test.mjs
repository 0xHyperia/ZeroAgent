import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("native restore commands receive the reviewed content/profile fingerprint", async () => {
  const calls = [];
  const outcome = { applied: { providers: 1 }, backupPath: "rollback.json" };
  const loader = createTsModuleLoader({ mocks: {
    "@tauri-apps/api/core": { invoke: async (command, args) => { calls.push({ command, args }); return outcome; } },
  } });
  const backup = loader.loadModule("src/lib/backup/index.ts");
  assert.equal(await backup.applyBackupImport("reviewed.json", "file-and-profile-fingerprint"), outcome);
  assert.equal(await backup.downloadBackup("remote-and-profile-fingerprint"), outcome);
  assert.deepEqual(calls, [
    { command: "settings_backup_apply_import", args: { path: "reviewed.json", fingerprint: "file-and-profile-fingerprint" } },
    { command: "settings_backup_download", args: { fingerprint: "remote-and-profile-fingerprint" } },
  ]);
});

test("canonical settings reload after both successful and failed restores", async () => {
  const backup = createTsModuleLoader().loadModule("src/lib/backup/index.ts");
  const calls = [];
  const result = { applied: {}, backupPath: "rollback.json" };
  assert.equal(await backup.restoreBackupAndReload(async () => { calls.push("restore"); return result; }, async () => { calls.push("reload"); }), result);
  const failedRestore = new Error("Automatic rollback failed; recover from profile/backups/config.json");
  await assert.rejects(() => backup.restoreBackupAndReload(async () => { calls.push("failed-restore"); throw failedRestore; }, async () => { calls.push("reload-after-failure"); }), (error) => error === failedRestore);
  assert.deepEqual(calls, ["restore", "reload", "failed-restore", "reload-after-failure"]);
});

test("a reload failure preserves the restore error and recovery path", async () => {
  const backup = createTsModuleLoader().loadModule("src/lib/backup/index.ts");
  const failedRestore = new Error("Recover from profile/backups/config.json");
  const failedReload = new Error("Backend unavailable");
  await assert.rejects(() => backup.restoreBackupAndReload(async () => { throw failedRestore; }, async () => { throw failedReload; }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failedRestore, failedReload]);
    assert.match(error.message, /profile\/backups\/config\.json/);
    return true;
  });
});
