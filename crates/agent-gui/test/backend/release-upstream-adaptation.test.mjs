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
  assert.match(chatPage, /activateWorkspaceProject\(targetProject\)/);
  assert.match(chatPage, /setActiveWorkspaceProjectId\(DEFAULT_WORKSPACE_PROJECT_ID\)/);
});
