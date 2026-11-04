import { createRequire } from "node:module";
import { createWebModuleLoader } from "./load-web-module.mjs";

const requireFromWeb = createRequire(new URL("../../web/package.json", import.meta.url));

export async function createWebDomTestEnv(options = {}) {
  const { JSDOM } = requireFromWeb("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  dom.window.scrollTo = () => {};
  // JSDOM has no Web Animations API; the shared Base UI viewport checks for active animations.
  dom.window.Element.prototype.getAnimations = () => [];
  const { window } = dom;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    CustomEvent: window.CustomEvent,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent ?? window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    SVGElement: window.SVGElement,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
    // Vite injects this constant in every Web/mobile build. Restore it with the DOM globals.
    __ZEROAGENT_APP_VERSION__: globalThis.__ZEROAGENT_APP_VERSION__ ?? "0.0.0-test",
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }

  const React = requireFromWeb("react");
  const ReactDOMClient = requireFromWeb("react-dom/client");
  const loader = createWebModuleLoader({
    ...options,
    // Vite icon modules are real components in a DOM test, not structural loader records.
    iconFactory: specifier => specifier.endsWith("?raw") ? '<svg aria-hidden="true"></svg>' : props => React.createElement("svg", { ...props, "aria-hidden": true }),
    mocks: {
      react: React,
      "react/jsx-runtime": requireFromWeb("react/jsx-runtime"),
      "react-dom": requireFromWeb("react-dom"),
      "react-dom/client": ReactDOMClient,
      ...(options.mocks ?? {}),
    },
  });
  return {
    dom,
    React,
    act: React.act,
    createRoot: ReactDOMClient.createRoot,
    loadModule: loader.loadModule,
    async waitFor(check, description = "DOM condition", timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (!check()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
        await React.act(async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
        });
      }
    },
    cleanup() {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      window.close();
    },
  };
}
