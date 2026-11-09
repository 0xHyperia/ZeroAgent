import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalSession } from "../../lib/terminal/types";
import type { WorkspaceCodeEditorOpenRequest } from "./WorkspaceCodeEditorOverlay";
import type { WorkspaceFilePreviewOpenRequest } from "./WorkspaceFilePreviewOverlay";
import type { SftpOpenFileRequest } from "./WorkspaceSftpPanel";
import type { WorkspaceSshTerminalOpenRequest } from "./WorkspaceSshTerminalOverlay";
import { isWorkspacePreviewPath } from "./workspaceImagePreview";

type UseWorkspaceOverlaysParams = {
  workspaceOwner: string;
  conversationId: string;
  terminalProjectPath: string;
  terminalProjectPathKey: string;
  rightDockFileTreeOpen: boolean;
};

type EditorView = {
  request: WorkspaceCodeEditorOpenRequest;
  open: boolean;
  closeRequestId: number;
  cleanupPending?: boolean;
};

type FileView = {
  editor?: EditorView;
  preview?: { request: WorkspaceFilePreviewOpenRequest; open: boolean };
};

const EMPTY_VIEWS: ReadonlyMap<string, FileView> = new Map();

export function useWorkspaceOverlays({
  workspaceOwner,
  conversationId,
  terminalProjectPath,
  terminalProjectPathKey,
  rightDockFileTreeOpen,
}: UseWorkspaceOverlaysParams) {
  const workspaceViewScope = JSON.stringify([
    workspaceOwner,
    conversationId,
    terminalProjectPathKey,
  ]);
  const [fileViews, setFileViews] = useState({ owner: workspaceOwner, views: EMPTY_VIEWS });
  const views = fileViews.owner === workspaceOwner ? fileViews.views : EMPTY_VIEWS;
  const view = views.get(workspaceViewScope);
  const activeView = useRef({ owner: workspaceOwner, scope: workspaceViewScope });
  activeView.current = { owner: workspaceOwner, scope: workspaceViewScope };
  const requestId = useRef(0);
  const previousFileTree = useRef({ owner: "", scope: "", open: false });
  const [ssh, setSsh] = useState<{
    owner: string;
    scope: string;
    request: WorkspaceSshTerminalOpenRequest;
    open: boolean;
  } | null>(null);
  const activeSsh = ssh?.owner === workspaceOwner && ssh.scope === workspaceViewScope ? ssh : null;
  const returnToSsh = useRef<{ owner: string; scope: string } | null>(null);

  useEffect(() => {
    setFileViews((current) =>
      current.owner === workspaceOwner ? current : { owner: workspaceOwner, views: EMPTY_VIEWS },
    );
    setSsh((current) => (current?.owner === workspaceOwner ? current : null));
    if (returnToSsh.current?.owner !== workspaceOwner) returnToSsh.current = null;
  }, [workspaceOwner]);

  const updateView = useCallback(
    (scope: string, update: (current: FileView) => FileView) => {
      setFileViews((current) => {
        if (activeView.current.owner !== workspaceOwner) return current;
        const scopedViews = current.owner === workspaceOwner ? current.views : EMPTY_VIEWS;
        const before = scopedViews.get(scope) ?? {};
        const after = update(before);
        if (after === before) return current;
        const next = new Map(scopedViews);
        if (after.editor || after.preview) next.set(scope, after);
        else next.delete(scope);
        return { owner: workspaceOwner, views: next };
      });
    },
    [workspaceOwner],
  );

  const setWorkspaceSshTerminalOpen = useCallback(
    (open: boolean) => {
      setSsh((current) =>
        current?.owner === workspaceOwner && current.scope === workspaceViewScope
          ? { ...current, open }
          : current,
      );
    },
    [workspaceOwner, workspaceViewScope],
  );

  const hideWorkspaceSshTerminalOverlay = useCallback(
    () => setWorkspaceSshTerminalOpen(false),
    [setWorkspaceSshTerminalOpen],
  );

  const restoreSshTerminal = useCallback(
    (scope: string) => {
      if (returnToSsh.current?.owner !== workspaceOwner || returnToSsh.current.scope !== scope)
        return;
      returnToSsh.current = null;
      setSsh((current) =>
        current?.owner === workspaceOwner && current.scope === scope
          ? { ...current, open: true }
          : current,
      );
    },
    [workspaceOwner],
  );

  const openWorkspaceEditorFile = useCallback(
    (request: Omit<WorkspaceCodeEditorOpenRequest, "id">) => {
      hideWorkspaceSshTerminalOverlay();
      const editor = {
        request: { id: ++requestId.current, ...request },
        open: true,
        closeRequestId: 0,
      };
      updateView(workspaceViewScope, (current) => ({
        editor: { ...editor, closeRequestId: current.editor?.closeRequestId ?? 0 },
        preview: current.preview && { ...current.preview, open: false },
      }));
    },
    [hideWorkspaceSshTerminalOverlay, updateView, workspaceViewScope],
  );

  const openWorkspaceFilePreview = useCallback(
    (request: Omit<WorkspaceFilePreviewOpenRequest, "id">) => {
      hideWorkspaceSshTerminalOverlay();
      const preview = {
        request: {
          id: ++requestId.current,
          ...request,
          returnFocusTo:
            request.returnFocusTo ??
            (document.activeElement instanceof HTMLElement ? document.activeElement : undefined),
        },
        open: true,
      };
      updateView(workspaceViewScope, (current) => ({
        editor: current.editor && { ...current.editor, open: false },
        preview,
      }));
    },
    [hideWorkspaceSshTerminalOverlay, updateView, workspaceViewScope],
  );

  const openWorkspaceSshTerminalRequest = useCallback(
    (request: WorkspaceSshTerminalOpenRequest) => {
      if (
        activeView.current.owner !== workspaceOwner ||
        activeView.current.scope !== workspaceViewScope
      )
        return;
      returnToSsh.current = null;
      updateView(workspaceViewScope, (current) => ({
        editor: current.editor && { ...current.editor, open: false },
        preview: current.preview && { ...current.preview, open: false },
      }));
      setSsh({ owner: workspaceOwner, scope: workspaceViewScope, request, open: true });
    },
    [updateView, workspaceOwner, workspaceViewScope],
  );

  const handleOpenWorkspaceFile = useCallback(
    (path: string, imagePaths?: string[]) => {
      if (!terminalProjectPath || !terminalProjectPathKey) return;
      returnToSsh.current = null;
      const request = {
        projectPathKey: terminalProjectPathKey,
        workdir: terminalProjectPath,
        path,
        imagePaths,
      };
      if (isWorkspacePreviewPath(path)) openWorkspaceFilePreview(request);
      else openWorkspaceEditorFile(request);
    },
    [
      openWorkspaceEditorFile,
      openWorkspaceFilePreview,
      terminalProjectPath,
      terminalProjectPathKey,
    ],
  );

  const handleOpenSftpFile = useCallback(
    (session: TerminalSession, request: SftpOpenFileRequest) => {
      if (!terminalProjectPath || !terminalProjectPathKey) return;
      if (request.side === "local") handleOpenWorkspaceFile(request.path);
      else {
        openWorkspaceEditorFile({
          projectPathKey: terminalProjectPathKey,
          workdir: terminalProjectPath,
          path: request.path,
          remote: { sessionId: session.id },
        });
      }
      returnToSsh.current = { owner: workspaceOwner, scope: workspaceViewScope };
    },
    [
      handleOpenWorkspaceFile,
      openWorkspaceEditorFile,
      terminalProjectPath,
      terminalProjectPathKey,
      workspaceOwner,
      workspaceViewScope,
    ],
  );

  const handleOpenSshTerminal = useCallback(
    (session: TerminalSession, kind: WorkspaceSshTerminalOpenRequest["kind"] = "bash") => {
      if (session.kind === "ssh") {
        openWorkspaceSshTerminalRequest({ id: ++requestId.current, sessionId: session.id, kind });
      }
    },
    [openWorkspaceSshTerminalRequest],
  );

  const requestWorkspaceFilePreviewClose = useCallback(() => {
    updateView(workspaceViewScope, (current) =>
      current.preview ? { ...current, preview: { ...current.preview, open: false } } : current,
    );
  }, [updateView, workspaceViewScope]);

  const previewRequestId = view?.preview?.request.id;
  const handleWorkspaceFilePreviewClosed = useCallback(() => {
    updateView(workspaceViewScope, (current) =>
      current.preview?.request.id === previewRequestId && current.preview?.open === false
        ? { ...current, preview: undefined }
        : current,
    );
    if (!view?.editor) restoreSshTerminal(workspaceViewScope);
  }, [previewRequestId, restoreSshTerminal, updateView, view?.editor, workspaceViewScope]);

  const handleWorkspaceEditorHide = useCallback(
    (scope: string, id: number) => {
      updateView(scope, (current) =>
        current.editor?.request.id === id
          ? { ...current, editor: { ...current.editor, open: false } }
          : current,
      );
      restoreSshTerminal(scope);
    },
    [restoreSshTerminal, updateView],
  );

  const handleWorkspaceEditorClosed = useCallback(
    (scope: string, id: number) => {
      updateView(scope, (current) =>
        current.editor?.request.id === id ? { ...current, editor: undefined } : current,
      );
      restoreSshTerminal(scope);
    },
    [restoreSshTerminal, updateView],
  );

  useEffect(() => {
    const previous = previousFileTree.current;
    previousFileTree.current = {
      owner: workspaceOwner,
      scope: workspaceViewScope,
      open: rightDockFileTreeOpen,
    };
    if (previous.owner !== workspaceOwner || previous.scope !== workspaceViewScope) return;
    if (rightDockFileTreeOpen && view?.editor?.cleanupPending) {
      updateView(workspaceViewScope, (current) =>
        current.editor
          ? { ...current, editor: { ...current.editor, cleanupPending: false } }
          : current,
      );
    } else if (previous.open && !rightDockFileTreeOpen) {
      updateView(workspaceViewScope, (current) => ({
        editor: current.editor && {
          ...current.editor,
          open: true,
          cleanupPending: true,
          closeRequestId: current.editor.closeRequestId + 1,
        },
        preview: current.preview && { ...current.preview, open: false },
      }));
    }
  }, [
    rightDockFileTreeOpen,
    updateView,
    view?.editor?.cleanupPending,
    workspaceOwner,
    workspaceViewScope,
  ]);

  const workspaceEditors = [...views].flatMap(([scope, fileView]) =>
    fileView.editor ? [{ ...fileView.editor, scope }] : [],
  );
  return {
    workspaceViewScope,
    workspaceEditors,
    workspaceFilePreviewMounted: Boolean(view?.preview),
    workspaceFilePreviewOpen: view?.preview?.open ?? false,
    workspaceFilePreviewOpenRequest: view?.preview?.request ?? null,
    workspaceSshTerminalMounted: Boolean(activeSsh),
    workspaceSshTerminalOpen: activeSsh?.open ?? false,
    setWorkspaceSshTerminalOpen,
    workspaceSshTerminalOpenRequest: activeSsh?.request ?? null,
    openWorkspaceSshTerminalRequest,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    handleWorkspaceEditorHide,
    handleWorkspaceEditorClosed,
    handleOpenWorkspaceFile,
    handleOpenSftpFile,
    handleOpenSshTerminal,
    requestWorkspaceFilePreviewClose,
    handleWorkspaceFilePreviewClosed,
    hideWorkspaceSshTerminalOverlay,
  };
}
