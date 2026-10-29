import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Adapter, Context } from "../src/adapter.ts";
import { readConfig } from "../src/config.ts";
import { Ledger } from "../src/ledger.ts";
import {
  type Config,
  Fault,
  type Operation,
  operation,
  requestHash,
  type StoredReceipt,
  scopeHash,
} from "../src/protocol.ts";
import { Executor, httpServer } from "../src/service.ts";

const owner = { owner_scope: "account-one", workspace_ref: "workspace-one" };
function config(dataDir: string): Config {
  return readConfig({
    ZEROAGENT_CLOUD_EXECUTOR_TOKEN: "test-only-random-token-0123456789-abcdef",
    ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR: dataDir,
    ZEROAGENT_CLOUD_EXECUTOR_PORT: "0",
  });
}
function op(id = "op-one", extra: Record<string, unknown> = {}) {
  return { ...owner, operation_id: id, action: "sandbox.create", ...extra };
}
async function done(executor: Executor, id: string) {
  const timeout = Date.now() + 2500;
  while (executor.get(id, owner).state === "executing") {
    if (Date.now() > timeout) throw new Error("receipt did not finish");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return executor.get(id, owner);
}
async function fixture(
  adapter: Adapter,
  callback: (executor: Executor, base: string, cfg: Config) => Promise<void>,
  overrides: Partial<Config> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "zeroagent-executor-test-"));
  const cfg = { ...config(dir), ...overrides };
  const executor = new Executor(cfg, adapter);
  await executor.init();
  const server = httpServer(executor);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    await callback(executor, `http://127.0.0.1:${address.port}`, cfg);
  } finally {
    server.close();
    server.closeAllConnections();
    await executor.close();
    await rm(dir, { recursive: true, force: true });
  }
}
async function request(
  base: string,
  cfg: Config,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
test("configuration requires explicit strong token, local state directory and loopback", () => {
  assert.throws(() => readConfig({}), /strong_internal_token_required/);
  assert.throws(
    () =>
      readConfig({
        ZEROAGENT_CLOUD_EXECUTOR_TOKEN: "x".repeat(40),
        ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR: "relative",
      }),
    /absolute_data_dir_required/,
  );
  const common = {
    ZEROAGENT_CLOUD_EXECUTOR_TOKEN: "x".repeat(40),
    ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR: tmpdir(),
  };
  assert.throws(
    () => readConfig({ ...common, ZEROAGENT_CLOUD_EXECUTOR_HOST: "0.0.0.0" }),
    /loopback_required/,
  );
  assert.throws(
    () => readConfig({ ...common, ZEROAGENT_E2B_API_KEY: "example-key" }),
    /explicit_template_required/,
  );
  assert.equal(readConfig({ ...common, E2B_API_KEY: "ignored-profile-key" }).apiKey, undefined);
});
test("internal authentication and browser-origin rejection apply to health, operations and cancellation", async () => {
  await fixture({ enabled: true, execute: async () => ({}) }, async (_executor, base, cfg) => {
    assert.equal(
      (await request(base, cfg, "/v1/health", undefined, { Authorization: "Bearer wrong" })).status,
      401,
    );
    assert.equal(
      (await request(base, cfg, "/v1/operations", op(), { Origin: "https://example.test" })).status,
      401,
    );
    assert.equal(
      (await request(base, cfg, "/v1/operations/op-one/cancel", owner, { Authorization: "" }))
        .status,
      401,
    );
    assert.equal((await request(base, cfg, "/v1/health")).body.enabled, true);
  });
});
test("missing ZeroAgent E2B key returns explicit disabled without invoking SDK adapter", async () => {
  let calls = 0;
  await fixture(
    {
      enabled: false,
      execute: async () => {
        calls++;
        return {};
      },
    },
    async (_executor, base, cfg) => {
      const health = await request(base, cfg, "/v1/health");
      assert.equal(health.body.enabled, false);
      assert.equal(health.body.disabled_reason, "ZEROAGENT_E2B_API_KEY_missing");
      assert.equal((await request(base, cfg, "/v1/operations", op())).status, 503);
      assert.equal(calls, 0);
    },
  );
});
test("operation IDs deduplicate concurrently, reject changed payload, survive restart and hide other owners", async () => {
  let calls = 0;
  await fixture(
    {
      enabled: true,
      execute: async () => {
        calls++;
        return { sandbox_id: "sandbox-one" };
      },
    },
    async (executor, base, cfg) => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => request(base, cfg, "/v1/operations", op())),
      );
      assert(results.every((result) => result.status === 200 || result.status === 202));
      assert.equal((await done(executor, "op-one")).state, "succeeded");
      assert.equal(calls, 1);
      assert.equal(
        (
          await request(
            base,
            cfg,
            "/v1/operations",
            op("op-one", {
              action: "sandbox.reconcile",
              input: { create_operation_id: "earlier" },
            }),
          )
        ).status,
        409,
      );
      const foreign = { owner_scope: "account-two", workspace_ref: owner.workspace_ref };
      assert.equal(
        (await request(base, cfg, "/v1/operations", { ...op(), ...foreign })).status,
        404,
      );
      assert.equal(
        (
          await request(
            base,
            cfg,
            "/v1/operations/op-one?owner_scope=account-two&workspace_ref=workspace-one",
          )
        ).status,
        404,
      );
      assert.equal((await request(base, cfg, "/v1/operations/op-one/cancel", foreign)).status, 404);
      await executor.close();
      const restarted = new Executor(cfg, {
        enabled: true,
        execute: async () => {
          calls++;
          return {};
        },
      });
      await restarted.init();
      try {
        assert.equal((await restarted.submit(op())).state, "succeeded");
        assert.equal(calls, 1);
      } finally {
        await restarted.close();
      }
    },
  );
});

