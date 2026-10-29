import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Sandbox, SandboxNotFoundError } from "e2b";
import { readConfig } from "../src/config.ts";
import { E2BAdapter } from "../src/e2b-adapter.ts";
import { type Config, Fault, type Operation, operation, scopeHash } from "../src/protocol.ts";

function config(): Config {
  return readConfig({
    ZEROAGENT_CLOUD_EXECUTOR_TOKEN: "test-only-executor-token-0123456789-abcdef",
    ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR: tmpdir(),
    ZEROAGENT_E2B_API_KEY: "test-never-sent-to-real-provider",
    ZEROAGENT_E2B_TEMPLATE: "configured-test-template",
  });
}
const owner = { owner_scope: "test-account", workspace_ref: "test-workspace" };
function op(action: string, input = {}, id = "sandbox-one", cfg = config()) {
  return operation(
    {
      ...owner,
      operation_id: "op-one",
      action,
      sandbox_id: action === "sandbox.create" || action === "sandbox.reconcile" ? undefined : id,
      input,
    },
    cfg,
  );
}
const apiMethods = ["create", "getInfo", "connect", "kill", "pause", "list"] as const;
async function provider(
  callback: (
    stub: ReturnType<typeof stubProvider>,
    adapter: E2BAdapter,
    cfg: Config,
  ) => Promise<void>,
) {
  const original = Object.fromEntries(apiMethods.map((key) => [key, Sandbox[key]]));
  const cfg = config();
  const stub = stubProvider(cfg);
  for (const key of apiMethods) Object.assign(Sandbox, { [key]: stub[key] });
  try {
    await callback(stub, new E2BAdapter(cfg), cfg);
  } finally {
    for (const key of apiMethods) Object.assign(Sandbox, { [key]: original[key] });
  }
}
function stubProvider(cfg: Config) {
  const calls: { action: string; args: any[] }[] = [];
  const info: any = {
    sandboxId: "sandbox-one",
    state: "running",
    templateId: cfg.template,
    envdVersion: "0.5.2",
    startedAt: new Date(),
    endAt: new Date(Date.now() + 300_000),
    metadata: { zeroagent_namespace: cfg.namespace, zeroagent_scope: scopeHash(cfg, owner) },
    network: { denyOut: ["0.0.0.0/0"], allowOut: [], allowPublicTraffic: false },
    lifecycle: { onTimeout: "pause", autoResume: false },
  };
  let run: (cmd: string, opts: any) => Promise<any> = async (_cmd, opts) => {
    await opts.onStdout?.("{}");
    return { pid: 777, wait: async () => ({ exitCode: 0 }) };
  };
  const sandbox = {
    sandboxId: info.sandboxId,
    getInfo: async (...args: any[]) => {
      calls.push({ action: "instance.getInfo", args });
      return info;
    },
    commands: {
      supportsStdinClose: true,
      run: async (cmd: string, opts: any) => {
        calls.push({ action: "commands.run", args: [cmd, opts] });
        return run(cmd, opts);
      },
    },
  };
  return {
    calls,
    info,
    sandbox,
    setRun: (next: typeof run) => {
      run = next;
    },
    create: async (...args: any[]) => {
      calls.push({ action: "create", args });
      info.metadata = args[1].metadata;
      return sandbox;
    },
    getInfo: async (...args: any[]) => {
      calls.push({ action: "getInfo", args });
      return info;
    },
    connect: async (...args: any[]) => {
      calls.push({ action: "connect", args });
      return sandbox;
    },
    kill: async (...args: any[]) => {
      calls.push({ action: "kill", args });
      return true;
    },
    pause: async (...args: any[]) => {
      calls.push({ action: "pause", args });
      return true;
    },
    list: (...args: any[]) => {
      calls.push({ action: "list", args });
      info.metadata = args[0].query.metadata;
      return { hasNext: false, nextItems: async () => [info] };
    },
  };
}
const context = () => ({
  signal: new AbortController().signal,
  checkpoint: async (_result: Record<string, unknown>) => {},
});
test("SDK create uses configured template, explicit isolation, HMAC ownership, no implicit credentials or retries", async () => {
  await provider(async (stub, adapter, cfg) => {
    let checkpoint: Record<string, unknown> | undefined;
    const result = await adapter.execute(op("sandbox.create"), {
      ...context(),
      checkpoint: async (value) => {
        checkpoint = value;
      },
    });
    const create = stub.calls.find((call) => call.action === "create")!;
    const opts = create.args[1];
    assert.equal(create.args[0], cfg.template);
    assert.equal(opts.apiKey, cfg.apiKey);
    assert.equal(opts.apiUrl, "https://api.e2b.app");
    assert.equal(opts.retries, 0);
    assert.equal(opts.debug, false);
    assert.equal(opts.allowInternetAccess, false);
    assert.deepEqual(opts.network, {
      denyOut: ["0.0.0.0/0"],
      allowOut: [],
      allowPublicTraffic: false,
    });
    assert.deepEqual(opts.lifecycle, { onTimeout: "pause", autoResume: false });
    assert.deepEqual(opts.envs, {});
    assert.equal(opts.metadata.zeroagent_scope, scopeHash(cfg, owner));
    assert(!JSON.stringify(opts.metadata).includes(owner.owner_scope));
    assert.equal(checkpoint?.sandbox_id, "sandbox-one");
    assert.equal(result.sandbox_id, "sandbox-one");
    assert(!JSON.stringify(result).includes(cfg.apiKey!));
    assert(!("trafficAccessToken" in result));
  });
});
test("every existing sandbox operation verifies owner before connecting, resuming, pausing, killing or reading files", async () => {
  await provider(async (stub, adapter) => {
    stub.info.metadata.zeroagent_scope = "foreign";
    for (const action of [
      "sandbox.info",
      "sandbox.connect",
      "sandbox.pause",
      "sandbox.resume",
      "sandbox.kill",
      "command.run",
      "file.read",
    ]) {
      await assert.rejects(
        adapter.execute(
          op(
            action,
            action === "command.run"
              ? { command: "true" }
              : action === "file.read"
                ? { path: "a" }
                : {},
          ),
          context(),
        ),
        (error: unknown) => error instanceof Fault && error.code === "sandbox_not_found",
      );
    }
    assert(stub.calls.every((call) => call.action === "getInfo"));
  });
});
test("paused VM requires explicit resume; foreign or network-policy drift cannot execute", async () => {
  await provider(async (stub, adapter) => {
    stub.info.state = "paused";
    await assert.rejects(
      adapter.execute(op("command.run", { command: "true" }), context()),
      /sandbox_paused/,
    );
    assert(!stub.calls.some((call) => call.action === "connect"));
    stub.info.state = "running";
    await adapter.execute(op("sandbox.resume"), context());
    assert(stub.calls.some((call) => call.action === "connect"));
    stub.info.network.allowPublicTraffic = true;
    await assert.rejects(
      adapter.execute(op("command.run", { command: "true" }), context()),
      /unsafe_sandbox_policy/,
    );
    await adapter.execute(op("sandbox.kill"), context());
    assert(stub.calls.some((call) => call.action === "kill"));
  });
});
test("provider envd capability is checked before initialization and existing VM execution, while cleanup remains possible", async () => {
  await provider(async (stub, adapter) => {
    for (const version of [undefined, "", "0.4.99", "0.5.1", "0.5.2-rc.1", "invalid"]) {
      stub.info.envdVersion = version;
      await assert.rejects(adapter.execute(op("sandbox.create"), context()), /sandbox_initialization_failed/);
      await assert.rejects(
        adapter.execute(op("command.run", { command: "true" }), context()),
        /unsafe_envd_version/,
      );
      assert(!stub.calls.some((call) => call.action === "commands.run" || call.action === "connect"));
    }
    await adapter.execute(op("sandbox.kill"), context());
    assert(stub.calls.some((call) => call.action === "kill"));
    for (const version of ["0.5.2", "0.5.3", "0.6.0", "1.0.0", "0.5.2+build.1"]) {
      stub.info.envdVersion = version;
      const result = await adapter.execute(op("sandbox.info"), context());
      assert.equal(result.sandbox_id, "sandbox-one");
    }
  });
});

