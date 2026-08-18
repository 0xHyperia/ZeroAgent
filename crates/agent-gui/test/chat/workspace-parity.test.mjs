import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guiRoot = new URL("../../", import.meta.url);
const repoRoot = new URL("../../../../", import.meta.url);

function readSource(root, relativePath) {
  return readFileSync(new URL(relativePath, root), "utf8").replace(/\r\n/g, "\n");
}

test("desktop and WebUI expose workspaces whenever Agent mode is active", () => {
  const desktop = readSource(guiRoot, "src/pages/ChatPage.tsx");
  const web = readSource(repoRoot, "crates/agent-gateway/web/src/app/GatewayAppView.tsx");

  assert.match(desktop, /showProjects=\{isAgentMode\}/);
  assert.match(web, /showProjects=\{isAgentMode\}/);
  assert.doesNotMatch(desktop, /showProjects=\{isAgentMode\s*&&/);
});

test("desktop keeps the persisted default workspace instead of replacing it with plain chat", () => {
  const workspaceHook = readSource(
    guiRoot,
    "src/pages/chat/workspace/useWorkspaceProjects.ts",
  );

  assert.match(
    workspaceHook,
    /\(\) => mergeWorkspaceProjectsWithHistory\(settings\.system, sidebarWorkdirs\)/,
  );
  assert.doesNotMatch(workspaceHook, /name: t\("chat\.plainChat"\)/);
  assert.doesNotMatch(workspaceHook, /startNewConversationActionRef\.current\(\{ workdir: "" \}\)/);
});

test("desktop Agent conversations inherit the active workspace", () => {
  const desktop = readSource(guiRoot, "src/pages/ChatPage.tsx");

  assert.match(
    desktop,
    /workdir: isAgentMode \? activeWorkspaceProjectPath \|\| workdir : ""/,
  );
});

test("desktop keeps an empty draft aligned with the active workspace like WebUI", () => {
  const desktop = readSource(guiRoot, "src/pages/ChatPage.tsx");
  const web = readSource(repoRoot, "crates/agent-gateway/web/src/app/GatewayApp.tsx");

  assert.match(desktop, /Keep an empty draft conversation's workdir following the active project/);
  assert.match(web, /Keep an empty draft conversation's workdir following the active project/);
  assert.match(desktop, /workdir: nextWorkdir/);
  assert.match(web, /conversationWorkdirsRef\.current\.set\(conversationIdValue, nextWorkdir\)/);
});
