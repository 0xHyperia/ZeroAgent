import assert from "node:assert/strict";
import test from "node:test";
import React0 from "react";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Like Claude Code: after an approval is answered (the bar that replaced the composer goes
// away) the caret is back in the composer, so the user can type what to do next.

const svgIcons = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "__esModule"
        ? true
        : (props) => React0.createElement("svg", { className: props?.className }),
  },
);
let composerProps = null;
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": svgIcons,
    "@liveagent/ui/components/chat/fileTypeIcons": svgIcons,
    "@liveagent/ui/components/chat/MentionComposer": {
      MentionComposer: (props) => {
        composerProps = props;
        return null;
      },
    },
  },
});
const { React, act, createRoot } = env;
const doc = env.dom.window.document;
const { ChatComposerBar } = env.loadModule("@liveagent/ui/pages/chat/ChatComposerBar.tsx");
const { LocaleContext } = env.loadModule("@liveagent/ui/i18n/LocaleContext.tsx");
const { t: translate } = env.loadModule("@liveagent/app/i18n/config.ts");
const noop = () => {};

let container;
let root;
let modeChanges;
let controlChanges;

async function render(overrides = {}) {
  modeChanges = [];
  controlChanges = [];
  composerProps = null;
  if (!root) {
    container = doc.createElement("div");
    doc.body.appendChild(container);
    root = createRoot(container);
  }
  const props = {
    surface: "desktop",
    conversationId: "c1",
    composerRef: { current: null },
    isSending: false,
    isUploadingFiles: false,
    isInputDisabled: false,
    inputPlaceholder: "Ask",
    workdir: "/w",
    enabledSkills: [],
    executionMode: "tools",
    hasModels: true,
    currentModelLabel: "m",
    modelOptions: [],
    chatRuntimeControls: { planModeEnabled: false },
    reasoningOptions: [],
    thinkingAlwaysOn: false,
    commandSafetyMode: "ask",
    onCommandSafetyModeChange: (mode) => modeChanges.push(mode),
    onSend: noop,
    onStop: noop,
    onComposerBusyChange: noop,
    onSelectModel: noop,
    onSelectExecutionMode: noop,
    onChatRuntimeControlsChange: (patch) => controlChanges.push(patch),
    onPickReadableFiles: noop,
    onPickWorkspaceFolder: noop,
    onPasteFiles: noop,
    pendingUploadedFiles: [],
    onRemovePendingUpload: noop,
    queuedTurns: [],
    queuePaused: false,
    onQueuePausedChange: noop,
    onRunQueuedTurnNow: noop,
    onMoveQueuedTurnUp: noop,
    onEditQueuedTurn: noop,
    onRemoveQueuedTurn: noop,
    ...overrides,
  };
  await act(async () => {
    root.render(
      React.createElement(
        LocaleContext.Provider,
        { value: { locale: "en-US", t: (key) => translate(key, "en-US") } },
        React.createElement(ChatComposerBar, props),
      ),
    );
  });
}

const focusCalls = [];
const composerRef = {
  current: { focus: () => focusCalls.push("composer"), cancelTransientText: noop },
};
const approvalBar = () =>
  React.createElement("section", { tabIndex: -1, "data-test-approval": "" }, "approval");

test("the composer gets the caret back when the answered approval bar goes away", async () => {
  focusCalls.length = 0;
  await render({ composerRef, approvalBar: approvalBar() });
  const bar = container.querySelector("[data-test-approval]");
  bar.focus();
  assert.equal(doc.activeElement === bar, true);
  await render({ composerRef, approvalBar: null });
  assert.deepEqual(focusCalls, ["composer"]);
});

test("a caret the user moved elsewhere meanwhile is left alone", async () => {
  focusCalls.length = 0;
  const other = doc.createElement("input");
  doc.body.appendChild(other);
  try {
    await render({ composerRef, approvalBar: approvalBar() });
    other.focus();
    await render({ composerRef, approvalBar: null });
    assert.deepEqual(focusCalls, []);
  } finally {
    other.remove();
  }
});

test("rendering without an approval bar never grabs focus", async () => {
  focusCalls.length = 0;
  await render({ composerRef, approvalBar: null });
  await render({ composerRef, approvalBar: null, inputPlaceholder: "Ask again" });
  assert.deepEqual(focusCalls, []);
});

for (const surface of ["desktop", "web"]) {
  test(`plan mode is independent of the permission menu on ${surface}`, async () => {
    await render({ surface, showExecutionControls: true });
    const add = container.querySelector(".composer-add-trigger");
    await act(async () => add.click());
    const plan = [...doc.querySelectorAll('[role="menuitemcheckbox"]')]
      .find((item) => item.textContent === "Plan mode");
    assert.ok(plan);
    assert.equal(plan.getAttribute("aria-checked"), "false");
    await act(async () => plan.click());
    assert.deepEqual(controlChanges, [{ planModeEnabled: true }]);
    assert.deepEqual(modeChanges, []);
    await render({
      surface,
      showExecutionControls: true,
      chatRuntimeControls: { planModeEnabled: true },
    });
    assert.equal(plan.getAttribute("aria-checked"), "true");
    await act(async () => add.click());

    const permission = container.querySelector('[aria-label^="Command execution mode"]');
    await act(async () => permission.click());
    const rows = [...doc.querySelectorAll('[role="menuitem"]')];
    assert.equal(rows.some((row) => /^(Plan mode|Full access)/.test(row.textContent)), false);
    const always = rows.find((row) => row.textContent.startsWith("Always allow"));
    assert.ok(always);
    await act(async () => always.click());
    assert.deepEqual(modeChanges, ["always"]);
    assert.deepEqual(controlChanges, []);
    const planChip = container.querySelector('[aria-label="Turn off plan mode"]');
    await act(async () => planChip.click());
    assert.deepEqual(controlChanges, [{ planModeEnabled: false }]);
  });
}
