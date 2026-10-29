// Runs only as a synthetic crash fixture; never imports or invokes an adapter.
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { Ledger } from "/app/crates/cloud-executor/src/ledger.ts";
import { readConfig } from "/app/crates/cloud-executor/src/config.ts";
import { operation, requestHash, scopeHash } from "/app/crates/cloud-executor/src/protocol.ts";

const config = readConfig();
if (config.apiKey || process.getuid() !== 10001 || process.getgid() !== 10001) throw Error("fixture_boundary");
const owner = { owner_scope: "smoke-owner", workspace_ref: "smoke-workspace" };
const operations = [
  operation({ ...owner, operation_id: "crash-checkpoint", action: "sandbox.create" }, config),
  operation({ ...owner, operation_id: "retired-download", action: "file.download.chunk", sandbox_id: "synthetic-checkpoint-vm", input: { path: "fixture.bin", offset: 0, max_bytes: 786432 } }, config),
];
const ledger = new Ledger(config.dataDir, config.maxReceipts, config.maxJournalBytes, scopeHash(config, { owner_scope: "journal-authority", workspace_ref: "journal-v1" }));
await ledger.init();
const now = new Date().toISOString();
for (const [index, op] of operations.entries()) {
  await ledger.save({ operation_id: op.operation_id, action: op.action, state: index === 0 ? "executing" : "succeeded", created_at: now, updated_at: now, request_hash: requestHash(op), scope_hash: scopeHash(config, op), result: index === 0 ? { sandbox_id: "synthetic-checkpoint-vm", checkpoint_marker: "before-true-sigkill" } : { data_base64: Buffer.alloc(786432, 7).toString("base64"), bytes: 786432 } });
}
const bytesBeforeRetire = ledger.bytes;
await ledger.retire(ledger.get("retired-download"));
if (bytesBeforeRetire < 900000 || ledger.bytes > 10000 || ledger.size !== 2) throw Error("retirement_failed");
await writeFile("/tmp/smoke-transient-marker", "must not survive container replacement", { mode: 0o600 });
let rootWriteDenied = false;
try { await writeFile("/app/smoke-write-probe", "must fail"); } catch (error) { rootWriteDenied = ["EROFS", "EACCES"].includes(error.code); }
if (!rootWriteDenied) throw Error("root_not_readonly");
const paths = { "src/ledger.ts": "/app/crates/cloud-executor/src/ledger.ts", "src/config.ts": "/app/crates/cloud-executor/src/config.ts", "src/protocol.ts": "/app/crates/cloud-executor/src/protocol.ts", "src/service.ts": "/app/crates/cloud-executor/src/service.ts", "src/main.ts": "/app/crates/cloud-executor/src/main.ts", "executor-healthcheck.mjs": "/app/executor-healthcheck.mjs" };
const source_sha256 = {};
for (const name of ["file_broker.py", "file_parser.py", "archive_extract.py"]) paths[`sandbox/${name}`] = `/app/crates/cloud-executor/sandbox/${name}`;
for (const [key, path] of Object.entries(paths)) source_sha256[key] = createHash("sha256").update(await readFile(path)).digest("hex");
const permissions = {};
for (const path of [config.dataDir, `${config.dataDir}/ownership.sqlite`, `${config.dataDir}/receipts.sqlite`]) {
  const info = await stat(path);
  permissions[path] = { uid: info.uid, gid: info.gid, mode: (info.mode & 0o777).toString(8) };
  if (info.uid !== 10001 || (info.mode & 0o077)) throw Error("unsafe_persistent_permissions");
}
console.log(`ZEROAGENT_SMOKE_READY ${JSON.stringify({ uid: process.getuid(), gid: process.getgid(), node: process.version, records: ledger.size, bytes_before_retire: bytesBeforeRetire, bytes_after_retire: ledger.bytes, root_write_denied: rootWriteDenied, permissions, source_sha256 })}`);
// Deliberately retain the real SQLite exclusive lock until docker SIGKILL.
setInterval(() => {}, 1000);