test("command cancellation kills the owned remote VM and descendants, then resolves without waiting for a stuck stream", async () => {
  await provider(async (stub, adapter) => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    stub.setRun(async () => {
      began();
      return { pid: 123, wait: () => new Promise(() => {}) };
    });
    const controller = new AbortController();
    const pending = adapter.execute(op("command.run", { command: "sleep 999" }), {
      ...context(),
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof Fault &&
        error.code === "cancelled" &&
        error.detail?.sandbox_terminated === true,
    );
    assert.equal(stub.calls.filter((call) => call.action === "kill").length, 1);
    const run = stub.calls.find((call) => call.action === "commands.run")!.args[1];
    assert.equal(run.retainOutput, false);
    assert.equal(run.background, true);
    assert.equal(run.user, "user");
    assert.equal(run.envs, undefined);
  });
});
test("output limit triggers remote termination; failed termination leaves unknown result", async () => {
  await provider(async (stub, adapter, cfg) => {
    stub.setRun(async (_cmd, opts) => {
      opts.onStdout("x".repeat(cfg.maxOutputBytes + 1));
      return { pid: 123, wait: async () => ({ exitCode: 0 }) };
    });
    await assert.rejects(
      adapter.execute(op("command.run", { command: "print too much" }), context()),
      (error: unknown) =>
        error instanceof Fault && error.code === "output_limit" && !error.uncertain,
    );
    Object.assign(Sandbox, {
      kill: async () => {
        throw new Error("network failure secret URL");
      },
    });
    await assert.rejects(
      adapter.execute(op("command.run", { command: "print too much" }), context()),
      (error: unknown) =>
        error instanceof Fault && error.uncertain && error.detail?.sandbox_terminated === false,
    );
  });
});
test("broken command stream stays unknown even after VM termination confirms that execution stopped", async () => {
  await provider(async (stub, adapter) => {
    stub.setRun(async () => ({
      pid: 123,
      wait: async () => {
        throw new Error("stream closed after side effect");
      },
    }));
    await assert.rejects(
      adapter.execute(op("command.run", { command: "external effect" }), context()),
      (error: unknown) =>
        error instanceof Fault &&
        error.code === "execution_unknown" &&
        error.uncertain &&
        error.detail?.sandbox_terminated === true,
    );
  });
});
test("uncertain create is not retried, and reconciliation filters exact scoped create metadata", async () => {
  await provider(async (stub, adapter) => {
    let creates = 0;
    Object.assign(Sandbox, {
      create: async () => {
        creates++;
        throw new Error("timed out after allocating");
      },
    });
    await assert.rejects(adapter.execute(op("sandbox.create"), context()));
    assert.equal(creates, 1);
    await adapter.execute(
      op("sandbox.reconcile", { create_operation_id: "original-create" }),
      context(),
    );
    const list = stub.calls.find((call) => call.action === "list")!.args[0];
    assert.equal(list.query.metadata.zeroagent_scope, stub.info.metadata.zeroagent_scope);
    assert.equal(list.limit, 20);
    assert.equal(list.retries, 0);
  });
});
test("reconciliation can discover unsafe owned VMs only for cleanup and verifies exact create identity", async () => {
  await provider(async (stub, adapter) => {
    stub.info.envdVersion = "0.1.0";
    stub.info.network = { allowPublicTraffic: true, allowOut: ["0.0.0.0/0"] };
    stub.info.lifecycle.autoResume = true;
    const result = await adapter.execute(op("sandbox.reconcile", { create_operation_id: "original" }), context());
    assert.equal(result.cleanup_only, true);
    assert.equal(result.automatic_retry_safe, false);
    assert.equal((result.candidates as any[])[0].network.outbound, "unconfirmed");
    assert.equal((result.candidates as any[])[0].network.public_access, true);
    assert(!stub.calls.some((call) => call.action === "connect" || call.action === "commands.run"));
    await adapter.execute(op("sandbox.kill"), context());
    const expected = { ...stub.info.metadata };
    for (const key of ["zeroagent_create", "zeroagent_scope", "zeroagent_namespace"]) {
      stub.info.metadata = { ...expected, [key]: "foreign" };
      Object.assign(Sandbox, { list: () => ({ hasNext: false, nextItems: async () => [stub.info] }) });
      await assert.rejects(
        adapter.execute(op("sandbox.reconcile", { create_operation_id: "original" }), context()),
        /sandbox_not_found/,
      );
    }
  });
});