test("archive effects use stable receipts across replay, changed destination, foreign scope and restart", async () => {
  let effects = 0;
  const input = { path: "code.zip", destination: "source", source_sha256: "a".repeat(64) };
  const raw = op("extract-one", { action: "archive.extract", sandbox_id: "sandbox-one", input });
  await fixture({ enabled: true, execute: async () => { effects++; return { sandbox_id: "sandbox-one", source_sha256: "a".repeat(64), destination: "source", files: [], file_count: 0, total_bytes: 0 }; } }, async (executor, base, cfg) => {
    const submissions = await Promise.all(Array.from({ length: 8 }, () => request(base, cfg, "/v1/operations", raw)));
    assert(submissions.every((value) => value.status === 200 || value.status === 202));
    assert.equal((await done(executor, "extract-one")).state, "succeeded");
    assert.equal(effects, 1);
    assert.equal((await request(base, cfg, "/v1/operations", { ...raw, input: { ...input, destination: "different" } })).status, 409);
    assert.equal((await request(base, cfg, "/v1/operations", { ...raw, owner_scope: "foreign" })).status, 404);
    await executor.close();
    const restarted = new Executor(cfg, { enabled: true, execute: async () => { effects++; return {}; } });
    await restarted.init();
    try { assert.equal((await restarted.submit(raw)).state, "succeeded"); assert.equal(effects, 1); }
    finally { await restarted.close(); }
  });
});

