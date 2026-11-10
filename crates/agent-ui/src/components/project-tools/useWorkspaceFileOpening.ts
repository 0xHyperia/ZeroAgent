import { useCallback } from "react";
import type { WorkspaceFileMode, WorkspaceFileRequest, useWorkspaceTabs } from "./useWorkspaceTabs";

export function useWorkspaceFileOpening(options: {
  tabbed: boolean;
  openFile: ReturnType<typeof useWorkspaceTabs>["openFile"];
  closeTerminalOverlay: () => void;
  openEditorOverlay: (request: WorkspaceFileRequest) => void;
  openPreviewOverlay: (request: WorkspaceFileRequest) => void;
}) {
  const { tabbed, openFile, closeTerminalOverlay, openEditorOverlay, openPreviewOverlay } = options;
  const openFileTab = useCallback(
    (request: WorkspaceFileRequest, mode: WorkspaceFileMode, temporary = false) => {
      if (!tabbed || (request.remote && mode === "source")) return false;
      closeTerminalOverlay();
      openFile(request, mode, temporary);
      return true;
    },
    [tabbed, openFile, closeTerminalOverlay],
  );
  const openWorkspaceEditorFile = useCallback(
    (request: WorkspaceFileRequest) => {
      if (!openFileTab(request, "source")) openEditorOverlay(request);
    },
    [openFileTab, openEditorOverlay],
  );
  const openWorkspaceFilePreview = useCallback(
    (request: WorkspaceFileRequest) => {
      if (!openFileTab(request, "preview")) openPreviewOverlay(request);
    },
    [openFileTab, openPreviewOverlay],
  );
  return { openFileTab, openWorkspaceEditorFile, openWorkspaceFilePreview };
}
