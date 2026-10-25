import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("account menu keeps verified account refresh and separate account/settings navigation", () => {
  const view = readFileSync(new URL("../src/app/GatewayAppView.tsx", import.meta.url), "utf8");
  assert.match(view, /email=\{relayUser\?\.email/);
  assert.match(view, /balance=\{relayUser\?\.balance\}/);
  assert.match(view, /todayTokens=\{relayStats\?\.today_tokens\}/);
  assert.match(view, /onRefreshAccount=\{refreshRelayAccount\}/);
  assert.match(view, /onOpenAccount=\{\(\) => openSettings\("account"\)\}/);
  assert.match(view, /onOpenSettings=\{\(\) => openSettings\("system"\)\}/);
  const account = readFileSync(new URL("../src/pages/settings/AccountSection.tsx", import.meta.url), "utf8");
  assert.match(account, /formatRelayBalance\(user.balance\)/);
  assert.match(account, /stats\?\.today_tokens/);
  assert.doesNotMatch(view, /StatusDashboardPage/);
});

test("Cloud Chat keeps the same footer menu with its own account/system destinations", () => {
  const source = readFileSync(new URL("../src/pages/CloudChatPage.tsx", import.meta.url), "utf8");
  const menu = source.slice(source.indexOf("accountMenu={"), source.indexOf("onLogout={onLogout}"));
  assert.match(menu, /onOpenAccount=\{\(\) => \{\s*setSettingsSection\("account"\)/);
  assert.match(menu, /onOpenSettings=\{\(\) => \{\s*setSettingsSection\("system"\)/);
  assert.doesNotMatch(menu, /setSettingsSection\("devices"\)/);
});
