import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../../../../", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");
const lock = JSON.parse(read("scripts/release/file-runtime/dependencies.lock.json"));

test("desktop release consumes Actions runtime packs for all four native targets", () => {
  const pack = read(".github/workflows/file-runtime-packs.yml");
  const desktop = read(".github/workflows/desktop-release.yml");
  const targets = [...pack.matchAll(/target: ([a-z0-9_-]+)\r?$/gm)].map(([, target]) => target);
  assert.deepEqual(targets.sort(), Object.keys(lock.targets).sort());
  assert.equal(targets.length, 4);
  assert.match(pack, /contents: read/);
  assert.match(pack, /pack\.mjs[\s\S]*actions\/upload-artifact/);
  assert.match(desktop, /uses: \.\/\.github\/workflows\/file-runtime-packs\.yml/);
  assert.equal([...desktop.matchAll(/needs: \[release-metadata, file-runtime\]/g)].length, 3);
  assert.match(pack, /name: Verify the companion ZIP in a clean offline profile[\s\S]*ZEROAGENT_REQUIRE_OFFLINE_FILE_QA: "1"[\s\S]*managed_pack\.py restore[\s\S]*verify-installed-file-runtime\.mjs/);
  assert.doesNotMatch(desktop, /vars\.ZEROAGENT_FILE_RUNTIME_PACKS/);
});

