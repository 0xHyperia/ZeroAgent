import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Ledger } from "../src/ledger.ts";
import type { StoredReceipt } from "../src/protocol.ts";

function record(id: string, result?: Record<string, unknown>): StoredReceipt {
  return {
    operation_id: id,
    action: "file.download.chunk",
    state: "succeeded",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    scope_hash: "scope",
    request_hash: "hash",
    result,
  };
}

test("journal remains usable beyond the former 2048-record limit and reads old results by ID after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zeroagent-journal-many-"));
  let ledger = new Ledger(dir, 5000);
  try {
    await ledger.init();
    for (let i = 0; i < 2100; i++) await ledger.save(record(`operation-${i}`, { index: i }));
    assert.equal(ledger.size, 2100);
    await ledger.close();
    ledger = new Ledger(dir, 5000);
    await ledger.init();
    assert.equal(ledger.size, 2100);
    assert.equal(ledger.get("operation-0")?.result?.index, 0);
    assert.equal(ledger.get("operation-2099")?.result?.index, 2099);
  } finally {
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("acknowledgement releases large results, retains identity across restart and refuses unknown outcomes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zeroagent-journal-retire-"));
  let ledger = new Ledger(dir, 10);
  try {
    await ledger.init();
    const original = record("large", { data_base64: "a".repeat(1_300_000) });
    await ledger.save(original);
    const before = ledger.bytes;
    await ledger.retire(original);
    assert(ledger.bytes < before / 100);
    assert.equal(ledger.size, 1);
    assert.equal(ledger.get("large")?.request_hash, "hash");
    assert.equal(ledger.get("large")?.result, undefined);
    assert.equal(ledger.get("large")?.result_retired, true);
    await ledger.close();
    ledger = new Ledger(dir, 10);
    await ledger.init();
    assert.equal(ledger.get("large")?.result_retired, true);
    const unknown = { ...record("unknown"), state: "unknown" as const };
    await ledger.save(unknown);
    await assert.rejects(ledger.retire(unknown), /operation_not_terminal/);
    assert.equal(ledger.get("unknown")?.state, "unknown");
  } finally {
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an actually terminated process releases the kernel lock and leaves external dispatch unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zeroagent-journal-crash-"));
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./ledger-child.ts", import.meta.url)), dir],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true },
  );
  const ledger = new Ledger(dir, 100);
  try {
    await once(child, "message", { signal: AbortSignal.timeout(10000) });
    const other = new Ledger(dir, 100);
    try {
      await assert.rejects(other.init(), /ledger_locked/);
    } finally {
      await other.close();
    }
    const stopped = once(child, "exit");
    child.kill("SIGKILL");
    await stopped;
    await ledger.init();
    const recovered = ledger.get("crash-operation");
    assert.equal(recovered?.state, "unknown");
    assert.equal(recovered?.result?.sandbox_id, "possibly-created-before-crash");
    assert.equal(recovered?.error?.code, "process_interrupted");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGKILL");
      await stopped;
    }
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("old JSON dispatch facts are refused without deletion or implicit migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zeroagent-journal-format-"));
  const ledger = new Ledger(dir, 100);
  try {
    await writeFile(join(dir, `${"a".repeat(64)}.json`), JSON.stringify(record("old")), {
      mode: 0o600,
    });
    await assert.rejects(ledger.init(), /ledger_format_unsupported/);
  } finally {
    await ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});
