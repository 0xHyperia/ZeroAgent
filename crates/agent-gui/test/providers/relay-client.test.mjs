import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
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
}

test("OAuth refresh and app resources use the desktop local proxy", async () => {
  const previousFetch = globalThis.fetch;
  const previousLocalStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const requests = [];
  const proxyCalls = [];

  globalThis.localStorage = createLocalStorage({
    "zeroagent.relay.refresh-token": "refresh-1",
    "zeroagent.relay.auth-kind": "oauth",
    "zeroagent.relay.oauth-client-id": "zeroagent-desktop",
  });
  globalThis.window = new EventTarget();
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/app-auth/token")) {
      return new Response(
        JSON.stringify({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ success: true, data: { id: 7, email: "user@example.com" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const loader = createTsModuleLoader({
      mocks: {
        "@liveagent/ui/lib/providers/proxy": {
          async prepareProxyRequest(providerId, upstreamBaseUrl, headers) {
            proxyCalls.push({ providerId, upstreamBaseUrl, headers });
            return {
              baseUrl: "http://127.0.0.1:4567/proxy/codex/api/v1",
              headers: { ...headers, "x-liveagent-proxy-token": "proxy-token" },
            };
          },
        },
        "./installation": { getInstallationID: () => "installation-1" },
      },
    });
    const client = loader.loadModule("src/lib/relay/client.ts");

    const user = await client.getRelayCurrentUser();
    await client.logoutRelay();

    assert.deepEqual(user, { id: 7, email: "user@example.com" });
    assert.equal(proxyCalls.length, 3);
    assert.deepEqual(
      requests.map((request) => request.url),
      [
        "http://127.0.0.1:4567/proxy/codex/api/v1/app-auth/token",
        "http://127.0.0.1:4567/proxy/codex/api/v1/app/me",
        "http://127.0.0.1:4567/proxy/codex/api/v1/app-auth/revoke",
      ],
    );
    assert.equal(requests.some((request) => request.url.startsWith("https://usa0.top")), false);
    assert.equal(requests[1].init.headers.Authorization, "Bearer access-2");
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.localStorage = previousLocalStorage;
    globalThis.window = previousWindow;
  }
});

test("expired access tokens refresh once across concurrent consumers", async () => {
  const previousFetch = globalThis.fetch;
  const previousLocalStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const values = new Map(
    Object.entries({
      "zeroagent.relay.access-token": "expired-access",
      "zeroagent.relay.refresh-token": "refresh-1",
      "zeroagent.relay.expires-at": String(Date.now() - 1),
      "zeroagent.relay.auth-kind": "oauth",
      "zeroagent.relay.oauth-client-id": "zeroagent-desktop",
    }),
  );
  globalThis.localStorage = createLocalStorage(Object.fromEntries(values));
  globalThis.window = new EventTarget();
  let refreshRequests = 0;
  globalThis.fetch = async () => {
    refreshRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({
      access_token: "refreshed-access",
      refresh_token: "refresh-2",
      expires_in: 3600,
    });
  };

  try {
    const loader = createTsModuleLoader({
      mocks: {
        "@liveagent/ui/lib/providers/proxy": {
          async prepareProxyRequest(_providerId, _baseUrl, headers) {
            return { baseUrl: "http://127.0.0.1:4567/proxy/codex/api/v1", headers };
          },
        },
        "./installation": { getInstallationID: () => "installation-1" },
      },
    });
    const client = loader.loadModule("src/lib/relay/client.ts");
    let tokenChanges = 0;
    window.addEventListener(client.RELAY_TOKEN_CHANGED_EVENT, () => {
      tokenChanges += 1;
    });

    const tokens = await Promise.all([
      client.getValidRelayAccessToken(),
      client.getValidRelayAccessToken(),
      client.getValidRelayAccessToken(),
    ]);

    assert.deepEqual(tokens, ["refreshed-access", "refreshed-access", "refreshed-access"]);
    assert.equal(refreshRequests, 1);
    assert.equal(tokenChanges, 1);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.localStorage = previousLocalStorage;
    globalThis.window = previousWindow;
  }
});

test("transient refresh failures preserve the stored session", async () => {
  const previousFetch = globalThis.fetch;
  const previousLocalStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const values = new Map(
    Object.entries({
      "zeroagent.relay.access-token": "expired-access",
      "zeroagent.relay.refresh-token": "refresh-1",
      "zeroagent.relay.expires-at": String(Date.now() - 1),
      "zeroagent.relay.auth-kind": "oauth",
    }),
  );
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  globalThis.window = new EventTarget();
  globalThis.fetch = async () => {
    throw new TypeError("network unavailable");
  };

  try {
    const loader = createTsModuleLoader({
      mocks: {
        "@liveagent/ui/lib/providers/proxy": {
          async prepareProxyRequest(_providerId, _baseUrl, headers) {
            return { baseUrl: "http://127.0.0.1:4567/proxy/codex/api/v1", headers };
          },
        },
        "./installation": { getInstallationID: () => "installation-1" },
      },
    });
    const client = loader.loadModule("src/lib/relay/client.ts");
    let sessionChanges = 0;
    window.addEventListener(client.RELAY_SESSION_CHANGED_EVENT, () => {
      sessionChanges += 1;
    });

    await assert.rejects(client.getValidRelayAccessToken(), /network unavailable/);
    assert.equal(values.get("zeroagent.relay.access-token"), "expired-access");
    assert.equal(values.get("zeroagent.relay.refresh-token"), "refresh-1");
    assert.equal(sessionChanges, 0);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.localStorage = previousLocalStorage;
    globalThis.window = previousWindow;
  }
});
