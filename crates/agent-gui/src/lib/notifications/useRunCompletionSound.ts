import { isCommandPaletteSuppressed } from "@liveagent/ui/lib/chat/commandPalette";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import { useEffect, useRef } from "react";
import { completionSoundPlayer } from "./completionSound";

/** Only monitors the local device and rebases when its sidebar scope changes. */
export function useRunCompletionSound(
  store: SidebarStore,
  enabled: boolean,
  owner: string,
  visibleConversationId: string,
) {
  const visibleId = useRef(visibleConversationId);
  visibleId.current = visibleConversationId;
  useEffect(() => {
    if (!enabled || !owner) return;
    let previous = store.getSnapshot();
    const stopWatching = store.subscribe(() => {
      const next = store.getSnapshot();
      const { scopeKey, runningConversationIds } = previous;
      previous = next;
      if (scopeKey !== next.scopeKey || runningConversationIds === next.runningConversationIds) {
        return;
      }
      const lookingAtConversation =
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        !isCommandPaletteSuppressed()
          ? visibleId.current
          : "";
      for (const id of runningConversationIds) {
        if (
          id !== lookingAtConversation &&
          next.byId.has(id) &&
          !next.runningConversationIds.has(id)
        ) {
          completionSoundPlayer().play();
          return;
        }
      }
    });
    const unlock = () => completionSoundPlayer().unlock();
    window.addEventListener("pointerdown", unlock, { capture: true, passive: true });
    window.addEventListener("keydown", unlock, { capture: true, passive: true });
    return () => {
      stopWatching();
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      completionSoundPlayer().dispose();
    };
  }, [enabled, owner, store]);
}
