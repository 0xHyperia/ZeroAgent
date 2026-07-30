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

test("service endpoints are independent from the frontend build mode", () => {
  assert.match(viteConfig, /env\.ZEROAGENT_USA_ZERO_ORIGIN/);
  assert.match(viteConfig, /__ZEROAGENT_USA_ZERO_ORIGIN_CONFIGURED__/);
  assert.doesNotMatch(viteConfig, /__ZEROAGENT_DEVELOPMENT__/);
  assert.doesNotMatch(relayClient, /RELAY_DEBUG_CONTROLS_ENABLED/);
  assert.doesNotMatch(remoteSettings, /REMOTE_DEBUG_CONTROLS_ENABLED/);
  assert.doesNotMatch(remoteSettings, /__ZEROAGENT_DEVELOPMENT__/);
});

test("an explicit USA-Zero startup address overrides the stored address", () => {
  const previousLocalStorage = globalThis.localStorage;
  const previousOrigin = globalThis.__ZEROAGENT_USA_ZERO_ORIGIN__;
  const previousConfigured = globalThis.__ZEROAGENT_USA_ZERO_ORIGIN_CONFIGURED__;
  globalThis.localStorage = {
    getItem: () => "https://stored.example.com",
    setItem() {},
    removeItem() {},
  };
  globalThis.__ZEROAGENT_USA_ZERO_ORIGIN__ = "https://startup.example.com";
  globalThis.__ZEROAGENT_USA_ZERO_ORIGIN_CONFIGURED__ = true;

  try {
    const relay = createTsModuleLoader().loadModule("src/lib/relay/client.ts");
    assert.equal(relay.RELAY_ORIGIN, "https://startup.example.com");
  } finally {
    globalThis.localStorage = previousLocalStorage;
    if (previousOrigin === undefined) delete globalThis.__ZEROAGENT_USA_ZERO_ORIGIN__;
    else globalThis.__ZEROAGENT_USA_ZERO_ORIGIN__ = previousOrigin;
    if (previousConfigured === undefined) {
      delete globalThis.__ZEROAGENT_USA_ZERO_ORIGIN_CONFIGURED__;
    } else {
      globalThis.__ZEROAGENT_USA_ZERO_ORIGIN_CONFIGURED__ = previousConfigured;
    }
  }
});
