import { ChangedFilesActionsProvider } from "@liveagent/ui/components/chat/ChangedFilesCard";
import { FileDropOverlay } from "@liveagent/ui/components/chat/FileDropOverlay";
import type { MentionComposerHandle } from "@liveagent/ui/components/chat/MentionComposer";
import { ScheduledReplyPreview } from "@liveagent/ui/components/chat/ScheduledReplyPreview";
import { AssistantVisualContext } from "@liveagent/ui/components/chat/AssistantVisuals";
import { ConversationReaderWorkbench } from "@liveagent/ui/components/resource-preview/ConversationReaderWorkbench";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ScrollFollowHandle } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { ChatComposerBar } from "@liveagent/ui/pages/chat/ChatComposerBar";
import {
  type ForwardedRef,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PaneLoadingSkeleton } from "../../../components/app/PaneLoadingSkeleton";
import { isKBrainBackendEnabled } from "../../../lib/host";
import { ConversationStatsBarHost } from "../components/ConversationStatsBarHost";
import { CurrentTaskProgress } from "../components/CurrentTaskProgress";
import { DesktopCheckpointRewindProvider } from "../components/DesktopCheckpointRewindProvider";
import { KBrainCheckpointRewindProvider } from "../components/KBrainCheckpointRewindProvider";
import { PendingToolApprovalBar } from "../components/PendingToolApprovalBar";
import { KBrainGoalBarHost } from "../composer/KBrainGoalBarHost";
import type { ConversationPaneHostHandle } from "../conversations/useConversationPaneHostBridge";
import { useConversationSurfaceSnapshot } from "../conversations/useConversationSurfaceSnapshot";
import { buildQueuedChatTurnPreview } from "../queue/chatTurnQueue";
import {
  KBrainSubagentPaneHost,
  KBrainSubagentRunningChip,
} from "../subagents/KBrainSubagentPaneHost";

const CheckpointRewindProvider = isKBrainBackendEnabled()
  ? KBrainCheckpointRewindProvider
  : DesktopCheckpointRewindProvider;

import { ChatTranscript } from "../transcript/ChatTranscript";
import {
  type ConversationPaneRegistration,
  sameConversationPaneRegistration,
  useConversationPaneRegistration,
} from "./ConversationPaneHostEnvironment";
import { ConversationSurface } from "./ConversationSurface";
import { useDesktopConversationImages } from "./useDesktopConversationImages";
import {
  beginPaneComposerDraftSession,
  restoreClearedPaneComposerDraft,
} from "./paneComposerDraftSession";
import { createPaneComposerSendHandler } from "./paneComposerSend";

export type ConversationPaneHostProps = {
  paneId: string;
};

export type RestorableConversationPaneHostProps = ConversationPaneHostProps & {
  title?: string;
  deferHydration?: boolean;
  historyRefresh?: { version: string; reload: () => Promise<unknown> };
};

export const RestorableConversationPaneHost = forwardRef<
  ConversationPaneHostHandle,
  RestorableConversationPaneHostProps
>(function RestorableConversationPaneHost(props, forwardedRef) {
  const registration = useConversationPaneRegistration(props.paneId);
  if (!registration) {
    return <PendingConversationPaneHost />;
  }
  return (
    <RegisteredRestorableConversationPaneHost
      registration={registration}
      title={props.title}
      deferHydration={props.deferHydration ?? false}
      historyRefresh={props.historyRefresh}
      forwardedRef={forwardedRef}
    />
  );
});

function PendingConversationPaneHost() {
  const { t } = useLocale();
  return <PaneLoadingSkeleton label={t("chat.loadingConversation")} />;
}

