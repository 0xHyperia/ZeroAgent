import { parentPort, workerData } from "node:worker_threads";
import { boundedFetch } from "./bounded-fetch.ts";
import { codeSession } from "./code-session.ts";
import type { SandboxAccess } from "./sandbox-access.ts";
import { sanitizeSdkEnvironment } from "./sdk-options.ts";

// The code SDK buffers execution logs and NDJSON lines internally. Bound the raw
// response BEFORE its parser, in a dedicated memory-limited worker, too.
sanitizeSdkEnvironment();
const data = workerData as {
  apiKey: string;
  access: SandboxAccess;
  code: string;
  language: string;
  root: string;
  timeoutMs: number;
  maxBytes: number;
};
globalThis.fetch = boundedFetch(globalThis.fetch, data.maxBytes * 3 + 64 * 1024);
let outputBytes = 0;
function bounded(value: unknown) {
  outputBytes += Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
  if (outputBytes > data.maxBytes) throw new Error("output_limit");
}
try {
  const sandbox = codeSession(data.access, data.apiKey);
  const context = await sandbox.createCodeContext({
    cwd: data.root,
    language: data.language,
    requestTimeoutMs: 15_000,
  });
  const execution = await sandbox.runCode(data.code, {
    context,
    timeoutMs: data.timeoutMs,
    requestTimeoutMs: 15_000,
    onStdout: (output) => bounded(output.line),
    onStderr: (output) => bounded(output.line),
    onResult: (result) => bounded(result.toJSON()),
    onError: (error) =>
      bounded({ name: error.name, value: error.value, traceback: error.traceback }),
  });
  // Rich binary/HTML results remain bounded; caller can choose file artifacts.
  const result = {
    stdout: execution.logs.stdout.join(""),
    stderr: execution.logs.stderr.join(""),
    results: execution.results.map((result) => result.toJSON()),
    error: execution.error
      ? {
          name: execution.error.name,
          value: execution.error.value,
          traceback: execution.error.traceback,
        }
      : null,
  };
  // New context per operation avoids silently replaying interpreter state.
  await sandbox.removeCodeContext(context);
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    code:
      error instanceof Error && error.message === "output_limit"
        ? "output_limit"
        : "provider_error",
  });
}