test("file operations never use host paths and keep encoded payload separate from executable source", async () => {
  await provider(async (stub, adapter) => {
    stub.setRun(async (cmd, opts) => {
      assert(cmd.startsWith("python3 -c 'import base64;exec(base64.b64decode("));
      const chunks: Uint8Array[] = [];
      assert.equal(opts.stdin, true);
      return {
        pid: 123,
        wait: async () => ({ exitCode: 0 }),
        sendStdin: async (input: Uint8Array) => {
          assert(input.byteLength <= 32 * 1024);
          chunks.push(input);
        },
        closeStdin: async () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          assert.equal(payload.root, "/home/user/zeroagent-workspace");
          assert.equal(payload.path, "folder/a.txt");
          assert.equal(payload.data, "aGk=");
          opts.onStdout('{"bytes":2}');
        },
      };
    });
    const result = await adapter.execute(
      op("file.write", { path: "folder/a.txt", data_base64: "aGk=" }),
      context(),
    );
    assert.equal(result.bytes, 2);
  });
});

test("archive extraction uses the owned denied-network VM and fixed guest source with bounded stdin and manifest output", async () => {
  await provider(async (stub, adapter) => {
    stub.setRun(async (cmd, opts) => {
      assert(cmd.startsWith("python3 -I -c"));
      assert(!cmd.includes("uploads/code-task.zip"));
      assert.equal(opts.timeoutMs, 35_000);
      assert.equal(opts.user, "user");
      const chunks: Uint8Array[] = [];
      return {
        pid: 321,
        wait: async () => ({ exitCode: 0 }),
        sendStdin: async (data: Uint8Array) => { assert(data.byteLength <= 32 * 1024); chunks.push(data); },
        closeStdin: async () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString());
          assert.deepEqual(payload, { path: "uploads/code-task.zip", destination: "source", source_sha256: "a".repeat(64), root: "/home/user/zeroagent-workspace" });
          opts.onStdout(JSON.stringify({ source_sha256: payload.source_sha256, destination: payload.destination, files: [], file_count: 0, total_bytes: 0 }));
        },
      };
    });
    const result = await adapter.execute(op("archive.extract", { path: "uploads/code-task.zip", destination: "source", source_sha256: "a".repeat(64) }), context());
    assert.equal(result.sandbox_id, "sandbox-one");
    assert.equal(result.destination, "source");
    stub.info.metadata.zeroagent_scope = "foreign";
    await assert.rejects(adapter.execute(op("archive.extract", { path: "a.zip", destination: "b", source_sha256: "a".repeat(64) }), context()), /sandbox_not_found/);
  });
});

