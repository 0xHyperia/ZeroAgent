import { isAbsolute } from "node:path";
import { type Config, Fault } from "./protocol.ts";

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.ZEROAGENT_CLOUD_EXECUTOR_TOKEN ?? "";
  const scopeKey = env.ZEROAGENT_CLOUD_EXECUTOR_SCOPE_KEY ?? token;
  if (
    Buffer.byteLength(token) < 32 ||
    token.length > 512 ||
    /\s/.test(token) ||
    Buffer.byteLength(scopeKey) < 32
  )
    throw new Fault("strong_internal_token_required");
  const dataDir = env.ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR ?? "";
  if (!isAbsolute(dataDir)) throw new Fault("absolute_data_dir_required");
  const host = env.ZEROAGENT_CLOUD_EXECUTOR_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Fault("loopback_required");
  const port = Number(env.ZEROAGENT_CLOUD_EXECUTOR_PORT ?? 17843);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Fault("invalid_port");
  const namespace = env.ZEROAGENT_CLOUD_EXECUTOR_NAMESPACE ?? "zeroagent-cloudchat-v1";
  if (!/^[a-z][a-z0-9_-]{2,63}$/.test(namespace)) throw new Fault("invalid_namespace");
  const apiKey = env.ZEROAGENT_E2B_API_KEY || undefined;
  const template = env.ZEROAGENT_E2B_TEMPLATE || undefined;
  if (apiKey && !template) throw new Fault("explicit_template_required");
  const maxReceipts = Number(env.ZEROAGENT_CLOUD_EXECUTOR_MAX_RECEIPTS ?? 1_000_000);
  const maxJournalBytes = Number(env.ZEROAGENT_CLOUD_EXECUTOR_MAX_JOURNAL_BYTES ?? 1_073_741_824);
  if (
    !Number.isSafeInteger(maxReceipts) ||
    maxReceipts < 1 ||
    maxReceipts > 10_000_000 ||
    !Number.isSafeInteger(maxJournalBytes) ||
    maxJournalBytes < 2_000_000 ||
    maxJournalBytes > 64 * 1024 * 1024 * 1024
  )
    throw new Fault("invalid_journal_limits");
  // Never consult E2B_API_KEY, CLI profiles, SDK access tokens, endpoint or debug environment.
  return {
    token,
    scopeKey,
    apiKey,
    template,
    namespace,
    dataDir,
    host,
    port,
    maxConcurrent: 4,
    maxReceipts,
    maxJournalBytes,
    maxBodyBytes: 1_500_000,
    maxInputBytes: 64 * 1024,
    maxOutputBytes: 256 * 1024,
    maxFileBytes: 1024 * 1024,
    maxTimeoutMs: 120_000,
    sandboxTimeoutMs: 300_000,
    workspaceRoot: "/home/user/zeroagent-workspace",
  };
}
