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
            if (command === "device_default_name") return "Desktop";
            if (command === "zeroagent_app_version") return "0.1.0";
            if (command === "device_credential_set") {
              credentialWrites.push(args.record);
              return undefined;
            }
            if (command === "gateway_nudge_connection") return true;
            throw new Error(`unexpected invoke: ${command}`);
          },
        },
        "../providers/proxy": {
          async prepareProxyRequest(providerId, upstreamBaseUrl, headers) {
            proxyCalls.push({ providerId, upstreamBaseUrl, headers });
            return {
              baseUrl: "http://127.0.0.1:4567/proxy/codex",
              headers: { ...headers, "x-liveagent-proxy-token": "proxy-token" },
            };
          },
        },
        "./client": { getRelayAccessToken: () => "usa-zero-access" },
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
      { agentId: "agent-local", token: "agt-registered", deviceId: "", credential: "" },
      { agentId: "agent-local", token: "agt-rotated", deviceId: "", credential: "" },
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
