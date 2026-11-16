// Explicit post-build probe: mounts the shipped complete WebUI bundle in a real
// JSDOM/React DOM with loopback binary Gateway traffic. No desktop UI automation,
// user account or paid model is used. This file is intentionally not *.test.mjs.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createWebModuleLoader } from "../../../../agent-gateway/test/helpers/load-web-module.mjs";
import { createGatewayV2Codec } from "../../../../agent-gateway/test/helpers/gateway-v2.mjs";
import { createDesktopRemoteGatewayFixture } from "./desktop-remote-gateway-fixture.mjs";

const guiRequire = createRequire(new URL("../../../package.json", import.meta.url));
const NativeWebSocket = globalThis.WebSocket;

async function waitFor(predicate, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function installDom(t) {
  const { JSDOM } = guiRequire("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='remote-root'></div></body></html>", {
    url: "http://desktop-shell.invalid/", pretendToBeVisual: true,
  });
  const { window } = dom;
  window.scrollTo = () => {};
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return true; } });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.scrollTo = () => {};
  window.HTMLElement.prototype.scrollBy = () => {};
  const elementRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function rectangle() {
    // JSDOM has no layout; give the real canvas one explicit viewport so its
    // normal geometry reducer mounts conversation panes instead of hiding them.
    return this.hasAttribute("data-workbench-canvas") ? new window.DOMRect(0, 48, 1000, 750) : elementRect.call(this);
  };
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.releasePointerCapture = () => {};
  window.HTMLElement.prototype.getAnimations = () => [];
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.WebSocket = NativeWebSocket;
  // Node's real WebSocket dispatches Node Event instances. Keep its global
  // Event constructor intact and adapt only events entering the DOM realm.
  const dispatchDomEvent = window.EventTarget.prototype.dispatchEvent;
  window.EventTarget.prototype.dispatchEvent = function dispatch(event) {
    return dispatchDomEvent.call(this, event instanceof window.Event ? event : new window.Event(event.type, { bubbles: event.bubbles, cancelable: event.cancelable }));
  };
  Object.defineProperty(window.document, "fonts", { value: { ready: Promise.resolve(), addEventListener() {}, removeEventListener() {} } });
  const installed = { window, self: window, document: window.document, navigator: window.navigator, localStorage: window.localStorage, sessionStorage: window.sessionStorage, location: window.location, getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), ResizeObserver: window.ResizeObserver, IntersectionObserver: window.IntersectionObserver, WebSocket: NativeWebSocket, IS_REACT_ACT_ENVIRONMENT: false };
  for (const key of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "HTMLFormElement", "Element", "Node", "CustomEvent", "MouseEvent", "PointerEvent", "KeyboardEvent", "SVGElement", "DocumentFragment", "MutationObserver", "FileReader", "Image", "DOMParser", "DOMRect", "DOMRectReadOnly", "Range", "Document", "ShadowRoot"]) installed[key] = window[key] ?? window.MouseEvent;
  const previous = new Map();
  for (const [key, value] of Object.entries(installed)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    window.close();
  });
  return dom;
}

