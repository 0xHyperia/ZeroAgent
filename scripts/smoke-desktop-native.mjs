#!/usr/bin/env node
// Drive the built Tauri app through tauri-driver and WebKitWebDriver on Linux.
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [binary, backend] = process.argv.slice(2);
if (process.platform !== "linux" || !binary || !backend) {
  throw new Error("Usage on Linux: node scripts/smoke-desktop-native.mjs <debug-app> <locked-backend>");
}
const application = resolve(binary);
const engine = resolve(backend);
await Promise.all([access(application), access(engine)]);
const home = await mkdtemp(join(tmpdir(), "zeroagent-native-smoke-"));
const runtime = join(home, "runtime");
await mkdir(runtime, { mode: 0o700 });

const origin = "http://127.0.0.1:19373";
const driverUrl = "http://127.0.0.1:4444";
let publicSettingsRequested = false;
const account = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/v1/settings/public" && request.method === "GET") {
    publicSettingsRequested = true;
    response.end(JSON.stringify({ code: 0, data: { registration_enabled: false } }));
    return;
  }
  response.writeHead(401).end(JSON.stringify({ code: 401, message: "No E2E account session" }));
});
await new Promise((accept, reject) => {
  account.once("error", reject);
  account.listen(Number(new URL(origin).port), "127.0.0.1", accept);
});

const driver = spawn("tauri-driver", ["--port", "4444", "--native-port", "4445"], {
  cwd: home,
  // A clean profile and vault environment for each run. The app is compiled
  // with the same loopback account origin; synthetic credentials are unnecessary.
  env: {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_RUNTIME_DIR: runtime,
    ZEROAGENT_DEV_HOME: home,
    ZEROAGENT_CONFIG_DIR: join(home, "zeroagent"),
    ZEROAGENT_BACKEND_BINARY: engine,
    ZEROAGENT_DEV_MCP_BRIDGE_PORT: "19424",
    WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    NO_AT_BRIDGE: "1",
  },
  stdio: "inherit",
});
let driverFailure;
driver.on("error", (error) => { driverFailure = error; });
driver.on("exit", (code) => { driverFailure ??= new Error(`tauri-driver exited (${code})`); });

async function request(method, route, payload, timeoutMs = 15_000) {
  const response = await fetch(`${driverUrl}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`WebDriver ${method} ${route} failed (${response.status}): ${data.value?.message ?? ""}`);
  return data.value;
}

async function waitFor(condition, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (driverFailure) throw driverFailure;
    const result = await condition();
    if (result) return result;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

let session;
try {
  await waitFor(() => request("GET", "/status", undefined, 1_000).catch(() => null), 20_000, "WebDriver");
  const result = await request("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application } } },
  }, 60_000);
  session = `/session/${encodeURIComponent(result.sessionId)}`;
  await waitFor(() => request("POST", `${session}/execute/sync`, {
    script: `return Boolean(window.__TAURI_INTERNALS__ &&
      document.querySelector('#relay-email')?.getClientRects().length &&
      document.querySelector('#relay-password')?.getClientRects().length);`,
    args: [],
  }), 90_000, "Tauri signed-out account screen");
  if (!publicSettingsRequested) throw new Error("Native account screen did not use the loopback fixture");
  console.log("Linux native ZeroAgent startup and signed-out account gate passed");
} finally {
  if (session) await request("DELETE", session, undefined, 8_000).catch(() => undefined);
  driver.kill();
  account.closeAllConnections();
  await new Promise((done) => account.close(done));
}
