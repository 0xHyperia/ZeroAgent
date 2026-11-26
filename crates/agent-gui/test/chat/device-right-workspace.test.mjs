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
const { requestWorkspaceRevision, WorkspaceFileRuntimeError } = loadModule(
  "@liveagent/ui/components/workspace-editor/requestWorkspaceRevision",
);
const { FileRuntimeSettings } = loadModule("@liveagent/ui/pages/settings/FileRuntimeSettings");
const { createReadingSnapshotStore } = loadModule(
  "@liveagent/ui/components/resource-preview/readingSession",
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
  }), (error) => {
    assert.match(error.message, /文件运行时.*批注已保留/);
    assert.match(error.message, /执行设备.*ZeroAgent 设置/);
    assert.equal(error.openSetup, undefined);
    return true;
  });
  let openedSetup = 0;
  let openSetup;
  await assert.rejects(requestWorkspaceRevision(revision, {
    ...host,
    checkFileRuntime: async () => ({ ready: false, phase: "missing" }),
    openFileRuntimeSetup: () => { openedSetup += 1; },
    importSources: () => assert.fail("local setup must precede uploading"),
  }), (error) => {
    assert.ok(error instanceof WorkspaceFileRuntimeError);
    assert.match(error.message, /此电脑.*批注已保留/);
    openSetup = error.openSetup;
    assert.equal(typeof openSetup, "function");
    return true;
  });
  assert.equal(openedSetup, 0);
  assert.equal(openSetup(), true);
  assert.equal(openedSetup, 1);
  current = false;
  assert.equal(openSetup(), false);
  assert.equal(openedSetup, 1);
  current = true;
  await assert.rejects(requestWorkspaceRevision(revision, {
    ...host,
    checkFileRuntime: async () => ({ ready: false, phase: "pending_restart" }),
  }), /重启执行设备上的 ZeroAgent.*批注已保留/);
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

test("preparing file tools requires a local choice and stays pending until an explicit restart", async (t) => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  t.after(async () => {
    await act(async () => root.unmount());
    element.remove();
  });
  const prepareCalls = [];
  let checks = 0;
  let restartCalls = 0;
  let finishDownload;
  let status = {
    phase: "missing",
    ready: false,
    version: "1.2.3",
    download_bytes: 600_000_000,
    can_download: true,
    can_import: true,
    enabled: true,
    can_manage: true,
    can_remove: false,
  };
  const controls = {
    status: async () => {
      checks += 1;
      return status;
    },
    prepare: async (source) => {
      prepareCalls.push(source);
      if (source === "download") {
        status = { ...status, phase: "downloading", downloaded_bytes: 100_000_000 };
        return new Promise((resolve) => { finishDownload = () => resolve(status); });
      }
      return status;
    },
    restart: async () => {
      restartCalls += 1;
      return true;
    },
  };
  const button = (text) => Array.from(element.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  await act(async () => root.render(React.createElement(FileRuntimeSettings, { controls })));
  assert.match(element.textContent, /版本 1\.2\.3.*下载大小/);
  assert.equal(checks, 1);
  assert.deepEqual(prepareCalls, []);
  await act(async () => button("选择离线安装包").click());
  assert.deepEqual(prepareCalls, ["offline"]);
  assert.ok(button("下载并准备"), "canceling the file picker leaves setup available");
  await act(async () => button("下载并准备").click());
  assert.deepEqual(prepareCalls, ["offline", "download"]);
  assert.equal(element.querySelector("progress").value, 100_000_000);
  assert.equal(button("下载并准备"), undefined);
  status = { ...status, phase: "pending_restart" };
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    finishDownload();
  });
  assert.equal(restartCalls, 0);
  assert.equal(button("选择离线安装包"), undefined);
  await act(async () => button("重启 ZeroAgent").click());
  assert.equal(restartCalls, 1);
});

