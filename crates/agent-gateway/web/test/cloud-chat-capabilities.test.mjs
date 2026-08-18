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

test("Cloud Chat declares its runtime and hides unsupported local capability sections", () => {
  assert.match(cloudChatSource, /runtimeKind="web_chat"/);
  assert.match(
    cloudChatSource,
    /hiddenSections=\{\["systemTools", "agents", "ssh", "memory", "hooks", "cron", "remote"\]\}/,
  );
  assert.match(settingsPageSource, /props\.runtimeKind === "web_chat"/);
  assert.match(systemSettingsSource, /\.\.\.\(showLocalRuntimeSettings/);
  assert.match(systemSettingsSource, /key: "rightDock" as const/);
  assert.match(systemSettingsSource, /settings\.executionMode/);
  assert.match(systemSettingsSource, /settings\.systemProxy/);
});

test("Device Agent keeps desktop runtime settings while hiding only remote self-management", () => {
  assert.match(deviceAgentViewSource, /hiddenSections=\{\["remote"\]\}/);
  assert.doesNotMatch(deviceAgentViewSource, /runtimeKind="web_chat"/);
});
