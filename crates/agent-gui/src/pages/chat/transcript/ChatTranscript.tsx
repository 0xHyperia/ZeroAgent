import { ChatEmptyState } from "@liveagent/ui/components/chat/ChatEmptyState";
import { ChatFileLinkContextMenuHost } from "@liveagent/ui/components/chat/ChatFileLinkContextMenu";
import { TranscriptCommentProvider } from "@liveagent/ui/components/chat/TranscriptCommentContext";
import { TranscriptFindBar } from "@liveagent/ui/components/chat/TranscriptFindBar";
import { TranscriptLatestButton } from "@liveagent/ui/components/chat/TranscriptLatestButton";
import { TranscriptQuoteSelection } from "@liveagent/ui/components/chat/TranscriptQuoteSelection";
import { Copy } from "@liveagent/ui/components/IconSet";
import { ContextMenuItem, ContextMenuPopup } from "@liveagent/ui/components/ui/context-menu";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  clearSearchJumpTarget,
  getSearchJumpTargetSnapshot,
  resolveSearchJumpRowKey,
  subscribeSearchJumpTarget,
} from "@liveagent/ui/lib/chat/searchJumpTarget";
import { buildFloorEntries } from "@liveagent/ui/lib/chat-floor-nav/floorModel";
import { useScrollFollow } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { isMacLikePlatform } from "@liveagent/ui/lib/transcript-find/transcriptFind";
import { createTranscriptFindSource } from "@liveagent/ui/lib/transcript-find/transcriptFindSource";
import { useTranscriptFind } from "@liveagent/ui/lib/transcript-find/useTranscriptFind";
import { useTranscriptMessageJump } from "@liveagent/ui/lib/transcript-virtual/useTranscriptMessageJump";
import { FloorNavRail } from "@liveagent/ui/pages/chat/transcript/FloorNavRail";
import { TranscriptWidthControls } from "@liveagent/ui/pages/chat/transcript/TranscriptWidthControls";
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isTauriHost } from "../../../lib/host";
import { RowInteractionProvider, useRowInteractionStore } from "./rowInteraction";
import { TranscriptList, type TranscriptNavHandle } from "./TranscriptList";
import { HistorySwitchLoadingOverlay } from "./TranscriptLoadingStates";
import type { ChatTranscriptProps } from "./transcriptTypes";
import {
  resolveTranscriptSelectionText,
  type TranscriptContextMenuState,
  writeTextToClipboard,
} from "./transcriptUtils";

export type { ChatTranscriptProps } from "./transcriptTypes";

// Short and medium conversations paint directly. Only large transcripts keep
// the convergence gate that prevents a visible estimate-to-measure jump.
const DEFER_REVEAL_HISTORY_ITEM_THRESHOLD = 120;
const SEARCH_JUMP_MAX_PAGES = 20;

