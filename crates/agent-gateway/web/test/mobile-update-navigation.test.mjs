import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const candidate = { currentVersion: "1.0.0", version: "1.1.0", title: "ZeroAgent v1.1.0", notes: "更新内容", apkUrl: "https://github.com/USA-Zero/ZeroAgent/releases/download/v1.1.0/ZeroAgent-Android-arm64.apk", releaseUrl: "https://github.com/USA-Zero/ZeroAgent/releases/tag/v1.1.0" };

async function setup(embedded = true) {
  let checks = 0, downloads = 0, automatic;
  let finishDownload;
  const pendingDownload = new Promise((resolve, reject) => { finishDownload = { resolve, reject }; });
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    "../components/IconSet": new Proxy({}, { get: () => () => null }),
    "../IconSet": new Proxy({}, { get: () => () => null }),
    "../../lib/mobileRuntime": { isEmbeddedMobileRuntime: () => embedded, mobileHaptic() {}, MOBILE_BACK_EVENT: "zeroagent:mobile-back" },
    "../../lib/mobileAppUpdate": { MOBILE_APP_VERSION: "1.0.0", MOBILE_UPDATE_CHECK_EVENT: "zeroagent:mobile-update-check", checkMobileAppUpdate: async () => { checks++; return candidate; }, downloadMobileAppUpdate: () => { downloads++; return pendingDownload; } },
  } });
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
  const nativeTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) => {
    if (delay === 1500) { automatic = callback; return 2147483646; }
    return nativeTimeout(callback, delay, ...args);
  };
  const { React, act, createRoot } = env;
  const { MobileAppExperience, MobileSidebarUpdate } = env.loadModule("@/components/mobile/MobileAppExperience.tsx");
  const { ApplicationRail } = env.loadModule("@liveagent/ui/application/ApplicationRail.tsx");
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(MobileAppExperience, null,
    React.createElement(ApplicationRail, { brand: "Z", activeId: "chat", items: [], footer: React.createElement(React.Fragment, null, React.createElement(MobileSidebarUpdate), React.createElement("button", { "data-account": "" }, "账户")) })) ); await tick(); });
  return { ...env, container, root, finishDownload,
    get checks() { return checks; }, get downloads() { return downloads; },
    async automatic() { assert.ok(automatic); await act(async () => { automatic(); await tick(); }); },
    async click(element) { assert.ok(element); await act(async () => { element.click(); await tick(); }); },
    trigger: () => container.querySelector(".application-rail-update"),
    dialog: () => document.querySelector('[role="dialog"][data-open]'),
    async destroy() { await act(async () => root.unmount()); container.remove(); if (storage) Object.defineProperty(globalThis, "localStorage", storage); else delete globalThis.localStorage; env.cleanup(); },
  };
}

test("automatic mobile discovery shows an entry above the account without interrupting the page", async () => {
  const app = await setup();
  try {
    await app.automatic();
    assert.equal(app.checks, 1);
    const entry = app.trigger();
    assert.match(entry.getAttribute("aria-label"), /v1\.1\.0/);
    assert.ok(entry.closest('nav[aria-label="应用导航"]'));
    assert.equal(entry.nextElementSibling.getAttribute("data-account"), "");
    assert.equal(app.dialog(), null);
    const back = new Event("zeroagent:mobile-back", { cancelable: true });
    window.dispatchEvent(back);
    assert.equal(back.defaultPrevented, false, "an unopened update must not swallow page Back");
    await app.click(entry);
    assert.ok(app.dialog());
    await app.click([...app.dialog().querySelectorAll("button")].find((button) => button.textContent === "稍后"));
    assert.equal(app.dialog(), null);
    assert.equal(app.trigger(), entry, "postponing retains the same available-update entry");
    await app.click(entry);
    assert.ok(app.dialog(), "the retained entry reopens details");
    assert.equal(app.downloads, 0);
  } finally { await app.destroy(); }
});

test("mobile update handoff stays guarded while pending and download failure remains retryable", async () => {
  const app = await setup();
  try {
    await app.automatic(); await app.click(app.trigger());
    const download = [...app.dialog().querySelectorAll("button")].find((button) => button.textContent === "下载更新");
    await app.click(download);
    assert.equal(app.downloads, 1); assert.equal(app.trigger().disabled, true);
    await app.click(download);
    assert.equal(app.downloads, 1);
    assert.ok([...app.dialog().querySelectorAll("button")].every((button) => button.disabled));
    await app.act(async () => { app.finishDownload.reject(new Error("无法打开下载")); await tick(); });
    assert.equal(app.dialog(), null); assert.equal(app.trigger().disabled, false);
    assert.match(document.body.textContent, /无法打开下载/);
    await app.click(app.trigger()); assert.ok(app.dialog());
  } finally { await app.destroy(); }
});

test("ordinary Web never exposes a native updater or performs automatic release requests", async () => {
  const app = await setup(false);
  try {
    await app.act(async () => { window.dispatchEvent(new Event("zeroagent:mobile-update-check")); await tick(); });
    assert.equal(app.checks, 0); assert.equal(app.trigger(), null); assert.equal(app.dialog(), null);
  } finally { await app.destroy(); }
});
