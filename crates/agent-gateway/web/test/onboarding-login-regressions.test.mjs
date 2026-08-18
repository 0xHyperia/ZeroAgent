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
const gatewaySocketSource = readFileSync(
  new URL("../src/lib/gatewaySocket.ts", import.meta.url),
  "utf8",
);
const gatewaySocketTransportSource = readFileSync(
  new URL("../src/lib/gatewaySocketTransport.ts", import.meta.url),
  "utf8",
);
const cloudChatSource = readFileSync(
  new URL("../src/pages/CloudChatPage.tsx", import.meta.url),
  "utf8",
);
const relayClientSource = readFileSync(
  new URL("../src/lib/relay/client.ts", import.meta.url),
  "utf8",
);
const gatewaySessionSource = readFileSync(
  new URL("../src/app/hooks/useGatewaySession.ts", import.meta.url),
  "utf8",
);
const executionSwitcherSource = readFileSync(
  new URL("../src/components/ExecutionEnvironmentSwitcher.tsx", import.meta.url),
  "utf8",
);
const executionTargetsSource = readFileSync(
  new URL("../src/lib/executionTargets.ts", import.meta.url),
  "utf8",
);
const makefileSource = readFileSync(new URL("../../../../Makefile", import.meta.url), "utf8");

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
  assert.match(viteConfigSource, /DEFAULT_PROXY_API\s*=\s*"http:\/\/127\.0\.0\.1:50052"/);
  assert.match(
    viteConfigSource,
    /"\/ws": \{[\s\S]*?changeOrigin: false,[\s\S]*?ws: true/,
  );
  assert.match(makefileSource, /\$\(MAKE\) wait-dev-gateway &&/);
  assert.match(makefileSource, /wait-dev-gateway:[\s\S]*?127\.0\.0\.1:50052\/healthz/);
});

test("gateway credential is published before token state mounts websocket consumers", () => {
  assert.match(
    gatewaySessionSource,
    /const applyToken = useCallback\(\(next: string\) => \{[\s\S]*?setEphemeralCredential\(next\);[\s\S]*?setToken\(next\);/,
  );
  assert.doesNotMatch(
    gatewaySessionSource,
    /useEffect\(\(\) => \{\s*setEphemeralCredential\(token\)/,
  );
  assert.match(gatewaySessionSource, /applyToken\(encodeSelectionCredential\(restored\)\)/);
  assert.match(gatewaySessionSource, /await validateExecutionSelection\(restored\)/);
  assert.match(
    gatewaySessionSource,
    /addEventListener\(GATEWAY_SELECTION_INVALID_EVENT, handleInvalidSelection\)/,
  );
  assert.match(gatewaySocketTransportSource, /message\.includes\("selection lease"\)/);
  assert.match(
    gatewaySocketTransportSource,
    /dispatchEvent\(new Event\(GATEWAY_SELECTION_INVALID_EVENT\)\)/,
  );
  assert.match(
    gatewaySessionSource,
    /applyToken\(next\.runtime_kind === "device_agent" \? encodeSelectionCredential\(next\) : ""\)/,
  );
  assert.match(gatewaySessionSource, /applyToken\(""\)/);
});

test("execution target switching does not request a second password verification", () => {
  assert.doesNotMatch(executionSwitcherSource, /current-password|验证账户密码|requiresPassword/);
  assert.doesNotMatch(executionTargetsSource, /execution-target\/step-up|proof|password/);
  assert.match(executionTargetsSource, /"\/api\/execution-target\/select"/);
});

test("first-run onboarding uses the shared modal layer", () => {
  assert.match(onboardingSource, /from "@liveagent\/ui\/components\/ui\/dialog"/);
  assert.match(onboardingSource, /<Dialog open=\{open\}/);
  assert.match(onboardingSource, /<DialogContent/);
  assert.doesNotMatch(onboardingSource, /createPortal|role="dialog"|zIndex:/);
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
