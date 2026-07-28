import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(guiRoot, "../..");

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("Android workflow builds a signed arm64 APK and can publish it", () => {
  const workflow = readRepoFile(".github/workflows/android-release.yml");
  const cargoToml = readRepoFile("crates/agent-gui/src-tauri/Cargo.toml");
  const launcherBackground = readRepoFile(
    "crates/agent-gui/src-tauri/icons/android/values/ic_launcher_background.xml",
  );

  assert.match(workflow, /java-version: "17"/);
  assert.match(workflow, /targets: aarch64-linux-android/);
  assert.match(
    workflow,
    /BINDGEN_EXTRA_CLANG_ARGS=--sysroot=\$\{ANDROID_HOME\}\/ndk\/\$\{ANDROID_NDK_VERSION\}\/toolchains\/llvm\/prebuilt\/linux-x86_64\/sysroot/,
  );
  assert.match(workflow, /tauri android build --apk --target aarch64 --ci/);
  assert.match(workflow, /ANDROID_KEYSTORE_BASE64/);
  assert.match(workflow, /apksigner" sign/);
  assert.match(workflow, /apksigner" verify --verbose --print-certs/);
  assert.match(workflow, /gh release upload/);
  assert.match(workflow, /SOURCE_RELEASE_TOKEN/);
  assert.match(workflow, /PUBLIC_RELEASE_TOKEN/);
  assert.match(workflow, /upload_apk "\$SOURCE_REPOSITORY"/);
  assert.match(workflow, /upload_apk "\$RELEASE_REPOSITORY"/);
  assert.match(workflow, /Install ZeroAgent Android launcher icons/);
  assert.match(workflow, /src-tauri\/icons\/android/);
  assert.match(workflow, /cp -R "\$source_dir"\/\. "\$target_dir"\//);
  assert.match(workflow, /cmp "\$source_dir\/mipmap-\$\{density\}\/\$\{icon\}\.png"/);
  assert.doesNotMatch(workflow, /usesCleartextTraffic/);
  assert.match(workflow, /Install Gateway WebUI dependencies/);
  assert.match(launcherBackground, /@android:color\/transparent/);
  assert.match(workflow, /networkTimeout=120000/);
  assert.match(workflow, /\.\/gradlew --version --no-daemon/);
  assert.match(workflow, /for attempt in 1 2 3/);
  assert.match(
    cargoToml,
    /target\.'cfg\(not\(any\(target_os = "android", target_os = "ios"\)\)\)'\.dependencies/,
  );
  assert.match(
    cargoToml,
    /target\.'cfg\(target_os = "android"\)'\.dependencies[\s\S]*rquickjs = \{[^\n]*features = \["bindgen"\]/,
  );
});

test("Android bundles the ZeroAgent Gateway WebUI instead of redirecting to a site", () => {
  const androidConfig = readRepoFile("crates/agent-gui/src-tauri/tauri.android.conf.json");
  const tauriLib = readRepoFile("crates/agent-gui/src-tauri/src/lib.rs");
  const mobileRuntime = readRepoFile("crates/agent-gateway/web/src/lib/mobileRuntime.ts");
  const gatewayViteConfig = readRepoFile("crates/agent-gateway/web/vite.config.ts");

  assert.match(androidConfig, /agent-gateway\/web exec vite build --mode embedded-mobile/);
  assert.match(androidConfig, /"frontendDist": "\.\.\/\.\.\/agent-gateway\/web\/dist"/);
  assert.match(androidConfig, /"url": "index\.html"/);
  assert.doesNotMatch(androidConfig, /usa0\.top/);
  assert.match(tauriLib, /#\[cfg\(mobile\)\][\s\S]*ZeroAgent mobile WebView/);
  assert.match(tauriLib, /mobile_gateway_socket_connect/);
  assert.match(tauriLib, /#\[cfg\(desktop\)\]\s*pub fn run\(\)/);
  assert.match(mobileRuntime, /mobile_gateway_request/);
  assert.match(mobileRuntime, /mobile_gateway_socket_connect/);
  assert.doesNotMatch(mobileRuntime, /mobile-session/);
  assert.match(gatewayViteConfig, /mode === "embedded-mobile"/);
  assert.equal(existsSync(path.join(guiRoot, "mobile.html")), false);
  assert.equal(existsSync(path.join(guiRoot, "src/mobile.ts")), false);
  for (const filename of ["README.md", "README.zh-CN.md"]) {
    const readme = readRepoFile(filename);
    assert.match(readme, /Android-arm64\.apk/);
    assert.match(readme, /内置|bundles/i);
    assert.doesNotMatch(readme, /https:\/\/usa0\.top\/login/);
  }
});

test("Android excludes desktop-only global shortcut commands", () => {
  const appCommands = readRepoFile(
    "crates/agent-gui/src-tauri/src/commands/app/app.rs",
  );
  const appUpdate = readRepoFile(
    "crates/agent-gui/src-tauri/src/commands/app/update.rs",
  );
  const systemCommands = readRepoFile(
    "crates/agent-gui/src-tauri/src/commands/app/system.rs",
  );
  const tauriLib = readRepoFile("crates/agent-gui/src-tauri/src/lib.rs");

  assert.match(
    appCommands,
    /#\[cfg\(desktop\)\]\s*use tauri_plugin_global_shortcut/,
  );
  for (const command of [
    "app_window_pinned",
    "app_toggle_window_pin",
    "app_set_global_shortcuts",
  ]) {
    assert.match(
      appCommands,
      new RegExp(
        `#\\[tauri::command\\]\\s*#\\[cfg\\(desktop\\)\\]\\s*pub fn ${command}`,
      ),
    );
  }
  assert.match(
    appUpdate,
    /#\[tauri::command\]\s*#\[cfg\(desktop\)\]\s*pub fn app_restart/,
  );
  assert.match(
    systemCommands,
    /#\[cfg\(desktop\)\]\s*fn system_clipboard_read_text_sync/,
  );
  assert.match(
    systemCommands,
    /#\[tauri::command\]\s*#\[cfg\(desktop\)\]\s*pub async fn system_clipboard_read_text/,
  );
  assert.match(
    tauriLib,
    /#\[cfg\(desktop\)\]\s*pub\(crate\) const WINDOW_STATE_FLAGS/,
  );
});
