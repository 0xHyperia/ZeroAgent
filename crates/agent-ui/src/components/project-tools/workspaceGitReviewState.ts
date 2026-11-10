import { useEffect, useState } from "react";
import { resolveWorkbenchLayoutStorage } from "../../lib/workbench/layoutStorage";
import { WORKSPACE_GIT_TURN_REVIEW_EVENT } from "./workspaceGitPaths";

export type WorkspaceGitPresentation = {
  layout: "auto" | "split" | "unified";
  wrapLines: boolean;
  fullContext: boolean;
  richPreview: boolean;
  wordDiffs: boolean;
  hideWhitespace: boolean;
  hideImports: boolean;
};
const PRESENTATION_KEY = "zeroagent.workspace-git.diff-presentation";
const PRESENTATION_EVENT = "zeroagent:workspace-git-presentation";
const defaultPresentation: WorkspaceGitPresentation = {
  layout: "auto",
  wrapLines: false,
  fullContext: true,
  richPreview: true,
  wordDiffs: true,
  hideWhitespace: false,
  hideImports: false,
};
let fallback = defaultPresentation;

function readPresentation(): WorkspaceGitPresentation {
  try {
    const raw = resolveWorkbenchLayoutStorage()?.getItem(PRESENTATION_KEY);
    if (raw) {
      const value = JSON.parse(raw) as Partial<WorkspaceGitPresentation> | null;
      return {
        layout: value?.layout === "split" || value?.layout === "unified" ? value.layout : "auto",
        wrapLines: value?.wrapLines === true,
        fullContext: value?.fullContext !== false,
        richPreview: value?.richPreview !== false,
        wordDiffs: value?.wordDiffs !== false,
        hideWhitespace: value?.hideWhitespace === true,
        hideImports: value?.hideImports === true,
      };
    }
  } catch {
    // Optional preference recovery.
  }
  return fallback;
}

export function useWorkspaceGitPresentation() {
  const [presentation, setPresentation] = useState(readPresentation);
  useEffect(() => {
    const sync = () => setPresentation(readPresentation());
    window.addEventListener(PRESENTATION_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PRESENTATION_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const update = (patch: Partial<WorkspaceGitPresentation>) => {
    const next = { ...readPresentation(), ...patch };
    fallback = next;
    try {
      resolveWorkbenchLayoutStorage()?.setItem(PRESENTATION_KEY, JSON.stringify(next));
    } catch {
      // The in-memory preference remains available.
    }
    setPresentation(next);
    window.dispatchEvent(new Event(PRESENTATION_EVENT));
  };
  return [presentation, update] as const;
}

export function useWorkspaceGitTurnRevision(conversationId: string | undefined) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!conversationId) return;
    const update = (event: Event) => {
      if ((event as CustomEvent<unknown>).detail === conversationId)
        setRevision((current) => current + 1);
    };
    window.addEventListener(WORKSPACE_GIT_TURN_REVIEW_EVENT, update);
    return () => window.removeEventListener(WORKSPACE_GIT_TURN_REVIEW_EVENT, update);
  }, [conversationId]);
  return revision;
}
