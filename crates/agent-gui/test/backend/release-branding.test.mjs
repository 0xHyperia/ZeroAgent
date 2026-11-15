import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(guiRoot, "../..");

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("release and Gateway documentation use the ZeroAgent repository and image", () => {
  const workflow = readRepoFile(".github/workflows/gateway-docker.yml");
  const readmes = [readRepoFile("README.md"), readRepoFile("README.zh-CN.md")];

  assert.match(workflow, /IMAGE_NAME: ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/zeroagent-gateway/);
  for (const readme of readmes) {
    assert.match(readme, /https:\/\/github\.com\/USA-Zero\/ZeroAgent\/releases\/latest/);
    assert.match(
      readme,
      /GATEWAY_IMAGE=ghcr\.io\/0xhyperia\/zeroagent-gateway@sha256:(?:[a-f0-9]{64}|REPLACE_WITH_VERIFIED_DIGEST)\b/,
    );
    assert.match(readme, /docker pull "\$GATEWAY_IMAGE"/);
    assert.doesNotMatch(readme, /ghcr\.io\/0xhyperia\/zeroagent-gateway:(?:latest|main)\b/);
    assert.doesNotMatch(readme, /Stack-Cairn|stack-cairn|LiveAgent-Updater/);
  }
});

test("desktop releases gate public credentials, notes, manifest URLs and uploads on the release tag", () => {
  const workflow = readRepoFile(".github/workflows/desktop-release.yml");

  assert.match(workflow, /SOURCE_RELEASE_TOKEN/);
  assert.match(workflow, /Validate public release repository\s+if: steps\.version\.outputs\.publish_public == 'true' &&/);
  assert.match(workflow, /PUBLIC_RELEASE_TOKEN: \$\{\{ needs\.release-metadata\.outputs\.publish_public == 'true' && secrets\.PUBLIC_RELEASE_TOKEN/);
  assert.match(workflow, /publish_release "\$SOURCE_REPOSITORY"/);
  assert.match(workflow, /if \[ "\$PUBLISH_PUBLIC" = true \]; then\s+publish_release "\$RELEASE_REPOSITORY"/);
  assert.match(workflow, /\.github\/release-notes\/\$RELEASE_TAG\.md/);
  assert.match(workflow, /\.github\/release-notes-public\/\$RELEASE_TAG\.md/);
  assert.match(workflow, /manifest_repository="\$SOURCE_REPOSITORY"[\s\S]*if \[ "\$PUBLISH_PUBLIC" = true \]; then\s+test -n "\$PUBLIC_RELEASE_TOKEN"\s+test -s "\$curated_public_notes_path"[\s\S]*manifest_repository="\$RELEASE_REPOSITORY"/);
  assert.match(workflow, /RELEASE_REPOSITORY="\$manifest_repository" node scripts\/release\/create-tauri-updater-manifest\.mjs/);
});

test("Windows packaging retains stock uninstall without the upstream data cleanup hook", () => {
  for (const filename of ["tauri.conf.json", "tauri.windows.conf.json", "tauri.windows.release.conf.json"]) {
    const config = JSON.parse(readRepoFile(`crates/agent-gui/src-tauri/${filename}`));
    assert.equal(config.bundle.windows.nsis.installerIcon, "icons/icon.ico", filename);
    assert.equal(Object.hasOwn(config.bundle.windows.nsis, "installerHooks"), false, filename);
  }
});

test("Windows upgrade acceptance is opt-in and consumes the signed candidate on a separate read-only runner", () => {
  const workflow = readRepoFile(".github/workflows/desktop-release.yml");
  const upgrade = workflow.match(/\n  windows-upgrade:\n([\s\S]*?)(?=\n  [\w-]+:\n)/)?.[1];
  assert.ok(upgrade);
  assert.match(upgrade, /if: github\.event_name == 'workflow_dispatch' && inputs\.artifacts_only && inputs\.previous_windows_release != ''/);
  assert.match(upgrade, /needs: \[release-metadata, windows\]\s+runs-on: windows-latest\s+permissions:\s+contents: read/);
  assert.match(upgrade, /actions\/download-artifact@v8\s+with:\s+name: liveagent-windows-x64/);
  assert.match(upgrade, /-PreviousVersion \$env:PREVIOUS_WINDOWS_RELEASE\.Substring\(1\)/);
  assert.match(upgrade, /\$asset\[0\]\.digest -cne \$digest/);
  assert.doesNotMatch(upgrade, /TAURI_SIGNING_PRIVATE_KEY|PUBLIC_RELEASE_TOKEN|gh release (?:create|upload)|contents: write/);
  assert.doesNotMatch(workflow.match(/\n  publish:\n([\s\S]+)/)?.[1] ?? "", /- windows-upgrade/);
});

test("browser extension presents ZeroAgent branding while keeping its bridge protocol", () => {
  const manifest = JSON.parse(readRepoFile("crates/agent-gui/browser-extension/manifest.json"));
  const background = readRepoFile("crates/agent-gui/browser-extension/background.js");

  assert.equal(manifest.name, "ZeroAgent Browser Bridge");
  assert.match(manifest.description, /ZeroAgent desktop app/);
  assert.doesNotMatch(manifest.description, /LiveAgent/);
  assert.match(background, /only tabs created by ZeroAgent can be attached/);
  assert.match(background, /const RECONNECT_ALARM = "liveagent-bridge-reconnect"/);
  assert.match(background, /method: "LiveAgent\.ping"/);
});
