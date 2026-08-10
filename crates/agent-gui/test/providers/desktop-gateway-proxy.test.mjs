import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const settings = {
  remote: {
    enabled: true,
    gatewayUrl: "https://agent.usa0.top",
    gatewayPort: 443,
    agentId: "agent-configured",
  },
};

test("desktop Gateway APIs preserve query parameters and use the local proxy", async () => {
  const previousFetch = globalThis.fetch;
  const previousNavigator = globalThis.navigator;
  const requests = [];
  const proxyCalls = [];
  const credentialWrites = [];
  const credentialActivations = [];

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { platform: "Win32" },
  });
  globalThis.fetch = async (url, init) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, init });
    if (requestUrl.includes("/environments?")) {
      return Response.json({ environments: [] });
    }
    if (requestUrl.includes("/conversation-routes?")) {
      return Response.json({ conversations: [] });
    }
    if (requestUrl.endsWith("/devices/register")) {
      return Response.json({
        device: { id: "agent-local", agent_id: "agent-local" },
        agent_id: "agent-local",
        agent_token: "agt-registered",
      });
    }
    if (requestUrl.endsWith("/devices/agent-local/rotate-token")) {
      return Response.json({ agent_id: "agent-local", agent_token: "agt-rotated" });
    }
    throw new Error(`unexpected request: ${requestUrl}`);
  };

  try {
    const loader = createTsModuleLoader({
      mocks: {
        "@tauri-apps/api/core": {
          async invoke(command, args) {
            if (command === "device_credential_get") {
              return { agentId: "agent-local", token: "agt-existing" };
            }
            if (command === "device_credential_activate") {
              credentialActivations.push(args.accountScope);
              return undefined;
            }
            if (command === "device_default_name") return "Desktop";
            if (command === "zeroagent_app_version") return "0.1.0";
            if (command === "device_credential_set") {
              credentialWrites.push(args);
              return undefined;
            }
            if (command === "gateway_nudge_connection") return true;
            throw new Error(`unexpected invoke: ${command}`);
          },
        },
        "@liveagent/ui/lib/providers/proxy": {
          async prepareProxyRequest(providerId, upstreamBaseUrl, headers) {
            proxyCalls.push({ providerId, upstreamBaseUrl, headers });
            return {
              baseUrl: "http://127.0.0.1:4567/proxy/codex",
              headers: { ...headers, "x-liveagent-proxy-token": "proxy-token" },
            };
          },
        },
        "./client": {
          RELAY_ORIGIN: "https://usa0.top",
          getValidRelayAccessToken: async () => "usa-zero-access",
          getRelayCurrentUser: async () => ({ id: 42 }),
        },
        "./installation": { getInstallationID: () => "installation-local" },
      },
    });
    const execution = loader.loadModule("src/lib/relay/desktopExecution.ts");
    const registration = loader.loadModule("src/lib/relay/deviceRegistration.ts");

    await execution.getDesktopEnvironments(settings);
    await execution.getDesktopConversationRoutes(settings, "agent-remote");
    await registration.registerDesktopDevice(settings);
    await registration.rotateDesktopAgentToken(settings, "agent-local");

    assert.deepEqual(
      requests.map((request) => request.url),
      [
        "http://127.0.0.1:4567/proxy/codex/api/desktop/environments?local_agent_id=agent-local&local_device_id=agent-local",
        "http://127.0.0.1:4567/proxy/codex/api/desktop/conversation-routes?device_id=agent-remote",
        "http://127.0.0.1:4567/proxy/codex/api/desktop/devices/register",
        "http://127.0.0.1:4567/proxy/codex/api/desktop/devices/agent-local/rotate-token",
      ],
    );
    assert.equal(requests.some((request) => request.url.includes("%3F")), false);
    assert.equal(requests.some((request) => request.url.startsWith("https://agent.usa0.top")), false);
    assert.equal(proxyCalls.length, 4);
    assert.equal(proxyCalls.every((call) => call.upstreamBaseUrl === "https://agent.usa0.top/"), true);
    assert.equal(
      proxyCalls.every((call) => call.headers.Authorization === "Bearer usa-zero-access"),
      true,
    );
    assert.deepEqual(credentialWrites, [
      {
        accountScope: "https://usa0.top|user:42",
        record: { agentId: "agent-local", token: "agt-registered", deviceId: "", credential: "" },
      },
      {
        accountScope: "https://usa0.top|user:42",
        record: { agentId: "agent-local", token: "agt-rotated", deviceId: "", credential: "" },
      },
    ]);
    assert.deepEqual(credentialActivations, [
      "https://usa0.top|user:42",
      "https://usa0.top|user:42",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousNavigator === undefined) {
      delete globalThis.navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: previousNavigator,
      });
    }
  }
});

