import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const calls = [];
let extensions = [];
const storeId = "nngceckbapebfimnlniiiahkandclblb";
const reviewToken = "0782c72d-edde-4e1f-b9f2-9695f790d228";
const env = await createDomTestEnv({
  mocks: {
    "@tauri-apps/api/core": {
      Channel: class { onmessage = () => {}; },
      invoke: async (command, args) => {
        calls.push({ command, ...args });
        if (command === "workbench_browser_prepare_store_extension") {
          return {
            token: reviewToken, id: storeId, name: "Store fixture", version: "1.0",
            permissions: ["storage", "https://example.com/*"], optionalPermissions: ["tabs"],
          };
        }
        if (command !== "workbench_browser_extensions") return;
        const request = args.request;
        if (request.action === "install") extensions = [{ id: "fixture-extension", name: "Fixture", enabled: true }];
        if (request.action === "installStore") extensions = [{ id: storeId, name: "Store fixture", enabled: true, canOpenPopup: true }];
        if (request.action === "enable") extensions = extensions.map((item) =>
          item.id === request.extension ? { ...item, enabled: request.enabled } : item);
        if (request.action === "remove") extensions = extensions.filter((item) => item.id !== request.extension);
        return extensions;
      },
    },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en" }) },
  },
});
const { React, act, createRoot, loadModule } = env;
const { BrowserExtensionMenu, chromeStoreExtensionId } = loadModule("src/components/workbench-browser/BrowserExtensionMenu.tsx");
const { browserLoopbackAddress, displaySshLoopbackAddress } = loadModule("src/components/workbench-browser/BrowserSshLoopbackMenu.tsx");
const { WorkbenchBrowserPane } = loadModule("src/components/workbench-browser/WorkbenchBrowserPane.tsx");
test.after(() => env.cleanup());

function mount(t) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return { container, root };
}

test("extension management asks the native account browser to install, disable and remove", async (t) => {
  const { container, root } = mount(t);
  const start = calls.length;
  await act(async () => root.render(React.createElement(BrowserExtensionMenu, { id: "current-browser", onVisitStore() {} })));
  await act(async () => container.querySelector('button[aria-label="Browser extensions"]').click());
  assert.match(document.body.textContent, /No extensions installed/);
  const button = (name) => [...document.querySelectorAll("button")].find((item) =>
    item.getAttribute("aria-label") === name || item.textContent.trim() === name);
  await act(async () => button("Load unpacked extension").click());
  assert.equal(document.querySelector('[role="switch"][aria-label="Fixture"]').getAttribute("aria-checked"), "true");
  await act(async () => document.querySelector('[role="switch"][aria-label="Fixture"]').click());
  assert.equal(document.querySelector('[role="switch"][aria-label="Fixture"]').getAttribute("aria-checked"), "false");
  await act(async () => button("Remove Fixture").click());
  assert.match(document.body.textContent, /No extensions installed/);
  const operations = calls.slice(start).filter((call) => call.command === "workbench_browser_extensions");
  assert.ok(operations.every((call) => call.id === "current-browser"));
  assert.deepEqual(operations.map(({ request }) => request), [
    { action: "list" }, { action: "install" }, { action: "list" },
    { action: "enable", extension: "fixture-extension", enabled: false }, { action: "list" },
    { action: "remove", extension: "fixture-extension" }, { action: "list" },
  ]);
});

