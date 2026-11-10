import {
  buildDocumentRevisionMessage,
  MAX_REVISION_EVIDENCE,
} from "../../lib/chat/documentRevisionMessage";
import type { PendingUploadedFile } from "../../lib/chat/uploadedFiles";
import { workspaceGitRelativePath } from "../project-tools/workspaceGitPaths";
import type { WorkspaceDocumentRevision } from "./WorkspaceFilePreviewOverlay";

export async function requestWorkspaceRevision(
  { source, comments, assertCurrent, workspacePath, evidence = [] }: WorkspaceDocumentRevision,
  host: {
    workspaceRoot: string;
    canSend: () => boolean;
    importSources: (sources: File[]) => Promise<PendingUploadedFile[] | null | undefined>;
    send: (text: string, files: PendingUploadedFile[]) => Promise<boolean>;
  },
) {
  if (!comments.length || comments.length > 20 || !host.canSend()) return false;
  assertCurrent();
  const selectedEvidence = evidence.slice(0, MAX_REVISION_EVIDENCE);
  const files = await host.importSources([source, ...selectedEvidence]);
  if (!files?.some(({ fileName }) => fileName === source.name) || !host.canSend())
    return false;
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

export function formatWorkspaceFileExcerpt(
  text: string,
  path: string,
  comment: string | undefined,
  zh: boolean,
) {
  const selected = text.trim();
  if (!selected) return "";
  const label = `${zh ? "引用文件" : "File excerpt"} ${path.replace(/[\r\n]/g, " ")}`;
  const quote = selected
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  const note = comment?.trim();
  return `\n\n${label}\n${quote}${note ? `\n\n${note}` : ""}\n`;
}
