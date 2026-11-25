import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cloudChatSource = readFileSync(
  new URL("../src/pages/CloudChatPage.tsx", import.meta.url),
  "utf8",
);
const settingsPageSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const systemSettingsSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/SystemSettingsForm.tsx", import.meta.url),
  "utf8",
);
const deviceAgentViewSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);
const settingsSearchSource = readFileSync(
  new URL("../../../agent-ui/src/lib/settings/settingsSearchIndex.ts", import.meta.url),
  "utf8",
);

test("Cloud Chat declares its runtime and hides unsupported local capability sections", () => {
  assert.match(cloudChatSource, /runtimeKind="web_chat"/);
  assert.match(
    cloudChatSource,
    /hiddenSections=\{\[[\s\S]*"systemTools",[\s\S]*"stt",[\s\S]*"agents",[\s\S]*"ssh",[\s\S]*"memory",[\s\S]*"hooks",[\s\S]*"cron",[\s\S]*"remote",?[\s\S]*\]\}/,
  );
  assert.match(settingsPageSource, /props\.runtimeKind === "web_chat"/);
  assert.match(systemSettingsSource, /\.\.\.\(showLocalRuntimeSettings/);
  assert.match(systemSettingsSource, /key: "rightDock" as const/);
  assert.match(systemSettingsSource, /settings\.executionMode/);
  assert.match(systemSettingsSource, /settings\.systemProxy/);
});

test("Device Agent keeps desktop runtime settings while hiding remote self-management and Web STT", () => {
  assert.match(deviceAgentViewSource, /hiddenSections=\{\[\.\.\.DEVICE_WEB_HIDDEN_SETTINGS_SECTIONS\]\}/);
  assert.match(settingsSearchSource, /DEVICE_WEB_HIDDEN_SETTINGS_SECTIONS = \["remote", "stt"\]/);
  assert.doesNotMatch(deviceAgentViewSource, /runtimeKind="web_chat"/);
});
