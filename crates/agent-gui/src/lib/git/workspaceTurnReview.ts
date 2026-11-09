import { invoke } from "@liveagent/app/shims/tauriCore";
import { WORKSPACE_GIT_TURN_REVIEW_EVENT } from "@liveagent/ui/components/project-tools/workspaceGitPaths";

export async function beginWorkspaceTurnReview(
  conversationId: string,
  workdir: string,
  capture: boolean,
) {
  try {
    return await invoke<string | null>("git_workspace_turn_review", {
      request: { action: "begin", conversationId, workdir, capture },
    });
  } catch {
    return null;
  }
}

export async function settleWorkspaceTurnReview(
  id: string | null,
  conversationId: string,
  completed?: boolean,
) {
  if (!id) return;
  try {
    await invoke("git_workspace_turn_review", {
      request:
        completed === undefined ? { action: "discard", id } : { action: "finish", id, completed },
    });
    if (completed !== undefined)
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_GIT_TURN_REVIEW_EVENT, { detail: conversationId }),
      );
  } catch {
    // An unavailable review may not change the conversation's execution result.
  }
}
