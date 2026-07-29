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
const desktopRelayGateSource = readFileSync(
  new URL("../../../agent-gui/src/components/relay/RelayAccessGate.tsx", import.meta.url),
  "utf8",
);
const viteConfigSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const gatewayAppSource = readFileSync(new URL("../src/app/GatewayApp.tsx", import.meta.url), "utf8");
const cloudChatSource = readFileSync(
  new URL("../src/pages/CloudChatPage.tsx", import.meta.url),
  "utf8",
);
const relayClientSource = readFileSync(
  new URL("../src/lib/relay/client.ts", import.meta.url),
  "utf8",
);

test("account login primary action submits its form", () => {
  assert.match(loginSource, /<Button\s+type="submit"\s+className="mt-7 w-full"/);
});

test("OAuth login is limited to the password-login state on web and desktop", () => {
  assert.match(loginSource, /!twoFactorRequired && mode === "login" && \(/);
  assert.match(loginSource, /const completedInPlace = await startRelayOAuth\(\)/);
  assert.match(loginSource, /if \(completedInPlace\) window\.location\.reload\(\)/);
  assert.match(relayClientSource, /window\.location\.assign\(response\.authorize_url\);\s+return false;/);
  assert.match(loginSource, /认证登录/);
  assert.match(desktopRelayGateSource, /mode === "login" && \(/);
  assert.match(desktopRelayGateSource, /await loginRelayOAuth\(\)/);
  assert.match(desktopRelayGateSource, /认证登录/);
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

test("session restoration renders a neutral loading surface before the login page", () => {
  assert.match(gatewayAppSource, /if \(authInitializing\) \{/);
  assert.match(gatewayAppSource, /aria-label="正在恢复登录状态"/);
  assert.match(
    gatewayAppSource,
    /if \(authInitializing\) \{[\s\S]*?if \(!accountUser\) \{/,
  );
});