test("archive cancellation stops the owned VM and uncertain guest cleanup remains unknown", async () => {
  await provider(async (stub, adapter) => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    stub.setRun(async () => { began(); return { pid: 123, wait: () => new Promise(() => {}), sendStdin: async () => {}, closeStdin: async () => {} }; });
    const controller = new AbortController();
    const pending = adapter.execute(op("archive.extract", { path: "a.zip", destination: "b", source_sha256: "a".repeat(64) }), { ...context(), signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof Fault && error.code === "cancelled" && error.detail?.sandbox_terminated === true);
    assert(stub.calls.some((call) => call.action === "kill"));
    stub.setRun(async (_cmd, opts) => ({ pid: 124, wait: async () => ({ exitCode: 0 }), sendStdin: async () => {}, closeStdin: async () => { opts.onStdout('{"error":"archive_cleanup_unknown","uncertain":true}'); } }));
    await assert.rejects(adapter.execute(op("archive.extract", { path: "a.zip", destination: "b", source_sha256: "a".repeat(64) }), context()), (error: unknown) => error instanceof Fault && error.code === "archive_cleanup_unknown" && error.uncertain);
    stub.setRun(async (_cmd, opts) => ({ pid: 125, wait: async () => ({ exitCode: 0 }), sendStdin: async () => {}, closeStdin: async () => { opts.onStdout('{"error":"archive_timeout","uncertain":true}'); } }));
    await assert.rejects(adapter.execute(op("archive.extract", { path: "a.zip", destination: "b", source_sha256: "a".repeat(64) }), context()), (error: unknown) => error instanceof Fault && error.code === "archive_timeout" && error.uncertain);
  });
});
test("one MiB file input uses bounded SDK stdin chunks without Linux argument size overflow", async () => {
  await provider(async (stub, adapter, cfg) => {
    let total = 0;
    let chunks = 0;
    const content = Buffer.alloc(cfg.maxFileBytes, 99).toString("base64");
    stub.setRun(async (command, opts) => {
      assert(Buffer.byteLength(command) < 16 * 1024);
      return {
        pid: 123,
        wait: async () => ({ exitCode: 0 }),
        sendStdin: async (input: Uint8Array) => {
          assert(input.byteLength <= 32 * 1024);
          total += input.byteLength;
          chunks++;
        },
        closeStdin: async () => {
          opts.onStdout(`{"bytes":${cfg.maxFileBytes}}`);
        },
      };
    });
    const result = await adapter.execute(
      op("file.write", { path: "large.bin", data_base64: content }),
      context(),
    );
    assert.equal(result.bytes, cfg.maxFileBytes);
    assert(total > cfg.maxFileBytes);
    assert(chunks > 32);
  });
});
test("kill confirms an already-absent VM without skipping ownership checks for a live foreign VM", async () => {
  await provider(async (stub, adapter) => {
    Object.assign(Sandbox, {
      getInfo: async () => {
        throw new SandboxNotFoundError("absent");
      },
    });
    const result = await adapter.execute(op("sandbox.kill"), context());
    assert.equal(result.sandbox_terminated, true);
    assert.equal(result.was_running, false);
    assert(!stub.calls.some((call) => call.action === "kill"));
  });
});
test("ordinary workspace operations never extend the reserved VM lifetime", async () => {
  await provider(async (stub, adapter) => {
    await adapter.execute(op("command.run", { command: "true" }), context());
    const connect = stub.calls.find((call) => call.action === "connect");
    assert.equal(connect?.args[1].timeoutMs, undefined);
  });
});
