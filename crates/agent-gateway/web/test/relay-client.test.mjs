import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

test("multi-group key creation is sequential and preserves group names", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map([["zeroagent.relay.access-token", "relay-token"]]);
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const requests = [];

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
  globalThis.fetch = async (url, init) => {
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    const body = JSON.parse(init.body);
    requests.push({ body, url: String(url) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeRequests -= 1;
    return new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: {
          id: body.group_id,
          key: `sk-${body.group_id}`,
          name: body.name,
          group_id: body.group_id,
          status: "active",
          quota: 0,
          quota_used: 0,
          created_at: "2026-07-20T00:00:00Z",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const loader = createTsModuleLoader({
      rootDir: fileURLToPath(new URL("..", import.meta.url)),
      mocks: {
        "@/lib/storage": { loadToken: () => "gateway-token" },
      },
    });
    const relay = loader.loadModule("src/lib/relay/client.ts");
    const groups = [
      { id: 1, name: "Claude 组", platform: "anthropic", rate_multiplier: 1, status: "active" },
      { id: 2, name: "Codex 组", platform: "openai", rate_multiplier: 1, status: "active" },
    ];

    const created = await relay.createRelayApiKeys("ZeroAgent", [1, 2], groups);

    assert.equal(maximumActiveRequests, 1);
    assert.deepEqual(
      requests.map((request) => request.body),
      [
        { name: "ZeroAgent / Claude 组", group_id: 1 },
        { name: "ZeroAgent / Codex 组", group_id: 2 },
      ],
    );
    assert.deepEqual(
      Array.from(created, (key) => key.key),
      ["sk-1", "sk-2"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  }
});

test("account APIs use the Gateway relay proxy with authenticated payloads", async () => {
  const originalFetch = globalThis.fetch;
  const originalLocalStorage = globalThis.localStorage;
  const values = new Map([["zeroagent.relay.access-token", "relay-token"]]);
  const requests = [];

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
  globalThis.fetch = async (url, init) => {
    requests.push({
      url: String(url),
      method: init.method,
      headers: init.headers,
      credentials: init.credentials,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return new Response(
      JSON.stringify({
        code: 0,
        message: "success",
        data: String(url).endsWith("/usage/dashboard/stats")
          ? { today_tokens: 12345 }
          : { id: 7, email: "new@example.com", username: "Zero", balance: 9.5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const loader = createTsModuleLoader({
      rootDir: fileURLToPath(new URL("..", import.meta.url)),
      mocks: {
        "@/lib/storage": { loadToken: () => "gateway-token" },
      },
    });
    const relay = loader.loadModule("src/lib/relay/client.ts");

    await relay.getRelayProfile();
    const stats = await relay.getRelayDashboardStats();
    await relay.updateRelayProfile({ username: "Zero" });
    await relay.sendRelayEmailBindingCode(" new@example.com ");
    await relay.bindRelayEmail(" new@example.com ", " 123456 ", "secret" );
    await relay.changeRelayPassword("old-secret", "new-secret");

    assert.equal(stats.today_tokens, 12345);
    assert.deepEqual(
      requests.map(({ url, method, body }) => ({ url, method, body })),
      [
        { url: "/api/usa-zero/user/profile", method: "GET", body: undefined },
        { url: "/api/usa-zero/usage/dashboard/stats", method: "GET", body: undefined },
        { url: "/api/usa-zero/user", method: "PUT", body: { username: "Zero" } },
        { url: "/api/usa-zero/user/account-bindings/email/send-code", method: "POST", body: { email: "new@example.com" } },
        { url: "/api/usa-zero/user/account-bindings/email", method: "POST", body: { email: "new@example.com", verify_code: "123456", password: "secret" } },
        { url: "/api/usa-zero/user/password", method: "PUT", body: { old_password: "old-secret", new_password: "new-secret" } },
      ],
    );
    for (const request of requests) {
      assert.equal(request.headers.Authorization, undefined);
      assert.equal(request.headers["X-USA-Zero-Authorization"], undefined);
      assert.equal(request.credentials, "include");
    }
    assert.equal(relay.formatRelayBalance(9.5), "$9.50");
    assert.equal(relay.formatRelayBalance(undefined), "--");
    assert.notEqual(relay.formatRelayTokenCount(12345), "--");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalLocalStorage;
  }
});

test("provider model refresh uses the Gateway session and key ID without exposing the key", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ models: { data: [{ id: "gpt-5.2" }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const loader = createTsModuleLoader({
      rootDir: fileURLToPath(new URL("..", import.meta.url)),
      mocks: {
        "@/lib/storage": { loadToken: () => "" },
      },
    });
    const relay = loader.loadModule("src/lib/relay/client.ts");
    const models = await relay.getRelayProviderModels(41);

    assert.deepEqual(models, { data: [{ id: "gpt-5.2" }] });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/web-chat/provider-keys/41/models");
    assert.equal(requests[0].init.method, "GET");
    assert.equal(requests[0].init.credentials, "include");
    assert.equal(requests[0].init.headers.Authorization, undefined);
    assert.equal(requests[0].init.body, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated 401 expires the web session but invalid login credentials do not", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  globalThis.fetch = async (url) =>
    new Response(JSON.stringify({ error: `unauthorized: ${String(url)}` }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });

  try {
    const loader = createTsModuleLoader({
      rootDir: fileURLToPath(new URL("..", import.meta.url)),
      mocks: {
        "@/lib/storage": { loadToken: () => "" },
      },
    });
    const relay = loader.loadModule("src/lib/relay/client.ts");
    let expirations = 0;
    window.addEventListener(relay.RELAY_SESSION_EXPIRED_EVENT, () => {
      expirations += 1;
    });

    await assert.rejects(relay.getRelayCurrentUser(), (error) => error.status === 401);
    assert.equal(expirations, 1);

    await assert.rejects(
      relay.loginRelay("wrong@example.com", "wrong-password"),
      (error) => error.status === 401,
    );
    assert.equal(expirations, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("login waits for logout's response and Android secure storage cleanup", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  let completeLogout;
  let completeCleanup;
  const logoutResponse = new Promise((resolve) => { completeLogout = resolve; });
  const cleanup = new Promise((resolve) => { completeCleanup = resolve; });
  const requests = [];
  let cleanupStarted = false;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).endsWith("/logout")) return logoutResponse;
    return Response.json({ user: { id: 2, email: "b@example.test" } });
  };
  const loader = createTsModuleLoader({
    rootDir: fileURLToPath(new URL("..", import.meta.url)),
    mocks: {
      [fileURLToPath(new URL("../src/lib/mobileRuntime.ts", import.meta.url))]: {
        isEmbeddedMobileRuntime: () => true,
        clearEmbeddedMobileGatewaySession: () => { cleanupStarted = true; return cleanup; },
      },
    },
  });
  const relay = loader.loadModule("src/lib/relay/client.ts");
  const logout = relay.logoutRelay();
  const login = relay.loginRelay("b@example.test", "fixture");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ["/api/auth/logout"]);
  completeLogout(new Response(null, { status: 204 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupStarted, true);
  assert.deepEqual(requests, ["/api/auth/logout"]);
  completeCleanup();
  await logout;
  assert.equal((await login).user.id, 2);
  assert.deepEqual(requests, ["/api/auth/logout", "/api/auth/login"]);
});

test("a failed login does not block a subsequent session change", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let attempts = 0;
  globalThis.fetch = async () => ++attempts === 1
    ? Response.json({ error: "invalid credentials" }, { status: 401 })
    : Response.json({ user: { id: 2 } });
  const loader = createTsModuleLoader({rootDir: fileURLToPath(new URL("..", import.meta.url))});
  const relay = loader.loadModule("src/lib/relay/client.ts");
  const first = relay.loginRelay("a@example.test", "wrong");
  const second = relay.loginRelay("b@example.test", "fixture");
  await assert.rejects(first, (error) => error.status === 401);
  assert.equal((await second).user.id, 2);
  assert.equal(attempts, 2);
});

test("independent tabs serialize cookie mutations through the browser lock", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else delete globalThis.navigator;
  });
  globalThis.window = new EventTarget();
  let tail = Promise.resolve();
  const locks = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: (name, action) => {
    locks.push(name);
    const pending = tail.then(action, action);
    tail = pending.catch(() => undefined);
    return pending;
  } } } });
  let finishLogout;
  const logoutResponse = new Promise((resolve) => { finishLogout = resolve; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ path: String(url), headers: new Headers(init.headers) });
    return String(url).endsWith("/logout") ? logoutResponse : Response.json({ user: { id: 2 } });
  };
  const first = createTsModuleLoader({rootDir: fileURLToPath(new URL("..", import.meta.url))});
  const second = createTsModuleLoader({rootDir: fileURLToPath(new URL("..", import.meta.url))});
  const owner = first.loadModule("src/lib/accountRequest.ts");
  owner.bindAccountRequests(1);
  const logout = first.loadModule("src/lib/relay/client.ts").logoutRelay();
  owner.bindAccountRequests(null);
  const login = second.loadModule("src/lib/relay/client.ts").loginRelay("b@example.test", "fixture");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.map((request) => request.path), ["/api/auth/logout"]);
  assert.equal(requests[0].headers.get(owner.ACCOUNT_OWNER_HEADER), "1");
  finishLogout(new Response(null, { status: 204 }));
  await logout;
  assert.equal((await login).user.id, 2);
  assert.deepEqual(requests.map((request) => request.path), ["/api/auth/logout", "/api/auth/login"]);
  assert.deepEqual(locks, ["zeroagent:account-cookie", "zeroagent:account-cookie"]);
});

test("only cookie mutations notify other tabs, using a nonce without account data", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else delete globalThis.localStorage;
  });
  globalThis.window = new EventTarget();
  const notices = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { setItem: (key, value) => notices.push({ key, value }) } });
  globalThis.fetch = async (url) => String(url).endsWith("/logout")
    ? new Response(null, { status: 204 }) : Response.json({ user: { id: 1, email: "a@example.test" } });
  const loader = createTsModuleLoader({rootDir: fileURLToPath(new URL("..", import.meta.url))});
  const relay = loader.loadModule("src/lib/relay/client.ts");
  const api = loader.loadModule("src/lib/accountRequest.ts");
  await relay.getRelayCurrentUser();
  assert.equal(notices.length, 0);
  await relay.loginRelay("a@example.test", "fixture-password");
  await relay.getRelayCurrentUser();
  assert.equal(notices.length, 1);
  await relay.logoutRelay();
  assert.equal(notices.length, 2);
  assert.ok(notices.every((notice) => notice.key === api.ACCOUNT_SESSION_STORAGE_KEY));
  assert.notEqual(notices[0].value, notices[1].value);
  assert.doesNotMatch(JSON.stringify(notices), /a@example|fixture-password|access_token|refresh_token/);
});
