import { useCallback, useEffect, useRef, useState } from "react";
import {
  CloudSavedDraftController,
  type CloudSavedDraftState,
} from "@/lib/cloudChatSavedDraftController";
import {
  type CloudChatSavedDraft,
  type CloudChatSavedDraftsClient,
  cloudSavedDraftScope,
} from "@/lib/cloudChatSavedDrafts";

type Options = {
  ownerId: number | null;
  scope: string;
  client: CloudChatSavedDraftsClient;
  /** Read the matching host draft, including resources and mode, never another scope's editor. */
  captureSnapshot: (scope: string) => CloudChatSavedDraft | null | undefined;
  applySnapshot: (snapshot: CloudChatSavedDraft | null, scope: string) => void;
  debounceMs?: number;
};
const initialState = (scope: string): CloudSavedDraftState => ({
  scope,
  status: "loading",
  dirty: false,
  error: "",
  backgroundPendingCount: 0,
});

/** Host adapter: editor ownership stays in the page; synchronization stays in the account controller. */
export function useCloudSavedDraft(options: Options) {
  const { ownerId, client } = options;
  const latest = useRef(options);
  latest.current = options;
  const controller = useRef<CloudSavedDraftController | null>(null);
  const applying = useRef(false);
  const pendingCapture = useRef<{
    ownerId: number;
    scope: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [published, setPublished] = useState<{
    ownerId: number | null;
    source: CloudSavedDraftController | null;
    state: CloudSavedDraftState;
  }>({
    ownerId: options.ownerId,
    source: null,
    state: initialState(cloudSavedDraftScope(options.scope)),
  });

  useEffect(() => {
    if (ownerId === null) return;
    const instance = new CloudSavedDraftController({
      client,
      debounceMs: latest.current.debounceMs,
      isOwnerCurrent: () => latest.current.ownerId === ownerId && latest.current.client === client,
      changed: (state) => setPublished({ ownerId, source: instance, state }),
      apply: (snapshot, scope) => {
        if (
          latest.current.ownerId !== ownerId ||
          cloudSavedDraftScope(latest.current.scope) !== scope
        )
          return;
        applying.current = true;
        try {
          latest.current.applySnapshot(snapshot, scope);
        } finally {
          applying.current = false;
        }
      },
    });
    controller.current = instance;
    return () => {
      if (pendingCapture.current) clearTimeout(pendingCapture.current.timer);
      pendingCapture.current = null;
      instance.dispose();
      if (controller.current === instance) controller.current = null;
    };
  }, [ownerId, client]);

  useEffect(() => {
    if (options.ownerId === null || latest.current.client !== client || !controller.current) return;
    const scope = cloudSavedDraftScope(options.scope);
    void controller.current.activate(scope, latest.current.captureSnapshot(scope));
  }, [options.ownerId, client, options.scope]);

  const markDirty = useCallback((snapshot?: CloudChatSavedDraft) => {
    if (pendingCapture.current) clearTimeout(pendingCapture.current.timer);
    pendingCapture.current = null;
    const current = latest.current;
    const instance = controller.current;
    if (
      applying.current ||
      current.ownerId === null ||
      !instance ||
      instance.getState().scope !== cloudSavedDraftScope(current.scope)
    )
      return;
    const value = snapshot ?? current.captureSnapshot(cloudSavedDraftScope(current.scope));
    if (value) instance.markDirty(value);
  }, []);
  // Capture after the editor commits its input, and avoid serializing a large draft per keystroke.
  const scheduleCapture = useCallback(() => {
    const current = latest.current;
    if (applying.current || current.ownerId === null) return;
    if (pendingCapture.current) clearTimeout(pendingCapture.current.timer);
    const owner = current.ownerId;
    const scope = cloudSavedDraftScope(current.scope);
    pendingCapture.current = {
      ownerId: owner,
      scope,
      timer: setTimeout(() => {
        pendingCapture.current = null;
        if (
          latest.current.ownerId === owner &&
          cloudSavedDraftScope(latest.current.scope) === scope
        )
          markDirty();
      }, 120),
    };
  }, [markDirty]);
  const flush = useCallback(async () => {
    markDirty();
    return controller.current?.flush() ?? false;
  }, [markDirty]);
  const retry = useCallback(async () => controller.current?.retry() ?? false, []);
  const resolveConflict = useCallback(
    async (choice: "keep-local" | "use-server") =>
      controller.current?.resolveConflict(choice) ?? false,
    [],
  );
  const clearIfUnchanged = useCallback(
    async (sent: CloudChatSavedDraft, scope?: string) =>
      controller.current?.clearIfUnchanged(sent, scope) ?? false,
    [],
  );
  const resetBlank = useCallback(
    async (seed?: CloudChatSavedDraft) => controller.current?.resetBlank(seed) ?? false,
    [],
  );

  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const pagehide = () => {
      void flush();
    };
    const beforeunload = (event: BeforeUnloadEvent) => {
      // Include the final input even when the debounce has not fired yet.
      if (pendingCapture.current) markDirty();
      const state = controller.current?.getState();
      if (
        state &&
        (state.dirty ||
          state.status === "saving" ||
          state.status === "unknown" ||
          state.backgroundPendingCount > 0)
      ) {
        void flush();
        event.preventDefault();
        event.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("beforeunload", beforeunload);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("beforeunload", beforeunload);
    };
  }, [flush, markDirty]);

  // Hide old-account/old-scope content immediately, before passive cleanup runs.
  const state =
    published.ownerId === options.ownerId &&
    published.source === controller.current &&
    published.state.scope === cloudSavedDraftScope(options.scope)
      ? published.state
      : initialState(cloudSavedDraftScope(options.scope));
  return {
    state,
    markDirty,
    scheduleCapture,
    flush,
    retry,
    resolveConflict,
    clearIfUnchanged,
    resetBlank,
  };
}