function RegisteredRestorableConversationPaneHostContent(props: {
  registration: ConversationPaneRegistration;
  title?: string;
  deferHydration: boolean;
  historyRefresh?: RestorableConversationPaneHostProps["historyRefresh"];
  forwardedRef: ForwardedRef<ConversationPaneHostHandle>;
}) {
  const { registration, title, deferHydration, forwardedRef, historyRefresh } = props;
  const { t } = useLocale();
  const { controller } = registration.binding;
  const snapshot = useConversationSurfaceSnapshot(controller);
  const refreshVersion = historyRefresh?.version;
  const reloadHistoryRef = useRef(historyRefresh?.reload);
  reloadHistoryRef.current = historyRefresh?.reload;
  const [readyVersion, setReadyVersion] = useState<string>();
  const isRunning = snapshot.runtime?.isSending || registration.binding.isConversationRunning;
  const hasRuntime = Boolean(snapshot.runtime);

  useEffect(() => {
    if (!refreshVersion || readyVersion === refreshVersion || !hasRuntime || isRunning) return;
    let retired = false;
    let timer: number;
    async function reload(version: string) {
      try {
        const snapshot = await reloadHistoryRef.current?.();
        if (retired) return;
        if (snapshot) {
          setReadyVersion(version);
          return;
        }
      } catch {
        // Keep the preview until the native history is readable.
      }
      if (!retired) timer = window.setTimeout(() => void reload(version), 4000);
    }
    void reload(refreshVersion);
    return () => {
      retired = true;
      window.clearTimeout(timer);
    };
  }, [hasRuntime, isRunning, readyVersion, refreshVersion]);

  useEffect(() => {
    if (snapshot.runtime || snapshot.lifecycle.hydrating || snapshot.lifecycle.hydrationFailed) {
      return;
    }
    let cancelled = false;
    const hydrate = () => {
      if (!cancelled) void controller.hydrate().catch(() => undefined);
    };
    if (!deferHydration) {
      hydrate();
      return;
    }
    if (typeof window.requestIdleCallback === "function") {
      const idleCallback = window.requestIdleCallback(hydrate, {
        timeout: 800,
      });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(idleCallback);
      };
    }
    const timeout = window.setTimeout(hydrate, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [
    controller,
    deferHydration,
    snapshot.lifecycle.hydrating,
    snapshot.lifecycle.hydrationFailed,
    snapshot.runtime,
  ]);

  if (!snapshot.runtime) {
    const loading = snapshot.lifecycle.hydrating;
    if (loading) {
      return <PaneLoadingSkeleton label={t("chat.loadingConversation")} />;
    }
    return (
      <div
        className={cn(
          "flex size-full min-h-0 flex-col items-center justify-center gap-3 p-6",
          "text-center",
        )}
      >
        <p className="text-sm text-muted-foreground">{title || t("chat.pendingTitle")}</p>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted"
          onClick={() => void controller.retry().catch(() => undefined)}
        >
          {t("workbench.loadConversation")}
        </button>
      </div>
    );
  }

  return (
    <RegisteredConversationPaneHost
      ref={forwardedRef}
      registration={registration}
      suspendMessageJump={Boolean(refreshVersion && refreshVersion !== readyVersion)}
      scheduledHistoryReady={Boolean(refreshVersion && refreshVersion === readyVersion)}
    />
  );
}

export const ConversationPaneHost = forwardRef<
  ConversationPaneHostHandle,
  ConversationPaneHostProps
>(function ConversationPaneHost(props, forwardedRef) {
  const registration = useConversationPaneRegistration(props.paneId);
  if (!registration) {
    return <PendingConversationPaneHost />;
  }
  return <RegisteredConversationPaneHost ref={forwardedRef} registration={registration} />;
});

const RegisteredConversationPaneHostContent = forwardRef<
  ConversationPaneHostHandle,
  {
    registration: ConversationPaneRegistration;
    suspendMessageJump?: boolean;
    scheduledHistoryReady?: boolean;
  }
>(function RegisteredConversationPaneHost(props, forwardedRef) {
  const { identity, binding } = props.registration;
  const { paneId, conversationId } = identity;
  const {
    controller,
    transcript,
    composer,
    changedFilesActions,
    checkpointRewind,
    isConversationRunning,
    scheduledRun,
    fileDrop,
    trajectory,
    sendDraft,
  } = binding;
  const composerRef = useRef<MentionComposerHandle | null>(null);
  const scrollFollowRef = useRef<ScrollFollowHandle | null>(null);
  const images = useDesktopConversationImages(
    conversationId,
    transcript.workspaceRoot ?? "",
    !scheduledRun && !trajectory?.active,
  );
  const [composerOverlayHeight, setComposerOverlayHeight] = useState(0);
  const [composerFloatingOverhang, setComposerFloatingOverhang] = useState(0);
  const [composerCenterOffset, setComposerCenterOffset] = useState(0);
  // Background panes send through their own conversation-scoped pipeline; the
  // handler owns clear-on-send/restore-on-failure for this pane's composer.
  const paneSendHandler = useMemo(
    () =>
      sendDraft
        ? createPaneComposerSendHandler({
            composerRef,
            clearConversationDraft: () => controller.clearDraft(),
            restoreConversationDraft: (draft) => controller.setDraft(draft),
            hasPendingUploads: () => controller.getSnapshot().uploads.length > 0,
            sendDraft,
          })
        : null,
    [controller, sendDraft],
  );

  const handleQuoteSelection = useCallback((text: string) => {
    composerRef.current?.insertQuote(text);
  }, []);

  useImperativeHandle(
    forwardedRef,
    () => ({
      getComposer: () => composerRef.current,
      getScrollFollow: () => scrollFollowRef.current,
    }),
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on conversationId so primary↔background controller swaps for the same conversation never clear a composer mid-typing.
  useLayoutEffect(() => {
    const composer = composerRef.current;
    return beginPaneComposerDraftSession(composer, {
      getDraft: () => controller.getSnapshot().draft,
      setDraft: (draft) => controller.setDraft(draft),
      clearDraft: controller.composerScopeId ? () => controller.clearDraft() : undefined,
    });
  }, [conversationId]);

  // Focus leaving this pane swaps it from the primary binding (no sendDraft)
  // to a background one for the same conversation. The page pipeline cleared
  // this composer while it was still primary, after caching its draft; put the
  // draft back. Only this transition is handled: the incoming pane is never
  // cleared, and restoring on focus-in could resurrect text the user deleted.
  const isBackgroundPane = Boolean(sendDraft);
  const wasBackgroundPaneRef = useRef(isBackgroundPane);
  useLayoutEffect(() => {
    const wasBackgroundPane = wasBackgroundPaneRef.current;
    wasBackgroundPaneRef.current = isBackgroundPane;
    if (wasBackgroundPane || !isBackgroundPane) return;
    restoreClearedPaneComposerDraft(composerRef.current, {
      getDraft: () => controller.getSnapshot().draft,
    });
  }, [controller, isBackgroundPane]);

  const kbrainSubagents = isKBrainBackendEnabled();
  const surface = (
    <ConversationSurface
      paneId={paneId}
      contentWidth={transcript.contentWidth}
      controller={controller}
      renderContent={(snapshot) => {
        const runtime = snapshot.runtime;
        const historyItems = runtime?.state.transcript.items ?? [];
        const scheduleActive = Boolean(scheduledRun?.active);
        const isSending = Boolean(runtime?.isSending || scheduleActive);
        const preview = scheduledRun?.preview;
        const previewStreaming = scheduleActive && !preview?.done;
        const scheduledReply =
          scheduledRun &&
          preview &&
          (previewStreaming || ((preview.text || preview.prompt) && !props.scheduledHistoryReady))
            ? {
                key: `scheduled-preview:${scheduledRun.run.id}`,
                content: (
                  <ScheduledReplyPreview
                    preview={preview}
                    startedAt={scheduledRun.run.startedAt}
                    streaming={previewStreaming}
                    showPrompt={
                      !historyItems.some(
                        (item) =>
                          item.kind === "user" &&
                          item.messageRef?.messageId === preview.prompt?.messageId,
                      )
                    }
                  />
                ),
              }
            : undefined;
        const isCompactionRunning = snapshot.compaction.phase === "running";
        const queuedTurns = snapshot.queue.map((item) => ({
          id: item.id,
          previewText: buildQueuedChatTurnPreview(item.draft),
          fileCount: item.uploadedFiles.length,
        }));
        const trajectoryActive = Boolean(trajectory?.active);

        return {
          transcript: trajectoryActive ? (
            trajectory?.renderContent(snapshot)
          ) : (
            <ChangedFilesActionsProvider value={changedFilesActions}>
              <CheckpointRewindProvider
                conversationId={snapshot.conversationId}
                workspaceRoot={transcript.workspaceRoot}
                project={checkpointRewind.project}
                disabled={checkpointRewind.disabled}
                onRewound={checkpointRewind.onRewound}
              >
                <ChatTranscript
                  {...transcript}
                  messageJump={props.suspendMessageJump ? undefined : transcript.messageJump}
                  conversationId={snapshot.conversationId}
                  followRef={scrollFollowRef}
                  historyItems={historyItems}
                  hasMoreHistory={runtime?.state.transcript.hasMoreBefore ?? false}
                  isSending={Boolean(runtime?.isSending || (previewStreaming && !scheduledReply))}
                  pendingReply={scheduledReply}
                  isCompactionRunning={isCompactionRunning}
                  bottomReservePx={composerOverlayHeight}
                  floatingOverhangPx={composerFloatingOverhang}
                  composerCenterOffsetPx={composerCenterOffset}
                  onQuoteSelection={handleQuoteSelection}
                />
              </CheckpointRewindProvider>
            </ChangedFilesActionsProvider>
          ),
          composer: (
            <ChatComposerBar
              focusImagePlacement
              {...composer}
              {...(paneSendHandler ? { onSend: paneSendHandler } : {})}
              conversationId={snapshot.conversationId}
              // 轨迹页是只读分析视图：挂起输入区（保持挂载，草稿不丢）。
              hidden={trajectoryActive}
              composerRef={composerRef}
              isSending={isSending}
              pendingUploadedFiles={snapshot.uploads}
              queuedTurns={queuedTurns}
              goalBar={
                <KBrainGoalBarHost
                  key={`goal-${snapshot.conversationId}`}
                  conversationId={snapshot.conversationId}
                  commandHost={composer.commandHost}
                  enabled={isKBrainBackendEnabled()}
                />
              }
              onStop={scheduledRun?.active ? () => scheduledRun.cancel?.() : controller.stop}
              stopDisabled={Boolean(scheduledRun?.active && !scheduledRun.cancel)}
              queueRunDisabled={scheduleActive || composer.queueRunDisabled}
              onManualCompactConfirm={controller.compact}
              manualCompactBlocked={isCompactionRunning}
              onHeightChange={setComposerOverlayHeight}
              onFloatingOverhangChange={setComposerFloatingOverhang}
              onCenterOffsetChange={setComposerCenterOffset}
              taskProgressBar={
                <>
                  <CurrentTaskProgress
                    key={snapshot.conversationId}
                    historyItems={historyItems}
                    liveTranscriptStore={transcript.liveTranscriptStore}
                    isConversationRunning={isSending || isConversationRunning}
                  />
                  {kbrainSubagents && !trajectoryActive ? (
                    <KBrainSubagentRunningChip
                      key={`subagents-${snapshot.conversationId}`}
                      conversationId={snapshot.conversationId}
                    />
                  ) : null}
                </>
              }
              approvalBar={
                snapshot.approvals.length > 0 ? (
                  <PendingToolApprovalBar
                    conversationId={snapshot.conversationId}
                    approvals={snapshot.approvals}
                  />
                ) : null
              }
              statsBar={
                <ConversationStatsBarHost
                  // 前缀防与同级 taskProgressBar 的 key（裸会话 id）碰撞：React 对同键
                  // 兄弟的 keyed diff 会让旧 fiber 逃过删除，DOM 残留逐次累积。
                  key={`stats-${snapshot.conversationId}`}
                  conversationId={snapshot.conversationId}
                  // 轨迹页挂起输入区时状态栏随之隐藏，无需重复拉取。
                  enabled={!trajectoryActive}
                  contextUsageTokensSource={composer.contextUsageTokensSource}
                  contextWindow={composer.contextWindow}
                  onManualCompactConfirm={controller.compact}
                  manualCompactBlocked={isCompactionRunning}
                />
              }
              fileDropOverlay={
                fileDrop.active ? (
                  <FileDropOverlay
                    variant="composer"
                    canDropUpload={fileDrop.canDropUpload}
                    title={fileDrop.title}
                    description={fileDrop.description}
                    limitHint={fileDrop.limitHint}
                  />
                ) : null
              }
            />
          ),
        };
      }}
    />
  );
  // The subagent pane sits beside this conversation, so split panes each get their own.
  const conversationWithSubagents = kbrainSubagents ? (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {surface}
      <KBrainSubagentPaneHost
        conversationId={conversationId}
        workdir={transcript.workspaceRoot}
        onOpenFileLink={transcript.onOpenFileLink}
      />
    </div>
  ) : (
    surface
  );

  return (
    <ConversationReaderWorkbench
      open={images?.panel === true}
      primaryVisible
      readingScope={`device-image:${conversationId}`}
      primary={
        <AssistantVisualContext.Provider value={images?.visuals ?? null}>
          {conversationWithSubagents}
        </AssistantVisualContext.Provider>
      }
    >
      {images?.reader}
    </ConversationReaderWorkbench>
  );
});

// Context changes reach the small lookup wrapper; unchanged bindings stop here.
const RegisteredRestorableConversationPaneHost = memo(
  RegisteredRestorableConversationPaneHostContent,
  (previous, next) =>
    sameConversationPaneRegistration(previous.registration, next.registration) &&
    previous.title === next.title &&
    previous.deferHydration === next.deferHydration &&
    previous.historyRefresh?.version === next.historyRefresh?.version &&
    previous.forwardedRef === next.forwardedRef,
);
const RegisteredConversationPaneHost = memo(
  RegisteredConversationPaneHostContent,
  (previous, next) =>
    previous.suspendMessageJump === next.suspendMessageJump &&
    previous.scheduledHistoryReady === next.scheduledHistoryReady &&
    sameConversationPaneRegistration(previous.registration, next.registration),
);
