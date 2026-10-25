import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const { selectRecentSidebarConversations } = createWebModuleLoader().loadModule(
  "@liveagent/ui/lib/sidebar/recentConversations.ts",
);

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
  const tasks = Object.freeze([
    Object.freeze({ id: "project", cwd: "/workspace" }),
    Object.freeze({ id: "task", cwd: "" }),
    Object.freeze({ id: "whitespace", cwd: "  " }),
    Object.freeze({ id: "pinned", cwd: "", isPinned: true }),
  ]);
  assert.deepEqual(selectRecentSidebarConversations(tasks, true).map((item) => item.id), ["task", "whitespace"]);
  assert.equal(selectRecentSidebarConversations(tasks, false), tasks);
  assert.match(
    sidebarContainerSource,
    /Array\.from\(conversationIndex\.values\(\)\)\.filter\(\(item\) => !item\.cwd\?\.trim\(\)\)/,
  );
  assert.match(sidebarContainerSource, /buildChatHistorySidebarBaseProps\(props, \{[\s\S]*?items,[\s\S]*?taskItems,/);
  assert.match(sidebarSource, /selectRecentSidebarConversations/);
  assert.match(sidebarSource, /workspaceHistory\?\.get\(key\)/);
  assert.match(sidebarSource, /onNewConversation=\{onNewConversationForProject\}/);
  assert.match(sidebarSource, /visible\.map\(\(item\) => renderHistoryRow\(item\)\)/);
  assert.match(sidebarSource, /const item = taskItems\[virtualRow\.index\]/);
});

test("cloud chat lists only cloud-runtime conversations", () => {
  assert.match(cloudChatSource, /"\/api\/web-chat\/conversations"/);
  assert.doesNotMatch(cloudChatSource, /\/api\/conversation-routes/);
  assert.doesNotMatch(cloudChatSource, /DEVICE_ROUTE_PREFIX|deviceConversations/);
});
