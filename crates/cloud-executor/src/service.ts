import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Adapter } from "./adapter.ts";
import { redact } from "./adapter.ts";
import { Ledger } from "./ledger.ts";
import {
  type Config,
  Fault,
  identifier,
  normalizedError,
  type Operation,
  operation,
  publicReceipt,
  requestHash,
  type Scope,
  type StoredReceipt,
  scope,
  scopeHash,
} from "./protocol.ts";

export class Executor {
  config: Config;
  adapter: Adapter;
  ledger: Ledger;
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private admissions = new Map<string, Promise<void>>();
  private scopes = new Set<string>();
  private accepting = true;
  constructor(config: Config, adapter: Adapter) {
    this.config = config;
    this.adapter = adapter;
    this.ledger = new Ledger(
      config.dataDir,
      config.maxReceipts,
      config.maxJournalBytes,
      scopeHash(config, { owner_scope: "journal-authority", workspace_ref: "journal-v1" }),
    );
  }
  async init() {
    try {
      await this.ledger.init();
    } catch (error) {
      await this.ledger.close();
      throw error;
    }
  }
  get ready() {
    return this.accepting && this.ledger.canAdmit();
  }
  get(id: string, owner: Scope): StoredReceipt {
    const record = this.ledger.get(id);
    if (!record || record.scope_hash !== scopeHash(this.config, owner))
      throw new Fault("operation_not_found", 404);
    if (record.result_retired) throw new Fault("operation_result_retired", 410, true);
    return record;
  }
  async submit(value: unknown): Promise<StoredReceipt> {
    const op = operation(value, this.config);
    const hash = scopeHash(this.config, op);
    const fingerprint = requestHash(op);
    const existing = this.ledger.get(op.operation_id);
    if (existing) {
      if (existing.scope_hash !== hash) throw new Fault("operation_not_found", 404);
      if (existing.request_hash !== fingerprint) throw new Fault("operation_conflict", 409);
      await this.admissions.get(op.operation_id);
      return this.get(op.operation_id, op);
    }
    if (!this.accepting) throw new Fault("shutting_down", 503);
    if (!this.adapter.enabled) throw new Fault("e2b_disabled", 503);
    if (this.active.size >= this.config.maxConcurrent || this.scopes.has(hash))
      throw new Fault("executor_busy", 429);
    if (!this.ledger.canAdmit()) throw new Fault("ledger_capacity", 503);
    const record: StoredReceipt = {
      operation_id: op.operation_id,
      action: op.action,
      state: "executing",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      scope_hash: hash,
      request_hash: fingerprint,
    };
    // Reserve scope and ID synchronously before the first await. No remote work
    // starts until the receipt was flushed to disk.
    this.scopes.add(hash);
    this.ledger.stage(record);
    const controller = new AbortController();
    let start!: () => void;
    const gate = new Promise<void>((resolve) => {
      start = resolve;
    });
    const promise = gate
      .then(() => this.run(op, record, controller))
      .finally(() => {
        this.active.delete(op.operation_id);
        this.scopes.delete(hash);
      });
    this.active.set(op.operation_id, { controller, promise });
    const admission = this.ledger.save(record);
    this.admissions.set(op.operation_id, admission);
    try {
      await admission;
    } catch (error) {
      this.active.delete(op.operation_id);
      this.scopes.delete(hash);
      this.ledger.unstage(op.operation_id);
      // Resolve the gate without issuing any provider operation.
      controller.abort(new Fault("receipt_write_failed", 503));
      start();
      await promise;
      throw error;
    } finally {
      this.admissions.delete(op.operation_id);
    }
    start();
    return this.get(op.operation_id, op);
  }
  private async run(op: Operation, record: StoredReceipt, controller: AbortController) {
    let settled = false;
    const deadline = setTimeout(
      () => controller.abort(new Fault("operation_timeout", 504)),
      this.config.maxTimeoutMs + 45_000,
    );
    try {
      controller.signal.throwIfAborted();
      const result = await this.adapter.execute(op, {
        signal: controller.signal,
        checkpoint: async (partial) => {
          if (settled || record.state !== "executing") return;
          record.result = redact(partial, this.config) as Record<string, unknown>;
          record.updated_at = new Date().toISOString();
          await this.ledger.save(record);
        },
      });
      settled = true;
      if (Buffer.byteLength(JSON.stringify(result)) > 1_600_000)
        throw new Fault("result_limit", 502, true);
      record.result = redact(result, this.config) as Record<string, unknown>;
      record.state = controller.signal.aborted ? "unknown" : "succeeded";
      if (record.state === "unknown")
        record.error = normalizedError(new Fault("cancel_outcome_unknown", 502, true));
    } catch (error) {
      settled = true;
      const known = error instanceof Fault && !error.uncertain;
      record.state = known
        ? controller.signal.aborted || (error as Fault).code === "cancelled"
          ? "cancelled"
          : "failed"
        : "unknown";
      record.error = normalizedError(error);
      if (error instanceof Fault && error.detail)
        record.result = {
          ...record.result,
          ...(redact(error.detail, this.config) as Record<string, unknown>),
        };
    } finally {
      settled = true;
      clearTimeout(deadline);
      record.updated_at = new Date().toISOString();
      try {
        await this.ledger.save(record);
      } catch {
        // No false success if the external result could not be durably recorded.
        record.state = "unknown";
        record.result = undefined;
        record.error = normalizedError(new Fault("receipt_write_failed", 503, true));
        this.ledger.stage(record);
        this.accepting = false;
      }
    }
  }
  cancel(id: string, owner: Scope) {
    const record = this.get(id, owner);
    if (record.state === "executing")
      this.active.get(id)?.controller.abort(new Fault("cancelled", 409));
    return record;
  }
  async close() {
    this.accepting = false;
    for (const active of this.active.values()) active.controller.abort(new Fault("shutdown", 503));
    await Promise.allSettled([...this.active.values()].map((active) => active.promise));
    await this.ledger.close();
  }
  async acknowledge(id: string, owner: Scope) {
    const record = this.ledger.get(id);
    if (!record || record.scope_hash !== scopeHash(this.config, owner))
      throw new Fault("operation_not_found", 404);
    await this.ledger.retire(record);
  }
}
function authorized(request: IncomingMessage, token: string) {
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const actual = createHash("sha256")
    .update(request.headers.authorization ?? "")
    .digest();
  return timingSafeEqual(expected, actual);
}
async function body(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (
    request.headers["content-type"]?.split(";")[0].trim() !== "application/json" ||
    request.headers["content-encoding"]
  )
    throw new Fault("json_required", 415);
  const declared = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared > maxBytes) throw new Fault("body_limit", 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Fault("body_limit", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Fault("invalid_json");
  }
}
function send(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(data));
}
export function httpServer(executor: Executor) {
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 1000 },
    async (request, response) => {
      try {
        // Browser origins never receive an internal API CORS surface.
        if (request.headers.origin || !authorized(request, executor.config.token))
          throw new Fault("unauthorized", 401);
        const url = new URL(request.url ?? "/", "http://localhost");
        if (request.method === "GET" && url.pathname === "/v1/health") {
          send(response, 200, {
            service: "zeroagent-cloud-executor",
            protocol: 1,
            enabled: executor.adapter.enabled,
            disabled_reason: executor.adapter.enabled ? undefined : "ZEROAGENT_E2B_API_KEY_missing",
            limits: {
              max_concurrent: executor.config.maxConcurrent,
              max_timeout_ms: executor.config.maxTimeoutMs,
              max_input_bytes: executor.config.maxInputBytes,
              max_output_bytes: executor.config.maxOutputBytes,
              max_file_bytes: executor.config.maxFileBytes,
            },
            journal: {
              records: executor.ledger.size,
              result_bytes: executor.ledger.bytes,
              max_records: executor.config.maxReceipts,
              max_result_bytes: executor.config.maxJournalBytes,
              admission_available: executor.ready,
            },
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/operations") {
          const receipt = await executor.submit(await body(request, executor.config.maxBodyBytes));
          send(response, receipt.state === "executing" ? 202 : 200, publicReceipt(receipt));
          return;
        }
        const match = /^\/v1\/operations\/([^/]+)(\/(?:cancel|acknowledge))?$/.exec(url.pathname);
        if (!match) throw new Fault("not_found", 404);
        const id = identifier(decodeURIComponent(match[1]));
        if (request.method === "GET" && !match[2]) {
          const owner = scope({
            owner_scope: url.searchParams.get("owner_scope"),
            workspace_ref: url.searchParams.get("workspace_ref"),
          });
          send(response, 200, publicReceipt(executor.get(id, owner)));
          return;
        }
        if (request.method === "POST" && match[2] === "/acknowledge") {
          const owner = scope(await body(request, executor.config.maxBodyBytes));
          await executor.acknowledge(id, owner);
          send(response, 200, { operation_id: id, acknowledged: true });
          return;
        }
        if (request.method === "POST" && match[2] === "/cancel") {
          const owner = scope(await body(request, executor.config.maxBodyBytes));
          const receipt = executor.cancel(id, owner);
          send(response, receipt.state === "executing" ? 202 : 200, publicReceipt(receipt));
          return;
        }
        throw new Fault("not_found", 404);
      } catch (error) {
        const status = error instanceof Fault ? error.status : 500;
        if (!response.headersSent) send(response, status, { error: normalizedError(error) });
        else response.destroy();
      }
    },
  );
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  return server;
}