test("archive timeout is durably unknown and the same operation never extracts twice", async () => {
  let effects = 0;
  const raw = op("extract-timeout", { action: "archive.extract", sandbox_id: "sandbox-one", input: { path: "code.zip", destination: "source", source_sha256: "a".repeat(64) } });
  await fixture({ enabled: true, execute: async () => { effects++; throw new Fault("archive_timeout", 409, true); } }, async (executor) => {
    await executor.submit(raw);
    const receipt = await done(executor, "extract-timeout");
    assert.equal(receipt.state, "unknown");
    assert.equal(receipt.error?.code, "archive_timeout");
    assert.equal((await executor.submit(raw)).state, "unknown");
    assert.equal(effects, 1);
  });
});
test("restart fences unfinished external operation as unknown and never retries it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zeroagent-executor-restart-"));
  const cfg = config(dir);
  const ledger = new Ledger(dir, 10);
  await ledger.init();
  const parsed = operation(op(), cfg);
  const record: StoredReceipt = {
    operation_id: parsed.operation_id,
    action: parsed.action,
    state: "executing",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    scope_hash: scopeHash(cfg, owner),
    request_hash: requestHash(parsed),
    result: { sandbox_id: "possibly-created" },
  };
  await ledger.save(record);
  await ledger.close();
  let calls = 0;
  const executor = new Executor(cfg, {
    enabled: true,
    execute: async () => {
      calls++;
      return {};
    },
  });
  await executor.init();
  try {
    const receipt = await executor.submit(op());
    assert.equal(receipt.state, "unknown");
    assert.equal(receipt.result?.sandbox_id, "possibly-created");
    assert.equal(calls, 0);
  } finally {
    await executor.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("cancel reaches the adapter signal; disconnecting an HTTP subscriber does not cancel execution", async () => {
  let stop = 0;
  let release!: () => void;
  const adapter: Adapter = {
    enabled: true,
    execute: async (_op, context) => {
      await new Promise<void>((resolve) => {
        release = resolve;
        context.signal.addEventListener(
          "abort",
          () => {
            stop++;
            resolve();
          },
          { once: true },
        );
      });
      if (context.signal.aborted)
        throw new Fault("cancelled", 409, false, { sandbox_terminated: true });
      return {};
    },
  };
  await fixture(adapter, async (executor, base, cfg) => {
    assert.equal((await request(base, cfg, "/v1/operations", op())).status, 202);
    assert.equal(stop, 0);
    assert.equal((await request(base, cfg, "/v1/operations/op-one/cancel", owner)).status, 202);
    const receipt = await done(executor, "op-one");
    assert.equal(stop, 1);
    assert.equal(receipt.state, "cancelled");
    assert.equal(receipt.result?.sandbox_terminated, true);
    await request(base, cfg, "/v1/operations", op("op-two"));
    assert.equal(stop, 1);
    release();
    await done(executor, "op-two");
  });
});
test("paths, inputs, files, request body and allowed fields are bounded before external calls", async () => {
  let calls = 0;
  await fixture(
    {
      enabled: true,
      execute: async () => {
        calls++;
        return {};
      },
    },
    async (_executor, base, cfg) => {
      for (const path of [
        "../escape",
        "/etc/passwd",
        "nested/../escape",
        "a\\b",
        "a//b",
        "a/./b",
        "a\0b",
      ]) {
        assert.equal(
          (
            await request(
              base,
              cfg,
              "/v1/operations",
              op("bad-path", { action: "file.read", sandbox_id: "sandbox-one", input: { path } }),
            )
          ).status,
          400,
        );
      }
      assert.equal(
        (
          await request(
            base,
            cfg,
            "/v1/operations",
            op("bad-template", { input: { template: "caller-template" } }),
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await request(
            base,
            cfg,
            "/v1/operations",
            op("long-input", {
              action: "code.run",
              sandbox_id: "s",
              input: { code: "x".repeat(cfg.maxInputBytes + 1) },
            }),
          )
        ).status,
        413,
      );
      assert.equal(
        (
          await request(
            base,
            cfg,
            "/v1/operations",
            op("long-file", {
              action: "file.write",
              sandbox_id: "s",
              input: {
                path: "a",
                data_base64: Buffer.alloc(cfg.maxFileBytes + 1).toString("base64"),
              },
            }),
          )
        ).status,
        413,
      );
      assert.equal(
        (
          await request(
            base,
            cfg,
            "/v1/operations",
            op("bad-time", {
              action: "command.run",
              sandbox_id: "s",
              input: { command: "true", timeout_ms: cfg.maxTimeoutMs + 1 },
            }),
          )
        ).status,
        400,
      );
      assert.equal(
        (await request(base, cfg, "/v1/operations", { ignored: "x".repeat(cfg.maxBodyBytes + 1) }))
          .status,
        413,
      );
      assert.equal(calls, 0);
    },
  );
});
test("service and workspace concurrency and durable receipt capacity remain bounded", async () => {
  const execute = async (_op: Operation, context: Context) => {
    await new Promise<void>((resolve) =>
      context.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    throw new Fault("cancelled");
  };
  await fixture(
    { enabled: true, execute },
    async (executor, base, cfg) => {
      await request(base, cfg, "/v1/operations", op());
      assert.equal((await request(base, cfg, "/v1/operations", op("same-scope"))).status, 429);
      await request(base, cfg, "/v1/operations", {
        ...op("other-scope"),
        workspace_ref: "workspace-two",
      });
      assert.equal(
        (
          await request(base, cfg, "/v1/operations", {
            ...op("third"),
            workspace_ref: "workspace-three",
          })
        ).status,
        429,
      );
      executor.cancel("op-one", owner);
      await done(executor, "op-one");
    },
    { maxConcurrent: 2 },
  );
  await fixture(
    { enabled: true, execute: async () => ({}) },
    async (executor, base, cfg) => {
      await request(base, cfg, "/v1/operations", op());
      await done(executor, "op-one");
      assert.equal((await request(base, cfg, "/v1/operations", op("new-op"))).status, 503);
    },
    { maxReceipts: 1 },
  );
});
test("SDK error details never reflect, known management secrets redact, excess adapter output is unknown", async () => {
  let count = 0;
  await fixture(
    {
      enabled: true,
      execute: async () => {
        count++;
        if (count === 1) throw new Error("https://secret.test?token=do-not-reflect sk-secret");
        if (count === 2)
          return { stdout: "test-only-random-token-0123456789-abcdef api-key-never-return" };
        return { stdout: "x".repeat(1_600_001) };
      },
    },
    async (executor, base, cfg) => {
      await request(base, cfg, "/v1/operations", op());
      const first = await done(executor, "op-one");
      assert.equal(first.state, "unknown");
      assert(!JSON.stringify(first).includes("secret.test"));
      await request(base, cfg, "/v1/operations", op("redact"));
      const second = await done(executor, "redact");
      assert.equal(second.result?.stdout, "[redacted] [redacted]");
      await request(base, cfg, "/v1/operations", op("limit"));
      const third = await done(executor, "limit");
      assert.equal(third.state, "unknown");
      assert.equal(third.error?.code, "result_limit");
    },
    { apiKey: "api-key-never-return" },
  );
});
test("ledger refuses a second live process owner of the same data directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zeroagent-executor-lock-"));
  const a = new Ledger(dir, 10);
  const b = new Ledger(dir, 10);
  await a.init();
  try {
    await assert.rejects(b.init(), /ledger_locked/);
  } finally {
    await a.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("durable acknowledgement releases result bytes while stable IDs cannot execute again", async () => {
  let calls = 0;
  await fixture(
    {
      enabled: true,
      execute: async () => {
        calls++;
        return { data_base64: "a".repeat(1_300_000) };
      },
    },
    async (executor, base, cfg) => {
      const original = op("ack-large");
      await request(base, cfg, "/v1/operations", original);
      await done(executor, "ack-large");
      const before = executor.ledger.bytes;
      const ackPath = "/v1/operations/ack-large/acknowledge";
      assert.equal(
        (await request(base, cfg, ackPath, { ...owner, owner_scope: "another-owner" })).status,
        404,
      );
      assert.equal((await request(base, cfg, ackPath, owner)).status, 200);
      assert(executor.ledger.bytes < before / 100);
      assert.equal((await request(base, cfg, ackPath, owner)).body.acknowledged, true);
      assert.equal((await request(base, cfg, "/v1/operations", original)).status, 410);
      assert.equal(
        (
          await request(base, cfg, "/v1/operations", {
            ...original,
            action: "sandbox.info",
            sandbox_id: "vm",
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request(
            base,
            cfg,
            "/v1/operations/ack-large?owner_scope=account-one&workspace_ref=workspace-one",
          )
        ).status,
        410,
      );
      assert.equal(calls, 1);
      await request(base, cfg, "/v1/operations", op("unrelated"));
      await done(executor, "unrelated");
      assert.equal(calls, 2);
    },
  );
});

test("late adapter checkpoints cannot overwrite a terminal result before or after acknowledgement", async () => {
  let checkpoint: Context["checkpoint"] | undefined;
  await fixture(
    {
      enabled: true,
      execute: async (_op, context) => {
        checkpoint = context.checkpoint;
        return { final_result: "durable-final" };
      },
    },
    async (executor, base, cfg) => {
      await request(base, cfg, "/v1/operations", op("late-checkpoint"));
      assert.equal((await done(executor, "late-checkpoint")).result?.final_result, "durable-final");
      assert(checkpoint);
      await checkpoint({ late_progress: "must-not-replace-final" });
      assert.deepEqual(executor.get("late-checkpoint", owner).result, {
        final_result: "durable-final",
      });
      await request(base, cfg, "/v1/operations/late-checkpoint/acknowledge", owner);
      await checkpoint({ later_progress: "must-not-revive-retired" });
      assert.equal((await request(base, cfg, "/v1/operations", op("late-checkpoint"))).status, 410);
    },
  );
});

test("a journal binds namespace and stable scope key while allowing internal token rotation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zeroagent-journal-authority-"));
  const original = { ...config(dir), scopeKey: "stable-scope-key-0123456789-abcdef" };
  let executor = new Executor(original, { enabled: true, execute: async () => ({}) });
  try {
    await executor.init();
    await executor.close();
    for (const changed of [
      { ...original, scopeKey: "another-scope-key-0123456789-abcdef" },
      { ...original, namespace: "another-namespace" },
    ]) {
      const wrong = new Executor(changed, { enabled: true, execute: async () => ({}) });
      try {
        await assert.rejects(wrong.init(), /journal_authority_changed/);
      } finally {
        await wrong.close();
      }
    }
    executor = new Executor(
      { ...original, token: "rotated-service-token-0123456789-abcdef" },
      { enabled: true, execute: async () => ({}) },
    );
    await executor.init();
    assert.equal(executor.ready, true);
  } finally {
    await executor.close();
    await rm(dir, { recursive: true, force: true });
  }
});
