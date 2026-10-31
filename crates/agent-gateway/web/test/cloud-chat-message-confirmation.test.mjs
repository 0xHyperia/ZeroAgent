import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick = () => new Promise(resolve => setImmediate(resolve));
const sharedPath = path => fileURLToPath(new URL(`../../../agent-ui/src/${path}`, import.meta.url));

async function mount(t, { disabled = false, controlled = false } = {}) {
  const nil = () => null;
  const locale = { locale: "zh-CN", t: key => key };
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => nil }),
    [sharedPath("components/IconSet.tsx")]: new Proxy({}, { get: () => nil }),
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    [sharedPath("i18n/index.ts")]: { useLocale: () => locale },
    [sharedPath("lib/chat/checkpointRewind.tsx")]: { useCheckpointRewindAction: () => null },
    [sharedPath("components/chat/UsagePanel.tsx")]: { UsageInfoPopover: nil },
  } });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const calls = { retry: 0, branch: 0, requests: 0 };
  const { TranscriptAssistantMessageActions } = env.loadModule("@liveagent/ui/components/chat/TranscriptMessageActions.tsx");
  const { ConfirmActionPopover } = env.loadModule("@liveagent/ui/components/ui/confirm-action-popover.tsx");
  const { Button } = env.loadModule("@liveagent/ui/components/ui/button.tsx");
  function ControlledConfirm() {
    const [open, setOpen] = env.React.useState(false);
    return env.React.createElement(ConfirmActionPopover, {
      title: "native confirmation", description: "Keep the existing caller-owned gate", confirmLabel: "confirm native", open,
      onOpenChange: next => { if (!next || ++calls.requests > 1) setOpen(next); },
      onConfirm: () => calls.retry++,
    }, open => env.React.createElement(Button, { onClick: open, "aria-label": "native trigger" }, "native trigger"));
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); });
  await env.act(async () => {
    root.render(controlled ? env.React.createElement(ControlledConfirm) : env.React.createElement(TranscriptAssistantMessageActions, {
      copied: false, onCopy() {}, retryDisabled: disabled, retryTitle: "retry action", onRetry: () => calls.retry++,
      branchDisabled: disabled, branchTitle: "branch action", branchPending: false, onBranch: () => calls.branch++,
    }));
    await tick();
  });
  return { env, host, calls, popup: () => document.querySelector('[data-slot="popover-content"]'),
    async click(selector) { const target = document.querySelector(selector); assert.ok(target, selector); await env.act(async () => { target.click(); await tick(); }); },
    async choose(label) { const button = [...document.querySelectorAll('[data-slot="popover-content"] button')].find(node => node.textContent === label); assert.ok(button, label); await env.act(async () => { button.click(); await tick(); }); },
  };
}

test("real tooltip/popover composition opens retry and branch confirmation on the actual button without executing early", async t => {
  const app = await mount(t);
  for (const [action, label] of [["retry", "chat.retry"], ["branch", "chat.branch"]]) {
    const selector = `[aria-label="${action} action"]`;
    const trigger = app.host.querySelector(selector);
    assert.equal(trigger.tagName, "BUTTON");
    assert.equal(trigger.hasAttribute("title"), false, "the shared tooltip must not compete with a native title bubble");
    assert.equal(trigger.querySelector("button"), null);
    assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
    await app.click(selector);
    assert.ok(app.popup());
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(trigger.getAttribute("aria-controls"), app.popup().id);
    assert.equal(app.calls[action], 0);
    await app.choose("settings.cancel");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(app.calls[action], 0);
    await app.click(selector);
    await app.choose(label);
    assert.equal(app.calls[action], 1);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  }
});

test("disabled message actions cannot open a confirmation or invoke the host", async t => {
  const app = await mount(t, { disabled: true });
  for (const action of ["retry", "branch"]) {
    await app.click(`[aria-label="${action} action"]`);
    assert.equal(app.popup(), null);
    assert.equal(app.calls[action], 0);
  }
});

test("native direct-button confirmations retain controlled opening and explicit confirmation", async t => {
  const app = await mount(t, { controlled: true });
  await app.click('[aria-label="native trigger"]');
  assert.equal(app.calls.requests, 1);
  assert.equal(app.popup(), null);
  await app.click('[aria-label="native trigger"]');
  assert.equal(app.calls.requests, 2);
  assert.ok(app.popup());
  assert.equal(app.calls.retry, 0);
  await app.choose("confirm native");
  assert.equal(app.calls.retry, 1);
  assert.equal(app.host.querySelector('[aria-label="native trigger"]').getAttribute("aria-expanded"), "false");
});
