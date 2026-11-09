import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot, loadModule } = env;
const { useWorkspaceOverlays } = loadModule(
  "@liveagent/ui/components/workspace-editor/useWorkspaceOverlays.ts",
);
const { useChangedFilesActions } = loadModule("@liveagent/ui/lib/chat/useChangedFilesActions.ts");
const { useConversationRightDock } = loadModule("@liveagent/ui/lib/projectTools/useConversationRightDock.ts");
const { useRightDockSettings } = loadModule("@liveagent/ui/lib/projectTools/useRightDockSettings.ts");
const { getDefaultSettings } = loadModule("@liveagent/app/lib/settings");
const settings = getDefaultSettings();
const noop = () => {};

test("switching conversations restores their own editor and reader and isolates late actions", async (t) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  let view;
  let diff;
  let dock;
  let dockSettings;
  function Harness(props) {
    dock = useConversationRightDock(props.workspaceOwner, props.conversationId);
    dockSettings = useRightDockSettings({
      settings,
      setSettings: noop,
      terminalProjectPathKey: props.terminalProjectPathKey,
      dock,
    });
    view = useWorkspaceOverlays({ ...props, rightDockFileTreeOpen: dockSettings.rightDockFileTreeOpen });
    diff = useChangedFilesActions({
      terminalProjectPathKey: props.terminalProjectPathKey,
      workspaceViewScope: view.workspaceViewScope,
      onOpenFile: noop,
      setRightDockOpen: dock.setRightDockOpen,
      onDockToolStateChange: dockSettings.handleRightDockProjectStateChange,
    });
    return null;
  }
  async function render(conversationId, project = "/repo", workspaceOwner = "account:device") {
    await act(async () => {
      root.render(React.createElement(Harness, {
        conversationId,
        terminalProjectPath: project,
        terminalProjectPathKey: project,
        workspaceOwner,
      }));
    });
  }

  await render("A");
  await act(async () => {
    view.handleOpenWorkspaceFile("/repo/a.ts");
    diff.handleChangedFileOpenDiff("a.ts");
  });
  const aEditor = view.workspaceEditors[0];
  assert.equal(aEditor.request.path, "/repo/a.ts");
  assert.equal(aEditor.open, true);
  const aScope = view.workspaceViewScope;
  const aRequest = aEditor.request.id;
  const revealInA = diff.handleChangedFileReveal;
  assert.equal(dock.rightDockOpen, true);
  assert.equal(dockSettings.rightDockProjectState.activeTabId, "tool:gitReview");

  await render("B");
  assert.notEqual(view.workspaceViewScope, aEditor.scope);
  assert.equal(view.workspaceEditors[0].request, aEditor.request);
  assert.equal(diff.gitReviewFocusRequest, null);
  assert.equal(view.workspaceFilePreviewOpen, false);
  assert.equal(dock.rightDockOpen, false);
  assert.equal(dockSettings.rightDockProjectState.activeTabId, undefined);
  await act(async () => diff.handleChangedFileReveal("b-dir/b.ts"));
  assert.equal(dockSettings.rightDockFileTreeState.selectedPath, "b-dir/b.ts");
  await act(async () => dock.setRightDockOpen(false));
  await act(async () => view.handleOpenWorkspaceFile("/repo/b.pdf"));
  const lateCloseB = view.handleWorkspaceFilePreviewClosed;
  assert.equal(view.workspaceFilePreviewOpenRequest.path, "/repo/b.pdf");

  await render("A");
  assert.equal(dock.rightDockOpen, true);
  assert.equal(dockSettings.rightDockProjectState.activeTabId, "tool:gitReview");
  assert.equal(view.workspaceFilePreviewOpen, false);
  assert.equal(diff.gitReviewFocusRequest.path, "a.ts");
  assert.equal(view.workspaceEditors[0].request, aEditor.request);
  assert.equal(view.workspaceEditors[0].open, true);
  await act(async () => view.handleOpenWorkspaceFile("/repo/a.pdf"));

  await render("B");
  assert.equal(dock.rightDockOpen, false);
  assert.equal(dockSettings.rightDockFileTreeState.selectedPath, "b-dir/b.ts");
  await act(async () => revealInA("a-dir/a.ts"));
  assert.equal(dock.rightDockOpen, false);
  assert.equal(dockSettings.rightDockFileTreeState.selectedPath, "b-dir/b.ts");
  assert.equal(view.workspaceFilePreviewOpenRequest.path, "/repo/b.pdf");
  await act(async () => view.handleOpenWorkspaceFile("/repo/b-new.pdf"));
  await act(async () => lateCloseB());
  await act(async () => view.handleWorkspaceEditorClosed(aScope, aRequest));
  assert.equal(view.workspaceFilePreviewOpenRequest.path, "/repo/b-new.pdf");
  assert.equal(view.workspaceFilePreviewOpen, true);
  await render("A", "/other");
  assert.equal(view.workspaceFilePreviewOpen, false);
  await render("A");
  assert.equal(dockSettings.rightDockFileTreeState.selectedPath, "a-dir/a.ts");
  assert.equal(view.workspaceFilePreviewOpenRequest.path, "/repo/a.pdf");
  await act(async () => dock.moveConversation("A", "C"));
  await render("C");
  assert.equal(dock.rightDockOpen, true);
  assert.equal(dockSettings.rightDockFileTreeState.selectedPath, "a-dir/a.ts");
  await render("C", "/repo", "other-account:device");
  assert.equal(dock.rightDockOpen, false);
  assert.equal(dockSettings.rightDockProjectState.activeTabId, undefined);
  assert.equal(view.workspaceFilePreviewOpen, false);
  assert.equal(view.workspaceEditors.length, 0);
  assert.equal(diff.gitReviewFocusRequest, null);
});

test.after(() => env.cleanup());
