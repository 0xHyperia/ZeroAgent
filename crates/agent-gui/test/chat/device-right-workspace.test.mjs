import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv({
  rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)),
  mocks: {
    "@/lib/settings": { workspaceProjectPathKey: (path) => path.trim() },
    "@/lib/chatUi": {},
    "@/lib/workspace-activity/gatewayWorkspaceActivityClient": {},
    "@liveagent/app/lib/managed-process/backend": {},
    "@liveagent/app/shims/tauriCore": {
      invoke(command, payload) {
        assert.equal(command, "open_chat_file_link");
        const resolveLink = (resolve) => resolve({
          action: "preview",
          kind: "file",
          workdir: payload.path === "/uploads/report.pdf" ? "/uploads" : payload.workdir || project,
          path: payload.path === "/uploads/report.pdf" ? "report.pdf" : payload.path,
          outsideWorkspace: payload.path === "/uploads/report.pdf",
        });
        return new Promise((resolve) => {
          if (payload.path === "late.png") finishPendingLink = () => resolveLink(resolve);
          else resolveLink(resolve);
        });
      },
    },
  },
});
const { React, act, createRoot, loadModule } = env;
const { getDefaultSettings } = loadModule("@liveagent/ui/lib/settings");
const { useConversationRightDock } = loadModule("@liveagent/ui/lib/projectTools/useConversationRightDock");
const { useGatewayProjectTools } = loadModule("src/app/hooks/useGatewayProjectTools.ts");
const { requestWorkspaceRevision } = loadModule(
  "@liveagent/ui/components/workspace-editor/requestWorkspaceRevision",
);
test.after(() => env.cleanup());

const project = "/workspace";
const terminalClient = { subscribe: () => () => {} };
let finishPendingLink;

