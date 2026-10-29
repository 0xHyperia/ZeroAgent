import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Fault, type StoredReceipt } from "./protocol.ts";

// Private SDK dispatch journal; PostgreSQL remains the task authority. Read by
// ID instead of keeping every potentially large receipt in JavaScript memory.
export class Ledger {
  readonly dir: string;
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly authority?: string;
  private db?: DatabaseSync;
  private ownership?: DatabaseSync;
  private pending = new Map<string, StoredReceipt>();
  constructor(dir: string, maxRecords: number, maxBytes = 1024 * 1024 * 1024, authority?: string) {
    this.dir = dir;
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    this.authority = authority;
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.dir);
    if (
      !directory.isDirectory() ||
      (process.platform !== "win32" && (directory.mode & 0o077) !== 0)
    )
      throw new Fault("unsafe_ledger_directory", 503);
    const files = await readdir(this.dir);
    // Never ignore or delete old dispatch facts and make their IDs new again.
    if (files.some((file) => /^[a-f0-9]{64}\.json$/.test(file) || file === "executor.lock"))
      throw new Fault("ledger_format_unsupported", 503);
    for (const name of ["ownership.sqlite", "receipts.sqlite"]) {
      const file = await open(
        join(this.dir, name),
        constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await file.close();
      const info = await lstat(join(this.dir, name));
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      )
        throw new Fault("unsafe_ledger_file", 503);
    }
    try {
      // Kernel releases this lock after process death, across container hostname
      // changes. No stale PID stealing, wall-clock lease or remote dispatch.
      this.ownership = new DatabaseSync(join(this.dir, "ownership.sqlite"));
      this.ownership.exec(
        "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY)",
      );
    } catch {
      this.ownership?.close();
      this.ownership = undefined;
      throw new Fault("ledger_locked", 503);
    }
    this.db = new DatabaseSync(join(this.dir, "receipts.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA cache_size=-8192;
      PRAGMA wal_autocheckpoint=128;
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0));
      CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY CHECK(id=1), records INTEGER NOT NULL, bytes INTEGER NOT NULL);
      INSERT OR IGNORE INTO usage VALUES(1,0,0);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    if (this.authority) {
      const existing = this.db.prepare("SELECT value FROM metadata WHERE key='authority'").get();
      if (existing && existing.value !== this.authority)
        throw new Fault("journal_authority_changed", 503);
      this.db
        .prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('authority',?)")
        .run(this.authority);
    }
    this.db
      .prepare(
        `UPDATE receipts SET data=json_set(data,'$.state','unknown','$.updated_at',?,'$.error',json(?)), state='unknown' WHERE state='executing'`,
      )
      .run(
        new Date().toISOString(),
        JSON.stringify({
          code: "process_interrupted",
          message:
            "Previous process ended during this operation; reconcile provider state before a new attempt.",
        }),
      );
    this.db.exec(
      "UPDATE receipts SET bytes=length(CAST(data AS BLOB)) WHERE state='unknown'; UPDATE usage SET bytes=(SELECT coalesce(sum(bytes),0) FROM receipts), records=(SELECT count(*) FROM receipts) WHERE id=1",
    );
  }
  get size() {
    return Number(this.db?.prepare("SELECT records FROM usage WHERE id=1").get()?.records ?? 0);
  }
  get bytes() {
    return Number(this.db?.prepare("SELECT bytes FROM usage WHERE id=1").get()?.bytes ?? 0);
  }
  stage(record: StoredReceipt) {
    this.pending.set(record.operation_id, record);
  }
  unstage(id: string) {
    this.pending.delete(id);
  }
  get(id: string): StoredReceipt | undefined {
    const pending = this.pending.get(id);
    if (pending) return structuredClone(pending);
    const row = this.db?.prepare("SELECT data FROM receipts WHERE id=?").get(id);
    return row ? (JSON.parse(String(row.data)) as StoredReceipt) : undefined;
  }
  canAdmit() {
    return this.size + this.pending.size < this.maxRecords && this.bytes < this.maxBytes;
  }
  async save(receipt: StoredReceipt) {
    if (!this.db) throw new Fault("ledger_unavailable", 503, true);
    const serialized = JSON.stringify(receipt);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > 2_000_000) throw new Fault("receipt_limit", 503, true);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare(
          "SELECT bytes,json_extract(data,'$.result_retired') AS retired FROM receipts WHERE id=?",
        )
        .get(receipt.operation_id);
      if (prior?.retired && !receipt.result_retired)
        throw new Fault("operation_result_retired", 410, true);
      const difference = bytes - Number(prior?.bytes ?? 0);
      // Existing bounded active operations may always persist their outcome.
      if (!prior && (this.size >= this.maxRecords || this.bytes + bytes > this.maxBytes))
        throw new Fault("ledger_capacity", 503);
      this.db
        .prepare(
          "INSERT INTO receipts(id,state,data,bytes) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data,bytes=excluded.bytes",
        )
        .run(receipt.operation_id, receipt.state, serialized, bytes);
      this.db
        .prepare("UPDATE usage SET records=records+?, bytes=bytes+? WHERE id=1")
        .run(prior ? 0 : 1, difference);
      this.db.exec("COMMIT");
      this.pending.delete(receipt.operation_id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async retire(receipt: StoredReceipt) {
    if (receipt.state === "executing" || receipt.state === "unknown")
      throw new Fault("operation_not_terminal", 409);
    if (receipt.result_retired) return;
    await this.save({ ...receipt, result: undefined, result_retired: true });
    // Reuse free pages; retain every operation identity. No serving-time VACUUM.
    this.db?.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
  async close() {
    this.db?.close();
    this.db = undefined;
    this.ownership?.close();
    this.ownership = undefined;
    this.pending.clear();
  }
}
