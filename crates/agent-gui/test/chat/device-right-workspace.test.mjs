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
const {
  buildDocumentRevisionMessage,
  copyDocumentRevision,
  documentRevisionEvidence,
  documentRevisionSource,
  parseDocumentRevisionMessage,
} = loadModule("@liveagent/ui/lib/chat/documentRevisionMessage");
const { buildUserMessageContentWithUploads, getUserMessageDisplayText, getUserMessageAttachments } =
  loadModule("@liveagent/ui/lib/chat/uploadedFiles");
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
  const screenshot = new File(["proof"], "pdf-comment-1-page-2.png", { type: "image/png" });
  const comments = [
    { id: "first", page: 2, block: "body", start: 0, end: 8, quote: "old text", comment: "new text" },
  ];
  const uploaded = [source, screenshot].map((file, index) => ({
    fileName: file.name,
    relativePath: `uploads/1/${file.name}`,
    absolutePath: `C:/profile/uploads/1/${file.name}`,
    kind: index === 0 ? "pdf" : "image",
    sizeBytes: file.size,
  }));
  let current = true;
  const revision = {
    source, comments, evidence: [screenshot], workspacePath: "D:/repo/report.pdf",
    assertCurrent: () => assert.ok(current),
  };
  const sent = [];
  const host = {
    workspaceRoot: "D:/repo",
    canSend: () => current,
    locale: "zh-CN",
    checkFileRuntime: async () => true,
    importSources: async (files) => {
      assert.deepEqual(files, [source, screenshot]);
      return uploaded;
    },
    send: async (text, files) => {
      sent.push({ text, files });
      return true;
    },
  };
  assert.equal(await requestWorkspaceRevision(revision, host), true);
  assert.match(sent[0].text, /D:\/repo\/report\.pdf.*in place/);
  assert.deepEqual(sent[0].files, uploaded);
  const persisted = { role: "user", content: buildUserMessageContentWithUploads(sent[0].text, uploaded) };
  const parsed = parseDocumentRevisionMessage(getUserMessageDisplayText(persisted));
  const reloadedAttachments = getUserMessageAttachments(persisted);
  assert.equal(documentRevisionSource(parsed, reloadedAttachments).absolutePath, uploaded[0].absolutePath);
  assert.equal(documentRevisionEvidence(parsed, reloadedAttachments)[0].fileName, screenshot.name);
  assert.equal(copyDocumentRevision(parsed), "report.pdf\nold text\nnew text");
  assert.equal(await requestWorkspaceRevision(revision, { ...host, workspaceRoot: "D:/other" }), true);
  assert.match(sent[1].text, /Save the edits as a new file or artifact version/);
  assert.doesNotMatch(sent[1].text, /D:\/repo\/report\.pdf/);
  await assert.rejects(requestWorkspaceRevision(revision, {
    ...host,
    checkFileRuntime: async () => false,
    importSources: () => assert.fail("missing runtime must stop before uploading"),
  }), /文件运行时.*批注已保留/);
  await assert.rejects(requestWorkspaceRevision(revision, {
    ...host,
    checkFileRuntime: async () => { throw new Error("device disconnected"); },
    importSources: () => assert.fail("an unavailable device must stop before uploading"),
  }), /无法核对.*批注已保留/);
  assert.equal(await requestWorkspaceRevision(revision, {
    ...host,
    importSources: async () => {
      current = false;
      return uploaded;
    },
  }), false);
  assert.equal(sent.length, 2);
});

test("reader revisions retain format-specific anchors without exposing instructions in the transcript", () => {
  const anchor = { id: "first", page: 1, block: "body", start: 2, end: 5, quote: "foo", comment: "改成\nbar" };
  for (const [name, kind, details, expected] of [
    ["报告.docx", "document", {}, '"block":"body"'],
    ["报告.pdf", "pdf", {
      pdf: { pageCount: 2, pageWidth: 600, pageHeight: 800, kind: "region" },
      region: { left: 0.1, top: 0.2, width: 0.3, height: 0.4 },
    }, '"bottomLeftY":320'],
    ["报价.xlsx", "workbook", { target: { kind: "sheet", sheet: "报价", range: "B2:C4" } }, "报价!B2:C4"],
    ["演示.pptx", "presentation", {
      target: { kind: "slide", slide: 1, element: { id: "7", name: "标题", kind: "shape" } },
    }, '"id":"7"'],
  ]) {
    const text = buildDocumentRevisionMessage(name, [{ ...anchor, ...details }, { ...anchor, id: "second" }]);
    assert.ok(text.includes(expected), name);
    const parsed = parseDocumentRevisionMessage(text);
    assert.equal(parsed.kind, kind);
    assert.equal(parsed.comments.length, 2);
    assert.equal(parsed.comments[0].comment, "改成\nbar");
    assert.doesNotMatch(copyDocumentRevision(parsed), /Diff comments|Anchor:|Side: R/);
  }
});
