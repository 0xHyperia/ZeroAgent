import { useEffect, useState } from "react";
import { resolveWorkbenchLayoutStorage } from "../../lib/workbench/layoutStorage";
import { WORKSPACE_GIT_TURN_REVIEW_EVENT } from "./workspaceGitPaths";

type Presentation = { layout: "split" | "unified"; wrapLines: boolean };
const PRESENTATION_KEY = "zeroagent.workspace-git.diff-presentation";
const PRESENTATION_EVENT = "zeroagent:workspace-git-presentation";
const defaultPresentation: Presentation = { layout: "unified", wrapLines: true };
let fallback = defaultPresentation;

function readPresentation(): Presentation {
  try {
    const raw = resolveWorkbenchLayoutStorage()?.getItem(PRESENTATION_KEY);
    if (raw) {
      const value = JSON.parse(raw) as Partial<Presentation> | null;
      return {
        layout: value?.layout === "split" ? "split" : "unified",
        wrapLines: value?.wrapLines !== false,
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
  const update = (patch: Partial<Presentation>) => {
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