test("device file links and Git use shared tabs scoped to the conversation and device", async (t) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  let tools;
  let dockOpen;
  const errors = [];
  function Harness({ owner, conversationId, enableWebGit, conversationWorkdir }) {
    const dock = useConversationRightDock(owner, conversationId);
    const defaults = getDefaultSettings();
    dockOpen = dock.rightDockOpen;
    tools = useGatewayProjectTools({
      activeWorkspaceProjectPath: conversationWorkdir ? "/other-project" : project,
      addNotify: (_type, message) => errors.push(message),
      api: null,
      codeReviewSkill: null,
      composerRef: React.useRef(null),
      displayedConversationId: conversationId,
      displayedConversationWorkdir: conversationWorkdir,
      workspaceOwner: owner,
      isAgentMode: true,
      resetProjectToolsRuntimeRef: React.useRef(() => {}),
      dock,
      setSettings() {},
      settings: { ...defaults, remote: { ...defaults.remote, enableWebGit, enableWebTerminal: false } },
      settingsSyncReady: true,
      status: { online: true },
      terminalClient,
    });
    return null;
  }
  const render = (conversationId, owner = "device-a", enableWebGit = true, conversationWorkdir = project, key = "initial") =>
    act(async () => root.render(React.createElement(Harness, {
      key, owner, conversationId, enableWebGit, conversationWorkdir,
    })));

  await render("chat-a");
  assert.equal(tools.terminalProjectPath, project);
  await act(async () => tools.handleOpenWorkspaceFile("docs/notes.md", undefined, true));
  assert.equal(dockOpen, true);
  assert.equal(tools.workspaceTabs.view.tabs[0].temporary, true);
  const notesId = tools.workspaceTabs.view.tabs[0].id;
  await act(async () => tools.handleOpenChatFileLink({ path: "docs/notes.md", source: "markdown" }));
  assert.equal(tools.workspaceTabs.view.tabs.length, 1);
  assert.equal(tools.workspaceTabs.view.activeId, notesId);
  assert.equal(tools.workspaceTabs.view.tabs[0].temporary, false);
  assert.equal(tools.rightDockFileTreeState.selectedPath, "docs/notes.md");

  await act(async () => tools.changedFilesActions.onOpenDiff("src/main.ts"));
  assert.equal(tools.workspaceTabs.view.tabs[1].mode, "diff");
  await act(async () => tools.changedFilesActions.onRevealInFileTree("docs/notes.md"));
  assert.equal(tools.workspaceTabs.view.treeOpen, true);
  assert.deepEqual(tools.rightDockFileTreeState.expandedPaths, ["", "docs", "src"]);

  await render("chat-b", "device-a", false);
  assert.equal(dockOpen, false);
  assert.equal(tools.workspaceTabs.view.tabs.length, 0);
  await act(async () => tools.changedFilesActions.onOpenDiff("src/main.ts"));
  assert.equal(tools.workspaceTabs.view.tabs.length, 0);
  assert.equal(dockOpen, true);
  assert.ok(tools.gitDisabledMessage);

  await render("chat-a");
  assert.equal(dockOpen, true);
  assert.equal(tools.workspaceTabs.view.tabs.length, 2);
  assert.equal(tools.workspaceTabs.view.treeOpen, true);

  await act(async () => tools.handleOpenChatFileLink({ path: "late.png", source: "markdown" }));
  await render("chat-a", "device-b");
  await act(async () => finishPendingLink());
  assert.equal(tools.workspaceTabs.view.tabs.length, 0);
  assert.equal(tools.workspaceTabs.view.treeOpen, false);

  await render("chat-c", "device-b", true, "");
  await act(async () => tools.handleOpenChatFileLink({ path: "docs/remote.pdf", source: "relative" }));
  assert.equal(dockOpen, true);
  assert.equal(tools.workspaceTabs.view.tabs[0].request.path, "docs/remote.pdf");
  await act(async () => tools.handleOpenChatFileLink({ path: "/uploads/report.pdf", source: "absolute" }));
  assert.equal(tools.workspaceTabs.view.tabs[1].request.workdir, "/uploads");
  assert.equal(tools.workspaceTabs.view.tabs[1].request.path, "report.pdf");
  assert.equal(tools.workspaceTabs.view.tabs[1].request.stagedAttachment, undefined);
  await act(async () => tools.handleOpenChatFileLink({
    path: "/uploads/report.pdf", source: "absolute", preferPreview: true,
  }));
  assert.equal(tools.workspaceTabs.view.tabs.length, 2);
  assert.deepEqual(tools.workspaceTabs.view.tabs[1].request.stagedAttachment, {
    conversationId: "chat-c", path: "/uploads/report.pdf",
  });
  assert.deepEqual(errors, []);

  await render("chat-c", "device-b", true, "", "reload");
  assert.equal(dockOpen, true);
  assert.deepEqual(tools.workspaceTabs.view.tabs.map((tab) => tab.request.path), ["docs/remote.pdf"]);
  await render("chat-c", "device-c", true, "", "reload");
  assert.equal(dockOpen, false);
  assert.equal(tools.workspaceTabs.view.tabs.length, 0);
});

test("device document revisions attach the original and never send after the authorized scope changes", async () => {
  const source = new File(["original"], "report.pdf", { type: "application/pdf" });
  const comments = [
    { id: "first", page: 2, block: "body", start: 0, end: 8, quote: "old text", comment: "new text" },
  ];
  const uploaded = { fileName: "report.pdf", relativePath: "uploads/report.pdf" };
  let current = true;
  const revision = { source, comments, assertCurrent: () => assert.ok(current) };
  const sent = [];
  const host = {
    canSend: () => current,
    importSource: async (file) => {
      assert.equal(file, source);
      return [uploaded];
    },
    send: async (text, files) => {
      sent.push({ text, files });
      return true;
    },
  };
  assert.equal(await requestWorkspaceRevision(revision, host), true);
  assert.match(sent[0].text, /report\.pdf[\s\S]*old text[\s\S]*new text[\s\S]*保留原件/);
  assert.deepEqual(sent[0].files, [uploaded]);
  assert.equal(await requestWorkspaceRevision(revision, {
    ...host,
    importSource: async () => {
      current = false;
      return [uploaded];
    },
  }), false);
  assert.equal(sent.length, 1);
});
