#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultDevStateDir, missingDevDependency } from "./dev-stack-paths.mjs";
import { desktopBackendReady } from "./dev-stack-readiness.mjs";

const scriptPath = resolve(import.meta.filename);
const repoRoot = realpathSync(resolve(import.meta.dirname, ".."));
const userKey =
  typeof process.getuid === "function"
    ? String(process.getuid())
    : (process.env.USERNAME ?? "user");
const stateDir = resolve(
  process.env.ZEROAGENT_DEV_STATE_DIR ?? defaultDevStateDir(repoRoot, userKey),
);
const gatewayDataDir = resolve(
  process.env.ZEROAGENT_GATEWAY_DATA_DIR ?? join(homedir(), ".zeroagent/gateway"),
);
const ports = {
  desktop: Number(process.env.ZEROAGENT_DEV_DESKTOP_PORT ?? 2120),
  gateway: Number(process.env.ZEROAGENT_DEV_GATEWAY_PORT ?? 50052),
  webui: Number(process.env.ZEROAGENT_DEV_WEBUI_PORT ?? 5173),
};
const mcpBridgePort = Number(process.env.ZEROAGENT_DEV_MCP_BRIDGE_PORT ?? 9223);
const externalDesktopFrontend = process.env.ZEROAGENT_DEV_DESKTOP_EXTERNAL_FRONTEND === "1";
const gatewayToken =
  process.env.ZEROAGENT_GATEWAY_TOKEN ?? process.env.DEV_GATEWAY_TOKEN ?? "dev-token";
const urls = Object.fromEntries(
  Object.entries(ports).map(([service, port]) => [service, `http://localhost:${port}`]),
);
const services = ["gateway", "webui", "desktop"];
const heartbeatMaxAgeMs = 10_000;

function usage() {
  console.log(`Usage: node scripts/dev-stack.mjs <start|stop|restart|status|logs> [desktop|gateway|webui|all]

Environment variables:
  ZEROAGENT_GATEWAY_TOKEN       Gateway token (default: dev-token)
  ZEROAGENT_GATEWAY_DATA_DIR    Gateway data directory
  ZEROAGENT_DEV_GATEWAY_PORT    Gateway HTTP port (default: 50052)
  ZEROAGENT_DEV_WEBUI_PORT      WebUI Vite port (default: 5173)
  ZEROAGENT_DEV_DESKTOP_PORT    Desktop Vite port (default: 2120)
  ZEROAGENT_DEV_MCP_BRIDGE_PORT MCP Bridge port (default: 9223)
  ZEROAGENT_DEV_DESKTOP_EXTERNAL_FRONTEND Set to 1 when an independently managed desktop Vite is ready
  ZEROAGENT_DEV_FILE_RUNTIME    Absolute path to an already staged file runtime
  ZEROAGENT_FILE_RUNTIME_SOURCE and ZEROAGENT_FILE_RUNTIME_MANIFEST_SHA256  Reviewed local dependency tree and manifest digest
  ZEROAGENT_FILE_RUNTIME_PACKS  Reviewed dependency packs by desktop target
  ZEROAGENT_DEV_STATE_DIR       State and log directory (default: isolated per checkout)`);
}

function fail(message) {
  throw new Error(`dev-stack: ${message}`);
}

function validateConfiguration() {
  for (const [name, port] of [...Object.entries(ports), ["mcp-bridge", mcpBridgePort]]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid ${name} port: ${port}`);
  }
}

function statePath(service) {
  return join(stateDir, `${service}.json`);
}

function logPath(service) {
  return join(stateDir, `${service}.log`);
}

function readState(service) {
  try {
    const state = JSON.parse(readFileSync(statePath(service), "utf8"));
    if (
      state.service !== service ||
      !Number.isInteger(state.pid) ||
      typeof state.token !== "string" ||
      typeof state.heartbeatAt !== "number"
    ) {
      return undefined;
    }
    return state;
  } catch {
    return undefined;
  }
}

function writeState(state) {
  mkdirSync(stateDir, { recursive: true });
  const destination = statePath(state.service);
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ ...state, repoRoot, port: ports[state.service] })}\n`,
  );
  renameSync(temporary, destination);
}

function removeState(service, token) {
  const state = readState(service);
  if (state && token && state.token !== token) return;
  try {
    unlinkSync(statePath(service));
  } catch {}
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") return true;
    return false;
  }
}

function stateIsFresh(state) {
  return Date.now() - state.heartbeatAt <= heartbeatMaxAgeMs;
}

