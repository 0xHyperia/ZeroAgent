import { invokeFs } from "@liveagent/ui/lib/tools/fsBackend";
import { useEffect, useSyncExternalStore } from "react";

const PREFERENCE_KEY = "zeroagent.workspace.preferredEditor";
const INITIAL_DETECTION: { targets: readonly string[]; loaded: boolean } = {
  targets: [],
  loaded: false,
};
const TARGETS_MAX_AGE_MS = 30_000;

let detection = INITIAL_DETECTION;
let detectedAt = 0;
let detecting: Promise<void> | undefined;
let transientEditor = "";
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function subscribePreferredEditor(listener: () => void) {
  const unsubscribe = subscribe(listener);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === PREFERENCE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", handleStorage);
  return () => {
    unsubscribe();
    window.removeEventListener("storage", handleStorage);
  };
}

function readPreferredEditor() {
  try {
    return window.localStorage.getItem(PREFERENCE_KEY) ?? "";
  } catch {
    return transientEditor;
  }
}

export function setPreferredWorkspaceEditor(editor: string) {
  transientEditor = editor;
  try {
    if (editor) window.localStorage.setItem(PREFERENCE_KEY, editor);
    else window.localStorage.removeItem(PREFERENCE_KEY);
  } catch {
    // The current window can still use the preference when storage is unavailable.
  }
  notifyListeners();
}

function detectWorkspaceEditors(refresh = false) {
  if (detecting) return detecting;
  if (!refresh && detection.loaded && Date.now() - detectedAt < TARGETS_MAX_AGE_MS)
    return Promise.resolve();
  detecting = invokeFs<string[]>("fs_workspace_editor_targets", {})
    .catch(() => [])
    .then((targets) => {
      detection = { targets, loaded: true };
      detectedAt = Date.now();
      notifyListeners();
    })
    .finally(() => {
      detecting = undefined;
    });
  return detecting;
}

export function refreshWorkspaceEditors() {
  return detectWorkspaceEditors(true);
}

export function useWorkspaceEditors(enabled: boolean) {
  const { targets, loaded } = useSyncExternalStore(
    subscribe,
    () => (enabled ? detection : INITIAL_DETECTION),
    () => INITIAL_DETECTION,
  );
  const preferredEditor = useSyncExternalStore(
    subscribePreferredEditor,
    () => (enabled ? readPreferredEditor() : ""),
    () => "",
  );
  useEffect(() => {
    if (enabled) detectWorkspaceEditors();
  }, [enabled]);
  return { targets, preferredEditor, loaded };
}

export function openInWorkspaceEditor(
  workdir: string,
  path: string,
  editor: string,
  line?: number,
  column?: number,
) {
  return invokeFs<void>("fs_open_workspace_editor", { workdir, path, editor, line, column });
}
