import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../../agent-gateway/test/helpers/dom-test-env.mjs";
import { createWebModuleLoader } from "../../../agent-gateway/test/helpers/load-web-module.mjs";
import { createGatewayV2Codec } from "../../../agent-gateway/test/helpers/gateway-v2.mjs";
import { createDesktopRemoteGatewayFixture } from "./fixtures/desktop-remote-gateway-fixture.mjs";

const NativeEvent = globalThis.Event;
const NativeWebSocket = globalThis.WebSocket;

test("model changes and terminal creation survive target presence transitions over the real binary client", { timeout: 20_000 }, async (t) => {
  let transitions = 0;
  const server = await createDesktopRemoteGatewayFixture(createGatewayV2Codec(createWebModuleLoader()), {
    onRequest(decoded, reply, peer) {
      const request = decoded.json.agent_request;
      if (!request?.settings_update && request?.terminal_request?.action !== "create") return false;
      peer.send({ agent_id: peer.agent, status: { agent_id: peer.agent, online: false } });
      transitions++;
      setTimeout(() => {
        peer.send({ agent_id: peer.agent, status: { agent_id: peer.agent, online: true, agent_ready: true } });
        if (request.settings_update) {
          const update = JSON.parse(request.settings_update.settings_json);
          assert.equal(update.configurationVersion, "version-device-a-1");
          assert.deepEqual(update.customProviders[0].enabledModels, ["next-model"]);
          assert.ok(update.customProviders[0].models.some((model) => model.id === "next-model"));
          reply({ agent_response: { settings_update_resp: { accepted: true } } });
        } else {
          assert.equal(request.terminal_request.cwd, "/synthetic-project");
          reply({ agent_response: { terminal_response: { action: "create", session: {
            id: "synthetic-terminal", cwd: "/synthetic-project", title: "Terminal", shell: "synthetic", project_path_key: "/synthetic-project",
          } } } });
        }
      }, 30);
      return true;
    },
  });
  t.after(() => server.close());
  const env = await createWebDomTestEnv();
  // Undici's WebSocket EventTarget requires its native Event constructor.
  globalThis.Event = NativeEvent;
  env.dom.window.WebSocket = NativeWebSocket;
  const dispatch = env.dom.window.EventTarget.prototype.dispatchEvent;
  env.dom.window.EventTarget.prototype.dispatchEvent = function (event) {
    return dispatch.call(this, event instanceof env.dom.window.Event ? event : new env.dom.window.Event(event.type));
  };
  const { installDesktopRemoteHost } = env.loadModule("src/lib/desktopRemoteHost.ts");
  const { useGatewaySession } = env.loadModule("src/app/hooks/useGatewaySession.ts");
  const { useGatewayClients } = env.loadModule("src/app/hooks/useGatewayClients.ts");
  const invalid = [];
  const environment = { runtime_kind: "device_agent", device_id: "device-a", agent_id: "device-a", name: "A", online: true, workspaces: [] };
  const release = installDesktopRemoteHost({
    sessionHandle: "opaque-native-session", accountScope: "synthetic-account", gatewayOrigin: server.origin,
    accountUser: { id: 7, email: "synthetic@example.invalid", status: "active" }, environment, environments: [environment],
    selection: { runtime_kind: "device_agent", device_id: "device-a", agent_id: "device-a", selection_lease: "lease-device-a", workspace_id: "", scope: "device", expires_at: new Date(Date.now() + 60_000).toISOString() },
    isCurrent: () => true, request: () => assert.fail("unexpected HTTP call"), onSelectionInvalid: (reason) => invalid.push(reason),
  });
  let current;
  function Probe() {
    const session = useGatewaySession(null);
    const clients = useGatewayClients(session.token);
    current = { session, ...clients };
    env.React.useEffect(() => clients.api?.subscribeAgents(session.applyExecutionPresence), [clients.api, session.applyExecutionPresence]);
    return env.React.createElement("div", null, session.token ? "active" : "blocked");
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  t.after(async () => { await env.act(async () => root.unmount()); release(); container.remove(); env.cleanup(); });
  await env.act(async () => root.render(env.React.createElement(Probe)));
  const original = current.api;
  const token = current.session.token;
  await env.act(async () => { await current.api.listAgents(); });
  const settings = await current.api.getSettings();
  await env.act(async () => {
    await current.api.updateSettings({ ...settings, customProviders: [{ ...settings.customProviders[0], models: [...settings.customProviders[0].models, { id: "next-model", contextWindow: 32000, maxOutputTokens: 512 }], enabledModels: ["next-model"] }] });
  });
  let terminal;
  await env.act(async () => { terminal = await current.terminalClient.create({ cwd: "/synthetic-project", projectPathKey: "/synthetic-project" }); });
  assert.equal(terminal.session.id, "synthetic-terminal");
  assert.equal(transitions, 2);
  assert.equal(current.api, original, "the operation must retain its client and pending requests");
  assert.equal(current.session.token, token);
  assert.equal(current.session.environments[0].online, true);
  assert.deepEqual(invalid, []);
  assert.equal(container.textContent, "active");
  server.assertHealthy();
  const hellos = server.frames.filter((frame) => frame.case === "hello");
  assert.equal(hellos.length, 1, "presence transitions do not create a new handoff or connection");
});
