import { workspaceProjectPathKey } from "@liveagent/app/lib/settings";
import type { WorkspaceCodeEditorOpenRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceCodeEditorOverlay";
import type { WorkspaceFilePreviewOpenRequest } from "@liveagent/ui/components/workspace-editor/WorkspaceFilePreviewOverlay";
import { isWorkspacePreviewPath } from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import { openInWorkspaceEditor } from "@liveagent/ui/lib/tools/workspaceEditors";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import type { ChatFileLink } from "./chatFileLinks";
import {
  type OpenChatFileLinkParams,
  type OpenChatFileLinkResult,
  openChatFileLink,
} from "./openChatFileLink";

type WorkspaceOpenRequest = Omit<WorkspaceCodeEditorOpenRequest, "id">;
type WorkspacePreviewRequest = Omit<WorkspaceFilePreviewOpenRequest, "id">;
type EditorLinkContext = { conversationId: string; workdir: string };

type UseChatFileLinkNavigationParams = {
  conversationId: string;
  conversationWorkdir: string;
  resolveWorkdirOnHost?: boolean;
  readStagedAttachments?: boolean;
  canOpenInLocalEditor?: boolean;
  workspaceOwner?: string;
  terminalProjectPathKey: string;
  notifyError: (message: string) => void;
  onRevealInFileTree: (path: string) => void;
  onSelectInFileTree?: (path: string) => void;
  openWorkspaceEditorFile: (request: WorkspaceOpenRequest) => void;
  openWorkspaceFilePreview: (request: WorkspacePreviewRequest) => void;
  openLink?: (params: OpenChatFileLinkParams) => Promise<OpenChatFileLinkResult>;
  getErrorMessage?: (error: unknown) => string;
};

const FILE_OPEN_FAILED = "The linked file could not be opened.";

function defaultErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error ?? "");
}

export function useChatFileLinkNavigation(params: UseChatFileLinkNavigationParams) {
  const {
    conversationId,
    conversationWorkdir,
    resolveWorkdirOnHost,
    readStagedAttachments,
    canOpenInLocalEditor,
    workspaceOwner,
    terminalProjectPathKey,
    notifyError,
    onRevealInFileTree,
    onSelectInFileTree,
    openWorkspaceEditorFile,
    openWorkspaceFilePreview,
    openLink = openChatFileLink,
    getErrorMessage = defaultErrorMessage,
  } = params;
  const scope = useMemo(
    () => ({ conversationId, conversationWorkdir, workspaceOwner, canOpenInLocalEditor }),
    [conversationId, conversationWorkdir, workspaceOwner, canOpenInLocalEditor],
  );
  const currentScope = useRef<typeof scope | null>(scope);
  useLayoutEffect(() => {
    currentScope.current = scope;
    return () => {
      currentScope.current = null;
    };
  }, [scope]);

  return useCallback(
    (link: ChatFileLink, editorContext?: EditorLinkContext) => {
      if (link.openInEditor && !canOpenInLocalEditor) return;
      const editorScope = link.openInEditor ? editorContext : undefined;
      const targetConversationId = editorScope?.conversationId ?? conversationId;
      const workdir = (editorScope?.workdir ?? conversationWorkdir).trim();
      if (!targetConversationId || (!workdir && !resolveWorkdirOnHost)) {
        notifyError("The conversation working directory is unavailable.");
        return;
      }
      const request = { ...link, conversationId: targetConversationId, workdir };
      const returnFocusTo =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      void openLink(request)
        .then(async (result) => {
          if (currentScope.current !== scope) return;
          const resultWorkdir = result.workdir?.trim() ?? "";
          const resultPath = result.path?.trim() ?? "";
          if (link.openInEditor) {
            if (!resultWorkdir || result.path === undefined || result.outsideWorkspace) {
              notifyError(FILE_OPEN_FAILED);
              return;
            }
            await openInWorkspaceEditor(
              resultWorkdir,
              result.path,
              link.openInEditor,
              result.line,
              result.column,
            );
            return;
          }
          if (result.action === "opened" || result.action === "revealed") return;
          if (!resultWorkdir || !resultPath) {
            notifyError(FILE_OPEN_FAILED);
            return;
          }
          if (result.action === "directory") {
            if (workspaceProjectPathKey(resultWorkdir) === terminalProjectPathKey) {
              onRevealInFileTree(resultPath);
              return;
            }
            const fallback = await openLink({ ...request, openInFileManager: true });
            if (currentScope.current !== scope) return;
            if (fallback.action !== "opened") {
              notifyError("The linked directory could not be opened.");
            }
            return;
          }
          const workspaceRequest = {
            projectPathKey: workspaceProjectPathKey(resultWorkdir),
            workdir: resultWorkdir,
            path: resultPath,
          };
          if (
            !result.outsideWorkspace &&
            workspaceRequest.projectPathKey === terminalProjectPathKey
          ) {
            (onSelectInFileTree ?? onRevealInFileTree)(resultPath);
          }
          if (
            result.action === "preview" ||
            (link.preferPreview && isWorkspacePreviewPath(resultPath))
          ) {
            openWorkspaceFilePreview({
              ...workspaceRequest,
              returnFocusTo,
              stagedAttachment:
                readStagedAttachments &&
                result.outsideWorkspace &&
                link.preferPreview &&
                link.source === "absolute"
                  ? { conversationId, path: link.path }
                  : undefined,
            });
            return;
          }
          openWorkspaceEditorFile({
            ...workspaceRequest,
            line: result.line,
            endLine: result.endLine,
            column: result.column,
          });
        })
        .catch((error: unknown) => {
          if (currentScope.current !== scope) return;
          const message = getErrorMessage(error);
          const normalized = message.toLowerCase();
          notifyError(
            normalized.includes("timed out") ||
              normalized.includes("offline") ||
              normalized.includes("not connected")
              ? "The device that owns this conversation is offline or did not respond."
              : message || FILE_OPEN_FAILED,
          );
        });
    },
    [
      canOpenInLocalEditor,
      conversationId,
      conversationWorkdir,
      getErrorMessage,
      notifyError,
      onRevealInFileTree,
      onSelectInFileTree,
      openLink,
      openWorkspaceEditorFile,
      openWorkspaceFilePreview,
      resolveWorkdirOnHost,
      readStagedAttachments,
      scope,
      terminalProjectPathKey,
    ],
  );
}
