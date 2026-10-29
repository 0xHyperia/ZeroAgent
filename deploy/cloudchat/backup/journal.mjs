// Maintenance-only SQLite snapshot guard. No E2B SDK, env profile or credentials.
import { constants } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

async function regular(path) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const stat = await file.stat();
  await file.close();
  if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== "win32" && (stat.mode & 0o077)))
    throw new Error("unsafe_journal_file");
}
function describe(db) {
  if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("journal_integrity");
  const authority = db.prepare("SELECT value FROM metadata WHERE key='authority'").get()?.value;
  if (typeof authority !== "string" || !/^[a-f0-9]{64}$/.test(authority)) throw new Error("journal_authority_missing");
  const hash = createHash("sha256");
  let receipt_count = 0, unknown_count = 0, executing_count = 0;
  for (const row of db.prepare("SELECT id,state,data FROM receipts ORDER BY id").iterate()) {
    if (Buffer.byteLength(row.data) > 2_000_000 || ++receipt_count > 10_000_000) throw new Error("journal_limit");
    const receipt = JSON.parse(row.data);
    if (receipt.operation_id !== row.id || receipt.state !== row.state || !/^[a-f0-9]{64}$/.test(receipt.scope_hash) || !/^[a-f0-9]{64}$/.test(receipt.request_hash)) throw new Error("journal_receipt_invalid");
    unknown_count += row.state === "unknown" ? 1 : 0;
    executing_count += row.state === "executing" ? 1 : 0;
    hash.update(String(Buffer.byteLength(row.data))).update(":").update(row.data).update("\n");
  }
  return { authority, receipt_count, unknown_count, executing_count, logical_sha256: hash.digest("hex") };
}
let owner, db;
try {
  const [mode = "verify", input, output] = process.argv.slice(2);
  if (mode === "verify") {
    if (!input || output) throw new Error("invalid_arguments");
    await regular(resolve(input));
    db = new DatabaseSync(resolve(input), { readOnly: true });
    process.stdout.write(`${JSON.stringify(describe(db))}\n`);
  } else if (mode === "guard-snapshot") {
    if (!input || !output) throw new Error("invalid_arguments");
    const directory = resolve(input), target = resolve(output);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077))) throw new Error("unsafe_journal_directory");
    await regular(join(directory, "ownership.sqlite"));
    await regular(join(directory, "receipts.sqlite"));
    owner = new DatabaseSync(join(directory, "ownership.sqlite"));
    owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    // Refuse overwrite, symlink and hardlink destinations before SQLite backup.
    const created = await open(target, "wx", 0o600);
    await created.close();
    db = new DatabaseSync(join(directory, "receipts.sqlite"), { readOnly: true });
    const summary = describe(db);
    await backup(db, target);
    await chmod(target, 0o600);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    // The Go coordinator retains stdin until PostgreSQL/object snapshot ends.
    await new Promise((accept) => { process.stdin.resume(); process.stdin.on("end", accept); });
  } else throw new Error("unsupported_command");
} catch {
  process.stderr.write("journal_snapshot_or_verification_failed\n");
  process.exitCode = 1;
} finally {
  db?.close();
  if (owner) { try { owner.exec("ROLLBACK"); } finally { owner.close(); } }
}
