import type { ExtensionRevision } from "./extensionTypes";

export type ExtensionDraft = { revision: ExtensionRevision; baseline: string; version: number };
const prefix = "zeroagent:extension-draft:";
export function extensionSessionStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
export function extensionDraftKey(scope: string, id?: string) {
  return `${prefix}${encodeURIComponent(scope)}:${encodeURIComponent(id ?? "new")}`;
}
export function readExtensionDraft(
  storage: Pick<Storage, "getItem"> | undefined,
  scope: string,
  id?: string,
): ExtensionDraft | null {
  try {
    const raw = storage?.getItem(extensionDraftKey(scope, id));
    if (!raw || raw.length > 524288) return null;
    const value = JSON.parse(raw) as ExtensionDraft;
    const revision = value.revision;
    if (
      !Number.isSafeInteger(value.version) ||
      value.version < 0 ||
      typeof value.baseline !== "string" ||
      !revision ||
      typeof revision.name !== "string" ||
      typeof revision.description !== "string" ||
      !Array.isArray(revision.skills) ||
      !revision.files ||
      Array.isArray(revision.files) ||
      Object.keys(revision.files).length > 64 ||
      !Object.values(revision.files).every((body) => typeof body === "string")
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function writeExtensionDraft(
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
  scope: string,
  id: string | undefined,
  draft: ExtensionDraft | null,
) {
  try {
    if (!storage) return;
    const key = extensionDraftKey(scope, id);
    if (!draft) storage.removeItem(key);
    else {
      const raw = JSON.stringify(draft);
      if (raw.length <= 524288) storage.setItem(key, raw);
    }
  } catch {
    /* Storage may be unavailable; the mounted editor still retains its draft. */
  }
}
