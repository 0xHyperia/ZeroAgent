import { createHmac } from "node:crypto";
import { Worker } from "node:worker_threads";
import { CommandExitError, Sandbox, type SandboxInfo, SandboxNotFoundError } from "e2b";
import type { Adapter, Context } from "./adapter.ts";
import { archiveInput, brokerCommand, brokerInput, parserInput } from "./file-broker.ts";
import { type Config, Fault, type Operation, scopeHash } from "./protocol.ts";
import { sanitizeSdkEnvironment, sdkOptions } from "./sdk-options.ts";

function brokerError(value: unknown): string {
  const allowed = [
    "invalid_path",
    "file_limit",
    "body_limit",
    "sandbox_file_error",
    "invalid_transfer",
    "transfer_conflict",
    "transfer_capacity",
    "transfer_not_found",
    "transfer_finalized",
    "transfer_expired",
    "transfer_out_of_order",
    "transfer_incomplete",
    "digest_mismatch",
    "invalid_offset",
    "file_changed",
    "input_limit",
    "invalid_request",
    "source_limit",
    "unsupported_format",
    "xml_limit",
    "zip_entries_limit",
    "unsafe_archive",
    "zip_expansion_limit",
    "unsafe_relationship",
    "encrypted_pdf",
    "page_limit",
    "pdf_stream_limit",
    "paragraph_limit",
    "cell_limit",
    "sheet_limit",
    "invalid_workbook",
    "invalid_cell",
    "invalid_shared_string",
    "invalid_presentation",
    "output_limit",
    "parse_timeout",
    "parser_dependency_missing",
    "parse_failed",
    "archive_destination_exists",
    "archive_atomic_publish_unavailable",
    "archive_cleanup_unknown",
    "archive_invalid",
    "archive_failed",
    "archive_timeout",
  ];
  return typeof value === "string" && allowed.includes(value) ? value : "sandbox_file_error";
}

