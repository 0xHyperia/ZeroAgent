import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const calls = [];
let rejectVisibleLayout = false;
const env = await createDomTestEnv({
  mocks: {
    "@tauri-apps/api/core": {
      Channel: class { onmessage = () => {}; },
      invoke: async (command, args) => {
        calls.push({ command, ...args });
        if (rejectVisibleLayout && args.request?.action === "layout" && args.request.bounds) {
          rejectVisibleLayout = false;
          throw new Error("Temporary native layout failure");
        }
      },
    },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en" }) },
  },
});
const { React, createRoot, act } = env;
const { WorkbenchBrowserPane, submitDetachedBrowserAnnotations } = env.loadModule("src/components/workbench-browser/WorkbenchBrowserPane.tsx");
const { resolveBrowserAddress, formatBrowserAddress } = env.loadModule("src/components/workbench-browser/browserAddress.ts");

test("browser addresses preserve valid HTTP URLs, search text, and reject executable schemes", () => {
  assert.equal(resolveBrowserAddress("example.com/a"), "https://example.com/a");
  assert.equal(resolveBrowserAddress("localhost:8123"), "http://localhost:8123/");
  assert.equal(resolveBrowserAddress("example.com:443"), "https://example.com/");
  assert.equal(resolveBrowserAddress("[::1]:8123"), "http://[::1]:8123/");
  assert.equal(resolveBrowserAddress("two words 中文"), "https://www.google.com/search?q=two+words+%E4%B8%AD%E6%96%87");
  assert.equal(formatBrowserAddress("https://www.example.com/secret"), "example.com");
  assert.equal(formatBrowserAddress("http://example.com/secret"), "http://example.com");
  for (const input of ["file:///C:/private.txt", "javascript:alert(1)", "tauri://localhost/", "https://test:secret@example.com/"]) {
    assert.equal(resolveBrowserAddress(input), null);
  }
});

test("browser tab preserves its native session when hidden and yields to a DOM overlay", async () => {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Windows" });
  const rootNode = document.createElement("div");
  const portal = document.createElement("div");
  portal.dataset.slot = "sheet-portal";
  const backdrop = document.createElement("div");
  backdrop.dataset.slot = "sheet-backdrop";
  const hostSheet = document.createElement("div");
  hostSheet.setAttribute("role", "dialog");
  hostSheet.append(rootNode);
  portal.append(backdrop, hostSheet);
  document.body.append(portal);
  const root = createRoot(rootNode);
  const navigated = [];
  const popups = [];
  const props = { id: "test", url: "https://example.com/", scope: "account-a", onNavigate: (...value) => navigated.push(value), onOpenTab: (...value) => popups.push(value) };
  const rect = { x: 600, y: 80, left: 600, top: 80, width: 300, height: 500, right: 900, bottom: 580 };
  hostSheet.getBoundingClientRect = () => rect;
  backdrop.getBoundingClientRect = () => rect;
  const render = (active) => act(async () => root.render(React.createElement(WorkbenchBrowserPane, { ...props, active })));
  const settleLayout = () => act(async () => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
  await render(true);
  const open = calls.find((call) => call.command === "workbench_browser_open");
  assert.equal(open.url, props.url);
  rootNode.querySelector(".za-workspace-browser-page").getBoundingClientRect = () => rect;
  document.body.append(document.createElement("hr"));
  await settleLayout();
  assert.equal(calls.at(-1).request.bounds.width, 300);

  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.getBoundingClientRect = () => rect;
  document.body.append(dialog);
  await settleLayout();
  assert.equal(calls.at(-1).request.bounds, null);
  rejectVisibleLayout = true;
  const beforeRecovery = calls.length;
  dialog.hidden = true;
  await settleLayout();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 130)));
  const recovery = calls.slice(beforeRecovery).filter((call) => call.request?.action === "layout");
  assert.equal(recovery.length, 2);
  assert.deepEqual(recovery[0].request.bounds, recovery[1].request.bounds);
  assert.ok(recovery[1].request.version > recovery[0].request.version);
  assert.equal(calls.at(-1).request.bounds.width, 300);
  dialog.hidden = false;
  await settleLayout();
  assert.equal(calls.at(-1).request.bounds, null);
  dialog.remove();
  await settleLayout();
  assert.equal(calls.at(-1).request.bounds.width, 300);

  await act(async () => open.events.onmessage({ kind: "state", state: {
    url: "https://example.com/a", title: "Fixture", loading: false, loadFailed: false,
    canGoBack: true, canGoForward: false, hasDownloads: false, findIndex: -1, findCount: 0,
  } }));
  assert.deepEqual(navigated, [["https://example.com/a", "Fixture"]]);
  await act(async () => open.events.onmessage({ kind: "openTab", url: "https://example.org/", foreground: false }));
  assert.deepEqual(popups, [["https://example.org/", false]]);

  await render(false);
  assert.equal(calls.at(-1).request.bounds, null);
  assert.equal(rootNode.querySelector("section").hidden, true);
  assert.equal(calls.some((call) => call.request?.action === "close"), false);
  await render(true);
  assert.equal(calls.filter((call) => call.command === "workbench_browser_open").length, 1);
  assert.equal(calls.at(-1).id, open.id);
  await act(async () => root.unmount());
  assert.deepEqual(calls.at(-1).request, { action: "close" });
  portal.remove();
});