test("the actual desktop remote bundle mounts the complete shared WebUI and disposes one device before mounting another", { timeout: 45_000 }, async (t) => {
  const dom = installDom(t);
  dom.window.document.documentElement.setAttribute("class", "native-shell-theme");
  dom.window.document.documentElement.setAttribute("style", "--native-shell-test: 1;");
  dom.window.document.documentElement.setAttribute("lang", "zh-CN");
  dom.window.document.title = "Native ZeroAgent";
  const nativeAttributes = ["class", "style", "lang"].map((name) => [name, dom.window.document.documentElement.getAttribute(name)]);
  const loader = createWebModuleLoader();
  const codec = createGatewayV2Codec(loader);
  const unsupported = [];
  const server = await createDesktopRemoteGatewayFixture(codec, { onRequest(decoded, reply) {
    const body = decoded.json;
    if (decoded.case === "chatActivities") { reply({ chat_activities: { running_conversations: [] } }); return true; }
    if (["workspaceSubscribe", "workspaceUnsubscribe"].includes(decoded.case)) { reply({ ack: { ok: true } }); return true; }
    const env = body.agent_request;
    if (!env) return false;
    if (env.history_list) { reply({ agent_response: { history_list_resp: { conversations: [], total_count: 0 } } }); return true; }
    if (env.history_workdirs) { reply({ agent_response: { history_workdirs_resp: { workdirs: [] } } }); return true; }
    if (env.provider_list) { reply({ agent_response: { provider_list_resp: { providers_json: "[]" } } }); return true; }
    if (env.slash_command_list) { reply({ agent_response: { slash_command_list_resp: { commands: [] } } }); return true; }
    if (env.prompt_template_list) { reply({ agent_response: { prompt_template_list_resp: { templates: [] } } }); return true; }
    if (env.skill_files_list) { reply({ agent_response: { skill_files_list_resp: { root_dir: "synthetic-skills", paths: [] } } }); return true; }
    if (env.cron_manage) { reply({ agent_response: { cron_manage_resp: { action: env.cron_manage.action, result_json: "[]" } } }); return true; }
    if (env.git_request) { reply({ agent_response: { git_response: { action: env.git_request.action, result_json: JSON.stringify({ isGitRepo: false, branch: "", branches: [], files: [] }) } } }); return true; }
    if (env.skill_manage) { reply({ agent_response: { skill_manage_resp: { result_json: JSON.stringify({ rootDir: "synthetic-skills", skills: [], settings: { enabled: true, selected: [] }, configurationVersion: "skills-synthetic" }) } } }); return true; }
    if (env.managed_process_request) { reply({ agent_response: { managed_process_response: { action: env.managed_process_request.action, snapshot: { revision: 1, processes: [] } } } }); return true; }
    if (env.memory_manage) { reply({ agent_response: { memory_manage_resp: { result_json: JSON.stringify({ enabled: false, items: [], memories: [], settings: { enabled: false } }) } } }); return true; }
    if (env.chat_queue) { reply({ agent_response: { chat_queue_resp: { accepted: true, revision: 1, snapshot_json: JSON.stringify({ conversationId: env.chat_queue.conversation_id, revision: 1, items: [] }) } } }); return true; }
    if (env.checkpoint) { reply({ agent_response: { checkpoint_resp: { action: env.checkpoint.action, result_json: "[]" } } }); return true; }
    if (env.trajectory_fetch) { reply({ agent_response: { trajectory_fetch_resp: { conversation_id: env.trajectory_fetch.conversation_id, events_json: "[]", sections: [], subagent_runs_json: "[]" } } }); return true; }
    if (env.settings_get || env.settings_update || env.chat_queue) return false;
    unsupported.push(Object.keys(env));
    reply({ local_error: { message: "This synthetic fixture does not provide the requested optional capability." } });
    return true;
  } });
  t.after(() => server.close());
  const bundle = process.env.ZEROAGENT_DESKTOP_REMOTE_BUNDLE
    ? resolve(process.env.ZEROAGENT_DESKTOP_REMOTE_BUNDLE)
    : fileURLToPath(new URL("../../../public/remote-device/runtime.js", import.meta.url));
  const { createDesktopRemoteRuntime } = await import(pathToFileURL(bundle).href);
  assert.equal(typeof createDesktopRemoteRuntime, "function");
  const root = document.getElementById("remote-root");
  const slots = { header: null, account: null, window: null, update: null };
  const requests = [];
  const invalid = [];
  const navigationListeners = new Set();
  let settingsTarget = null;
  let canLeaveSettings = false;
  const settingsNavigation = {
    getSnapshot: () => settingsTarget,
    subscribe(listener) { navigationListeners.add(listener); return () => navigationListeners.delete(listener); },
    requestLeave() {
      if (!canLeaveSettings) return false;
      settingsTarget = null;
      for (const listener of navigationListeners) listener();
      return true;
    },
  };
  const settingsRail = document.createElement("div");
  document.body.append(settingsRail);
  t.after(() => settingsRail.remove());
  const publicUser = { id: 7, email: "synthetic@example.invalid", username: "Synthetic", status: "active" };
  const mountHost = (agent) => {
    const environment = { runtime_kind: "device_agent", device_id: agent, agent_id: agent, name: agent, online: true, workspaces: [], capabilities: ["agent", "files", "terminal", "git", "mcp", "hooks", "cron"] };
    const selection = { runtime_kind: "device_agent", device_id: agent, agent_id: agent, selection_lease: `lease-${agent}`, workspace_id: "", scope: "device", expires_at: new Date(Date.now() + 60_000).toISOString() };
    const host = {
      sessionHandle: "opaque-native-session", accountScope: "verified-account-a", gatewayOrigin: server.origin, accountUser: publicUser,
      environment, environments: [environment], selection, isCurrent: () => true,
      settingsNavigation,
      async request(path) {
        requests.push(path);
        if (path === "/api/image/identity") return Response.json({ mode: "device", ownerId: "7", backendId: agent });
        if (path.startsWith("/api/image/")) {
          const route = new URL(path, server.origin);
          assert.equal(route.searchParams.get("backendId"), agent);
          const version = "kbrain.image.v1";
          if (route.pathname.endsWith("/health")) return Response.json({ status: "ok", capabilities: { image: { supported: true, version } } });
          if (route.pathname.endsWith("/projects")) {
            const date = "2026-11-16T00:00:00Z";
            return Response.json({ version, items: [{ id: "project-fixture", title: "Fixture archive", revision: 1, createdAt: date, updatedAt: date }] });
          }
          return Response.json({ version, items: [] });
        }
        if (path.startsWith("/api/auth/me")) return Response.json({ user: publicUser });
        if (path.startsWith("/api/usa-zero/user/profile")) return Response.json({ code: 0, data: publicUser });
        if (path.includes("/dashboard/stats")) return Response.json({ code: 0, data: { today_tokens: 0 } });
        if (path.includes("/groups/available")) return Response.json({ code: 0, data: [] });
        if (path.startsWith("/api/usa-zero/keys")) return Response.json({ code: 0, data: { items: [], total: 0, pages: 0, page: 1 } });
        return Response.json({ code: 0, data: {} });
      },
      onHeaderTarget: (element) => { slots.header = element; },
      onAccountTarget: (element) => { slots.account = element; },
      onWindowControlsTarget: (element) => { slots.window = element; },
      onUpdateTarget: (element) => { slots.update = element; },
      onSelectionInvalid: (reason) => invalid.push(reason),
    };
    const runtime = createDesktopRemoteRuntime();
    return runtime.mount(root, host);
  };
  let first;
  let second;
  try {
    first = mountHost("device-a");
    await waitFor(() => root.querySelector("[data-app-workbench-chrome]"), "the real shared AppWorkbenchChrome");
    const newConversation = await waitFor(() => Array.from(root.querySelectorAll("button")).find((button) => /^(New Conversation|新对话)$/.test(button.textContent.trim())), "the shared new-conversation action");
    newConversation.click();
    await waitFor(() => root.querySelector("[contenteditable='true'],textarea"), "the complete shared composer");
    assert.ok(/New Conversation|新对话/.test(root.textContent), "shared navigation is present");
    // Resource destinations moved to the shared icon rail; their accessible
    // names and actions remain available without expanding a text sidebar.
    for (const label of ["Skills", "MCP"]) {
      const action = root.querySelector(`nav button[aria-label="${label}"]`);
      assert.ok(action, `${label} remains reachable in the shared application rail`);
      assert.equal(action.disabled, false, `${label} is an enabled destination`);
    }
    assert.ok(slots.header?.isConnected, "desktop device switcher has a live header portal target");
    assert.ok(slots.account?.isConnected, "desktop account menu has a live portal target");
    assert.ok(slots.window?.isConnected, "desktop window controls have a live portal target");
    assert.ok(slots.update?.isConnected, "desktop updates have a live navigation portal target");
    assert.equal(root.querySelector(".application-rail img").getAttribute("src"), "/zeroagent-logo.png", "remote rail uses the logo shipped by the desktop host");
    const composer = root.querySelector("[contenteditable='true'],textarea");
    const imageAction = root.querySelector('nav button[aria-label="Image Studio"],nav button[aria-label="图像工作台"]');
    assert.ok(imageAction, "device Image Studio stays in the shared application rail");
    imageAction.click();
    await waitFor(() => root.querySelector('[aria-label="Create image"],[aria-label="图像创作"]'), "the remote image composer");
    assert.ok(requests.some((path) => path.startsWith("/api/image/projects?") && path.includes("backendId=device-a")));
    root.querySelector('nav button[aria-label="Skills"]').click();
    const featureSidebar = await waitFor(() => root.querySelector(".workbench-feature-sidebar"), "contextual feature navigation");
    assert.ok(featureSidebar.querySelector('[aria-current="page"]').textContent.includes("Skills"));
    assert.equal(featureSidebar.querySelector(".chat-history-row"), null, "Skills must not show the conversation/project list");
    assert.equal(root.querySelector("[contenteditable='true'],textarea"), composer, "switching feature pages keeps the conversation mounted");
    Array.from(featureSidebar.querySelectorAll("button")).find((button) => button.textContent.trim() === "MCP").click();
    await waitFor(() => root.querySelector('.workbench-feature-sidebar [aria-current="page"]')?.textContent.trim() === "MCP", "feature navigation follows the selected page");
    settingsTarget = settingsRail;
    for (const listener of navigationListeners) listener();
    await waitFor(() => settingsRail.querySelector(".application-rail"), "the owning remote rail in the Native settings canvas");
    assert.equal(root.querySelector(".application-rail"), null, "only one live rail exists");
    assert.ok(slots.update?.isConnected, "Native update controls remain mounted in settings");
    settingsRail.querySelector('button[aria-label="Skills"]').click();
    await new Promise((resolveGuard) => setTimeout(resolveGuard, 30));
    assert.ok(root.querySelector('.workbench-feature-sidebar [aria-current="page"]').textContent.includes("MCP"), "a rejected settings leave guard blocks navigation");
    canLeaveSettings = true;
    settingsRail.querySelector('button[aria-label="Skills"]').click();
    await waitFor(() => root.querySelector('.application-rail') && root.querySelector('.workbench-feature-sidebar [aria-current="page"]')?.textContent.includes("Skills"), "accepted navigation returns the rail and changes view");
    assert.ok(server.frames.some((frame) => frame.json.agent_id === "device-a" && frame.json.agent_request?.settings_get));
    const workbench = root.querySelector("[data-app-workbench-chrome]");
    const peer = server.frames.find((frame) => frame.case === "hello" && frame.peer.agent === "device-a").peer;
    peer.send({ agent_id: "device-a", status: { agent_id: "device-a", online: false } });
    await new Promise((resolvePresence) => setTimeout(resolvePresence, 50));
    assert.deepEqual(invalid, [], "offline presence cannot revoke a valid desktop lease");
    assert.equal(root.querySelector("[data-app-workbench-chrome]"), workbench, "the shipped workbench stays mounted while its target reconnects");
    peer.send({ agent_id: "device-a", status: { agent_id: "device-a", online: true, agent_ready: true, chat_runtime_ready: true } });
    await new Promise((resolvePresence) => setTimeout(resolvePresence, 50));
    assert.deepEqual(invalid, []);
    assert.equal(root.querySelector("[data-app-workbench-chrome]"), workbench);
    first.dispose();
    first = null;
    assert.equal(root.childElementCount, 0);
    assert.equal(settingsRail.childElementCount, 0, "disposed workbench leaves no settings navigation behind");
    assert.equal(navigationListeners.size, 0, "disposed workbench unsubscribes from Native presentation state");
    assert.deepEqual(slots, { header: null, account: null, window: null, update: null });
    for (const [name, value] of nativeAttributes) assert.equal(dom.window.document.documentElement.getAttribute(name), value, `${name} restored to native shell`);
    assert.equal(dom.window.document.title, "Native ZeroAgent");
    await waitFor(() => server.peerCount === 0, "the previous device's actual WebSocket to close");
    const boundary = server.frames.length;
    second = mountHost("device-b");
    await waitFor(() => root.querySelector("[data-app-workbench-chrome]"), "the second device's complete shared UI");
    await waitFor(() => server.frames.slice(boundary).some((frame) => frame.json.agent_id === "device-b" && frame.json.agent_request?.settings_get), "device-b's independent settings read");
    assert.equal(server.frames.slice(boundary).filter((frame) => frame.json.agent_id === "device-a").length, 0, "new UI cannot issue requests to the previous device");
    assert.deepEqual(invalid, []);
    server.assertHealthy();
    assert.deepEqual(unsupported, [], "all requested bootstrap capabilities have explicit protocol fixture responses");
    console.log(`Shipped remote bundle mounted both full device UIs; ${server.frames.length} real binary frames and ${requests.length} Native-owned HTTP calls.`);
  } catch (error) {
    try { server.assertHealthy(); } catch (serverError) { console.log("Remote UI probe wire error:", serverError.message); }
    console.log("Remote UI probe unsupported frames:", JSON.stringify(unsupported));
    console.log("Remote UI probe frames:", server.frames.map((frame) => `${frame.case}:${Object.keys(frame.json.agent_request ?? {}).join(",")}`).join(" "));
    console.log("Remote UI probe DOM:", root.textContent.slice(0, 2500));
    throw error;
  } finally {
    first?.dispose();
    second?.dispose();
    await new Promise((resolveCleanup) => setTimeout(resolveCleanup, 30));
  }
  assert.equal(dom.window.document.documentElement.dataset.liveagentWebui, undefined);
  for (const [name, value] of nativeAttributes) assert.equal(dom.window.document.documentElement.getAttribute(name), value);
  assert.equal(dom.window.document.title, "Native ZeroAgent");
});