export class E2BAdapter implements Adapter {
  config: Config;
  enabled: boolean;
  constructor(config: Config) {
    this.config = config;
    this.enabled = !!config.apiKey;
    sanitizeSdkEnvironment();
  }
  private options() {
    if (!this.config.apiKey) throw new Fault("e2b_disabled", 503);
    return sdkOptions(this.config.apiKey);
  }
  private metadata(op: Operation, createId = op.operation_id) {
    return {
      zeroagent_namespace: this.config.namespace,
      zeroagent_scope: scopeHash(this.config, op),
      zeroagent_create: createHmac("sha256", this.config.scopeKey)
        .update(JSON.stringify([scopeHash(this.config, op), createId]))
        .digest("hex"),
    };
  }
  private owned(info: SandboxInfo, op: Operation) {
    const expected = this.metadata(op);
    if (
      info.metadata.zeroagent_namespace !== expected.zeroagent_namespace ||
      info.metadata.zeroagent_scope !== expected.zeroagent_scope
    )
      throw new Fault("sandbox_not_found", 404);
  }
  private isolated(info: SandboxInfo) {
    if (
      info.network?.allowPublicTraffic !== false ||
      !info.network?.denyOut?.includes("0.0.0.0/0") ||
      (info.network.allowOut?.length ?? 0) !== 0 ||
      info.lifecycle?.autoResume !== false
    )
      throw new Fault("unsafe_sandbox_policy", 409);
    // The broker closes stdin to delimit bounded JSON frames. The pinned SDK
    // requires envd >= 0.5.2 for closeStdin; a local template image alone does
    // not establish the version installed by the provider.
    const version = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(info.envdVersion ?? "");
    const parts = version?.slice(1, 4).map(Number);
    if (
      !parts ||
      parts.some((part) => !Number.isSafeInteger(part)) ||
      (parts[0] === 0 && (parts[1] < 5 || (parts[1] === 5 && parts[2] < 2)))
    )
      throw new Fault("unsafe_envd_version", 409);
  }
  private view(info: SandboxInfo): Record<string, unknown> {
    return {
      sandbox_id: info.sandboxId,
      state: info.state,
      started_at: info.startedAt.toISOString(),
      expires_at: info.endAt.toISOString(),
      template_id: info.templateId,
      network: { outbound: "denied", public_access: false },
      auto_resume: false,
    };
  }
  private async terminate(sandboxId: string): Promise<boolean> {
    try {
      await Sandbox.kill(sandboxId, this.options());
      return true;
    } catch {
      return false;
    }
  }
  async execute(op: Operation, context: Context): Promise<Record<string, unknown>> {
    if (!this.enabled) throw new Fault("e2b_disabled", 503);
    context.signal.throwIfAborted();
    if (op.action === "sandbox.reconcile") {
      const expected = this.metadata(op, String(op.input.create_operation_id));
      const paginator = Sandbox.list({
        ...this.options(),
        query: { metadata: expected },
        limit: 20,
      });
      const matches = await paginator.nextItems({ signal: context.signal });
      if (paginator.hasNext) throw new Fault("reconcile_limit", 409);
      return {
        candidates: matches.map((info) => {
          this.owned(info, op);
          if (info.metadata.zeroagent_create !== expected.zeroagent_create)
            throw new Fault("sandbox_not_found", 404);
          // Discovery is exclusively for cleanup, including after policy or
          // envd drift. These observations cannot authorize execution/resume.
          return {
            sandbox_id: info.sandboxId,
            state: info.state,
            started_at: info.startedAt.toISOString(),
            expires_at: info.endAt.toISOString(),
            template_id: info.templateId,
            network: {
              outbound:
                info.network?.denyOut?.includes("0.0.0.0/0") &&
                (info.network.allowOut?.length ?? 0) === 0
                  ? "denied"
                  : "unconfirmed",
              public_access: info.network?.allowPublicTraffic ?? null,
            },
            auto_resume: info.lifecycle?.autoResume ?? null,
          };
        }),
        create_operation_id: op.input.create_operation_id,
        cleanup_only: true,
        automatic_retry_safe: false,
      };
    }
    if (op.action === "sandbox.create") {
      // No SDK retry: a timed-out create may still have allocated a billed VM.
      if (!this.config.template) throw new Fault("explicit_template_required", 503);
      const sandbox = await Sandbox.create(this.config.template, {
        ...this.options(),
        signal: context.signal,
        timeoutMs: this.config.sandboxTimeoutMs,
        metadata: this.metadata(op),
        envs: {},
        allowInternetAccess: false,
        network: { denyOut: ["0.0.0.0/0"], allowOut: [], allowPublicTraffic: false },
        lifecycle: { onTimeout: "pause", autoResume: false },
      });
      try {
        await context.checkpoint({ sandbox_id: sandbox.sandboxId });
        if (context.signal.aborted) throw new Fault("cancelled", 409);
        const info = await sandbox.getInfo(this.options());
        this.owned(info, op);
        this.isolated(info);
        const initialized = await this.command(
          sandbox,
          brokerCommand({ action: "init", root: this.config.workspaceRoot }),
          15_000,
          context.signal,
          1024,
        );
        if (initialized.exit_code !== 0 || JSON.parse(String(initialized.stdout)).error)
          throw new Fault("sandbox_initialization_failed", 502);
        return this.view(info);
      } catch {
        const confirmed = await this.terminate(sandbox.sandboxId);
        throw new Fault(
          context.signal.aborted ? "cancelled" : "sandbox_initialization_failed",
          502,
          !confirmed,
          { sandbox_id: sandbox.sandboxId, sandbox_terminated: confirmed },
        );
      }
    }
    const id = op.sandbox_id;
    if (!id) throw new Fault("sandbox_required");
    let info: SandboxInfo;
    try {
      info = await Sandbox.getInfo(id, { ...this.options(), signal: context.signal });
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        if (op.action === "sandbox.kill")
          return { sandbox_id: id, sandbox_terminated: true, was_running: false };
        throw new Fault("sandbox_not_found", 404);
      }
      throw error;
    }
    this.owned(info, op);
    // Killing an owned VM also remains possible after policy drift.
    if (op.action === "sandbox.kill")
      return {
        sandbox_id: id,
        sandbox_terminated: true,
        was_running: await Sandbox.kill(id, this.options()),
      };
    this.isolated(info);
    if (op.action === "sandbox.info") return this.view(info);
    if (op.action === "sandbox.pause")
      return { sandbox_id: id, paused: await Sandbox.pause(id, this.options()) };
    if (info.state === "paused" && op.action !== "sandbox.resume")
      throw new Fault("sandbox_paused", 409);
    context.signal.throwIfAborted();
    const sandbox = await Sandbox.connect(id, {
      ...this.options(),
      signal: context.signal,
      ...(op.action === "sandbox.resume" ? { timeoutMs: this.config.sandboxTimeoutMs } : {}),
    });
    if (op.action === "sandbox.resume" || op.action === "sandbox.connect") {
      const current = await sandbox.getInfo(this.options());
      this.owned(current, op);
      this.isolated(current);
      return this.view(current);
    }
    if (op.action === "command.run") {
      const cwd = op.input.cwd
        ? `${this.config.workspaceRoot}/${op.input.cwd}`
        : this.config.workspaceRoot;
      return {
        sandbox_id: id,
        ...(await this.command(
          sandbox,
          String(op.input.command),
          Number(op.input.timeout_ms ?? 60_000),
          context.signal,
          this.config.maxOutputBytes,
          cwd,
        )),
      };
    }
    if (op.action === "code.run")
      return { sandbox_id: id, ...(await this.code(sandbox, op, context.signal)) };
    if (op.action === "archive.extract") {
      const invocation = archiveInput({ ...op.input, root: this.config.workspaceRoot });
      const output = await this.command(
        sandbox,
        invocation.command,
        35_000,
        context.signal,
        192 * 1024,
        this.config.workspaceRoot,
        invocation.input,
      );
      if (output.exit_code !== 0) throw new Fault("archive_failed", 502, true);
      const parsed = JSON.parse(String(output.stdout));
      if (parsed.error) throw new Fault(brokerError(parsed.error), 409, !!parsed.uncertain);
      return { sandbox_id: id, ...parsed };
    }
    if (op.action === "file.parse") {
      const invocation = parserInput({
        ...op.input,
        root: this.config.workspaceRoot,
        scope: scopeHash(this.config, op),
        sandbox_id: id,
      });
      const output = await this.command(
        sandbox,
        invocation.command,
        60_000,
        context.signal,
        4096,
        this.config.workspaceRoot,
        invocation.input,
      );
      if (output.exit_code !== 0) throw new Fault("parse_failed", 502, true);
      const parsed = JSON.parse(String(output.stdout));
      if (parsed.error) throw new Fault(brokerError(parsed.error), 409, !!parsed.uncertain);
      return { sandbox_id: id, ...parsed };
    }
    const payload = {
      ...op.input,
      action:
        op.action === "file.read"
          ? "read"
          : op.action === "file.write"
            ? "write"
            : op.action.slice(5),
      root: this.config.workspaceRoot,
      path: op.input.path,
      data: op.input.data_base64,
      limit: this.config.maxFileBytes,
      scope: scopeHash(this.config, op),
      sandbox_id: id,
    };
    const invocation = brokerInput(payload);
    const output = await this.command(
      sandbox,
      invocation.command,
      30_000,
      context.signal,
      Math.ceil((this.config.maxFileBytes * 4) / 3) + 2048,
      this.config.workspaceRoot,
      invocation.input,
    );
    if (output.exit_code !== 0) throw new Fault("sandbox_file_error", 409);
    const parsed = JSON.parse(String(output.stdout));
    if (parsed.error) throw new Fault(brokerError(parsed.error), 409, !!parsed.uncertain);
    return { sandbox_id: id, path: op.input.path, ...parsed };
  }
  private async command(
    sandbox: Sandbox,
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    limit: number,
    cwd = this.config.workspaceRoot,
    input?: Uint8Array,
  ): Promise<Record<string, unknown>> {
    if (input && !sandbox.commands.supportsStdinClose)
      throw new Fault("template_stdin_unsupported", 409);
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let pid: number | undefined;
    let stop: Promise<boolean> | undefined;
    let reason = "cancelled";
    let rejectStopped!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStopped = reject;
    });
    void stopped.catch(() => {});
    const halt = () => {
      if (!stop) {
        stop = this.terminate(sandbox.sandboxId);
        void stop.then(() => rejectStopped(new Error("remote_stopped")));
      }
    };
    const timer = setTimeout(() => {
      reason = "execution_timeout";
      halt();
    }, timeoutMs);
    const capture = (kind: "stdout" | "stderr", text: string) => {
      bytes += Buffer.byteLength(text);
      if (bytes > limit) {
        reason = "output_limit";
        halt();
        throw new Fault("output_limit", 413);
      }
      if (kind === "stdout") stdout += text;
      else stderr += text;
    };
    signal.addEventListener("abort", halt, { once: true });
    try {
      signal.throwIfAborted();
      const handle = await sandbox.commands.run(command, {
        background: true,
        retainOutput: false,
        user: "user",
        cwd,
        timeoutMs,
        requestTimeoutMs: 15_000,
        stdin: !!input,
        onStdout: (text) => capture("stdout", text),
        onStderr: (text) => capture("stderr", text),
      });
      pid = handle.pid;
      if (signal.aborted || stop) halt();
      const completion = handle.wait();
      // Observe completion immediately, including while input is being sent.
      void completion.catch(() => {});
      if (input) {
        for (let offset = 0; offset < input.byteLength; offset += 32 * 1024) {
          await Promise.race([
            handle.sendStdin(input.subarray(offset, offset + 32 * 1024), {
              requestTimeoutMs: 15_000,
            }),
            stopped,
          ]);
        }
        await Promise.race([handle.closeStdin({ requestTimeoutMs: 15_000 }), stopped]);
      }
      let exitCode: number;
      try {
        exitCode = (await Promise.race([completion, stopped])).exitCode;
      } catch (error) {
        if (error instanceof CommandExitError) exitCode = error.exitCode;
        else throw error;
      }
      if (stop)
        throw new Fault(reason, 409, !(await stop), {
          sandbox_id: sandbox.sandboxId,
          sandbox_terminated: await stop,
        });
      return { stdout, stderr, exit_code: exitCode, output_bytes: bytes };
    } catch (error) {
      // A broken SDK stream/timeout is not proof that the process stopped. Kill
      // the VM (including descendants), rather than merely disconnecting it.
      halt();
      const confirmed = (await stop) === true;
      const code = signal.aborted || reason !== "cancelled" ? reason : "execution_unknown";
      throw new Fault(code, 502, code === "execution_unknown" || !confirmed, {
        sandbox_id: sandbox.sandboxId,
        command_pid: pid,
        sandbox_terminated: confirmed,
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", halt);
    }
  }
  private async code(
    sandbox: Sandbox,
    op: Operation,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const timeoutMs = Number(op.input.timeout_ms ?? 60_000);
    const worker = new Worker(new URL("./code-worker.ts", import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
      workerData: {
        apiKey: this.config.apiKey,
        sandboxId: sandbox.sandboxId,
        code: op.input.code,
        language: op.input.language ?? "python",
        root: this.config.workspaceRoot,
        timeoutMs,
        maxBytes: this.config.maxOutputBytes,
      },
    });
    let reason = "provider_error";
    let stopping: Promise<boolean> | undefined;
    const halt = () => {
      stopping ??= this.terminate(sandbox.sandboxId).finally(() => {
        void worker.terminate();
      });
    };
    const abort = () => {
      reason = "cancelled";
      halt();
    };
    const timer = setTimeout(() => {
      reason = "execution_timeout";
      halt();
    }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.once(
          "message",
          (message: { ok: boolean; code?: string; result?: Record<string, unknown> }) => {
            if (message.ok && message.result) resolve(message.result);
            else {
              reason = message.code ?? "provider_error";
              reject(new Error(reason));
            }
          },
        );
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code !== 0 || stopping) reject(new Error("worker_ended"));
        });
      });
      if (stopping) throw new Error(reason);
      return result;
    } catch {
      halt();
      const confirmed = (await stopping) === true;
      throw new Fault(reason, 502, !confirmed, {
        sandbox_id: sandbox.sandboxId,
        sandbox_terminated: confirmed,
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      await worker.terminate();
    }
  }
}
