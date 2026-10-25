import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("account menu receives verified USA-Zero balance, usage and account-settings navigation", () => {
  const view = readFileSync(new URL("../src/app/GatewayAppView.tsx", import.meta.url), "utf8");
  assert.match(view, /email=\{relayUser\?\.email/);
  assert.match(view, /balance=\{relayUser\?\.balance\}/);
  assert.match(view, /todayTokens=\{relayStats\?\.today_tokens\}/);
  assert.match(view, /onRefreshAccount=\{refreshRelayAccount\}/);
  assert.match(view, /onOpenSettings=\{\(\) => openSettings\("account"\)\}/);
  assert.doesNotMatch(view, /StatusDashboardPage/);
});
