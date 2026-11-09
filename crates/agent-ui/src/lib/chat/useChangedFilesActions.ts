import {
  openRightDockToolTabState,
  patchRightDockFileTreeState,
  type RightDockProjectState,
  readRightDockFileTreeState,
} from "@liveagent/app/lib/settings";
import type { ChangedFilesActions } from "@liveagent/ui/components/chat/ChangedFilesCard";
import type { GitReviewFocusRequest } from "@liveagent/ui/components/project-tools/RightDockContext";
import { expandedPathsForFileTreePath } from "@liveagent/ui/components/project-tools/rightDockModel";
import { useCallback, useMemo, useRef, useState } from "react";

type UseChangedFilesActionsParams = {
  terminalProjectPathKey: string;
  workspaceViewScope: string;
  setRightDockOpen: (open: boolean) => void;
  onDockToolStateChange: (
    update: (current: RightDockProjectState) => RightDockProjectState,
  ) => void;
  onOpenFile: (path: string) => void;
};

export function useChangedFilesActions(params: UseChangedFilesActionsParams) {
  const {
    terminalProjectPathKey,
    workspaceViewScope,
    setRightDockOpen,
    onDockToolStateChange,
    onOpenFile,
  } = params;
  const gitReviewFocusNonceRef = useRef(0);
  const [gitReviewFocus, setGitReviewFocus] = useState<{
    scope: string;
    request: GitReviewFocusRequest;
  } | null>(null);
  const handleGitReviewFocusRequestHandled = useCallback((nonce: number) => {
    setGitReviewFocus((current) => (current?.request.nonce === nonce ? null : current));
  }, []);
  const handleChangedFileOpenDiff = useCallback(
    (path: string | null) => {
      if (!terminalProjectPathKey) return;
      setRightDockOpen(true);
      onDockToolStateChange((state) => openRightDockToolTabState(state, "gitReview"));
      gitReviewFocusNonceRef.current += 1;
      setGitReviewFocus({
        scope: workspaceViewScope,
        request: { path: (path ?? "").trim(), nonce: gitReviewFocusNonceRef.current },
      });
    },
    [onDockToolStateChange, setRightDockOpen, terminalProjectPathKey, workspaceViewScope],
  );
  const handleChangedFileReveal = useCallback(
    (path: string) => {
      if (!terminalProjectPathKey) return;
      const selectedPath = path
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "");
      if (!selectedPath) return;
      setRightDockOpen(true);
      onDockToolStateChange((state) => {
        const opened = openRightDockToolTabState(state, "fileTree");
        const current = readRightDockFileTreeState(opened);
        return patchRightDockFileTreeState(opened, {
          query: "",
          selectedPath,
          expandedPaths: Array.from(
            new Set([...current.expandedPaths, ...expandedPathsForFileTreePath(selectedPath)]),
          ),
          bumpRevision: true,
        });
      });
    },
    [onDockToolStateChange, setRightDockOpen, terminalProjectPathKey],
  );
  const changedFilesActions = useMemo<ChangedFilesActions>(
    () => ({
      onOpenFile,
      onRevealInFileTree: handleChangedFileReveal,
      onOpenDiff: handleChangedFileOpenDiff,
    }),
    [handleChangedFileOpenDiff, handleChangedFileReveal, onOpenFile],
  );

  return {
    gitReviewFocusRequest:
      gitReviewFocus?.scope === workspaceViewScope ? gitReviewFocus.request : null,
    handleGitReviewFocusRequestHandled,
    handleChangedFileOpenDiff,
    handleChangedFileReveal,
    changedFilesActions,
  };
}
