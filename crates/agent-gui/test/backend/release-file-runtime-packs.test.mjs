import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../../../../", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");
const lock = JSON.parse(read("scripts/release/file-runtime/dependencies.lock.json"));

test("desktop release consumes privately hosted packs for all four native targets", () => {
  const pack = read(".github/workflows/file-runtime-packs.yml");
  const desktop = read(".github/workflows/desktop-release.yml");
  const targets = [...pack.matchAll(/target: ([a-z0-9_-]+)\r?$/gm)].map(([, target]) => target);
  assert.deepEqual(targets.sort(), Object.keys(lock.targets).sort());
  assert.equal(targets.length, 4);
  assert.match(pack, /contents: read/);
  assert.match(pack, /pack\.mjs[\s\S]*actions\/upload-artifact/);
  assert.match(desktop, /uses: \.\/\.github\/workflows\/file-runtime-packs\.yml/);
  assert.equal([...desktop.matchAll(/needs: \[release-metadata, file-runtime\]/g)].length, 3);
  assert.equal([...desktop.matchAll(/ZEROAGENT_REQUIRE_OFFLINE_FILE_QA: "1"/g)].length, 3);
  assert.doesNotMatch(desktop, /vars\.ZEROAGENT_FILE_RUNTIME_PACKS/);
});

test("every runtime dependency uses a verified HTTPS input", () => {
  const assets = [
    ...Object.values(lock.shared),
    ...Object.values(lock.targets).flatMap(Object.values),
    ...Object.values(lock.conda).flat(),
  ];
  for (const { url, sha256 } of assets) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "https:", url);
    assert.equal(parsed.username + parsed.password, "", url);
    assert.match(sha256, /^[a-f0-9]{64}$/, url);
  }
  for (const packages of Object.values(lock.conda)) {
    for (const name of ["poppler", "tesseract", "libarchive"]) {
      assert.equal(packages.filter((packageInput) => packageInput.name === name).length, 1);
    }
  }
});

test("Artifact Tool reports its actual supported version and verifies its exports", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "za-artifact-tool-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("crates/file-runtime/artifact_tool.mjs", root));
  const entry = join(scratch, "dist", "artifact_tool.mjs");
  mkdirSync(join(scratch, "dist"));
  writeFileSync(entry, "export class Workbook {}\nexport class Presentation {}\n");
  for (const version of ["2.8.145", "2.8.146"]) {
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "@oai/artifact-tool", version }));
    const probe = spawnSync(process.execPath, [script, "--probe"], {
      encoding: "utf8", env: { ...process.env, ZEROAGENT_FILE_ARTIFACT_ENTRY: entry },
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), { version, workbook: true, presentation: true });
  }
});

test("release staging rejects the wrong source commit and a corrupted hosted pack", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "za-runtime-receipt-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("scripts/release/stage-file-runtime.mjs", root));
  const cwd = fileURLToPath(root);
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
  const target = "x86_64-pc-windows-msvc";
  const receipt = { format: 1, target, source_sha: "0".repeat(40), sha256: "0".repeat(64), manifestSha256: "0".repeat(64) };
  writeFileSync(join(scratch, "file-runtime.tar.gz"), "corrupt payload");
  const stage = () => {
    writeFileSync(join(scratch, "receipt.json"), JSON.stringify(receipt));
    return spawnSync(process.execPath, [script, target, join(scratch, "out")], {
      cwd, encoding: "utf8", env: { ...process.env, ZEROAGENT_FILE_RUNTIME_PACK_DIR: scratch },
    });
  };
  const wrongCommit = stage();
  assert.equal(wrongCommit.status, 1);
  assert.match(wrongCommit.stderr, /receipt does not match/);
  receipt.source_sha = commit;
  const corrupted = stage();
  assert.equal(corrupted.status, 1);
  assert.match(corrupted.stderr, /archive checksum mismatch/);
});