test("file tools can be disabled, diagnosed and explicitly removed", async (t) => {
  const element = document.body.appendChild(document.createElement("div"));
  const root = createRoot(element);
  t.after(async () => {
    await act(async () => root.unmount());
    element.remove();
  });
  let status = {
    phase: "ready", ready: true, enabled: true, can_manage: true,
    can_remove: true, can_download: true, can_import: true,
  };
  const actions = [];
  const controls = {
    status: async () => status,
    diagnose: async () => {
      actions.push("diagnose");
      return status;
    },
    manage: async (action) => {
      actions.push(action);
      const removal = action === "remove";
      status = { ...status, enabled: false, phase: removal ? "pending_removal" : "pending_disable",
        can_remove: !removal, can_download: false, can_import: false };
      return status;
    },
    restart: async () => true,
  };
  const button = (name) => Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === name,
  );
  await act(async () => root.render(React.createElement(FileRuntimeSettings, { controls })));
  assert.ok(button("重新安装"));
  await act(async () => button("诊断").click());
  assert.match(element.textContent, /检查完成，文件工具可用/);

  await act(async () => element.querySelector("[role=switch]").click());
  assert.match(element.textContent, /重启 ZeroAgent 后停用文件工具/);
  assert.equal(button("重新安装").disabled, true);
  assert.ok(button("移除"));

  await act(async () => button("移除").click());
  assert.deepEqual(actions, ["diagnose", "disable"]);
  await act(async () => button("取消").click());
  assert.deepEqual(actions, ["diagnose", "disable"]);
  await act(async () => button("移除").click());
  await act(async () => button("确认移除").click());
  assert.deepEqual(actions, ["diagnose", "disable", "remove"]);
  assert.match(element.textContent, /重启 ZeroAgent，以移除本机文件工具/);
  assert.ok(button("重启 ZeroAgent"));

  status = { ...status, external: true, phase: "ready", enabled: true, can_remove: false };
  await act(async () => window.dispatchEvent(new Event("focus")));
  assert.match(element.textContent, /开发环境或应用自带资源/);
  assert.match(element.textContent, /缺少用于验证安装包的清单/);
  assert.equal(button("重新安装").disabled, true);
  assert.equal(button("移除"), undefined);
  await act(async () => button("解除关联").click());
  await act(async () => button("确认解除关联").click());
  assert.deepEqual(actions, ["diagnose", "disable", "remove", "disable"]);
});

test("a retained reader draft restores only to the matching file view and clears on send", () => {
  const saved = new Map();
  const recovery = {
    read: (key) => saved.get(key),
    write: (key, comments) => {
      if (comments.length) saved.set(key, JSON.parse(JSON.stringify(comments)));
      else saved.delete(key);
      return true;
    },
  };
  const identity = JSON.stringify(["account", "conversation", "file.pdf", "original-sha256"]);
  const comments = [{ id: "first", page: 1, block: "b1", start: 0, end: 1, quote: "a", comment: "b" }];
  const before = createReadingSnapshotStore();
  before.write(identity, "documentComments", comments);
  assert.equal(saved.size, 0, "ordinary drafts remain in memory");
  assert.equal(before.retainDocumentComments(identity, comments, recovery), true);
  const after = createReadingSnapshotStore();
  assert.equal(after.readDocumentComments(
    JSON.stringify(["account", "conversation", "file.pdf", "replaced-sha256"]), recovery,
  ), undefined);
  assert.deepEqual(after.readDocumentComments(identity, recovery), comments);
  const edited = [{ ...comments[0], comment: "updated" }];
  after.write(identity, "documentComments", edited, recovery);
  assert.deepEqual(createReadingSnapshotStore().readDocumentComments(identity, recovery), edited);
  after.write(identity, "documentComments", [], recovery);
  assert.equal(createReadingSnapshotStore().readDocumentComments(identity, recovery), undefined);
  saved.set(identity, [{ ...comments[0], page: 0 }]);
  assert.equal(createReadingSnapshotStore().readDocumentComments(identity, recovery), undefined);
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
