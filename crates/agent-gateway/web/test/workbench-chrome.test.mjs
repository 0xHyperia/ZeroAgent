import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeClassGroups } from "../../../agent-ui/test-support/source-class-groups.mjs";

const gatewayAppViewSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);
const webStyleClassesSource = readFileSync(
  new URL("../src/lib/webStyleClasses.ts", import.meta.url),
  "utf8",
);
const composerSource = normalizeClassGroups(readFileSync(
  new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
  "utf8",
));
const sidebarSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx", import.meta.url),
  "utf8",
);
const sidebarShellSource = readFileSync(
  new URL("../../../agent-ui/src/components/ui/sidebar.tsx", import.meta.url),
  "utf8",
);
const sheetSource = readFileSync(
  new URL("../../../agent-ui/src/components/ui/sheet.tsx", import.meta.url),
  "utf8",
);

test("gateway mounts workbench chrome outside the shared application view", () => {
  const shellIndex = gatewayAppViewSource.indexOf("<WorkbenchShell");
  const chromeIndex = gatewayAppViewSource.indexOf("<AppWorkbenchChrome");
  const bodyIndex = gatewayAppViewSource.indexOf("<WorkbenchBody");
  const mainPanelIndex = gatewayAppViewSource.indexOf("<DeviceWorkbenchLayout");
  const mainIndex = gatewayAppViewSource.indexOf("<main", bodyIndex);
  const applicationViewIndex = gatewayAppViewSource.indexOf("<ApplicationView", mainIndex);
  assert.ok(chromeIndex >= 0 && chromeIndex < shellIndex && shellIndex < bodyIndex);
  assert.ok(bodyIndex < mainPanelIndex && mainPanelIndex < mainIndex && mainIndex < applicationViewIndex);
  assert.match(gatewayAppViewSource.slice(mainPanelIndex, mainIndex), /chrome=\{workbenchChrome\}/);
  const mainOpening = gatewayAppViewSource.slice(mainIndex, gatewayAppViewSource.indexOf(">", mainIndex));
  assert.match(mainOpening, /className=\{accountDestination \? "hidden" : GATEWAY_MAIN_SHELL_CLASS\}/);
  assert.match(mainOpening, /inert=\{!!accountDestination\}/);
  const mainClass = webStyleClassesSource.match(/GATEWAY_MAIN_SHELL_CLASS\s*=\s*\n?\s*"([^"]+)"/);
  assert.ok(mainClass, "gateway-main-shell class constant not found");
  const mainClassNames = new Set(mainClass[1].split(/\s+/));
  for (const className of [
    "relative",
    "flex",
    "h-full",
    "min-w-0",
    "flex-1",
    "flex-col",
    "items-stretch",
    "overflow-hidden",
  ]) {
    assert.ok(
      mainClassNames.has(className),
      `gateway-main-shell is missing ${className}`,
    );
  }
  assert.doesNotMatch(gatewayAppViewSource, /chat=\{\{[\s\S]*?headerOverlay:/);
});

test("gateway shows the conversation view switcher in chrome only after an assistant reply", () => {
  const chromeIndex = gatewayAppViewSource.indexOf("<AppWorkbenchChrome");
  const tabsIndex = gatewayAppViewSource.indexOf("<ConversationViewTabs");
  const bodyIndex = gatewayAppViewSource.indexOf("<WorkbenchBody");

  assert.ok(chromeIndex >= 0);
  assert.ok(tabsIndex > chromeIndex);
  assert.ok(tabsIndex < bodyIndex);
  assert.equal(gatewayAppViewSource.match(/<ConversationViewTabs/g)?.length, 1);
  assert.match(
    gatewayAppViewSource,
    /const hasConversationReply =[\s\S]*?displayedConversationId !== "" &&[\s\S]*?!isLocalDraftConversationId\(displayedConversationId\)[\s\S]*?trajectoryMessages\.some\(\(message\) => message\.role === "assistant"\)/,
  );
  const chrome = gatewayAppViewSource.slice(chromeIndex, bodyIndex);
  assert.match(gatewayAppViewSource, /const showConversationViews =\s*!accountDestination\s*&&\s*activeView === "chat"\s*&&\s*hasConversationReply\s*&&\s*!workbenchHasMultiplePanes/);
  assert.match(chrome, /!compactDeviceHeader && showConversationViews\s*\?\s*\(\s*<ConversationViewTabs/);
  assert.match(chrome, /\{showConversationViews && \([\s\S]*?setActiveConversationView\(\s*renderedConversationView === "trajectory" \? "conversation" : "trajectory",?\s*\)/);
  assert.match(
    gatewayAppViewSource,
    /useConversationViewState\(displayedConversationId\)/,
  );
  assert.doesNotMatch(gatewayAppViewSource, /useState<ConversationViewId>/);
  assert.match(
    gatewayAppViewSource,
    /hidden=\{renderedConversationView === "trajectory"\}/,
  );
  assert.match(
    composerSource,
    /\(hidden \|\| imageEdit\?\.hidden\) && "hidden"/,
  );
});

test("the device header enables touch targets only in the mobile workbench", () => {
  assert.match(
    gatewayAppViewSource,
    /const compactDeviceHeader =\s*compactViewport\s*&&\s*!desktopHost\s*&&\s*!historyShareToken\s*&&\s*!accountDestination/,
  );
  assert.match(gatewayAppViewSource, /<AppWorkbenchChrome\s+settings=\{settings\}\s+mobile=\{compactDeviceHeader\}/);
  assert.match(gatewayAppViewSource, /compactDeviceHeader \? "min-h-11 min-w-11"/);
  for (const path of [
    "components/chat/ChatHeader.tsx",
    "components/chat/ConversationViewTabs.tsx",
    "components/project-tools/ProjectToolsPanelToggle.tsx",
  ]) {
    const source = readFileSync(new URL(`../../../agent-ui/src/${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /max-820:(?:size|h|min-h|min-w)-11/);
  }
});

test("web composer column clamps the clarify panel so new turns scroll inside it", () => {
  // 输入层 absolute 贴底、聊天区 overflow-hidden：面板 max-h-[40vh] 在矮 Pane
  // 里可能还没触顶就被外层裁掉，内部 overflow-y-auto 永不生效。列必须是
  // 有上限的 flex 列，并允许 [data-clarify-panel] 收缩。
  assert.match(
    composerSource,
    /gateway-composer-layer[^"\n]*max-h-full/,
  );
  assert.match(
    composerSource,
    /gateway-chat-column[^"\n]*flex[^"\n]*min-w-0[^"\n]*max-h-full[^"\n]*flex-col[^"\n]*justify-end/,
  );
  assert.match(
    composerSource,
    /\[&_\[data-clarify-panel\]\]:min-h-0[^"\n]*\[&_\[data-clarify-panel\]\]:shrink/,
  );
});

test("mobile sidebar stays above the interactive workbench header", () => {
  assert.match(
    webStyleClassesSource,
    /max-820:\[&_\[data-app-workbench-chrome\]\]:z-\(--layer-raised\)/,
  );
  // 移动端侧栏不再是行内 fixed 元素，而是 ui/sidebar 壳在窄屏下换成的 Sheet（Portal
  // + layer-modal）：模态层本身就高于工作台的 layer-raised，无需自带 z-index。
  assert.match(sidebarShellSource, /if \(isMobile\) \{[\s\S]*?<Sheet open=\{openMobile\}/);
  assert.match(sidebarShellSource, /data-mobile="true"/);
  assert.match(sheetSource, /"layer-modal fixed flex max-h-full min-h-0 min-w-0 flex-col overflow-hidden"/);
  assert.doesNotMatch(sidebarSource, /web:max-820:z-/);
});
