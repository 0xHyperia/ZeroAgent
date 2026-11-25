import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

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
const desktopAppSource = readFileSync(new URL("../../../agent-gui/src/App.tsx", import.meta.url), "utf8");
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

test("first-run onboarding follows the interface locale through group selection and completion", async (t) => {
  const env = await createWebDomTestEnv();
  const { React, act, createRoot } = env;
  const { FirstRunOnboarding } = env.loadModule("src/components/onboarding/FirstRunOnboarding.tsx");
  const { LocaleContext, t: translate } = env.loadModule("@liveagent/ui/i18n/index.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); env.cleanup(); });

  const group = { id: 5, name: "本地模型组", status: "active", platform: "openai", rate_multiplier: 1 };
  const created = [];
  const dataSource = {
    listApiKeys: async () => created.length ? [{ key: "fixture", status: "active", group_id: group.id }] : [],
    listGroups: async () => [group],
    createApiKeys: async (name, ids) => { created.push([name, ids]); },
    supportsPlatform: () => true,
  };
  const render = (locale) => act(async () => root.render(React.createElement(
    LocaleContext.Provider,
    { value: { locale, t: (key) => translate(key, locale) } },
    React.createElement(FirstRunOnboarding, { userId: 9, dataSource, onSyncKeys: async () => {} }),
  )));
  const dialog = () => document.querySelector('[role="dialog"]');
  const clickText = (text) => act(async () => {
    const action = [...dialog().querySelectorAll("button")].find((button) => button.textContent.trim() === text);
    assert.ok(action, text);
    action.click();
  });

  await render("en-US");
  assert.match(dialog().textContent, /Get started with ZeroAgent.*Account connected/);
  assert.ok(dialog().querySelector('[aria-label="Skip onboarding"]'));
  await clickText("Continue");
  assert.match(dialog().textContent, /Create your first group key.*Key name.*Model groups/);
  const groups = () => dialog().querySelector("#onboarding-key-groups");
  assert.match(groups().textContent, /1 group selected/);
  await act(async () => groups().click());
  assert.match(dialog().querySelector('[role="option"]').textContent, /本地模型组/);
  await act(async () => dialog().querySelector('[role="option"]').click());
  assert.match(groups().textContent, /Select one or more groups/);
  await act(async () => dialog().querySelector('[role="option"]').click());
  await clickText("Create and sync");
  assert.match(dialog().textContent, /Setup complete/);
  assert.deepEqual(created, [["ZeroAgent", [5]]]);
  await render("zh-CN");
  assert.match(dialog().textContent, /设置完成/);
  assert.ok(dialog().querySelector('[aria-label="跳过引导"]'));
});

test("desktop setup uses the signed-in local host settings without provisioning keys", () => {
  assert.match(desktopAppSource, /setupGuideAvailable = localExecutionSelected && !cloudSelected && isTauriHost\(\)/);
  assert.match(desktopAppSource, /<FirstRunOnboarding[\s\S]*?userId=\{relayUser\.id\}/);
  assert.match(desktopAppSource, /onConfigureModels=\{\(\) => openSettings\("providers"\)\}/);
  assert.match(desktopOnboardingSource, /await onChooseProject\(\)/);
  assert.doesNotMatch(desktopOnboardingSource, /lib\/relay\/client|RelayApiKey|agent-gateway\/web/);
});

test("expired web sessions clear the complete cached application state", () => {
  assert.match(
    gatewayAppSource,
    /const expired = \(\) => handleLogout\(false\)/,
  );
  assert.match(gatewayAppSource, /addEventListener\(RELAY_SESSION_EXPIRED_EVENT, expired\)/);
  assert.match(gatewayAppSource, /clearSession\(revokeRemotely\)/);
  assert.match(gatewayAppSource, /addEventListener\(ACCOUNT_CHANGED_EVENT, changed\)/);
  assert.match(gatewayAppSource, /addEventListener\("storage", cookieChanged\)/);
  assert.match(cloudChatSource, /response\.status === 401\) notifyRelaySessionExpired\(\)/);
});

test("session restoration renders a neutral loading surface before the login page", () => {
  const entrySource = readFileSync(new URL("../src/app/GatewaySessionEntry.tsx", import.meta.url), "utf8");
  assert.match(entrySource, /GatewayStartupStatus label="正在恢复登录状态"/);
  assert.match(
    entrySource,
    /if \(session\.authInitializing\) \{[\s\S]*?if \(!session\.accountUser\) \{/,
  );
});
