import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test("Android measures the docked keyboard from the edge-to-edge window bottom", async () => {
  const env = await createWebDomTestEnv();
  const embeddedMobile = Object.getOwnPropertyDescriptor(globalThis, "__ZEROAGENT_EMBEDDED_MOBILE__");
  Object.defineProperty(globalThis, "__ZEROAGENT_EMBEDDED_MOBILE__", {
    value: true,
    configurable: true,
  });
  const closedInsets = { top: 52, bottom: 24, left: 0, right: 0, imeBottom: 0, imeVisible: false };
  window.innerHeight = 915;
  window.visualViewport = Object.assign(new window.EventTarget(), {
    height: 915,
    width: 412,
    offsetTop: 0,
    scale: 1,
  });
  window.fetch = globalThis.fetch;
  window.__TAURI__ = {
    core: { invoke: async () => undefined },
    event: { listen: async () => () => {} },
  };
  window.__ZEROAGENT_ANDROID__ = { getSafeAreaInsets: () => JSON.stringify(closedInsets) };
  const dispatchInsets = (insets) =>
    window.dispatchEvent(new CustomEvent("zeroagent:native-insets", { detail: insets }));
  const root = document.documentElement;
  const viewportHeight = () => root.style.getPropertyValue("--zeroagent-visual-viewport-height");
  try {
    const { bootstrapEmbeddedMobileRuntime } = env.loadModule("@/lib/mobileRuntime.ts");
    await bootstrapEmbeddedMobileRuntime();
    assert.equal(viewportHeight(), "915px");

    dispatchInsets({ ...closedInsets, imeBottom: 296, imeVisible: true });
    assert.equal(viewportHeight(), "619px");
    assert.equal(root.style.getPropertyValue("--zeroagent-keyboard-inset"), "296px");
    assert.equal(root.style.getPropertyValue("--zeroagent-safe-area-bottom"), "24px");
    assert.equal(root.dataset.zeroagentKeyboard, "open");

    window.visualViewport.height = 605;
    window.visualViewport.dispatchEvent(new Event("resize"));
    assert.equal(viewportHeight(), "605px");

    window.visualViewport.height = 915;
    dispatchInsets(closedInsets);
    assert.equal(viewportHeight(), "915px");
    assert.equal(root.dataset.zeroagentKeyboard, "closed");
  } finally {
    if (embeddedMobile)
      Object.defineProperty(globalThis, "__ZEROAGENT_EMBEDDED_MOBILE__", embeddedMobile);
    else delete globalThis.__ZEROAGENT_EMBEDDED_MOBILE__;
    env.cleanup();
  }
});
