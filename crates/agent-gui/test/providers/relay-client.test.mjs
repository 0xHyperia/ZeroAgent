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
        "../providers/proxy": {
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
