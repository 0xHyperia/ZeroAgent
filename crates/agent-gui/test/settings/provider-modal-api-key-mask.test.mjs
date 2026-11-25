import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const STORED_KEY = "test-key-123-0123456789abcdefghij";
const PLACEHOLDER = "••••••••";
const reveals = [];
let denyReveal = false;

const icon = () => null;
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, {
      get: (_target, name) => name === "__esModule" ? true : icon,
    }),
    "@liveagent/adapters/providerSettings": {
      providerCredentialsRedacted: true,
      revealStoredProviderApiKey: async (id) => {
        reveals.push(id);
        if (denyReveal) throw new Error("A fresh verification is required");
        return STORED_KEY;
      },
      discoverProviderModels: async () => [],
    },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "@liveagent/app/lib/providers/usageQuery": { testProviderUsage: async () => null },
    "@liveagent/ui/lib/models/thinkingLive": { loadThinkingLiveSupplement: async () => {} },
  },
});
window.HTMLElement.prototype.getAnimations ??= () => [];
const { ProviderModal } = env.loadModule("@liveagent/ui/pages/settings/ProviderModal.tsx");

async function open(saved) {
  reveals.length = 0;
  denyReveal = false;
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  await env.act(async () =>
    root.render(
      env.React.createElement(ProviderModal, {
        providerType: "codex",
        initialData: {
          id: "relay-1",
          name: "Relay",
          type: "codex",
          baseUrl: "https://relay.example.com/v1",
          apiKey: "",
          apiKeyConfigured: true,
          models: [],
          activeModels: [],
        },
        onSave: (next) => saved.push(next),
        onClose: () => {},
      }),
    ),
  );
  return async () => {
    await env.act(async () => root.unmount());
    host.remove();
  };
}

const input = () => document.querySelector("#modal-apikey");
const reveal = () => env.act(async () => document.querySelector('[aria-label="settings.showApiKey"]').click());
const hide = () => env.act(async () => document.querySelector('[aria-label="settings.hideApiKey"]').click());
const save = () => env.act(async () => {
  const button = [...document.querySelectorAll("button")].find(
    (node) => node.textContent.trim() === "settings.save",
  );
  assert.ok(button, "provider settings can be saved");
  button.click();
});

test("hiding a revealed key restores the fixed mask and requires a new reveal", async () => {
  const saved = [];
  const close = await open(saved);
  try {
    assert.equal(input().value, PLACEHOLDER);

    await reveal();
    assert.equal(input().value, STORED_KEY);
    assert.deepEqual(reveals, ["relay-1"]);

    await hide();
    assert.equal(input().value, PLACEHOLDER);

    denyReveal = true;
    await reveal();
    assert.equal(input().value, PLACEHOLDER);
    assert.match(document.body.textContent, /A fresh verification is required/);
    assert.deepEqual(reveals, ["relay-1", "relay-1"]);

    await save();
    assert.equal(saved.at(-1).apiKey, "", "the resolved key is never sent back");
    assert.equal(saved.at(-1).apiKeyConfigured, true);
  } finally {
    await close();
  }
});

test("saving an unedited revealed key preserves its stored reference", async () => {
  const saved = [];
  const close = await open(saved);
  try {
    await reveal();
    await save();
    assert.equal(saved.at(-1).apiKey, "");
    assert.equal(saved.at(-1).apiKeyConfigured, true);
  } finally {
    await close();
  }
});

test("focus selects the fixed mask, and a replacement keeps its value when hidden", async () => {
  const saved = [];
  const close = await open(saved);
  try {
    const field = input();
    field.blur();
    field.setSelectionRange(PLACEHOLDER.length, PLACEHOLDER.length);
    await env.act(async () => field.focus());
    assert.equal(field.selectionStart, 0);
    assert.equal(field.selectionEnd, PLACEHOLDER.length);

    await reveal();
    await env.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(field, "test-key-456");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await hide();
    assert.equal(field.type, "password");
    assert.equal(field.value, "test-key-456");
    await save();
    assert.equal(saved.at(-1).apiKey, "test-key-456");
  } finally {
    await close();
  }
});

test.after(() => env.cleanup());
