import { invoke } from "@liveagent/app/shims/tauriCore";
import type { MentionComposerLargePaste } from "@liveagent/ui/components/chat/MentionComposer";
import {
  buildPastedTextFileName,
  validateImportedPastedTextFiles,
} from "@liveagent/ui/lib/chat/composerDraft";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { parseExtensionReference } from "@liveagent/ui/lib/extensions/reference";

export {
  buildTextFromComposerDraft,
  createTextComposerDraft,
} from "@liveagent/ui/lib/chat/composerDraft";

export function deviceAccountSkillIssue(skillFiles: readonly string[], selectedFile: string) {
  const selected = parseExtensionReference(selectedFile);
  if (!selected) return;
  const existing = new Set<string>();
  for (const skillFile of skillFiles) {
    const reference = parseExtensionReference(skillFile);
    if (!reference) continue;
    if (reference.packageId === selected.packageId && reference.version !== selected.version) {
      return "revision-conflict";
    }
    existing.add(skillFile);
  }
  // K-brain admits four distinct account skill references per run.
  if (!existing.has(selectedFile) && existing.size >= 4) return "limit";
}

type SystemImportPastedTextsResponse = {
  files: PendingUploadedFile[];
  skipped: string[];
};

export async function importPastedTextsAsFiles(
  workdir: string,
  pastes: MentionComposerLargePaste[],
) {
  const normalizedWorkdir = workdir.trim();
  if (!normalizedWorkdir) {
    throw new Error("请先在项目栏选择或创建项目后再发送大段粘贴内容。");
  }
  if (pastes.length === 0) {
    return {
      files: [],
      fileByPasteId: new Map<string, PendingUploadedFile>(),
    };
  }

  const response = await invoke<SystemImportPastedTextsResponse>("system_import_pasted_texts", {
    workdir: normalizedWorkdir,
    texts: pastes.map((paste, index) => ({
      fileName: buildPastedTextFileName(paste, index),
      content: paste.text,
    })),
  });

  return validateImportedPastedTextFiles(pastes, response.files, response.skipped);
}
