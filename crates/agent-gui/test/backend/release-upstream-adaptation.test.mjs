import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function readGuiFile(relativePath) {
  return readFileSync(path.join(guiRoot, relativePath), "utf8");
}

test("desktop tray integration remains isolated from the Android runtime", () => {
  const lib = readGuiFile("src-tauri/src/lib.rs");
  const services = readGuiFile("src-tauri/src/services/mod.rs");
  const appCommands = readGuiFile("src-tauri/src/commands/app/mod.rs");
  const commands = readGuiFile("src-tauri/src/commands/mod.rs");

  assert.match(lib, /#\[cfg\(desktop\)\]\s+use tauri::tray/);
  assert.match(lib, /#\[cfg\(mobile\)\]\s+#\[tauri::mobile_entry_point\]\s+pub fn run\(\)/);
  assert.match(services, /#\[cfg\(desktop\)\]\s+pub mod tray;/);
  assert.match(appCommands, /#\[cfg\(desktop\)\]\s+pub mod tray;/);
  assert.match(commands, /#\[cfg\(desktop\)\]\s+pub use app_commands::tray;/);
});

test("release builds cannot register the desktop development MCP bridge", () => {
  const lib = readGuiFile("src-tauri/src/lib.rs").replace(/\r\n/g, "\n");
  const desktopRunStart = lib.indexOf("#[cfg(desktop)]\npub fn run()");
  assert.notEqual(desktopRunStart, -1);
  const desktopRun = lib.slice(desktopRunStart);

  assert.equal(lib.match(/\btauri_plugin_mcp_bridge\b/g)?.length, 1);
  assert.equal(lib.match(/tauri_plugin_mcp_bridge::Builder::new\(\)/g)?.length, 1);
  assert.doesNotMatch(lib.slice(0, desktopRunStart), /tauri_plugin_mcp_bridge/);
  assert.match(
    desktopRun,
    /#\[cfg\(debug_assertions\)\]\s*let builder = builder\.plugin\(\s*tauri_plugin_mcp_bridge::Builder::new\(\)[\s\S]*?\.build\(\),\s*\);/,
  );
  assert.equal(lib.match(/ZEROAGENT_DEV_MCP_BRIDGE_PORT/g)?.length, 1);
  assert.match(desktopRun, /std::env::var\("ZEROAGENT_DEV_MCP_BRIDGE_PORT"\)/);
  assert.match(desktopRun, /\.unwrap_or\(9223\)/);
});

test("tray surfaces retain ZeroAgent identity", () => {
  const lib = readGuiFile("src-tauri/src/lib.rs");
  const trayService = readGuiFile("src-tauri/src/services/tray.rs");
  const trayMenu = readGuiFile("src/lib/tray/trayMenu.ts");
  const trayPrefs = readGuiFile("src/lib/tray/trayPrefs.ts");
  const i18n = readGuiFile("src/i18n/config.ts");

  assert.match(lib, /\.tooltip\("ZeroAgent"\)/);
  assert.doesNotMatch(trayService, /LiveAgent/);
  assert.doesNotMatch(trayMenu, /LiveAgent/);
  assert.match(trayPrefs, /const STORAGE_KEY = "zeroagent\.trayPrefs\.v1";/);
  assert.match(i18n, /"tray\.quit": "退出 ZeroAgent"/);
  assert.match(i18n, /"tray\.quit": "Quit ZeroAgent"/);
});

test("tray conversation actions preserve workspace-aware selection", () => {
  const chatPage = readGuiFile("src/pages/ChatPage.tsx");

  assert.match(chatPage, /"app:action"/);
  assert.match(chatPage, /params\.handleSelectConversation\(conversationId\)/);
  assert.match(chatPage, /sidebarStore\.peek\(targetConversationId\)\?\.cwd/);
  assert.match(chatPage, /openController\.open\(targetConversationId, \{\s*afterCommit:/);
  assert.match(chatPage, /activateConversationWorkspace\(targetWorkdir\)/);
});