export const ChatTranscript = memo(function ChatTranscript(props: ChatTranscriptProps) {
  const {
    conversationId,
    workspaceRoot,
    gitClient,
    followRef,
    hasModels,
    historyItems,
    hasMoreHistory,
    onLoadEarlierHistory,
    messageJump,
    isHistorySwitching,
    isSending,
    pendingReply,
    showUsage,
    usageContextWindow,
    liveTranscriptStore,
    isCompactionRunning,
    bottomReservePx = 0,
    floatingOverhangPx = 0,
    composerCenterOffsetPx = 0,
    contentWidth,
    onContentWidthChange,
    onOpenFileLink,
    onResendFromEdit,
    onBranchConversation,
    branchPendingMessageId,
    onOpenSettings,
    onSuggestionSelect,
    onQuoteSelection,
    onCommentSelection,
  } = props;
  const { t } = useLocale();
  const showNoModelsState = !hasModels && !pendingReply;
  const showStartChatState = hasModels && historyItems.length === 0 && !isSending && !pendingReply;
  const shouldReserveTranscriptBottomSpace = !(showNoModelsState || showStartChatState);
  // Leave 16px between the last row and the composer, including the transcript wrapper's 8px bottom padding.
  const transcriptBottomReservePx = shouldReserveTranscriptBottomSpace
    ? Math.ceil(bottomReservePx + floatingOverhangPx) + 8
    : 0;
  // The native viewport arrives via a callback ref → state so scroll-follow
  // and the virtualizer re-bind on identity changes. Keeping the transcript
  // off Base UI's custom ScrollArea also removes its per-scroll geometry,
  // computed-style and inherited CSS-variable work from WebKit's hot path.
  const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(null);
  const transcriptRootRef = useRef<HTMLDivElement | null>(null);
  // The find shortcut listener binds to the root element itself (always
  // rendered, so one read after mount is enough).
  const [transcriptRoot, setTranscriptRoot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    setTranscriptRoot(transcriptRootRef.current);
  }, []);

  const [transcriptContextMenu, setTranscriptContextMenu] =
    useState<TranscriptContextMenuState | null>(null);

  const closeTranscriptContextMenu = useCallback(() => {
    setTranscriptContextMenu(null);
  }, []);

  const { handle: scrollFollowHandle, following } = useScrollFollow({
    viewport: scrollViewport,
    listenerRoot: scrollViewport,
    trackKeys: true,
    // 回贴区为 0：只有真正到达底部（8px 容差内）才恢复跟随。192px 回贴区会在
    // 滚轮下行进入该区间的那一 tick 直接 pin 到底，读者看到的是正文突然上跳；
    // 到达底部后向下滚轮、手势落底、指针在底部释放仍会重新贴底。
    config: { reattachZonePx: 0 },
  });

  // Earlier-history paging lives in TranscriptList next to the virtualizer:
  // a prepended page is anchored by the virtualizer's origin (the row under
  // the viewport keeps its position with no scrollTop write from here), and
  // the "near the top" trigger has to read the virtualizer's settled offset
  // rather than the parked DOM scrollTop.

  // 楼层导航：从时间线派生用户消息楼层；当前楼层由 TranscriptList 上报。
  // 不在此处按 conversationId 重置——TranscriptList 按会话重挂载后其挂载
  // effect 会先于本组件的 effect 执行并上报新会话锚点，这里再置 null 会把
  // 刚上报的值清掉且被子组件的去重永久抑制。行 key 含 segmentId，跨会话
  // 不会误匹配，等待子组件上报即可。
  const floors = useMemo(() => buildFloorEntries(historyItems), [historyItems]);
  const [activeFloorKey, setActiveFloorKey] = useState<string | null>(null);
  const transcriptNavRef = useRef<TranscriptNavHandle | null>(null);
  const saveReadingPositionRef = useRef<(() => void) | null>(null);
  const shouldDeferTranscriptReveal =
    !isSending && historyItems.length >= DEFER_REVEAL_HISTORY_ITEM_THRESHOLD;
  const [settledConversationId, setSettledConversationId] = useState<string | null>(null);
  const handleFirstLayoutSettled = useCallback(() => {
    setSettledConversationId(conversationId);
  }, [conversationId]);
  const isTranscriptSettling =
    shouldReserveTranscriptBottomSpace &&
    shouldDeferTranscriptReveal &&
    settledConversationId !== conversationId;
  // Width controls must suspend while the loading overlay covers them.
  const isTranscriptBusy = isHistorySwitching || isTranscriptSettling;
  const handleFloorJump = useCallback(
    (rowKey: string) => {
      // 粘底跟随激活时程序化滚动会被立即拽回底部——先按「跳入历史」语义解除
      // 跟随，再执行跳转。
      scrollFollowHandle.breakFollow();
      transcriptNavRef.current?.scrollToRowKey(rowKey);
    },
    [scrollFollowHandle],
  );
  useTranscriptMessageJump({
    target: messageJump,
    rowKey: messageJump
      ? historyItems.find(
          (item) => item.kind === "user" && item.messageRef?.messageId === messageJump.messageId,
        )?.key
      : undefined,
    historyBoundary: historyItems[0]?.key ?? "",
    hasMoreHistory,
    loadEarlier: onLoadEarlierHistory,
    ready: Boolean(scrollViewport) && !isHistorySwitching,
    jumpToRow: handleFloorJump,
  });

  // 会话搜索跳转：目标消息在已加载窗口内就滚过去；否则逐页加载更早历史，
  // 直到命中或没有更多历史为止（最多 SEARCH_JUMP_MAX_PAGES 页）。
  const searchJumpPagesRef = useRef(0);
  const pendingSearchJump = useSyncExternalStore(
    subscribeSearchJumpTarget,
    getSearchJumpTargetSnapshot,
  );
  useEffect(() => {
    if (isTranscriptBusy || !scrollViewport) return;
    const target = pendingSearchJump?.conversationId === conversationId ? pendingSearchJump : null;
    if (!target) {
      searchJumpPagesRef.current = 0;
      return;
    }
    const rowKey = resolveSearchJumpRowKey(
      historyItems.map((item) => ({
        kind: item.kind,
        key: item.key,
        messageId: item.kind === "user" ? item.messageRef?.messageId : undefined,
        messageIndex:
          item.kind === "user"
            ? item.messageRef?.messageIndex
            : item.kind === "assistant"
              ? item.messageIndex
              : undefined,
      })),
      target,
    );
    if (rowKey) {
      const frame = requestAnimationFrame(() => {
        if (getSearchJumpTargetSnapshot() !== target || !transcriptNavRef.current) return;
        // A page prepend can rerender before the frame runs. Keep the target
        // pending until the current virtualizer can actually perform the jump.
        clearSearchJumpTarget(target);
        searchJumpPagesRef.current = 0;
        handleFloorJump(rowKey);
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!hasMoreHistory || searchJumpPagesRef.current >= SEARCH_JUMP_MAX_PAGES) {
      clearSearchJumpTarget(target);
      searchJumpPagesRef.current = 0;
      return;
    }
    searchJumpPagesRef.current += 1;
    void onLoadEarlierHistory().catch(() => clearSearchJumpTarget(target));
  }, [
    conversationId,
    handleFloorJump,
    pendingSearchJump,
    hasMoreHistory,
    historyItems,
    isTranscriptBusy,
    onLoadEarlierHistory,
    scrollViewport,
  ]);

  // Find in conversation (Cmd/Ctrl+F): matches are counted on the row model
  // TranscriptList publishes, then the active row is mounted through the
  // floor-jump handle and highlighted in the DOM.
  const [findSource] = useState(createTranscriptFindSource);
  const [isMac] = useState(isMacLikePlatform);
  const scrollToFindRow = useCallback((rowKey: string) => {
    transcriptNavRef.current?.scrollToRowKey(rowKey);
  }, []);
  const find = useTranscriptFind({
    root: transcriptRoot,
    scrollViewport,
    source: findSource,
    scrollToRowKey: scrollToFindRow,
    breakFollow: scrollFollowHandle.breakFollow,
    bottomInsetPx: transcriptBottomReservePx,
    resetKey: conversationId,
    isMac,
  });

  // Run-scoped state reaches row action bars through this store instead of
  // row props, so settled rows stay memo-stable across run start/settle.
  const rowInteractionStore = useRowInteractionStore({
    isSending,
    branchPendingMessageId: branchPendingMessageId ?? null,
  });

  useLayoutEffect(() => {
    const handle = {
      ...scrollFollowHandle,
      saveReadingPosition: () => saveReadingPositionRef.current?.(),
    };
    followRef.current = handle;
    return () => {
      if (followRef.current === handle) {
        followRef.current = null;
      }
    };
  }, [followRef, scrollFollowHandle]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId intentionally closes any menu left open by the previous transcript.
  useEffect(() => {
    closeTranscriptContextMenu();
  }, [closeTranscriptContextMenu, conversationId]);

  const handleTranscriptContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const selectedText = resolveTranscriptSelectionText(transcriptRootRef.current);
      if (!selectedText) {
        closeTranscriptContextMenu();
        return;
      }
      setTranscriptContextMenu({
        x: event.clientX,
        y: event.clientY,
        selectedText,
      });
    },
    [closeTranscriptContextMenu],
  );

  const copySelectedTextLabel = t("chat.transcript.copySelectedText");
  const resizeTranscriptLabel = t("chat.transcript.resizeWidth");
  const resetTranscriptWidthLabel = t("chat.transcript.resizeWidthReset");

  const transcriptView = (
    // biome-ignore lint/a11y/noStaticElementInteractions: The transcript surface exposes a pointer context menu; transcript content and menu items retain their own keyboard semantics.
    <div
      ref={transcriptRootRef}
      // `@container`: transcript overlays (FloorNavRail 等) size against the
      // pane, not the viewport — a narrow pane in a wide split window must
      // degrade like a narrow window.
      className="@container relative min-h-0 flex-1"
      onContextMenu={handleTranscriptContextMenu}
    >
      <div
        ref={setScrollViewport}
        data-scroll-viewport
        role="region"
        aria-label={t("chat.transcript.messages")}
        tabIndex={-1}
        className="chat-transcript-viewport chat-transcript-scrollbar mx-1.5 h-full overflow-y-auto [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]"
      >
        <div
          className={cn(
            // The assistant rows no longer reserve a 40px avatar column, so the
            // transcript column gives that width back instead of widening the
            // reading measure. Keeps assistant text at its original width and
            // aligned with the composer, which is tuned off the same variable.
            "mx-auto w-full max-w-transcript-web px-5 pb-2 pt-4 [overflow-anchor:none]",
            // Empty states center against the scroll viewport (the pane), not
            // the window: a viewport-height min-height overflows half-height
            // panes in vertical splits and shifts the hero content.
            (showNoModelsState || showStartChatState) && "flex min-h-full flex-col",
          )}
        >
          {showNoModelsState || showStartChatState ? (
            <div className="flex flex-1 flex-col items-center justify-center pb-24">
              {/* Keyed per conversation so the hero entrance replays when
                  switching between empty conversations, not just on mount. */}
              <ChatEmptyState
                key={conversationId ?? "empty"}
                variant={showNoModelsState ? "no-models" : "start-chat"}
                onOpenSettings={onOpenSettings}
                onSuggestionSelect={onSuggestionSelect}
              />
            </div>
          ) : null}

          <div className={cn("select-text", isTranscriptSettling && "invisible")}>
            <RowInteractionProvider value={rowInteractionStore}>
              {/* Keyed remount per conversation: per-conversation state
                  (row model, entrance registry, virtualizer measurements)
                  initializes fresh, and row keys can never collide across
                  conversations in the virtualizer's itemSizeCache. */}
              <TranscriptList
                key={conversationId}
                conversationId={conversationId}
                historyItems={historyItems}
                pendingReply={pendingReply}
                hasMoreHistory={hasMoreHistory}
                onLoadEarlierHistory={onLoadEarlierHistory}
                isHistorySwitching={isHistorySwitching}
                liveTranscriptStore={liveTranscriptStore}
                scrollViewport={scrollViewport}
                layoutWidth={contentWidth}
                isViewportFollowing={scrollFollowHandle.isFollowing}
                viewportFollowing={following}
                onRestoreFollowing={scrollFollowHandle.restoreFollowing}
                isSending={isSending}
                isCompactionRunning={isCompactionRunning}
                showUsage={showUsage}
                usageContextWindow={usageContextWindow}
                workspaceRoot={workspaceRoot}
                onOpenFileLink={onOpenFileLink}
                gitClient={gitClient}
                navRef={transcriptNavRef}
                saveReadingPositionRef={saveReadingPositionRef}
                onAnchorUserRowChange={setActiveFloorKey}
                onResendFromEdit={onResendFromEdit}
                onBranchConversation={onBranchConversation}
                onFirstLayoutSettled={
                  shouldDeferTranscriptReveal ? handleFirstLayoutSettled : undefined
                }
                findSource={findSource}
              />
            </RowInteractionProvider>
          </div>

          <div style={{ height: transcriptBottomReservePx }} />
        </div>
      </div>
      <TranscriptWidthControls
        hostRef={transcriptRootRef}
        width={contentWidth}
        onWidthChange={onContentWidthChange}
        resizeLabel={resizeTranscriptLabel}
        resetLabel={resetTranscriptWidthLabel}
        suspended={isTranscriptBusy}
      />
      {!showNoModelsState && !showStartChatState && !isTranscriptSettling ? (
        <FloorNavRail
          conversationId={conversationId}
          floors={floors}
          activeRowKey={activeFloorKey}
          bottomOffset={`${Math.ceil(transcriptBottomReservePx) + 8}px`}
          scrollViewport={scrollViewport}
          onJump={handleFloorJump}
        />
      ) : null}
      {!following && !isTranscriptBusy && (historyItems.length > 0 || pendingReply || isSending) ? (
        <TranscriptLatestButton
          viewport={scrollViewport}
          onJump={scrollFollowHandle.jumpToBottom}
          // Centered on the composer card (not the pane) and stacked above
          // the task-progress pill / queue panel: the composer layer paints
          // over the transcript, so any overlap would hide the button.
          left={`calc(50% + ${Math.round(composerCenterOffsetPx)}px)`}
          bottom={Math.ceil(bottomReservePx) + Math.ceil(floatingOverhangPx) + 16}
        />
      ) : null}
      {typeof document !== "undefined" && transcriptContextMenu ? (
        <ContextMenuPopup
          point={transcriptContextMenu}
          onClose={closeTranscriptContextMenu}
          className="min-w-38"
        >
          {transcriptContextMenu ? (
            <ContextMenuItem
              onClick={() => {
                writeTextToClipboard(transcriptContextMenu.selectedText);
                closeTranscriptContextMenu();
              }}
            >
              <Copy className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{copySelectedTextLabel}</span>
            </ContextMenuItem>
          ) : null}
        </ContextMenuPopup>
      ) : null}
      {onQuoteSelection ? (
        <TranscriptQuoteSelection
          rootRef={transcriptRootRef}
          scopeKey={conversationId}
          enabled={!isTranscriptBusy}
          onQuote={onQuoteSelection}
          onComment={onCommentSelection}
        />
      ) : null}
      <TranscriptFindBar find={find} />
      <ChatFileLinkContextMenuHost
        canOpenWithDefaultApp={isTauriHost()}
        canOpenInLocalEditor={props.canOpenInLocalEditor}
      />
      {isTranscriptBusy ? <HistorySwitchLoadingOverlay /> : null}
    </div>
  );
  return (
    <TranscriptCommentProvider onComment={isTranscriptBusy ? null : onCommentSelection}>
      {transcriptView}
    </TranscriptCommentProvider>
  );
});