test("device toolbar applies scoped native metrics and clears them on exit", async () => {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Windows" });
  const key = "zeroagent.workbench-browser.device-toolbar:account-device";
  window.localStorage.setItem(key, "true");
  const getRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("za-workspace-browser-page")) {
      return { x: 200, y: 80, left: 200, top: 80, width: 700, height: 600, right: 900, bottom: 680 };
    }
    if (this.classList.contains("za-workspace-browser-device-content")) {
      return { x: 380, y: 80, left: 380, top: 80, width: 340, height: 580, right: 720, bottom: 660 };
    }
    return getRect.call(this);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(WorkbenchBrowserPane, {
      id: "device", url: "https://example.com/", scope: "account-device", active: true,
      onNavigate() {}, onOpenTab() {},
    })));
    const lastLayout = () => calls.findLast((call) => call.request?.action === "layout").request;
    const toolbar = container.querySelector('[aria-label="Device toolbar"]');
    assert.ok(toolbar);
    assert.deepEqual(lastLayout().viewport, { width: 660, height: 580, scale: 1 });
    const preset = toolbar.querySelector("select");
    assert.equal(preset.options.length, 13);
    await act(async () => {
      preset.value = "iphone-15-pro-max";
      preset.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    assert.deepEqual(lastLayout().viewport, { width: 430, height: 932, scale: 580 / 932 });
    await act(async () => toolbar.querySelector('[aria-label="Rotate viewport"]').click());
    assert.deepEqual(lastLayout().viewport, { width: 932, height: 430, scale: 660 / 932 });
    await act(async () => toolbar.querySelector('[aria-label="Exit device toolbar mode"]').click());
    assert.equal(lastLayout().viewport, null);
    assert.equal(lastLayout().bounds.width, 700);
    assert.equal(window.localStorage.getItem(key), "true");
  } finally {
    await act(async () => root.unmount());
    HTMLElement.prototype.getBoundingClientRect = getRect;
    window.localStorage.removeItem(key);
    container.remove();
  }
});

