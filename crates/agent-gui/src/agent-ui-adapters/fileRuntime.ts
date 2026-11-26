import { invoke } from "@liveagent/app/shims/tauriCore";
import type { DocumentCommentRecovery } from "@liveagent/ui/components/resource-preview/readingSession";
import type { FileRuntimeControls, FileRuntimeStatus } from "@liveagent/ui/contracts/fileRuntime";
import { resolveWorkbenchLayoutStorage } from "@liveagent/ui/lib/workbench/layoutStorage";
import { isTauriHost } from "../lib/host";
import { inferRuntimePlatform } from "../lib/runtimePlatform";

export function canManageLocalFileRuntime() {
  return isTauriHost() && inferRuntimePlatform() === "windows";
}

export const desktopFileRuntime: FileRuntimeControls = {
  status: () => invoke("file_runtime_status"),
  diagnose: checkDesktopFileRuntime,
  prepare: (source) => invoke("file_runtime_prepare", { source }),
  manage: (action) => invoke("file_runtime_manage", { action }),
};

export function checkDesktopFileRuntime() {
  return invoke<FileRuntimeStatus>("file_runtime_status", { fresh: true });
}

const MAX_SAVED_DRAFTS = 8;
const MAX_SAVED_BYTES = 1024 * 1024;

export function localFileRuntimeCommentRecovery(account: string): DocumentCommentRecovery {
  const key = `zeroagent.fileTools.annotationDrafts:${account}`;
  const read = (raw: string | null): Map<string, unknown> => {
    if (!raw || raw.length > MAX_SAVED_BYTES) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    return new Map(
      parsed
        .slice(0, MAX_SAVED_DRAFTS)
        .filter((entry) => Array.isArray(entry) && typeof entry[0] === "string"),
    );
  };
  return {
    read(identity) {
      try {
        const storage = resolveWorkbenchLayoutStorage();
        return read(storage?.getItem(key) ?? null).get(identity);
      } catch {
        return undefined;
      }
    },
    write(identity, comments) {
      try {
        const storage = resolveWorkbenchLayoutStorage();
        if (!storage) return false;
        const drafts = read(storage.getItem(key));
        drafts.delete(identity);
        if (comments.length) drafts.set(identity, comments);
        if (!drafts.size) {
          storage.removeItem(key);
          return true;
        }
        const serialized = JSON.stringify(Array.from(drafts).slice(-MAX_SAVED_DRAFTS));
        if (serialized.length > MAX_SAVED_BYTES) return false;
        storage.setItem(key, serialized);
        return true;
      } catch {
        return false;
      }
    },
  };
}
