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
  assert.match(launcherBackground, /#FFFFFF/);
  assert.doesNotMatch(launcherBackground, /transparent/);
  assert.match(workflow, /networkTimeout=120000/);
  assert.match(workflow, /chmod \+x gradlew/);
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
  const tauriConfig = JSON.parse(readRepoFile("crates/agent-gui/src-tauri/tauri.conf.json"));
  const tauriLib = readRepoFile("crates/agent-gui/src-tauri/src/lib.rs");
  const mobileGateway = readRepoFile(
    "crates/agent-gui/src-tauri/src/services/mobile_gateway.rs",
  );
  const mobileRuntime = readRepoFile("crates/agent-gateway/web/src/lib/mobileRuntime.ts");
  const mobileStyles = readRepoFile("crates/agent-gateway/web/src/styles.css");
  const mainActivity = readRepoFile(
    "crates/agent-gui/src-tauri/gen/android/app/src/main/java/top/usa0/zeroagent/MainActivity.kt",
  );
  const androidManifest = readRepoFile(
    "crates/agent-gui/src-tauri/gen/android/app/src/main/AndroidManifest.xml",
  );
  const mobileUpdate = readRepoFile("crates/agent-gateway/web/src/lib/mobileAppUpdate.ts");
  const gatewayApp = readRepoFile("crates/agent-gateway/web/src/app/GatewayApp.tsx");
  const mobileRelayGate = readRepoFile(
    "crates/agent-gateway/web/src/components/relay/RelayAccessGate.tsx",
  );
  const accountLoginPage = readRepoFile("crates/agent-gateway/web/src/pages/AccountLoginPage.tsx");
  const gatewayViteConfig = readRepoFile("crates/agent-gateway/web/vite.config.ts");

  assert.match(androidConfig, /agent-gateway\/web exec vite build --mode embedded-mobile/);
  assert.match(androidConfig, /"frontendDist": "\.\.\/\.\.\/agent-gateway\/web\/dist"/);
  assert.match(androidConfig, /"url": "index\.html"/);
  assert.doesNotMatch(androidConfig, /usa0\.top/);
  assert.deepEqual(tauriConfig.plugins["deep-link"].mobile, [
    {
      scheme: ["top.usa0.zeroagent"],
      pathPrefix: ["/oauth/callback"],
    },
  ]);
  assert.match(tauriLib, /#\[cfg\(mobile\)\][\s\S]*ZeroAgent mobile WebView/);
  assert.match(tauriLib, /mobile_gateway_socket_connect/);
  assert.match(tauriLib, /#\[cfg\(desktop\)\]\s*pub fn run\(\)/);
  assert.match(mobileRuntime, /mobile_gateway_request/);
  assert.match(mobileRuntime, /body instanceof FormData/);
  assert.match(mobileRuntime, /mobile_gateway_multipart_request/);
  assert.match(tauriLib, /mobile_gateway_multipart_request/);
  assert.match(mobileRuntime, /mobile_gateway_socket_connect/);
  assert.match(mobileRuntime, /maximum-scale=1, user-scalable=no/);
  assert.match(mobileRuntime, /visualViewport/);
  assert.match(mobileRuntime, /zeroagent:native-insets/);
  assert.match(mobileRuntime, /--zeroagent-safe-area-\$\{edge\}/);
  assert.match(mobileRuntime, /MOBILE_BACK_EVENT/);
  assert.match(mobileRuntime, /zeroagent:native-back/);
  assert.match(mobileRuntime, /imeBottom/);
  assert.match(mobileRuntime, /moveTaskToBack/);
  assert.doesNotMatch(mobileRuntime, /addEventListener\("popstate"/);
  assert.match(mainActivity, /enableEdgeToEdge\(\)/);
  assert.match(mainActivity, /WindowInsetsCompat\.Type\.displayCutout\(\)/);
  assert.match(mainActivity, /WindowInsetsCompat\.Type\.ime\(\)/);
  assert.match(mainActivity, /OnBackPressedCallback/);
  assert.match(mainActivity, /zeroagent:native-back/);
  assert.match(mainActivity, /moveTaskToBack\(true\)/);
  assert.match(androidManifest, /android:windowSoftInputMode="adjustResize"/);
  assert.match(mainActivity, /LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS/);
  assert.match(mainActivity, /LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES/);
  assert.match(mainActivity, /addJavascriptInterface\(AndroidSafeAreaBridge\(\)/);
  assert.match(mainActivity, /@JavascriptInterface[\s\S]*getSafeAreaInsets/);
  assert.match(mainActivity, /zeroagent:native-insets/);
  for (const edge of ["top", "right", "bottom", "left"]) {
    assert.match(mobileStyles, new RegExp(`--zeroagent-safe-area-${edge}`));
  }
  assert.match(mobileStyles, /\.gateway-chat-frame > header[\s\S]*safe-area-top/);
  assert.match(mobileStyles, /\.gateway-main-shell[\s\S]*safe-area-right[\s\S]*safe-area-left/);
  assert.match(
    mobileStyles,
    /data-zeroagent-platform="android"\] \.gateway-settings-overlay[\s\S]*safe-area-top/,
  );
  assert.match(
    mobileStyles,
    /data-zeroagent-platform="android"\] \.settings-back-bar\s*\{\s*padding-top: 8px/,
  );
  assert.match(mobileStyles, /\.project-tools-panel-inner[\s\S]*safe-area-top[\s\S]*safe-area-bottom/);
  assert.match(
    mobileStyles,
    /\.workspace-code-editor-overlay[\s\S]*\.workspace-ssh-terminal-overlay[\s\S]*safe-area-top[\s\S]*safe-area-right[\s\S]*safe-area-bottom[\s\S]*safe-area-left/,
  );
  assert.match(mobileStyles, /\.workspace-overlay-header[\s\S]*min-height: 56px/);
  assert.match(mobileStyles, /\.chat-history-sidebar-inner[\s\S]*safe-area-bottom/);
  assert.match(mobileStyles, /:root\s*\{[\s\S]*--zeroagent-safe-area-left/);
  assert.match(
    mobileStyles,
    /data-zeroagent-platform="android"\] \.gateway-shell\s*\{\s*height: 100%;\s*min-height: 0;/,
  );
  assert.match(mobileStyles, /\.history-share-frame[\s\S]*safe-area-bottom/);
  assert.match(
    mobileStyles,
    /\.account-login-shell[\s\S]*safe-area-top[\s\S]*safe-area-right[\s\S]*safe-area-bottom[\s\S]*safe-area-left/,
  );
  assert.match(mobileStyles, /\.hub-sidebar-trigger[\s\S]*safe-area-top/);
  assert.match(mobileStyles, /\.hub-scroll[\s\S]*safe-area-bottom/);
  assert.match(
    mobileStyles,
    /\.skills-drawer-panel,[\s\S]*\.skills-drawer-panel-closing[\s\S]*safe-area-left/,
  );
  assert.match(
    mobileStyles,
    /\.workspace-clone-task-overlay[\s\S]*safe-area-right[\s\S]*safe-area-bottom[\s\S]*safe-area-left/,
  );
  assert.match(mobileStyles, /\.app-error-fallback[\s\S]*safe-area-bottom/);
  assert.match(mobileStyles, /\.mobile-safe-modal-overlay[\s\S]*safe-area-left/);
  assert.match(mobileStyles, /\.organizer-history-layout[\s\S]*grid-template-columns/);
  assert.doesNotMatch(tauriLib, /mobile_app_exit/);
  assert.match(tauriLib, /mobile_open_external_url/);
  assert.match(mainActivity, /pending-mobile-oauth-callback/);
  assert.match(mainActivity, /persistOAuthCallback\(intent\)/);
  assert.match(mainActivity, /override fun onNewIntent/);
  assert.match(mainActivity, /getPendingOAuthCallback/);
  assert.match(mainActivity, /acknowledgeOAuthCallback/);
  assert.match(mobileRuntime, /getPendingOAuthCallback/);
  assert.match(mobileRuntime, /acknowledgeOAuthCallback/);
  assert.match(accountLoginPage, /visibilitychange/);
  assert.match(accountLoginPage, /window\.addEventListener\("focus", drainPendingOAuth\)/);
  assert.match(accountLoginPage, /window\.addEventListener\("pageshow", drainPendingOAuth\)/);
  assert.doesNotMatch(tauriLib, /deep_link\(\)\s*\.get_current\(\)/);
  assert.match(gatewayApp, /MOBILE_BACK_EVENT/);
  assert.match(gatewayApp, /mobileNavigationStackRef/);
  assert.match(mobileUpdate, /Android-arm64\.apk/);
  assert.match(mobileUpdate, /__ZEROAGENT_APP_VERSION__/);
  assert.doesNotMatch(mobileRuntime, /mobile-session/);
  assert.match(mobileGateway, /OFFICIAL_GATEWAY_URL: &str = "https:\/\/agent\.usa0\.top"/);
  assert.match(mobileGateway, /option_env!\("ZEROAGENT_GATEWAY_URL"\)/);
  assert.match(mobileGateway, /option_env!\("ZEROAGENT_GATEWAY_PORT"\)/);
  assert.doesNotMatch(mobileGateway, /ZEROAGENT_MOBILE_GATEWAY_ORIGIN/);
  assert.doesNotMatch(tauriLib, /mobile_gateway_configure/);
  assert.doesNotMatch(mobileRuntime, /configureEmbeddedMobileGateway/);
  assert.doesNotMatch(mobileRelayGate, /mobile-gateway-origin|Gateway 服务地址|RELAY_ORIGIN/);
  assert.match(gatewayViteConfig, /mode === "embedded-mobile"/);
  assert.match(gatewayViteConfig, /LIVEAGENT_APP_VERSION/);
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
