import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

test("device conversation keeps its draft and requires fresh online status after reconnect", async (t) => {
  const env = await createWebDomTestEnv();
  const { React, act, createRoot } = env;
  const { useGatewayChatPresentation } = env.loadModule("src/app/hooks/useGatewayChatPresentation.tsx");
  const { GatewayDeviceConnectionNotice } = env.loadModule("src/app/GatewayDeviceConnectionNotice.tsx");
  const { LocaleContext, t: translate } = env.loadModule("@liveagent/ui/i18n/index.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  });

  let attempts = 0;
  let deviceChoices = 0;
  let resolveAttempt;
  let rejectAttempt;
  const reconnect = () => {
    attempts += 1;
    return new Promise((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
  };
  const settings = { locale: "en-US" };
  const locale = { locale: settings.locale, t: (key) => translate(key, settings.locale) };
  const base = {
    activeView: "chat",
    token: "test",
    settings,
    displayedConversationId: "saved-conversation",
    displayedConversationWorkdir: "/project",
    displayedTranscript: { rows: [] },
    selectedHistoryId: "",
    sidebarConversationsById: new Map(),
    transcriptStoreRegistry: new Map(),
    enabledComposerSkills: [],
    isAgentMode: true,
    isLocalDraftConversationId: () => false,
    chatCommandHasPending: () => false,
  };
  let presentation;
  function Harness({ connectionLost, statusFresh, online, historyOpenFailed }) {
    presentation = useGatewayChatPresentation({
      ...base,
      gatewayConnectionLost: connectionLost,
      sidebarAgentStatusFresh: statusFresh,
      status: { online },
      historyOpenFailed,
    });
    return React.createElement(
      LocaleContext.Provider,
      { value: locale },
      React.createElement(GatewayDeviceConnectionNotice, {
        unavailable: presentation.sidebarSectionsDisabled,
        connectionLost,
        agentOnline: online,
        statusReadFailed: false,
        draftEditable: presentation.composerDraftOnly,
        deviceName: "Original workstation",
        onReconnect: reconnect,
        onChooseDevice: () => { deviceChoices += 1; },
      }),
      React.createElement("textarea", {
        defaultValue: "Unsent reply",
        disabled: presentation.composerInputDisabled && !presentation.composerDraftOnly,
      }),
      React.createElement("button", { "data-send": "", disabled: presentation.composerInputDisabled }, "Send"),
    );
  }

  const render = (connectionLost, statusFresh, online = true, historyOpenFailed = false) =>
    act(async () => root.render(React.createElement(Harness, { connectionLost, statusFresh, online, historyOpenFailed })));
  const notice = () => host.querySelector('[role="status"]');
  const send = () => host.querySelector("[data-send]");
  await render(false, true);
  const draft = host.querySelector("textarea");
  assert.equal(notice(), null);
  assert.equal(draft.disabled, false);
  assert.equal(presentation.canDropUpload, true);

  await render(true, false);
  assert.match(notice().textContent, /Connection interrupted.*Keep editing your draft/);
  assert.equal(draft.disabled, false);
  assert.equal(send().disabled, true, "stale online status cannot accept a send");
  draft.value = "Reply edited offline";
  assert.equal(presentation.canDropUpload, false);
  const action = notice().querySelector("button");
  await act(async () => {
    action.focus();
    action.click();
    action.click();
  });
  assert.equal(attempts, 1);
  assert.match(notice().textContent, /Reconnecting/);
  assert.equal(action.getAttribute("aria-disabled"), "true");
  assert.equal(document.activeElement, action);
  await act(async () => rejectAttempt(new Error("network unavailable")));
  assert.equal(action.getAttribute("aria-disabled"), "false");
  assert.match(notice().textContent, /Connection interrupted/);

  await render(false, false);
  assert.match(notice().textContent, /Checking the device connection/);
  assert.equal(draft.disabled, false);
  assert.equal(send().disabled, true, "socket authentication alone cannot unlock sending");
  await render(false, true, false);
  assert.match(notice().textContent, /Original workstation is offline/);
  const choose = [...notice().querySelectorAll("button")].find((button) => button.textContent === "Choose another device");
  assert.equal(deviceChoices, 0, "an offline detection must not switch the target");
  await act(async () => choose.click());
  assert.equal(deviceChoices, 1);
  assert.equal(draft.value, "Reply edited offline");
  await act(async () => notice().querySelector("button").click());
  assert.equal(attempts, 2);
  await act(async () => resolveAttempt());
  await render(false, true, true, true);
  assert.equal(notice(), null);
  assert.equal(draft.disabled, true, "an online connection cannot unlock unreadable device history");
  assert.equal(presentation.canDropUpload, false);
  assert.equal(draft.value, "Reply edited offline");
  await render(false, true);
  assert.equal(notice(), null);
  assert.equal(host.querySelector("textarea"), draft);
  assert.equal(draft.value, "Reply edited offline");
  assert.equal(draft.disabled, false);
  assert.equal(send().disabled, false);
});

test("an unavailable draft identifies its original workspace and offers an in-place retry", async (t) => {
  const env = await createWebDomTestEnv();
  const { React, act, createRoot } = env;
  const { GatewaySavedDeviceDraftNotice } = env.loadModule("src/app/GatewayDeviceConnectionNotice.tsx");
  const { LocaleContext, t: translate } = env.loadModule("@liveagent/ui/i18n/index.ts");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    env.cleanup();
  });
  let retries = 0;
  const render = (locale, state) => act(async () => root.render(React.createElement(
    LocaleContext.Provider,
    { value: { locale, t: (key) => translate(key, locale) } },
    React.createElement(GatewaySavedDeviceDraftNotice, {
      state,
      path: "C:/work/original project",
      onRetry: () => retries++,
    }),
  )));
  await render("zh-CN", "workspace");
  const status = host.querySelector('[role="status"]');
  const button = status.querySelector("button");
  assert.match(status.textContent, /原工作区暂不可用.*C:\/work\/original project/);
  assert.equal(button.textContent, "重试恢复");
  await act(async () => {
    button.focus();
    button.click();
  });
  assert.equal(retries, 1);
  await render("en-US", "current-draft");
  assert.match(status.textContent, /Your current draft is in the sidebar\. Open an empty device conversation/);
  assert.equal(button.textContent, "Retry restoring draft");
  assert.equal(document.activeElement, button);
});
