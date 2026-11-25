import { normalizeLiveToolStatus } from "@liveagent/ui/lib/chat/assistantStatus";
import type { TranscriptFindSource } from "@liveagent/ui/lib/transcript-find/transcriptFindSource";
import { type ComponentProps, memo, useEffect, useMemo, useSyncExternalStore } from "react";
import type { RenderTimelineItem } from "../../../lib/chat/conversation/conversationState";
import type {
  LiveTranscriptState,
  LiveTranscriptStore,
} from "../../../lib/chat/conversation/liveTranscriptStore";
import { AssistantActivityRow } from "./AssistantActivityRow";
import type { AssistantActivityRow as ActivityRow, TranscriptRowModel } from "./rowModel";
import { buildTranscriptFindEntries } from "./transcriptFindEntries";

/**
 * What of the live store changes the transcript's row list rather than just
 * the content of the live row: whether the live tail shows at all, and whether
 * it has content (which decides how much trailing history it absorbs).
 * Everything else — streamed text, tool status, retries — only moves the live
 * row, which subscribes on its own (LiveAssistantActivityRow).
 */
export function liveTranscriptShapeKey(state: LiveTranscriptState): string {
  if (state.isSettled) return "settled";
  return state.liveRounds.length > 0 || state.draftAssistantText ? "content" : "empty";
}

type ActivityRowProps = Omit<
  ComponentProps<typeof AssistantActivityRow>,
  "row" | "toolStatus" | "retryAttempts"
>;

const subscribeToNothing = () => () => {};
const getNoLiveState = () => null;

/**
 * The force-mounted live activity row. It is the only part of the transcript
 * that subscribes to every live store emit: a streamed delta re-renders this
 * row, not the virtual list and every visible row around it. It rebuilds the
 * row through the same row model as the list (the model returns the cached
 * snapshot when the list already built this state in the same pass), and
 * keeps the find bar's entries in step with the streamed text. The same
 * host renders settled activity so keyed controls survive history adoption.
 */
export const LiveAssistantActivityRow = memo(function LiveAssistantActivityRow(
  props: ActivityRowProps & {
    row: ActivityRow;
    live?: {
      rowModel: TranscriptRowModel;
      historyItems: RenderTimelineItem[];
      store: LiveTranscriptStore;
      isSending: boolean;
      findSource?: TranscriptFindSource;
    };
  },
) {
  const { row, live, isCompactionRunning, ...rowProps } = props;
  const liveState = useSyncExternalStore(
    live?.store.subscribe ?? subscribeToNothing,
    live?.store.getSnapshot ?? getNoLiveState,
    live?.store.getSnapshot ?? getNoLiveState,
  );
  const snapshot = useMemo(() => {
    if (!live || !liveState) return undefined;
    return live.rowModel.build(live.historyItems, {
      ...liveState,
      isSending: live.isSending,
      isCompactionRunning,
    });
  }, [live, liveState, isCompactionRunning]);
  const liveRow = snapshot?.rows[snapshot.liveStartIndex];

  useEffect(() => {
    if (!snapshot || snapshot.liveStartIndex < 0) return;
    live?.findSource?.publish(() => buildTranscriptFindEntries(snapshot.rows));
  }, [live?.findSource, snapshot]);

  return (
    <AssistantActivityRow
      {...rowProps}
      row={liveRow?.kind === "assistant-activity" ? liveRow : row}
      isCompactionRunning={isCompactionRunning}
      toolStatus={normalizeLiveToolStatus(liveState?.toolStatus ?? null)}
      retryAttempts={liveState?.retryAttempts}
    />
  );
});
