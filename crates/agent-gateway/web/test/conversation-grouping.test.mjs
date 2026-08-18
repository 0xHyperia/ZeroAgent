import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebarContainerSource = readFileSync(
  new URL("../src/app/sidebar/GatewaySidebarContainer.tsx", import.meta.url),
  "utf8",
);
const sidebarSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ChatHistorySidebar.tsx", import.meta.url),
  "utf8",
);
const cloudChatSource = readFileSync(
  new URL("../src/pages/CloudChatPage.tsx", import.meta.url),
  "utf8",
);

test("gateway sidebar separates workspace and unscoped conversations", () => {
  assert.match(
    sidebarContainerSource,
    /Array\.from\(conversationIndex\.values\(\)\)\.filter\(\(item\) => !item\.cwd\?\.trim\(\)\)/,
  );
  assert.match(sidebarContainerSource, /buildChatHistorySidebarBaseProps\(props, \{[\s\S]*?items,[\s\S]*?taskItems,/);
  assert.match(sidebarSource, /activeScopedProject\?\.id !== project\.id/);
  assert.match(sidebarSource, /selectedProjectIsHidden \? projectSections : slicedSections\.sections/);
  assert.match(sidebarSource, /onNewConversationForProject=\{onNewConversationForProject\}/);
  assert.match(sidebarSource, /\{items\.map\(\(item\) => renderHistoryRow\(item\)\)\}/);
  assert.match(sidebarSource, /const item = taskItems\[virtualRow\.index\]/);
});

test("cloud chat lists only cloud-runtime conversations", () => {
  assert.match(cloudChatSource, /"\/api\/web-chat\/conversations"/);
  assert.doesNotMatch(cloudChatSource, /\/api\/conversation-routes/);
  assert.doesNotMatch(cloudChatSource, /DEVICE_ROUTE_PREFIX|deviceConversations/);
});
