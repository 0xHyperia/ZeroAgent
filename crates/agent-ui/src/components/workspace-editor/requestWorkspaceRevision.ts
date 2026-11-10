import { documentRevisionText } from "../resource-preview/ResourceDocumentComments";
import type { WorkspaceDocumentRevision } from "./WorkspaceFilePreviewOverlay";
import type { PendingUploadedFile } from "../../lib/chat/uploadedFiles";

export async function requestWorkspaceRevision(
  { source, comments, assertCurrent }: WorkspaceDocumentRevision,
  host: {
    canSend: () => boolean;
    importSource: (source: File) => Promise<PendingUploadedFile[] | null | undefined>;
    send: (text: string, files: PendingUploadedFile[]) => Promise<boolean>;
  },
) {
  if (!comments.length || comments.length > 20 || !host.canSend()) return false;
  assertCurrent();
  const files = await host.importSource(source);
  if (files?.length !== 1 || !host.canSend()) return false;
  assertCurrent();
  const text =
    documentRevisionText(source.name, comments) +
    "\n\n请在当前工作区另存修改稿并提供文件链接，保留原件和作为引用的附件。";
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