test("detached chrome connects to the existing guest and routes restored history", async () => {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Windows" });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const offset = calls.length;
  try {
    await act(async () => root.render(React.createElement(WorkbenchBrowserPane, {
      id: "detached", detachedLease: "same-native-guest", active: true, url: "",
      onNavigate() {}, onOpenTab() {},
    })));
    const connection = calls.slice(offset).find((call) => call.command === "workbench_browser_connect");
    assert.equal(connection.id, "same-native-guest");
    assert.equal(calls.slice(offset).some((call) => call.command === "workbench_browser_open"), false);
    await act(async () => connection.events.onmessage({
      kind: "history", history: { entries: ["https://example.com/", "https://example.com/next"], index: 0 },
      durableTraversal: true,
    }));
    assert.equal(container.querySelector('[aria-label="Back"]').disabled, true);
    await act(async () => container.querySelector('[aria-label="Forward"]').click());
    assert.equal(calls.at(-1).id, "same-native-guest");
    assert.equal(calls.at(-1).request.action, "forward");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
  assert.equal(calls.slice(offset).some((call) => call.request?.action === "close"), false);
});

test("point and drag annotations can be edited and attached in one explicit batch", async () => {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Windows" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const attached = [];
  let fail = true;
  const url = "https://example.com/article";
  try {
    await act(async () => root.render(React.createElement(WorkbenchBrowserPane, {
      id: "annotation", url, active: true, onNavigate() {}, onOpenTab() {},
      onAnnotate: (value) => {
        if (fail) throw new Error("Draft is full");
        attached.push(value);
      },
    })));
    const events = calls.findLast((call) => call.command === "workbench_browser_open").events;
    await act(async () => events.onmessage({ kind: "state", state: {
      url, title: "Article", loading: false, loadFailed: false,
      canGoBack: false, canGoForward: false, hasDownloads: false, findIndex: -1, findCount: 0,
    } }));
    const capture = async (event) => {
      await act(async () => events.onmessage(event));
      await act(async () => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
      assert.deepEqual(calls.at(-1).request, { action: "screenshot", toClipboard: false });
      await act(async () => events.onmessage({ kind: "screenshot", png: "aW1hZ2U=" }));
    };
    const save = async (text) => {
      const input = container.querySelector(".za-workspace-browser-annotation-form textarea");
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(input, text);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await act(async () => container.querySelector('.za-workspace-browser-annotation-form button[type="submit"]').click());
    };
    await act(async () => container.querySelector('[aria-label="Ask ZeroAgent"]').click());
    assert.deepEqual(calls.at(-1).request, { action: "selectRegion", enabled: true });
    await capture({ kind: "annotationTarget", target: "button#read", x: 0.25, y: 0.5,
      siteLabel: "Article action", siteMetadata: '{"role":"open"}', siteSuggestedComment: "Site suggestion",
      siteControls: JSON.stringify([{ type: "toggle", callback: "visible", label: "Show article", currentValue: true }]) });
    assert.equal(container.querySelector(".za-workspace-browser-annotation-form code").textContent, "Article action");
    assert.equal(container.querySelector(".za-workspace-browser-annotation-form textarea").value, "Site suggestion");
    await act(async () => container.querySelector('fieldset input[type="checkbox"]').click());
    assert.equal(container.querySelector('fieldset input[type="checkbox"]').checked, false);
    await save("Read this button");
    assert.equal(attached.length, 0);
    await capture({ kind: "annotationRegion", x: 0.2, y: 0.3, width: 0.5, height: 0.25 });
    const region = container.querySelector(".za-workspace-browser-region");
    assert.equal(region.style.width, "50%");
    assert.equal(region.style.height, "25%");
    await save("Read this region");
    await act(async () => container.querySelector('.za-browser-annotation-toolbar [aria-expanded="false"]').click());
    await act(async () => container.querySelector('[aria-label="Edit annotation 1"]').click());
    await save("Updated button note");
    assert.equal(attached.length, 0);
    await act(async () => container.querySelector(".za-workspace-browser-annotation-commit").click());
    assert.equal(container.querySelector("[role=alert]").textContent, "Draft is full");
    assert.equal(container.querySelectorAll(".za-workspace-browser-annotation-row").length, 2);
    assert.equal(attached.length, 0);
    fail = false;
    await act(async () => container.querySelector(".za-workspace-browser-annotation-commit").click());
    assert.equal(attached.length, 1);
    const [[{ image, ...annotation }, { image: regionImage, ...regionNote }]] = attached;
    assert.equal(image.type, "image/png");
    assert.equal(regionImage.type, "image/png");
    assert.deepEqual(annotation, { url, target: "button#read", x: 0.25, y: 0.5, text: "Updated button note", width: undefined, height: undefined, siteLabel: "Article action", siteMetadata: '{"role":"open"}', selectedText: undefined,
      siteControlChanges: JSON.stringify([{ callback: "visible", label: "Show article", previousValue: true, value: false }]) });
    assert.deepEqual(regionNote, { url, x: 0.2, y: 0.3, width: 0.5, height: 0.25, text: "Read this region" });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("detached annotation submission encodes only the explicitly approved batch", async () => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const url = "https://example.com/";
  await submitDetachedBrowserAnnotations("native-lease", [{
    image: { arrayBuffer: async () => bytes.buffer }, url, x: 0.1, y: 0.9, text: "Review this",
  }]);
  assert.deepEqual(calls.at(-1), {
    command: "workbench_browser_submit_annotations", id: "native-lease",
    annotations: [{ url, x: 0.1, y: 0.9, text: "Review this", png: "iVBORw0KGgo=" }],
  });
});

test("site controls refresh only the latest preview and close the native selection", async () => {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Windows" });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const url = "https://example.com/";
  const token = "live-site-preview";
  const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 90)));
  try {
    await act(async () => root.render(React.createElement(WorkbenchBrowserPane, {
      id: "site-preview", active: true, url, onNavigate() {}, onOpenTab() {}, onAnnotate() {},
    })));
    const events = calls.findLast((call) => call.command === "workbench_browser_open").events;
    await act(async () => events.onmessage({ kind: "state", state: {
      url, title: "Fixture", loading: false, loadFailed: false, canGoBack: false,
      canGoForward: false, hasDownloads: false, findIndex: -1, findCount: 0,
    } }));
    await act(async () => container.querySelector('[aria-label="Ask ZeroAgent"]').click());
    await act(async () => events.onmessage({
      kind: "annotationTarget", target: "button", x: 0.5, y: 0.5, sitePreviewToken: token,
      siteControls: JSON.stringify([{ type: "toggle", callback: "visible", label: "Visible", currentValue: true }]),
    }));
    await act(async () => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    await act(async () => events.onmessage({ kind: "screenshot", png: "aW1hZ2U=" }));
    const editorLayout = calls.findLast((call) => call.request?.action === "layout").request;
    assert.equal(editorLayout.bounds, null);
    assert.equal(editorLayout.sitePreviewToken, token);
    await act(async () => container.querySelector('fieldset input[type="checkbox"]').click());
    await tick();
    const update = calls.findLast((call) => call.request?.action === "previewSiteAnnotation").request;
    assert.deepEqual(update, { action: "previewSiteAnnotation", token, revision: 1, values: [{ callback: "visible", value: false }], original: false });
    await act(async () => events.onmessage({ kind: "siteAnnotationPreview", token, revision: 0, png: null }));
    assert.equal(container.querySelector('[role="status"]').textContent, "Updating preview…");
    await act(async () => events.onmessage({ kind: "siteAnnotationPreview", token, revision: 1, png: "cHJldmlldw==" }));
    const original = [...container.querySelectorAll('button[aria-pressed]')].find((button) => button.textContent === "Show original");
    await act(async () => original.click());
    await tick();
    assert.deepEqual(calls.findLast((call) => call.request?.action === "previewSiteAnnotation").request, { ...update, revision: 2, original: true });
    await act(async () => container.querySelector('.za-workspace-browser-annotation-form [aria-label="Close"]').click());
    assert.deepEqual(calls.findLast((call) => call.request?.action === "closeSiteAnnotation").request, { action: "closeSiteAnnotation", token });
    assert.equal(calls.findLast((call) => call.request?.action === "layout").request.sitePreviewToken, null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("ordinary element annotations open an anchored comment with optional style controls", async () => {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: "Windows" });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const url = "https://example.com/";
  try {
    await act(async () => root.render(React.createElement(WorkbenchBrowserPane, {
      id: "element-annotation", active: true, url, onNavigate() {}, onOpenTab() {}, onAnnotate() {},
    })));
    const events = calls.findLast((call) => call.command === "workbench_browser_open").events;
    await act(async () => events.onmessage({ kind: "state", state: {
      url, title: "Fixture", loading: false, loadFailed: false, canGoBack: false,
      canGoForward: false, hasDownloads: false, findIndex: -1, findCount: 0,
    } }));
    await act(async () => container.querySelector('[aria-label="Ask ZeroAgent"]').click());
    const page = container.querySelector(".za-workspace-browser-page");
    assert.equal(page.nextElementSibling.className, "za-browser-annotation-tray");
    await act(async () => events.onmessage({
      kind: "annotationTarget", target: "button#buy", x: 0.92, y: 0.87,
      localStylePreview: true, sitePreviewToken: "style-session",
      siteControls: JSON.stringify([{ type: "range", callback: "opacity", label: "Opacity", currentValue: 1, min: 0, max: 1, step: 0.05 }]),
    }));
    await act(async () => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
    await act(async () => events.onmessage({ kind: "screenshot", png: "aW1hZ2U=" }));
    const card = page.querySelector(".za-workspace-browser-annotation-image .za-browser-annotation-card");
    assert.ok(card.hasAttribute("data-above") && card.hasAttribute("data-before"));
    assert.equal(card.style.getPropertyValue("--anchor-x"), "92%");
    assert.equal(card.querySelector("fieldset"), null);
    const mode = (label) => card.querySelector(`button[aria-label="${label}"]`);
    await act(async () => mode("Style").click());
    assert.equal(mode("Comment").getAttribute("aria-pressed"), "true");
    assert.equal(card.querySelector('input[type="range"]').value, "1");
    await act(async () => mode("Comment").click());
    assert.equal(card.querySelector("fieldset"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test.after(() => env.cleanup());
