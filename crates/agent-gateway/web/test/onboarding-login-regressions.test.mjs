import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const loginSource = readFileSync(new URL("../src/pages/AccountLoginPage.tsx", import.meta.url), "utf8");
const onboardingSource = readFileSync(
  new URL("../src/components/onboarding/FirstRunOnboarding.tsx", import.meta.url),
  "utf8",
);
const desktopOnboardingSource = readFileSync(
  new URL(
    "../../../agent-gui/src/components/onboarding/FirstRunOnboarding.tsx",
    import.meta.url,
  ),
  "utf8",
);
const viteConfigSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const gatewayAppSource = readFileSync(new URL("../src/app/GatewayApp.tsx", import.meta.url), "utf8");
const cloudChatSource = readFileSync(
  new URL("../src/pages/CloudChatPage.tsx", import.meta.url),
  "utf8",
);

test("account login primary action submits its form", () => {
  assert.match(loginSource, /<Button\s+type="submit"\s+className="mt-7 w-full"/);
});

test("web development proxy targets the gateway default port", () => {
  assert.match(viteConfigSource, /DEFAULT_PROXY_API\s*=\s*"http:\/\/localhost:3001"/);
});

test("first-run onboarding renders above application stacking contexts", () => {
  assert.match(onboardingSource, /createPortal\(/);
  assert.match(onboardingSource, /zIndex:\s*2147483647/);
  assert.match(onboardingSource, /document\.body/);
});

test("desktop onboarding uses the desktop relay client", () => {
  assert.match(desktopOnboardingSource, /from "\.\.\/\.\.\/lib\/relay\/client"/);
  assert.match(desktopOnboardingSource, /Promise\.all\(\[listRelayApiKeys\(\), listRelayGroups\(\)\]\)/);
  assert.doesNotMatch(desktopOnboardingSource, /agent-gateway\/web/);
});

test("expired web sessions clear the complete cached application state", () => {
  assert.match(
    gatewayAppSource,
    /addEventListener\(RELAY_SESSION_EXPIRED_EVENT, handleLogout\)/,
  );
  assert.match(cloudChatSource, /response\.status === 401\) notifyRelaySessionExpired\(\)/);
});
