import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(guiRoot, "../..");
const versionScript = path.join(
  repoRoot,
  "scripts/release/prepare-app-version-from-tag.mjs",
);

function runVersionScript(args, env = {}) {
  return spawnSync(process.execPath, [versionScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ZEROAGENT_UPDATER_PUBLIC_KEY: "",
      ...env,
    },
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("release version script resolves tag metadata without mutating package.json", () => {
  const packageJsonPath = path.join(guiRoot, "package.json");
  const before = readFileSync(packageJsonPath, "utf8");

  const result = runVersionScript(["refs/tags/v9.10.11-beta.2", "--json"]);

  assert.equal(
    result.status,
    0,
    `version script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.releaseTag, "v9.10.11-beta.2");
  assert.equal(metadata.appVersion, "9.10.11-beta.2");
  assert.equal(metadata.isPrerelease, true);
  assert.equal(metadata.publishPublic, true);
  assert.equal(readFileSync(packageJsonPath, "utf8"), before);
});

test("release version script writes GitHub env, outputs, and Tauri config", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "liveagent-version-"));
  try {
    const envPath = path.join(dir, "github-env");
    const outputPath = path.join(dir, "github-output");
    const tauriConfigPath = path.join(dir, "tauri.version.generated.conf.json");

    const result = runVersionScript([
      "v1.2.3",
      "--github-env",
      envPath,
      "--github-output",
      outputPath,
      "--tauri-config",
      tauriConfigPath,
    ]);

    assert.equal(
      result.status,
      0,
      `version script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    assert.match(readFileSync(envPath, "utf8"), /^ZEROAGENT_APP_VERSION=1\.2\.3$/m);
    assert.match(
      readFileSync(envPath, "utf8"),
      new RegExp(`^ZEROAGENT_TAURI_VERSION_CONFIG=${escapeRegExp(tauriConfigPath)}$`, "m"),
    );
    assert.match(readFileSync(outputPath, "utf8"), /^release_tag=v1\.2\.3$/m);
    assert.match(readFileSync(outputPath, "utf8"), /^is_prerelease=false$/m);
    assert.match(readFileSync(outputPath, "utf8"), /^publish_public=true$/m);
    assert.deepEqual(JSON.parse(readFileSync(tauriConfigPath, "utf8")), {
      version: "1.2.3",
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("source-only release tags expose a false publish_public workflow output", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "zeroagent-release-route-"));
  try {
    for (const channel of ["alpha", "rc"]) {
      const outputPath = path.join(dir, channel);
      const result = runVersionScript([`v1.0.0-${channel}.1`, "--github-output", outputPath]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(readFileSync(outputPath, "utf8"), /^publish_public=false$/m);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("release version script rejects non-semver tags", () => {
  const result = runVersionScript(["v1.2"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /semver tag like v0\.1\.3/);
});

test("release overlay uses the configured updater key without changing the source config", () => {
  const sourcePath = path.join(guiRoot, "src-tauri/tauri.conf.json");
  const sourceBefore = readFileSync(sourcePath, "utf8");
  const publicKey = JSON.parse(sourceBefore).plugins.updater.pubkey;
  const dir = mkdtempSync(path.join(tmpdir(), "zeroagent-updater-overlay-"));
  try {
    const overlayPath = path.join(dir, "tauri.version.generated.conf.json");
    const result = runVersionScript(
      ["v0.4.0-beta.2", "--tauri-config", overlayPath, "--json"],
      { ZEROAGENT_UPDATER_PUBLIC_KEY: `  ${publicKey}\n` },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(overlayPath, "utf8")), {
      version: "0.4.0-beta.2",
      bundle: { windows: { wix: { version: "0.4.0.2" } } },
      plugins: { updater: { pubkey: publicKey } },
    });
    assert.equal(readFileSync(sourcePath, "utf8"), sourceBefore);
    assert.equal(result.stdout.includes(publicKey), false);
  } finally {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.equal(path.basename(resolved).startsWith("zeroagent-updater-overlay-"), true);
    rmSync(resolved, { force: true, recursive: true });
  }
});

test("Gateway Docker releases pass normalized versions and reserve latest for stable tags", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/gateway-docker.yml"), "utf8");
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

  assert.match(workflow, /id: version[\s\S]*prepare-app-version-from-tag\.mjs/);
  assert.match(workflow, /--github-env "\$GITHUB_ENV" --github-output "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /app_version: \$\{\{ steps\.version\.outputs\.app_version \}\}/);
  assert.match(workflow, /is_prerelease: \$\{\{ steps\.version\.outputs\.is_prerelease \}\}/);
  assert.match(workflow, /ZEROAGENT_APP_VERSION=\$\{\{ needs\.quality-gate\.outputs\.app_version \}\}/);
  assert.match(workflow, /value=latest,enable=\$\{\{ needs\.quality-gate\.outputs\.is_prerelease == 'false' \}\}/);
  assert.match(dockerfile, /^ARG ZEROAGENT_APP_VERSION\r?$/m);
  assert.match(dockerfile, /^RUN ZEROAGENT_APP_VERSION="\$ZEROAGENT_APP_VERSION" pnpm --filter @liveagent\/gateway-webui build\r?$/m);
});
