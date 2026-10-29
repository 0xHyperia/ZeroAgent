import { createHash, createHmac } from "node:crypto";

export const actions = [
  "sandbox.create",
  "sandbox.connect",
  "sandbox.info",
  "sandbox.pause",
  "sandbox.resume",
  "sandbox.kill",
  "sandbox.reconcile",
  "command.run",
  "code.run",
  "file.read",
  "file.write",
  "file.upload.begin",
  "file.upload.chunk",
  "file.upload.finalize",
  "file.upload.abort",
  "file.download.chunk",
  "file.parse",
  "archive.extract",
] as const;
export type Action = (typeof actions)[number];
export type Scope = { owner_scope: string; workspace_ref: string };
export type Operation = Scope & {
  operation_id: string;
  action: Action;
  sandbox_id?: string;
  input: Record<string, unknown>;
};
export type Receipt = {
  operation_id: string;
  action: Action;
  state: "executing" | "succeeded" | "failed" | "cancelled" | "unknown";
  created_at: string;
  updated_at: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};
export type StoredReceipt = Receipt & {
  scope_hash: string;
  request_hash: string;
  result_retired?: boolean;
};
export type Config = {
  token: string;
  scopeKey: string;
  apiKey?: string;
  template?: string;
  namespace: string;
  dataDir: string;
  host: "127.0.0.1" | "::1";
  port: number;
  maxConcurrent: number;
  maxReceipts: number;
  maxJournalBytes: number;
  maxBodyBytes: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxFileBytes: number;
  maxTimeoutMs: number;
  sandboxTimeoutMs: number;
  workspaceRoot: string;
};
export class Fault extends Error {
  code: string;
  status: number;
  uncertain: boolean;
  detail?: Record<string, unknown>;
  constructor(code: string, status = 400, uncertain = false, detail?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.status = status;
    this.uncertain = uncertain;
    this.detail = detail;
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Fault("invalid_request");
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value))
    throw new Fault("invalid_identifier");
  return value;
}
export function scope(value: unknown): Scope {
  const raw = object(value);
  return { owner_scope: identifier(raw.owner_scope), workspace_ref: identifier(raw.workspace_ref) };
}
export function relativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/")[0] === ".zeroagent-transfers" ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  ) {
    throw new Fault("invalid_path");
  }
  return value;
}
export function archivePath(value: unknown): string {
  const path = relativePath(value);
  if (
    Buffer.byteLength(path) > 1024 ||
    /[\p{Cc}:]/u.test(path) ||
    path !== path.normalize("NFC") ||
    path.split("/").length > 32 ||
    path.split("/")[0].startsWith(".zeroagent-")
  )
    throw new Fault("invalid_path");
  return path;
}
function only(raw: Record<string, unknown>, keys: string[]) {
  if (Object.keys(raw).some((key) => !keys.includes(key))) throw new Fault("unsupported_field");
}
export function operation(value: unknown, config: Config): Operation {
  const raw = object(value);
  only(raw, ["operation_id", "owner_scope", "workspace_ref", "action", "sandbox_id", "input"]);
  const action = raw.action as Action;
  if (!actions.includes(action)) throw new Fault("unsupported_action");
  const input = raw.input === undefined ? {} : object(raw.input);
  const allowed: Record<Action, string[]> = {
    "sandbox.create": [],
    "sandbox.connect": [],
    "sandbox.info": [],
    "sandbox.pause": [],
    "sandbox.resume": [],
    "sandbox.kill": [],
    "sandbox.reconcile": ["create_operation_id"],
    "command.run": ["command", "cwd", "timeout_ms"],
    "code.run": ["code", "language", "timeout_ms"],
    "file.read": ["path"],
    "file.write": ["path", "data_base64"],
    "file.upload.begin": ["transfer_id", "path", "total_bytes", "sha256"],
    "file.upload.chunk": ["transfer_id", "offset", "total_bytes", "sha256", "data_base64"],
    "file.upload.finalize": ["transfer_id", "path", "total_bytes", "sha256"],
    "file.upload.abort": ["transfer_id", "total_bytes", "sha256"],
    "file.download.chunk": ["path", "offset", "max_bytes", "expected_sha256"],
    "file.parse": ["path", "output_path", "format", "source_sha256"],
    "archive.extract": ["path", "destination", "source_sha256"],
  };
  only(input, allowed[action]);
  if (action === "archive.extract") {
    archivePath(input.path);
    archivePath(input.destination);
    if (typeof input.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.source_sha256))
      throw new Fault("invalid_digest");
  }
  if (action === "file.parse") {
    relativePath(input.path);
    relativePath(input.output_path);
    if (
      input.path === input.output_path ||
      !["pdf", "docx", "xlsx", "pptx"].includes(String(input.format))
    )
      throw new Fault("unsupported_format");
    if (typeof input.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.source_sha256))
      throw new Fault("invalid_digest");
  }
  if (action === "command.run" || action === "code.run") {
    const content = input[action === "command.run" ? "command" : "code"];
    if (
      typeof content !== "string" ||
      !content ||
      Buffer.byteLength(content) > config.maxInputBytes ||
      content.includes("\0")
    )
      throw new Fault("input_limit", 413);
    if (
      input.timeout_ms !== undefined &&
      (!Number.isInteger(input.timeout_ms) ||
        Number(input.timeout_ms) < 1 ||
        Number(input.timeout_ms) > config.maxTimeoutMs)
    )
      throw new Fault("invalid_timeout");
    if (input.cwd !== undefined) relativePath(input.cwd);
    if (
      action === "code.run" &&
      input.language !== undefined &&
      !["python", "javascript", "typescript", "bash", "r", "java"].includes(String(input.language))
    )
      throw new Fault("unsupported_language");
  }
  if (
    [
      "file.read",
      "file.write",
      "file.upload.begin",
      "file.upload.finalize",
      "file.download.chunk",
    ].includes(action)
  )
    relativePath(input.path);
  if (action.startsWith("file.upload.")) {
    if (typeof input.transfer_id !== "string" || !/^[a-f0-9]{32,64}$/.test(input.transfer_id))
      throw new Fault("invalid_transfer");
    if (
      !Number.isInteger(input.total_bytes) ||
      Number(input.total_bytes) < 0 ||
      Number(input.total_bytes) > 32 * 1024 * 1024
    )
      throw new Fault("file_limit", 413);
    if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256))
      throw new Fault("invalid_digest");
  }
  if (action === "file.upload.chunk" || action === "file.download.chunk") {
    if (
      !Number.isInteger(input.offset) ||
      Number(input.offset) < 0 ||
      Number(input.offset) > 32 * 1024 * 1024
    )
      throw new Fault("invalid_offset");
  }
  if (action === "file.download.chunk") {
    if (
      !Number.isInteger(input.max_bytes) ||
      Number(input.max_bytes) < 1 ||
      Number(input.max_bytes) > config.maxFileBytes
    )
      throw new Fault("file_limit", 413);
    if (
      input.expected_sha256 !== undefined &&
      (typeof input.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.expected_sha256))
    )
      throw new Fault("invalid_digest");
  }
  if (action === "file.write" || action === "file.upload.chunk") {
    const data = input.data_base64;
    if (
      typeof data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    )
      throw new Fault("invalid_base64");
    if (Buffer.byteLength(data, "base64") > config.maxFileBytes) throw new Fault("file_limit", 413);
  }
  if (action === "sandbox.reconcile") identifier(input.create_operation_id);
  const sandbox_id = raw.sandbox_id === undefined ? undefined : identifier(raw.sandbox_id);
  if (!["sandbox.create", "sandbox.reconcile"].includes(action) && !sandbox_id)
    throw new Fault("sandbox_required");
  if (["sandbox.create", "sandbox.reconcile"].includes(action) && sandbox_id)
    throw new Fault("unsupported_field");
  return { ...scope(raw), operation_id: identifier(raw.operation_id), action, sandbox_id, input };
}
export function scopeHash(config: Config, value: Scope): string {
  return createHmac("sha256", config.scopeKey)
    .update(JSON.stringify([config.namespace, value.owner_scope, value.workspace_ref]))
    .digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function requestHash(value: Operation): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function publicReceipt(value: StoredReceipt): Receipt {
  const {
    scope_hash: _scope,
    request_hash: _request,
    result_retired: _retired,
    ...receipt
  } = value;
  return receipt;
}
export function normalizedError(error: unknown): { code: string; message: string } {
  // SDK errors may contain URLs, tokens, response bodies and user code. Never reflect them.
  const code = error instanceof Fault ? error.code : "provider_error";
  return {
    code,
    message:
      code === "provider_error"
        ? "Sandbox provider operation failed; inspect its receipt before retrying."
        : code,
  };
}
