// Opening the model list must bring the active model into view: with a long
// catalog the current choice is otherwise hidden below other providers.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("entering the model list scrolls the active model into view and expands its provider", async () => {
  const icon = () => null;
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": new Proxy(
        {},
        { get: (_target, name) => (name === "__esModule" ? true : icon) },
      ),
      "@liveagent/ui/components/ProviderBrandIcon": { ProviderBrandIcon: icon },
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    },
  });
  window.HTMLElement.prototype.getAnimations ??= () => [];
  const { ComposerModelControls } = env.loadModule(
    "@liveagent/ui/components/chat/ComposerModelControls.tsx",
  );
  const { toModelValue } = env.loadModule("@liveagent/ui/lib/models/modelValue.ts");

  // A long first provider pushes the active model (second provider) out of view.
  const modelOptions = [
    ...Array.from({ length: 30 }, (_, index) => ({
      model: `first-${index}`,
      label: `first-${index}`,
      providerId: "first",
      providerName: "First",
      providerType: "openai",
      value: toModelValue("first", `first-${index}`),
    })),
    ...["second-a", "second-b"].map((model) => ({
      model,
      label: model,
      providerId: "second",
      providerName: "Second",
      providerType: "openai",
      value: toModelValue("second", model),
    })),
  ];

  // JSDOM has no layout: place the viewport and the active row, and record scrolls.
  const scrolls = [];
  const originalRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.matches?.("[data-model-picker-list]")) {
      return { top: 100, bottom: 380, height: 280, left: 0, right: 300, width: 300 };
    }
    if (this.matches?.('button[data-model-option][aria-pressed="true"]')) {
      return { top: 1000, bottom: 1028, height: 28, left: 0, right: 300, width: 300 };
    }
    return originalRect.call(this);
  };
  const viewportScroll = new WeakMap();
  const proto = window.Element.prototype;
  const scrollTop = Object.getOwnPropertyDescriptor(proto, "scrollTop");
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get() {
      return this.matches?.("[data-model-picker-list]")
        ? (viewportScroll.get(this) ?? 0)
        : scrollTop?.get?.call(this) ?? 0;
    },
    set(value) {
      if (this.matches?.("[data-model-picker-list]")) {
        viewportScroll.set(this, value);
        scrolls.push(value);
      } else scrollTop?.set?.call(this, value);
    },
  });
  const root = env.createRoot(document.body.appendChild(document.createElement("div")));
  const trigger = () => document.querySelector("[data-composer-model-trigger]");
  try {
    await env.act(async () =>
      root.render(
        env.React.createElement(ComposerModelControls, {
          executionMode: "tools",
          hasModels: true,
          currentModelLabel: "second-b",
          selectedValue: toModelValue("second", "second-b"),
          modelOptions,
          chatRuntimeControls: { reasoning: "low", thinkingEnabled: false, nativeWebSearchEnabled: false },
          reasoningOptions: [],
          thinkingAlwaysOn: false,
          onSelectModel() {},
          onSelectExecutionMode() {},
          onOpenSettings() {},
          onChatRuntimeControlsChange() {},
        }),
      ),
    );
    await env.act(async () => trigger().click());
    assert.ok(document.querySelector("[data-model-picker-list]"));
    assert.deepEqual(scrolls, [774], "the active model is scrolled to the middle of the list");

    const second = [...document.querySelectorAll("[data-model-group]")].find((node) =>
      node.textContent.includes("Second"),
    );
    assert.ok(second);
    assert.equal(second.getAttribute("aria-expanded"), "true");
    await env.act(async () => second.click());
    assert.equal(second.getAttribute("aria-expanded"), "false");
    await env.act(async () => trigger().click());
    await env.act(async () => sleep(100));
    await env.act(async () => trigger().click());
    const reopened = [...document.querySelectorAll("[data-model-group]")].find((node) =>
      node.textContent.includes("Second"),
    );
    assert.equal(reopened?.getAttribute("aria-expanded"), "true");
  } finally {
    await env.act(async () => root.unmount());
    if (scrollTop) Object.defineProperty(proto, "scrollTop", scrollTop);
    else delete proto.scrollTop;
    window.Element.prototype.getBoundingClientRect = originalRect;
    env.cleanup();
  }
});