test("only the official store page opens review and explicit consent installs the verified package", async (t) => {
  const { container, root } = mount(t);
  const start = calls.length;
  const page = `https://chromewebstore.google.com/detail/store-fixture/${storeId}?hl=en`;
  const render = (pageUrl, active = true) => act(async () => root.render(React.createElement(BrowserExtensionMenu, {
    id: "store-tab", active, pageUrl, onVisitStore() {},
  })));
  const button = (name) => [...document.querySelectorAll("button")].find((item) =>
    item.getAttribute("aria-label") === name || item.textContent.trim() === name);
  for (const untrusted of [
    `https://chromewebstore.google.com.evil.test/detail/${storeId}`,
    `https://user@chromewebstore.google.com/detail/${storeId}`,
    `https://chromewebstore.google.com/detail/${storeId}/other`,
    `http://chromewebstore.google.com/detail/${storeId}`,
  ]) assert.equal(chromeStoreExtensionId(untrusted), null, untrusted);
  await render("https://example.com/");
  assert.equal(container.querySelector('[aria-label="Add from Chrome Web Store"]'), null);
  await render(page);
  await act(async () => button("Add from Chrome Web Store").click());
  assert.match(document.body.textContent, /Review extension permissions/);
  assert.match(document.body.textContent, /https:\/\/example\.com\/\*/);
  assert.match(document.body.textContent, /May ask while running/);
  assert.deepEqual(calls.slice(start), [{ command: "workbench_browser_prepare_store_extension", id: "store-tab" }]);
  await act(async () => button("Cancel").click());
  assert.ok(calls.slice(start).some(({ request }) => request?.action === "cancelStore" && request.token === reviewToken));
  await act(async () => button("Add from Chrome Web Store").click());
  await act(async () => button("Add extension").click());
  assert.deepEqual(calls.slice(start).find(({ request }) => request?.action === "installStore"), {
    command: "workbench_browser_extensions", id: "store-tab", request: { action: "installStore", token: reviewToken },
  });
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function() {
    if (this.classList.contains("za-workspace-browser-extension-stage")) {
      return { x: 500, y: 80, left: 500, top: 80, right: 820, bottom: 520, width: 320, height: 440 };
    }
    return originalRect.call(this);
  };
  t.after(() => { window.HTMLElement.prototype.getBoundingClientRect = originalRect; });
  await act(async () => button("Open extension Store fixture").click());
  await act(async () => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
  const popup = calls.slice(start).find(({ request }) => request?.action === "openPopup");
  assert.equal(popup?.id, "store-tab");
  assert.equal(popup.request.extension, storeId);
  assert.equal(popup.request.bounds.width, 320);
  await render(page, false);
  assert.ok(calls.slice(start).some(({ request }) => request?.action === "closePopup" && request.token === popup.request.token));
  assert.equal(container.querySelector('[aria-label="Add from Chrome Web Store"]'), null);
});

test("remote loopback accepts loopback addresses and displays the remote host for the live path", () => {
  assert.equal(browserLoopbackAddress("localhost:4173/a"), "http://localhost:4173/a");
  assert.equal(browserLoopbackAddress("https://[::1]:4173/a"), "https://[::1]:4173/a");
  for (const input of ["http://localhost:0", "https://localhost.example/", "http://192.168.1.10/", "file:///C:/private"]) {
    assert.equal(browserLoopbackAddress(input), null, input);
  }
  assert.equal(
    displaySshLoopbackAddress("http://127.0.0.1:62000/redirected?next=1", "http://localhost:4173/"),
    "http://localhost:4173/redirected?next=1",
  );
});

test("temporary SSH browser addresses stay out of workspace routes and close on scope change", async (t) => {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Windows" });
  const { root, container } = mount(t);
  const visited = [];
  const start = calls.length;
  const render = (projectPathKey) => act(async () => root.render(React.createElement(WorkbenchBrowserPane, {
    id: "remote-browser", url: "", active: true, scope: "account-a", projectPathKey,
    sshTargets: projectPathKey ? [{ id: "project-ssh", label: "Project host" }] : undefined,
    onNavigate: (...items) => visited.push(items), onOpenTab() {},
  })));
  await render("project-a");
  const open = calls.slice(start).find((call) => call.command === "workbench_browser_open");
  assert.equal(open.projectPathKey, "project-a");
  assert.ok(container.querySelector('[aria-label="SSH loopback forwarding"]'));
  await act(async () => open.events.onmessage({
    kind: "state",
    state: {
      url: "http://127.0.0.1:62000/", title: "Remote", sshLoopback: true, ephemeralAddress: true,
      loading: false, loadFailed: false, canGoBack: false, canGoForward: false,
      hasDownloads: false, findIndex: -1, findCount: 0,
    },
  }));
  assert.deepEqual(visited, []);
  assert.ok(container.querySelector('[aria-label="SSH loopback connected"]'));
  await render(undefined);
  assert.ok(calls.slice(start).some((call) =>
    call.command === "workbench_browser_loopback" && call.id === open.id && call.request.action === "close"));
});
