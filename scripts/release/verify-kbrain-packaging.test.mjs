import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyBundle, verifyPreparedBinaries, verifyTauriConfiguration } from "./verify-kbrain-packaging.mjs";
import { root } from "./prepare-kbrain.mjs";

const target = "aarch64-apple-darwin";
const lock = join(root, "scripts/release/kbrain.lock.json");
const { sourceRevision: revision } = JSON.parse(await readFile(lock, "utf8"));

function sha256(data) { return createHash("sha256").update(data).digest("hex"); }

async function executable(path, data) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, data);
  await chmod(path, 0o755);
}

test("Tauri base and release configs retain both external binaries and preparation hooks", async () => {
  const result = await verifyTauriConfiguration();
  assert.deepEqual(result.externalBin, ["binaries/k-brain", "binaries/k-brain-computer", "binaries/liveagent-gateway"]);
  assert.match(result.beforeDevCommand, /prepare:kbrain/);
  assert.match(result.beforeBuildCommand, /prepare:kbrain/);
});

test("release workflow uses fixed triples for non-matrix jobs and packages both helpers", async () => {
  const workflow = await readFile(join(root, ".github/workflows/desktop-release.yml"), "utf8");
  assert.match(workflow, /TAURI_ENV_TARGET_TRIPLE: x86_64-pc-windows-msvc/);
  assert.match(workflow, /TAURI_ENV_TARGET_TRIPLE: x86_64-unknown-linux-gnu/);
  assert.equal(workflow.match(/run: pnpm --dir crates\/agent-gui prepare:kbrain:release/g)?.length, 3);
  assert.match(workflow, /k-brain-computer\.exe/);
});

test("desktop and CI jobs prepare the reviewed fixed-source adaptation", async () => {
  const workflow = await readFile(join(root, ".github/workflows/desktop-release.yml"), "utf8");
  assert.doesNotMatch(workflow, /kbrain-backend:|kbrain-source-|go build|KBRAIN_REPO_ROOT|git clone.*K-brain/);
  for (const job of ["macos", "windows", "linux"]) {
    const section = workflow.split(`\n  ${job}:`)[1]?.split(/\n  [\w-]+:/)[0];
    assert.ok(section, `${job} packaging job must exist`);
    assert.match(section, /uses: actions\/checkout@v6\s+with:\s+ref: \$\{\{ needs\.release-metadata\.outputs\.source_sha \}\}/);
    assert.match(section, /prepare:kbrain:release/);
    assert.match(section, /run: pnpm build:kbrain:source/);
    assert.ok(section.indexOf("build:kbrain:source") < section.indexOf("prepare:kbrain:release"));
  }
  const ci = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
  const gui = ci.split("\n  gui:")[1]?.split(/\n  [\w-]+:/)[0];
  assert.match(gui, /pnpm build:kbrain:source --target x86_64-unknown-linux-gnu/);
  assert.match(gui, /pnpm prepare:kbrain:release --target x86_64-unknown-linux-gnu/);
  assert.doesNotMatch(gui, /go build|KBRAIN_REPO_ROOT|\.kbrain-src/);
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.match(packageJson.scripts["build:kbrain:source"], /--patch-manifest patches\/kbrain\/manifest.json/);
  assert.match(packageJson.scripts["prepare:kbrain:release"], /--release --patch-manifest patches\/kbrain\/manifest.json --artifact-dir \.zeroagent\/backend-artifact/);
  assert.match(workflow, /verify-kbrain-packaging\.mjs[^\n]*--patch-manifest patches\/kbrain\/manifest.json/);
});

test("prepared backend and computer helper receipts use the locked target and checksums", { skip: process.platform === "win32" && "Unix executable bits are not observable on Windows" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "liveagent-kbrain-package-"));
  try {
    const backend = Buffer.from("backend fixture");
    const computer = Buffer.from("computer fixture");
    const backendName = `k-brain-${target}`;
    const computerName = `k-brain-computer-${target}`;
    await executable(join(directory, backendName), backend);
    await executable(join(directory, computerName), computer);
    await writeFile(join(directory, `${backendName}.json`), JSON.stringify({
      sourceRevision: revision,
      protocol: "kbrain.agent.v1",
      target,
      assets: { backend: "k-brain-darwin-arm64", computer: "k-brain-computer-darwin-arm64" },
      sha256: { backend: sha256(backend), computer: sha256(computer) },
    }));
    const result = await verifyPreparedBinaries({ binaryDir: directory, target, lock });
    assert.equal(await readFile(result.computer, "utf8"), "computer fixture");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verifies the real macOS Tauri app layout with executable files and receipt hashes", { skip: process.platform === "win32" && "Unix executable bits are not observable on Windows" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "liveagent-kbrain-app-"));
  try {
    const bundle = join(directory, "LiveAgent.app", "Contents", "MacOS");
    await mkdir(bundle, { recursive: true });
    const backend = Buffer.from("bundled backend");
    const computer = Buffer.from("bundled computer");
    await executable(join(bundle, "k-brain"), backend);
    await executable(join(bundle, "k-brain-computer"), computer);
    const result = await verifyBundle(directory, target, lock, { hashes: { backend: sha256(backend), computer: sha256(computer) } });
    assert.equal(result.backend, join(bundle, "k-brain"));
    assert.equal(result.computer, join(bundle, "k-brain-computer"));
    await chmod(join(bundle, "k-brain-computer"), 0o644);
    await assert.rejects(() => verifyBundle(directory, target, lock, { hashes: { backend: sha256(backend), computer: sha256(computer) } }), /must be executable/);
    await chmod(join(bundle, "k-brain-computer"), 0o755);
    await writeFile(join(bundle, "k-brain"), "tampered backend");
    await chmod(join(bundle, "k-brain"), 0o755);
    await assert.rejects(() => verifyBundle(directory, target, lock, { hashes: { backend: sha256(backend), computer: sha256(computer) } }), /SHA-256/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verifies the Windows portable layout and rejects duplicate backend files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "liveagent-kbrain-portable-"));
  const windowsLock = join(directory, "windows-lock.json");
  try {
    const manifest = JSON.parse(await readFile(lock, "utf8"));
    await writeFile(windowsLock, JSON.stringify(manifest));
    const bundle = join(directory, "LiveAgent");
    await mkdir(bundle, { recursive: true });
    const backend = Buffer.from("portable backend");
    const computer = Buffer.from("portable computer");
    await executable(join(bundle, "k-brain.exe"), backend);
    await executable(join(bundle, "k-brain-computer.exe"), computer);
    const result = await verifyBundle(directory, "x86_64-pc-windows-msvc", windowsLock, { hashes: { backend: sha256(backend), computer: sha256(computer) } });
    assert.equal(result.backend, join(bundle, "k-brain.exe"));
    await executable(join(directory, "duplicate", "k-brain.exe"), backend);
    await assert.rejects(() => verifyBundle(directory, "x86_64-pc-windows-msvc", windowsLock, { hashes: { backend: sha256(backend), computer: sha256(computer) } }), /exactly one backend and one computer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
