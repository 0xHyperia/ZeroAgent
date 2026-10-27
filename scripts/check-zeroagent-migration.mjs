import assert from "node:assert/strict";
import { kbrainStartupTimeoutMs, isolatedKbrainFixtureEnv } from "./kbrain-startup-budget.mjs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepare } from "./release/prepare-kbrain.mjs";
import { createTsModuleLoader } from "../crates/agent-gui/test/helpers/load-ts-module.mjs";

// First run the native exports_checkpoint_acceptance_fixture test with
// ZEROAGENT_HISTORY_IMPORT_ACCEPTANCE_DIR pointing to a new .codex-artifacts directory.
// This runner only operates on that copied fixture; it never opens an installed app's data.
const repository = fileURLToPath(new URL("..", import.meta.url));
const fixture = await realpath(process.argv[2] ?? "missing-native-fixture");
function within(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== "" && !path.isAbsolute(relative) && !relative.split(path.sep).includes("..");
}
assert.ok(within(path.join(repository, ".codex-artifacts"), fixture), "fixture must be in this worktree's .codex-artifacts");
const nativeHome = await realpath((await readFile(path.join(fixture, "native-home.txt"), "utf8")).trim());
assert.ok(within(fixture, nativeHome), "native fixture must stay inside the acceptance directory");
const pagePath = path.join(fixture, "native-page.json");
const page = JSON.parse(await readFile(pagePath, "utf8"));
assert.equal(page.conversations.length, 1);
const workspace = await realpath(page.conversations[0].cwd);
assert.ok(within(nativeHome, workspace), "checkpoint rewind must use the copied workspace");
const legacyPaths = ["chat-history.sqlite3", ".liveagent/checkpoints"];
async function hashes(root, paths) {
  const result = {};
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    assert.equal(info.isSymbolicLink(), false, "fixture must not reference external artifacts");
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await visit(path.join(relative, name));
    } else {
      assert.ok(info.isFile());
      result[relative] = createHash("sha256").update(await readFile(absolute)).digest("hex");
    }
  }
  for (const relative of paths) await visit(relative);
  return result;
}
const before = await hashes(nativeHome, legacyPaths);
const runRoot = path.join(fixture, `attempt-${randomUUID()}`);
const rollback = path.join(runRoot, "rollback");
await mkdir(rollback, { recursive: true });
for (const relative of legacyPaths) {
  const destination = path.join(rollback, "legacy", relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(nativeHome, relative), destination, { recursive: true, errorOnExist: true });
}
const prepared = await prepare({ release: true, artifactDir: false, output: path.join(fixture, "locked-binary") });
const acceptance = path.join(repository, "crates/agent-gui/test/providers/kbrain-checkpoint-acceptance.mjs");
function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: repository, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`acceptance phase exited ${code}`)));
  });
}
async function start(profile) {
  await mkdir(profile, { recursive: true });
  const config = path.join(profile, "config.json");
  await writeFile(config, JSON.stringify({ defaultModel: "fixture-model", providers: {
    fixture: { api: "openai-completions", baseUrl: "http://127.0.0.1:9", apiKey: "fixture-not-a-real-key",
      models: [{ id: "fixture-model", contextWindow: 131072, maxTokens: 1024 }] },
  } }));
  const token = `fixture-${randomUUID()}`;
  const child = spawn(prepared.binary, ["backend", "-listen", "127.0.0.1:0", "-parent-stdio",
    "-token", token, "-data-dir", profile, "-config", config], {
    cwd: workspace, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: isolatedKbrainFixtureEnv(profile),
  });
  let output = "";
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const stop = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const result = await closed;
    clearTimeout(timer);
    assert.deepEqual(result, { code: 0, signal: null }, output);
  };
  try {
    const baseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`backend startup timed out: ${output}`)), kbrainStartupTimeoutMs());
      const fail = (error) => { clearTimeout(timer); reject(error); };
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`backend exited ${code}: ${output}`)));
      child.stdout.on("data", () => {
        const match = output.match(/k-brain backend listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    return { baseUrl, token, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
const results = [];
async function verifyLargeHistory(backend) {
  const previousStorage = globalThis.localStorage;
  const cache = new Map();
  globalThis.localStorage = {
    getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, String(value)),
    removeItem: (key) => cache.delete(key),
  };
  const loader = createTsModuleLoader();
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtime.setKBrainRuntimeConnection({ ...backend, protocolVersion: "kbrain.agent.v1" });
  try {
    const { migrateLegacyHistoryPage } = loader.loadModule("src/lib/kbrain/historyMigration.ts");
    const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");
    const large = structuredClone(page.conversations[0]);
    large.id = "large-assets";
    large.checkpoint = { status: "not_found" };
    large.activeSegmentIndex = 2;
    large.totalSegmentCount = 3;
    const asset = { role: "user", id: "asset-user", timestamp: 10, content: [
      { type: "text", text: "inline legacy assets" },
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXWQAAAAASUVORK5CYII=" },
      { type: "file", mimeType: "text/plain", filename: "notes.txt", data: "Zml4dHVyZQ==" },
    ] };
    const tool = [
      { role: "assistant", id: "tool-assistant", timestamp: 11, provider: "fixture", model: "fixture-model", content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "notes.txt" } }] },
      { role: "toolResult", id: "tool-result", timestamp: 12, toolCallId: "tool-1", toolName: "read", content: [{ type: "text", text: "fixture" }], isError: false },
    ];
    large.segments = Array.from({ length: 3 }, (_, segmentIndex) => {
      const messages = segmentIndex === 0 ? [asset, ...tool] : [];
      for (let turn = 0; turn < 100; turn++) messages.push(
        { role: "user", id: `u-${segmentIndex}-${turn}`, timestamp: 20 + turn, content: `segment ${segmentIndex} turn ${turn}: ${"large history ".repeat(650)}` },
        { role: "assistant", id: `a-${segmentIndex}-${turn}`, timestamp: 20 + turn, provider: "fixture", model: "fixture-model", content: [{ type: "text", text: `answer ${segmentIndex}/${turn}` }] },
      );
      return { segmentIndex, segmentId: `segment-${segmentIndex}`, messagesJson: JSON.stringify(messages), messageCount: messages.length,
        ...(segmentIndex === 2 ? { summaryJson: JSON.stringify({ role: "summary", content: "earlier segments summarized" }) } : {}) };
    });
    large.totalMessageCount = 603;
    const bytes = Buffer.byteLength(JSON.stringify(large));
    assert.ok(bytes > 2_000_000, "large fixture must exercise a multi-megabyte import");
    let ackLost = false;
    const interrupted = await migrateLegacyHistoryPage({ conversations: [large], complete: true }, {
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (!ackLost && String(url).includes("/v1/migrations/")) {
          assert.equal(response.ok, true);
          await response.arrayBuffer();
          ackLost = true;
          throw new TypeError("fixture connection interrupted after commit");
        }
        return response;
      },
    });
    assert.equal(ackLost, true);
    assert.equal(interrupted.failures.length, 1);
    const bad = { ...large, id: "malformed", segments: [{ segmentIndex: 0, segmentId: "bad", messagesJson: "not-json" }] };
    const retry = await migrateLegacyHistoryPage({ conversations: [bad, large], complete: true });
    assert.equal(retry.failures.length, 1);
    assert.equal(retry.failures[0].sourceId, "malformed");
    assert.equal(retry.results.length, 1);
    assert.equal(retry.results[0].status, "already_imported");
    const repeated = await migrateLegacyHistoryPage({ conversations: [large], complete: true });
    assert.equal(repeated.complete, true);
    assert.equal(repeated.results[0].status, "already_imported");
    const client = createKBrainClient();
    const history = await client.getHistory(large.id, { maxMessages: 2000, includeActive: true });
    const messages = history.session.messages;
    assert.equal(history.total_message_count, 604); // system prompt plus the original messages
    assert.equal(new Set(messages.map((message) => message.id)).size, 604);
    const importedAsset = messages.find((message) => message.id === "asset-user");
    assert.match(importedAsset.content.find((block) => block.type === "image").image_url, /^data:image\/png;base64,/);
    assert.equal(importedAsset.content.find((block) => block.type === "file").filename, "notes.txt");
    assert.equal(messages.find((message) => message.id === "tool-result").tool_call_id, "tool-1");
    assert.equal(messages.find((message) => message.id === "tool-assistant").tool_calls[0].id, "tool-1");
    const active = history.active_messages ?? history.session.active_messages;
    assert.ok(Array.isArray(active), "backend must expose the imported active segment");
    assert.ok(active.some((message) => message.id === "u-2-0"));
    assert.ok(!active.some((message) => message.id === "asset-user"));
    results.push({ largeHistory: { bytes, messages: history.total_message_count, segments: 3, lostAck: true, assets: true, malformedItemIsolated: true } });
  } finally {
    runtime.clearKBrainRuntimeConnection();
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
}
for (const [account, phases] of [[1, ["import", "rewind"]], [2, ["seed-unresolved", "repair"]]]) {
  const scope = createHash("sha256").update(`https://usa0.top|user:${account}`).digest("hex");
  const profile = path.join(runRoot, "runtime-v2", "profiles", `account-${scope}`, "kbrain");
  await writeFile(path.join(workspace, "binary.dat"), "modified workspace");
  for (const [index, phase] of phases.entries()) {
    const backend = await start(profile);
    try {
      if (index === 0) {
        const response = await fetch(`${backend.baseUrl}/v1/sessions/acceptance`, {
          headers: { Authorization: `Bearer ${backend.token}` },
        });
        assert.equal(response.status, 404, "another account's identical conversation ID must be absent");
      }
      await run(process.execPath, [acceptance, pagePath, backend.baseUrl, backend.token, phase]);
      if (account === 1 && phase === "import") await verifyLargeHistory(backend);
      results.push({ account, phase });
    } finally {
      await backend.stop();
    }
    assert.deepEqual(await hashes(nativeHome, legacyPaths), before, "migration/rewind must not modify the legacy database or checkpoint ledger");
  }
}
assert.deepEqual(await hashes(path.join(rollback, "legacy"), legacyPaths), before);
// A rollback keeps v2 data beside the untouched legacy snapshot; old readers are not pointed at it.
await cp(path.join(runRoot, "runtime-v2"), path.join(rollback, "retained-v2"), { recursive: true, errorOnExist: true });
assert.deepEqual(await hashes(path.join(rollback, "retained-v2"), ["profiles"]),
  await hashes(path.join(runRoot, "runtime-v2"), ["profiles"]));
const restoredProfile = path.join(rollback, "retained-v2", "profiles", `account-${createHash("sha256").update("https://usa0.top|user:1").digest("hex")}`, "kbrain");
const restored = await start(restoredProfile);
try {
  const response = await fetch(`${restored.baseUrl}/v1/sessions/large-assets/history?max_messages=2000`, {
    headers: { Authorization: `Bearer ${restored.token}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total_message_count, 604);
  results.push({ rollback: { legacySnapshotUnchanged: true, retainedV2HashIdentical: true, restoredV2Readable: true } });
} finally {
  await restored.stop();
}
await writeFile(path.join(fixture, "result.json"), `${JSON.stringify({ sourceRevision: prepared.sourceRevision, results, legacyHashes: before, rollback }, null, 2)}\n`);
console.log(`Verified native export, locked-backend restart/import/checkpoint repair/rewind and legacy preservation: ${path.join(fixture, "result.json")}`);