function managedState(service) {
  const state = readState(service);
  if (!state) return undefined;
  if (state.repoRoot !== repoRoot || state.port !== ports[service]) {
    fail(
      `${service} state belongs to another checkout or port; use its original checkout/configuration to stop it, or choose a separate ZEROAGENT_DEV_STATE_DIR`,
    );
  }
  if (!processIsAlive(state.pid)) {
    removeState(service, state.token);
    return undefined;
  }
  return state;
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function portIsListening(port) {
  return await new Promise((resolveListening) => {
    const socket = createConnection({ host: "localhost", port });
    const finish = (listening) => {
      socket.destroy();
      resolveListening(listening);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function httpReady(service, requireVisible = false) {
  const url = service === "gateway" ? `${urls.gateway}/healthz` : `${urls[service]}/`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return (
      response.ok &&
      (service !== "desktop" ||
        (await desktopBackendReady(repoRoot, mcpBridgePort, requireVisible)))
    );
  } catch {
    return false;
  }
}

function ensureWebUiEmbedStub() {
  const distDir = join(repoRoot, "crates/agent-gateway/web/dist");
  const indexPath = join(distDir, "index.html");
  if (existsSync(indexPath)) return;
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    indexPath,
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>ZeroAgent Gateway</title></head><body><p>WebUI embed stub. Start the WebUI dev server for the real SPA.</p></body></html>\n',
  );
}

function serviceCommand(service) {
  if (service === "gateway") {
    ensureWebUiEmbedStub();
    mkdirSync(gatewayDataDir, { recursive: true });
    const listenAddress = process.env.ZEROAGENT_GATEWAY_HTTP_ADDR;
    return {
      args: ["-C", "crates/agent-gateway", "run", "./cmd/gateway"],
      command: "go",
      cwd: repoRoot,
      env: {
        ...process.env,
        GOCACHE: process.env.GOCACHE ?? join(stateDir, "go-cache"),
        ZEROAGENT_GATEWAY_DATA_DIR: gatewayDataDir,
        ZEROAGENT_GATEWAY_HTTP_ADDR: listenAddress ?? `127.0.0.1:${ports.gateway}`,
        ZEROAGENT_GATEWAY_TOKEN: gatewayToken,
      },
    };
  }
  if (service === "webui") {
    return {
      args: [
        "node_modules/vite/bin/vite.js",
        "--host",
        "localhost",
        "--port",
        String(ports.webui),
        "--strictPort",
      ],
      command: process.execPath,
      cwd: join(repoRoot, "crates/agent-gateway/web"),
      env: { ...process.env, npm_config_proxy_api: urls.gateway },
    };
  }
  return {
    args: [
      join(repoRoot, "crates/agent-gui/node_modules/@tauri-apps/cli/tauri.js"),
      "dev",
      "--config",
      JSON.stringify({
        build: {
          devUrl: urls.desktop,
          ...(externalDesktopFrontend
            ? { beforeDevCommand: "pnpm prepare:kbrain && pnpm gateway:prepare && pnpm remote:prepare" }
            : {}),
        },
      }),
    ],
    command: process.execPath,
    cwd: join(repoRoot, "crates/agent-gui"),
    env: {
      ...process.env,
      VITE_ZEROAGENT_SESSION_WORKBENCH: process.env.DEV_SESSION_WORKBENCH ?? "1",
    },
  };
}

async function runService(service, token) {
  process.title = `zeroagent-dev-stack-${service}`;
  const command = serviceCommand(service);
  mkdirSync(join(stateDir, "go-cache"), { recursive: true });
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  const startedAt = Date.now();
  const updateHeartbeat = () =>
    writeState({
      childPid: child.pid,
      heartbeatAt: Date.now(),
      pid: process.pid,
      service,
      startedAt,
      token,
    });
  updateHeartbeat();
  const heartbeat = setInterval(updateHeartbeat, 2000);
  heartbeat.unref();

  let stopping = false;
  const stopChild = () => {
    if (stopping) return;
    stopping = true;
    try {
      child.kill("SIGTERM");
    } catch {}
  };
  process.on("SIGTERM", stopChild);
  process.on("SIGINT", stopChild);

  const exitCode = await new Promise((resolveExitCode) => {
    child.once("error", (error) => {
      console.error(`Failed to start ${command.command}: ${error.message}`);
      resolveExitCode(127);
    });
    child.once("exit", (code) => resolveExitCode(code ?? 1));
  });
  clearInterval(heartbeat);
  removeState(service, token);
  process.exitCode = exitCode;
}

function desktopFileRuntime() {
  if (process.env.ZEROAGENT_DEV_FILE_RUNTIME) return resolve(process.env.ZEROAGENT_DEV_FILE_RUNTIME);
  if (!process.env.ZEROAGENT_FILE_RUNTIME_SOURCE && !process.env.ZEROAGENT_FILE_RUNTIME_PACKS) {
    const runtime = join(repoRoot, ".zeroagent", "file-runtime", "desktop-dev");
    if (existsSync(join(runtime, "runtime.json"))) return runtime;
    console.warn("desktop: file runtime unavailable. Set ZEROAGENT_DEV_FILE_RUNTIME or configure a runtime pack to enable reader revisions.");
    return undefined;
  }
  const target = ({
    "win32-x64": "x86_64-pc-windows-msvc",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
  })[`${process.platform}-${process.arch}`];
  if (!target) fail("file runtime has no build for this desktop target");
  const hash = createHash("sha256");
  for (const input of [
    target,
    process.env.ZEROAGENT_FILE_RUNTIME_SOURCE,
    process.env.ZEROAGENT_FILE_RUNTIME_MANIFEST_SHA256,
    process.env.ZEROAGENT_FILE_RUNTIME_PACKS,
  ]) hash.update(JSON.stringify(input ?? "") + "\n");
  for (const file of ["file_tool.py", "office.py", "document_review.py", "pdf_tools.py", "runtime_common.py", "artifact_tool.mjs"]) {
    hash.update(readFileSync(join(repoRoot, "crates/file-runtime", file)));
  }
  const cache = join(stateDir, `file-runtime-${hash.digest("hex").slice(0, 24)}`);
  const runtime = join(cache, "file-runtime");
  const manifest = join(runtime, "runtime.json");
  if (!existsSync(manifest)) {
    mkdirSync(stateDir, { recursive: true });
    const staging = `${cache}-${randomUUID()}`;
    try {
      const result = spawnSync(process.execPath, [join(repoRoot, "scripts/release/stage-file-runtime.mjs"), target, staging], {
        stdio: "inherit",
      });
      if (result.status !== 0) throw new Error("Failed to prepare the desktop file runtime", { cause: result.error });
      rmSync(join(staging, "tauri.file-runtime.conf.json"));
      try {
        renameSync(staging, cache);
      } catch (error) {
        if (!existsSync(manifest)) throw error;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return runtime;
}

function launchSupervisor(service, fileRuntime) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(logPath(service), "");
  const log = openSync(logPath(service), "a");
  const token = randomUUID();
  const supervisor = spawn(process.execPath, [scriptPath, "__run", service, token], {
    detached: true,
    env: {
      ...process.env,
      ...(fileRuntime ? { ZEROAGENT_DEV_FILE_RUNTIME: fileRuntime } : {}),
    },
    shell: false,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  closeSync(log);
  if (!supervisor.pid) fail(`failed to launch ${service} supervisor`);
  writeState({
    heartbeatAt: Date.now(),
    pid: supervisor.pid,
    service,
    startedAt: Date.now(),
    token,
  });
  supervisor.unref();
  return { pid: supervisor.pid, token };
}

function tail(file, lineCount) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).slice(-lineCount).join("\n");
  } catch {
    return "No managed log yet.";
  }
}

async function waitUntilReady(service, timeoutSeconds) {
  for (let elapsed = 0; elapsed < timeoutSeconds; elapsed += 1) {
    if (await httpReady(service, true)) return true;
    const state = managedState(service);
    if (!state || !stateIsFresh(state)) return false;
    await wait(1000);
  }
  return false;
}

async function startService(service) {
  if (service === "desktop" && externalDesktopFrontend && (await httpReady(service, true))) {
    console.log(`desktop: already running from this checkout (${urls.desktop})`);
    return true;
  }
  // A fresh worktree can spend several minutes compiling the native app.
  const timeoutSeconds = service === "desktop" ? 600 : 60;
  const state = managedState(service);
  if (state) {
    if (!stateIsFresh(state)) {
      console.error(
        `${service}: managed state is stale for pid ${state.pid}; refusing to replace it`,
      );
      return false;
    }
    if (await httpReady(service)) {
      console.log(`${service}: already running (managed pid ${state.pid}, ${urls[service]})`);
      return true;
    }
    console.log(`${service}: waiting for managed pid ${state.pid} to become ready`);
    return await waitUntilReady(service, timeoutSeconds);
  }
  if (
    (await portIsListening(ports[service])) &&
    !(service === "desktop" && externalDesktopFrontend)
  ) {
    console.error(
      `${service}: port ${ports[service]} is occupied by an unmanaged process (${urls[service]}); stop that process before starting this checkout. An HTTP response does not identify it as ZeroAgent.`,
    );
    return false;
  }

  const missing = missingDevDependency(repoRoot, service);
  if (missing) {
    console.error(
      `${service}: missing ${missing}; run "mise exec -- pnpm install --frozen-lockfile" from ${repoRoot} before starting this checkout`,
    );
    return false;
  }

  const supervisor = launchSupervisor(service, service === "desktop" ? desktopFileRuntime() : undefined);
  if (await waitUntilReady(service, timeoutSeconds)) {
    console.log(`${service}: started (managed pid ${supervisor.pid}, ${urls[service]})`);
    return true;
  }
  console.error(
    `${service}: failed to become ready; last log lines:\n${tail(logPath(service), 30)}`,
  );
  await stopService(service);
  return false;
}

function killProcessTree(pid, force = false) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    return result.status === 0;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

async function stopService(service) {
  const state = managedState(service);
  if (!state) {
    if (await portIsListening(ports[service])) {
      console.log(`${service}: external process is still running; left untouched`);
    } else {
      console.log(`${service}: stopped`);
    }
    return true;
  }
  if (!stateIsFresh(state)) {
    console.error(
      `${service}: managed heartbeat is stale for pid ${state.pid}; refusing to stop it`,
    );
    return false;
  }

  killProcessTree(state.pid);
  for (let elapsed = 0; elapsed < 15 && processIsAlive(state.pid); elapsed += 1) await wait(1000);
  if (processIsAlive(state.pid)) {
    killProcessTree(state.pid, true);
    await wait(1000);
  }
  if (processIsAlive(state.pid)) {
    console.error(`${service}: did not stop within 16 seconds (pid ${state.pid})`);
    return false;
  }
  removeState(service, state.token);
  console.log(`${service}: stopped`);
  return true;
}

async function statusService(service) {
  const state = managedState(service);
  if (state) {
    if (!stateIsFresh(state)) {
      console.log(`${service}: stale managed state (pid ${state.pid}, port ${ports[service]})`);
    } else if (await httpReady(service)) {
      console.log(`${service}: ready (managed pid ${state.pid}, ${urls[service]})`);
    } else {
      console.log(
        `${service}: starting or unhealthy (managed pid ${state.pid}, port ${ports[service]})`,
      );
    }
    return;
  }
  if (await portIsListening(ports[service])) {
    const stateLabel = (await httpReady(service)) ? "ready" : "unhealthy";
    console.log(`${service}: ${stateLabel} (external listener, ${urls[service]})`);
  } else {
    console.log(`${service}: stopped`);
  }
}

async function followLog(service) {
  const file = logPath(service);
  console.log(tail(file, 100));
  let position = existsSync(file) ? statSync(file).size : 0;
  await new Promise((resolveFollow) => {
    const stopFollowing = () => {
      unwatchFile(file);
      resolveFollow();
    };
    process.once("SIGINT", stopFollowing);
    process.once("SIGTERM", stopFollowing);
    watchFile(file, { interval: 500 }, (current) => {
      if (current.size < position) position = 0;
      if (current.size <= position) return;
      createReadStream(file, { end: current.size - 1, start: position }).pipe(process.stdout, {
        end: false,
      });
      position = current.size;
    });
  });
}

function targetServices(target, reverse = false) {
  if (target === "all") return reverse ? [...services].reverse() : services;
  if (!services.includes(target)) fail("target must be desktop, gateway, webui, or all");
  return [target];
}

async function main() {
  const action = process.argv[2] ?? "";
  const target = process.argv[3] ?? "all";
  if (["-h", "--help", "help", ""].includes(action)) {
    usage();
    return;
  }
  validateConfiguration();
  if (action === "__run") {
    if (!services.includes(target) || typeof process.argv[4] !== "string")
      fail("invalid supervisor arguments");
    await runService(target, process.argv[4]);
    return;
  }
  if (action === "start") {
    let failed = false;
    for (const service of targetServices(target)) failed = !(await startService(service)) || failed;
    console.log(`Runtime files: ${stateDir}`);
    if (failed) process.exitCode = 1;
    return;
  }
  if (action === "stop") {
    let failed = false;
    for (const service of targetServices(target, true))
      failed = !(await stopService(service)) || failed;
    if (failed) process.exitCode = 1;
    return;
  }
  if (action === "restart") {
    let failed = false;
    for (const service of targetServices(target, true))
      failed = !(await stopService(service)) || failed;
    for (const service of targetServices(target)) failed = !(await startService(service)) || failed;
    if (failed) process.exitCode = 1;
    return;
  }
  if (action === "status") {
    for (const service of targetServices(target)) await statusService(service);
    console.log(
      `mcp-bridge: ${(await portIsListening(mcpBridgePort)) ? "ready" : "stopped"} (port ${mcpBridgePort})`,
    );
    return;
  }
  if (action === "logs") {
    if (target === "all") {
      for (const service of services) {
        console.log(`===== ${service}: ${logPath(service)} =====`);
        console.log(tail(logPath(service), 60));
      }
    } else {
      await followLog(targetServices(target)[0]);
    }
    return;
  }
  fail(`unknown action: ${action}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
