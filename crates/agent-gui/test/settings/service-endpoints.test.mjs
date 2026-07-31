import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const viteConfig = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
const relayClient = readFileSync(
  new URL("../../src/lib/relay/client.ts", import.meta.url),
  "utf8",
);
const remoteSettings = readFileSync(
  new URL("../../src/lib/settings/index.ts", import.meta.url),
  "utf8",
);
const relayAccessGate = readFileSync(
  new URL("../../src/components/relay/RelayAccessGate.tsx", import.meta.url),
  "utf8",
);
const remoteSection = readFileSync(
  new URL("../../src/pages/settings/RemoteSection.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8");

test("service endpoints are independent from the frontend build mode", () => {
  assert.match(viteConfig, /env\.ZEROAGENT_USA_ZERO_ORIGIN/);
  assert.doesNotMatch(viteConfig, /__ZEROAGENT_USA_ZERO_ORIGIN_CONFIGURED__/);
  assert.doesNotMatch(viteConfig, /__ZEROAGENT_DEVELOPMENT__/);
  assert.doesNotMatch(relayClient, /RELAY_DEBUG_CONTROLS_ENABLED/);
  assert.doesNotMatch(remoteSettings, /REMOTE_DEBUG_CONTROLS_ENABLED/);
  assert.doesNotMatch(remoteSettings, /__ZEROAGENT_DEVELOPMENT__/);
});

test("USA-Zero uses only the startup address", () => {
  const previousOrigin = globalThis.__ZEROAGENT_USA_ZERO_ORIGIN__;
  globalThis.__ZEROAGENT_USA_ZERO_ORIGIN__ = "https://startup.example.com";

  try {
    const relay = createTsModuleLoader().loadModule("src/lib/relay/client.ts");
    assert.equal(relay.RELAY_ORIGIN, "https://startup.example.com");
  } finally {
    if (previousOrigin === undefined) delete globalThis.__ZEROAGENT_USA_ZERO_ORIGIN__;
    else globalThis.__ZEROAGENT_USA_ZERO_ORIGIN__ = previousOrigin;
  }
});

test("service endpoint controls are not rendered or persisted by the frontend", () => {
  assert.doesNotMatch(relayClient, /RELAY_ORIGIN_KEY|configureRelayOrigin/);
  assert.doesNotMatch(relayAccessGate, /relay-origin|USA-零服务地址/);
  assert.doesNotMatch(
    remoteSection,
    /remote-gateway-url|remoteGatewayPortDraft|gatewayEndpointPreview/,
  );
});

test("remote access switch is authoritative over stale runtime status", () => {
  assert.match(
    remoteSection,
    /settings\.remote\.enabled\s*&&\s*status\.enabled\s*&&\s*Boolean\(status\.online\)/,
  );
  assert.match(app, /prev\.remote\.enabled\s*&&\s*!next\.remote\.enabled/);
  assert.match(app, /invoke\("gateway_disconnect"\)/);
});
