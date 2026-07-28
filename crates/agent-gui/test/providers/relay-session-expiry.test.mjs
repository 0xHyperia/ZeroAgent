import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("failed desktop token refresh clears credentials and returns to the login gate", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;
  const values = new Map([
    ["liveagent.relay.access-token", "expired-access"],
    ["liveagent.relay.refresh-token", "expired-refresh"],
  ]);
  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  globalThis.window = new EventTarget();
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 401, message: "session expired" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  try {
    const proxyPath = fileURLToPath(
      new URL("../../src/lib/providers/proxy.ts", import.meta.url),
    );
    const loader = createTsModuleLoader({
      mocks: {
        [proxyPath]: {
          prepareProxyRequest: async (_providerId, baseUrl, headers) => ({ baseUrl, headers }),
        },
      },
    });
    const relay = loader.loadModule("src/lib/relay/client.ts");
    let sessionChanges = 0;
    window.addEventListener(relay.RELAY_SESSION_CHANGED_EVENT, () => {
      sessionChanges += 1;
    });

    await assert.rejects(relay.getRelayProfile(), (error) => error.status === 401);

    assert.equal(sessionChanges, 1);
    assert.equal(values.has("liveagent.relay.access-token"), false);
    assert.equal(values.has("liveagent.relay.refresh-token"), false);

    await assert.rejects(
      relay.loginRelay("wrong@example.com", "wrong-password"),
      (error) => error.status === 401,
    );
    assert.equal(sessionChanges, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("an HTML 401 response still clears the desktop session before its body is parsed", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const originalWindow = globalThis.window;
  const values = new Map([["liveagent.relay.access-token", "expired-access"]]);
  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  globalThis.window = new EventTarget();
  globalThis.fetch = async () => new Response("<h1>Unauthorized</h1>", { status: 401 });

  try {
    const proxyPath = fileURLToPath(
      new URL("../../src/lib/providers/proxy.ts", import.meta.url),
    );
    const loader = createTsModuleLoader({
      mocks: {
        [proxyPath]: {
          prepareProxyRequest: async (_providerId, baseUrl, headers) => ({ baseUrl, headers }),
        },
      },
    });
    const relay = loader.loadModule("src/lib/relay/client.ts");
    let sessionChanges = 0;
    window.addEventListener(relay.RELAY_SESSION_CHANGED_EVENT, () => {
      sessionChanges += 1;
    });

    await assert.rejects(relay.getRelayProfile(), (error) => error.status === 401);

    assert.equal(sessionChanges, 1);
    assert.equal(values.has("liveagent.relay.access-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
