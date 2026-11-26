import "@liveagent/ui/i18n/namespaces/projectTools";
import type { FileRuntimeSummary } from "@liveagent/ui/contracts/fileRuntime";
import { type Locale, t as translate } from "@liveagent/ui/i18n/index";
import {
  buildDocumentRevisionMessage,
  MAX_REVISION_EVIDENCE,
} from "../../lib/chat/documentRevisionMessage";
import type { PendingUploadedFile } from "../../lib/chat/uploadedFiles";
import { workspaceGitRelativePath } from "../project-tools/workspaceGitPaths";
import type { WorkspaceDocumentRevision } from "./WorkspaceFilePreviewOverlay";

export class WorkspaceFileRuntimeError extends Error {
  constructor(
    message: string,
    readonly openSetup?: () => boolean,
  ) {
    super(message);
  }
}

export async function requestWorkspaceRevision(
  { source, comments, assertCurrent, workspacePath, evidence = [] }: WorkspaceDocumentRevision,
  host: {
    workspaceRoot: string;
    canSend: () => boolean;
    locale: Locale;
    checkFileRuntime: () => Promise<boolean | FileRuntimeSummary>;
    openFileRuntimeSetup?: () => void;
    importSources: (sources: File[]) => Promise<PendingUploadedFile[] | null | undefined>;
    send: (text: string, files: PendingUploadedFile[]) => Promise<boolean>;
  },
) {
  if (!comments.length || comments.length > 20 || !host.canSend()) return false;
  assertCurrent();
  const status = await host.checkFileRuntime().catch(() => null);
  if (!host.canSend()) return false;
  assertCurrent();
  const ready = typeof status === "boolean" ? status : status?.ready;
  if (ready !== true) {
    const phase = typeof status === "object" ? status?.phase : undefined;
    const openSetup = host.openFileRuntimeSetup;
    const setupAction =
      status !== null && phase !== "unavailable" && openSetup
        ? () => {
            if (!host.canSend()) return false;
            try {
              assertCurrent();
            } catch {
              return false;
            }
            openSetup();
            return true;
          }
        : undefined;
    let message = setupAction
      ? "workspaceFilePreview.fileRuntimeMissingLocal"
      : "workspaceFilePreview.fileRuntimeMissingDevice";
    if (status === null) message = "workspaceFilePreview.fileRuntimeUnreadable";
    if (phase === "unavailable") message = "workspaceFilePreview.fileRuntimeUnavailable";
    if (phase === "pending_restart") message = "workspaceFilePreview.fileRuntimePendingRestart";
    if (phase === "pending_enable") message = "workspaceFilePreview.fileRuntimePendingEnable";
    if (phase === "disabled" || phase === "pending_disable" || phase === "pending_removal") {
      message = "workspaceFilePreview.fileRuntimeDisabled";
    }
    if (phase === "downloading" || phase === "verifying") {
      message = "workspaceFilePreview.fileRuntimePreparing";
    }
    throw new WorkspaceFileRuntimeError(translate(message, host.locale), setupAction);
  }
  const selectedEvidence = evidence.slice(0, MAX_REVISION_EVIDENCE);
  const files = await host.importSources([source, ...selectedEvidence]);
  if (!files?.some(({ fileName }) => fileName === source.name) || !host.canSend()) return false;
  assertCurrent();
  const text = buildDocumentRevisionMessage(source.name, comments, {
    workspacePath:
      workspacePath && workspaceGitRelativePath(host.workspaceRoot, workspacePath)
        ? workspacePath
        : undefined,
    evidenceNames: selectedEvidence
      .map(({ name }) => name)
      .filter((name) => files.some(({ fileName }) => fileName === name)),
  });
  return host.send(text, files);
}