test("a different account receives a new device identity on the same desktop", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  const writes = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({
      device: { id: "agent-for-second-account", agent_id: "agent-for-second-account" },
      agent_id: "agent-for-second-account",
      agent_token: "agt-second-account",
    });
  };

  try {
    const loader = createTsModuleLoader({
      mocks: {
        "@tauri-apps/api/core": {
          async invoke(command, args) {
            if (command === "device_credential_get") return null;
            if (command === "device_credential_activate") return undefined;
            if (command === "device_default_name") return "Desktop";
            if (command === "zeroagent_app_version") return "0.1.0";
            if (command === "device_credential_set") {
              writes.push(args);
              return undefined;
            }
            if (command === "gateway_nudge_connection") return true;
            throw new Error(`unexpected invoke: ${command}`);
          },
        },
        "@liveagent/ui/lib/providers/proxy": {
          async prepareProxyRequest(_providerId, _upstreamBaseUrl, headers) {
            return { baseUrl: "http://127.0.0.1:4567/proxy/codex", headers };
          },
        },
        "./client": {
          RELAY_ORIGIN: "https://usa0.top",
          getValidRelayAccessToken: async () => "usa-zero-access",
          getRelayCurrentUser: async () => ({ id: 99 }),
        },
        "./installation": { getInstallationID: () => "installation-local" },
      },
    });
    const registration = loader.loadModule("src/lib/relay/deviceRegistration.ts");

    await registration.registerDesktopDevice(settings);

    const payload = JSON.parse(requests[0].init.body);
    assert.equal(payload.agent_id, "");
    assert.equal(payload.agent_token, "");
    assert.deepEqual(writes, [
      {
        accountScope: "https://usa0.top|user:99",
        record: {
          agentId: "agent-for-second-account",
          token: "agt-second-account",
          deviceId: "",
          credential: "",
        },
      },
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("desktop Gateway requests force one token refresh after a 401", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  let attempt = 0;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    attempt += 1;
    if (attempt === 1) return Response.json({ error: "expired" }, { status: 401 });
    return Response.json({ environments: [] });
  };
  const tokenRequests = [];

  try {
    const loader = createTsModuleLoader({
      mocks: {
        "@tauri-apps/api/core": {
          async invoke(command) {
            if (command === "device_credential_get") return { agentId: "agent-local" };
            throw new Error(`unexpected invoke: ${command}`);
          },
        },
        "@liveagent/ui/lib/providers/proxy": {
          async prepareProxyRequest(_providerId, _baseUrl, headers) {
            return { baseUrl: "http://127.0.0.1:4567/proxy/codex", headers };
          },
        },
        "./client": {
          async getValidRelayAccessToken(forceRefresh) {
            tokenRequests.push(forceRefresh);
            return forceRefresh ? "refreshed-access" : "expired-access";
          },
        },
      },
    });
    const execution = loader.loadModule("src/lib/relay/desktopExecution.ts");
    await execution.getDesktopEnvironments(settings);

    assert.deepEqual(tokenRequests, [false, false, true]);
    assert.deepEqual(
      requests.map((request) => request.init.headers.Authorization),
      ["Bearer expired-access", "Bearer refreshed-access"],
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});