test("desktop publishing waits for separate Windows tools and slim installer checks", () => {
  const workflow = read(".github/workflows/desktop-release.yml");
  const build = workflow.split("  windows:")[1]?.split("  windows-file-qa:")[0];
  const check = workflow.split("  windows-file-qa:")[1]?.split("  windows-upgrade:")[0];
  const publish = workflow.split("  publish:")[1];
  assert.match(build, /needs: \[release-metadata, file-runtime\]/);
  assert.match(build, /publish_public == 'true' && !inputs\.artifacts_only && env\.RELEASE_REPOSITORY/);
  assert.match(build, /stage-managed\.mjs[\s\S]*ZEROAGENT_FILE_RUNTIME_DESCRIPTOR/);
  assert.match(build, /Windows-x64-file-tools\.zip" dist\//);
  assert.doesNotMatch(build, /tauri\.file-runtime\.conf\.json|dist\/portable\/ZeroAgent\/file-runtime/);
  assert.match(check, /package: \[msi, nsis, portable\]/);
  assert.match(check, /-ExpectExternalFileRuntime -Package/);
  assert.match(publish, /needs:[\s\S]*- windows-file-qa/);
});

test("macOS and Linux installers omit the tools and publish a matching companion", () => {
  const workflow = read(".github/workflows/desktop-release.yml");
  const postprocess = read("scripts/release/postprocess-linux-appimage.sh");
  assert.doesNotMatch(workflow, /tauri\.file-runtime\.conf\.json/);
  assert.match(workflow, /macOS-\$\{\{ matrix.suffix \}\}-file-tools\.zip" dist\//);
  assert.match(workflow, /Linux-x86_64-file-tools\.zip" dist\//);
  assert.match(workflow, /Verify the macOS disk image and updater omit file tools/);
  assert.match(workflow, /Verify Linux package payloads omit file tools/);
  assert.match(workflow, /postprocess-linux-appimage\.sh "\$appimage_path"[\s\S]*tauri signer sign/);
  assert.match(postprocess, /test ! -e "\$verified_app_dir\/usr\/lib\/ZeroAgent\/file-runtime"/);
});

test("every runtime dependency uses a verified HTTPS input", () => {
  const windows = JSON.parse(read("scripts/release/file-runtime/windows-managed.lock.json"));
  const assets = [
    ...Object.values(lock.shared),
    ...Object.values(lock.targets).flatMap(Object.values),
    ...Object.values(lock.conda).flat(),
    windows.python,
    ...windows.wheels,
  ];
  for (const { url, sha256 } of assets) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, "https:", url);
    assert.equal(parsed.username + parsed.password, "", url);
    assert.match(sha256, /^[a-f0-9]{64}$/, url);
  }
  assert.equal(new URL(windows.python.url).hostname, "www.python.org");
  assert.ok(windows.wheels.every((wheel) => new URL(wheel.url).hostname === "files.pythonhosted.org"));
  for (const name of ["python-docx", "pypdf", "openpyxl", "python-pptx"]) {
    assert.equal(windows.wheels.filter((wheel) => wheel.name === name).length, 1);
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
  const realScript = fileURLToPath(new URL("crates/file-runtime/artifact_tool.mjs", root));
  const entry = join(scratch, "dist", "artifact_tool.mjs");
  mkdirSync(join(scratch, "dist"));
  mkdirSync(join(scratch, "tools"));
  copyFileSync(realScript, join(scratch, "tools", "artifact_tool.mjs"));
  symlinkSync(join(scratch, "tools"), join(scratch, "linked-tools"), process.platform === "win32" ? "junction" : "dir");
  const script = join(scratch, "linked-tools", "artifact_tool.mjs");
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

test("Desktop companion descriptors bind the exact asset and omit private download URLs", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "za-managed-runtime-receipt-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("scripts/release/file-runtime/stage-managed.mjs", root));
  const cwd = fileURLToPath(root);
  const source = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
  const targets = {
    "x86_64-pc-windows-msvc": "Windows-x64",
    "x86_64-apple-darwin": "macOS-x64",
    "aarch64-apple-darwin": "macOS-aarch64",
    "x86_64-unknown-linux-gnu": "Linux-x86_64",
  };
  const archive = Buffer.from("synthetic archive");
  const receipt = {
    format: 1, target: "x86_64-pc-windows-msvc", source_sha: source, bytes: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
  };
  writeFileSync(join(scratch, "file-runtime.zip"), archive);
  const stage = (label, tag, repository, target = receipt.target) => {
    writeFileSync(join(scratch, "receipt.json"), JSON.stringify(receipt));
    return spawnSync(process.execPath, [script, target, scratch, join(scratch, label), tag, ...(repository ? [repository] : [])], {
      cwd, encoding: "utf8",
    });
  };
  for (const [label, tag, repository] of [
    ["beta", "v1.0.0-beta.1", "example/releases"],
    ["stable", "v1.0.0", "example/releases"],
    ["private", "v1.0.0-rc.2", null],
    ["preview", "v1.0.0-beta.1", null],
  ]) {
    for (const [target, suffix] of Object.entries(targets)) {
      receipt.target = target;
      const key = `${label}-${suffix}`;
      const result = stage(key, tag, repository);
      assert.equal(result.status, 0, result.stderr);
      const directory = join(scratch, key);
      const name = `ZeroAgent-${tag}-${suffix}-file-tools.zip`;
      const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
      assert.deepEqual(JSON.parse(readFileSync(join(directory, "descriptor.json"), "utf8")), {
        format: 1, target, version: tag,
        archive: { name, bytes: receipt.bytes, sha256: receipt.sha256, ...(repository ? { url } : {}) },
      });
      assert.deepEqual(readFileSync(join(directory, name)), archive);
    }
  }
  const otherTarget = stage("wrong-target", "v1.0.0", null, "aarch64-apple-darwin");
  assert.equal(otherTarget.status, 1);
  assert.match(otherTarget.stderr, /different source commit or target/);
  const privateUrl = stage("private-url", "v1.0.0-alpha.1", "example/releases");
  assert.equal(privateUrl.status, 1);
  assert.match(privateUrl.stderr, /requires a public release tag/);
  receipt.source_sha = "0".repeat(40);
  const wrongCommit = stage("wrong-commit", "v1.0.0");
  assert.equal(wrongCommit.status, 1);
  assert.match(wrongCommit.stderr, /different source commit/);
  receipt.source_sha = source;
  receipt.bytes += 1;
  const wrongSize = stage("wrong-size", "v1.0.0");
  assert.equal(wrongSize.status, 1);
  assert.match(wrongSize.stderr, /does not match the recorded size/);
  receipt.bytes = archive.length;
  receipt.sha256 = "0".repeat(64);
  const corrupt = stage("corrupt", "v1.0.0");
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stderr, /checksum mismatch/);
  assert.equal(existsSync(join(scratch, "corrupt")), false);
});
