import {
  AssistantBubble,
  LiveAssistantStatus,
} from "@liveagent/ui/components/chat/AssistantBubble";
import { AssistantDeliverables } from "@liveagent/ui/components/chat/AssistantDeliverables";
import { AssistantVisualActivity } from "@liveagent/ui/components/chat/AssistantVisuals";
import { BackgroundNoticeMessage } from "@liveagent/ui/components/chat/BackgroundNoticeMessage";
import { ChatEmptyState } from "@liveagent/ui/components/chat/ChatEmptyState";
import { ChatFileLinkContextMenuHost } from "@liveagent/ui/components/chat/ChatFileLinkContextMenu";
import { ContextCheckpointCard } from "@liveagent/ui/components/chat/ContextCheckpointCard";
import { DocumentRevisionMessageBody } from "@liveagent/ui/components/chat/DocumentRevisionMessageChip";
import { EditableUserMessageBubble } from "@liveagent/ui/components/chat/EditableUserMessageBubble";
import { ProcessDisclosureProvider } from "@liveagent/ui/components/chat/processDisclosure";
import { RetryDetailsBlock } from "@liveagent/ui/components/chat/RetryDetailsBlock";
import type { ScheduledPreviewRow } from "@liveagent/ui/components/chat/ScheduledReplyPreview";
import {
  type TranscriptCommentHandler,
  TranscriptCommentProvider,
} from "@liveagent/ui/components/chat/TranscriptCommentContext";
import {
  TranscriptAssistantMessageActions,
  TranscriptUserMessageActions,
} from "@liveagent/ui/components/chat/TranscriptMessageActions";
import { TranscriptQuoteSelection } from "@liveagent/ui/components/chat/TranscriptQuoteSelection";
import { TurnErrorNotice } from "@liveagent/ui/components/chat/TurnErrorNotice";
import { UserAttachmentCards } from "@liveagent/ui/components/chat/UserAttachmentCards";
import { Loader2 } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/LocaleContext";
import {
  normalizeLiveToolStatus,
  turnErrorDetailOf,
  turnErrorOf,
} from "@liveagent/ui/lib/chat/assistantStatus";
import { type ChatFileLink, chatAttachmentFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import {
  copyDocumentRevision,
  parseDocumentRevisionMessage,
} from "@liveagent/ui/lib/chat/documentRevisionMessage";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { ReplyShareSource } from "@liveagent/ui/lib/chat/replyShare";
import {
  type PendingUploadedFile,
  splitUserAttachmentsForDisplay,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import type { UploadedImagePreviewLoader } from "@liveagent/ui/lib/chat/uploadedImagePreview";
import { useCommitDetailsLoader } from "@liveagent/ui/lib/chat/useCommitDetailsLoader";
import {
  type CommitDetailsLoader,
  UserMessageContent,
} from "@liveagent/ui/lib/chat/userMessageContent";
import { chatDuration } from "@liveagent/ui/lib/chat/workTiming";
import type { GitClient } from "@liveagent/ui/lib/git/types";
import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { createLiveRowScrollAdjustPolicy } from "@liveagent/ui/lib/transcript-virtual/liveScrollAdjustPolicy";
import {
  buildTranscriptLayoutKey,
  createTranscriptMeasurementsLru,
} from "@liveagent/ui/lib/transcript-virtual/measurementsLru";
import {
  CHECKPOINT_ROW_ESTIMATE_PX,
  estimateAssistantRowHeight,
  estimateUserRowHeight,
  measureEstimateText,
} from "@liveagent/ui/lib/transcript-virtual/rowEstimates";
import {
  type TranscriptNavigationHandle,
  useTranscriptNavigation,
} from "@liveagent/ui/lib/transcript-virtual/useTranscriptNavigation";
import { type Range, useVirtualizer } from "@tanstack/react-virtual";
import {
  type Dispatch,
  type MutableRefObject,
  memo,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { HistoryMessageRef } from "@/lib/chat/conversationState";
import { getRoundText } from "@/lib/chat/uiMessages";
import { DEFAULT_CHAT_TRANSCRIPT_WIDTH } from "@/lib/settings";
import { extractLiveRange } from "@/lib/transcript-virtual/liveRangeExtractor";
import { findLiveTurnStartTimestamp } from "../lib/chat/transcript/rows";
import type { RetryAttemptRecord, TranscriptRow } from "../lib/chat/transcript/types";
import {
  GATEWAY_CHAT_COLUMN_CLASS,
  GATEWAY_EMPTY_STATE_CLASS,
  GATEWAY_TRANSCRIPT_ROW_CLASS,
  GATEWAY_TRANSCRIPT_SHELL_CLASS,
} from "../lib/webStyleClasses";
import type { SectionId } from "../pages/settings/types";

type GatewayScheduledTurn = {
  key: string;
  promptHistoryKey?: string;
  replyHistoryKey?: string;
  prompt?: ReactNode;
  reply?: ReactNode;
};

type GatewayTranscriptProps = {
  expandProcessByDefault?: boolean;
  detailedProgress?: boolean;
  editRequest?: { token: string; messageId: string } | null;
  onEditRequestHandled?: (token: string) => void;
  emptyState?: ReactNode;
  /** Host-owned feedback follows the final turn inside the same reading column. */
  footer?: ReactNode;
  scheduledTurn?: GatewayScheduledTurn;
  conversationId?: string;
  // The whole transcript as one row list, rendered by one virtualizer. Rows
  // come from one store assembly, so a row can never render twice.
  rows: readonly TranscriptRow[];
  // Index of the first unfolded-turn row (-1 when everything is folded);
  // rows at or after it are force-mounted so a streaming reply never
  // unmounts mid-run.
  liveStartIndex?: number;
  // Key of the actively streaming turn (caret / live structural state).
  activeTurnKey?: string | null;
  contentWidth?: number;
  // Whether the scroll-follow engine is attached to the bottom; gates the
  // virtualizer's resize-compensation carve-out for live-row growth.
  isViewportFollowing?: () => boolean;
  viewportFollowing?: boolean;
  // Imperative jump handle for the floor navigation rail.
  navRef?: MutableRefObject<GatewayTranscriptNavHandle | null>;
  // Reports the user row at the viewport's top edge (the "current floor").
  onAnchorUserRowChange?: (rowKey: string | null) => void;
  error?: string | null;
  toolStatus?: string | null;
  toolStatusIsCompaction?: boolean;
  // Live run's stream-retry history; renders as an expandable details block
  // under the live status (mirrors the desktop app).
  retryAttempts?: readonly RetryAttemptRecord[];
  isStreaming?: boolean;
  // Local Agent turns retain their live structure until folding. Cloud has a
  // separate durable Run lifecycle: settled prose is already the saved answer.
  assistantLiveMode?: "retained" | "streaming";
  isLoading?: boolean;
  loadingTitle?: string;
  hasModels?: boolean;
  onOpenSettings?: (section?: SectionId) => void;
  hasMoreHistory?: boolean;
  isLoadingMoreHistory?: boolean;
  onLoadEarlierHistory?: () => void;
  showUsage?: boolean;
  usageContextWindow?: number;
  workspaceRoot?: string;
  imagePreviewScope?: string;
  gitClient?: GitClient | null;
  onOpenFileLink?: (link: ChatFileLink) => void;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  onResendFromEdit?: (
    messageRef: HistoryMessageRef,
    text: string,
    uploadedFiles: PendingUploadedFile[],
    referencedConversations: ConversationMentionReference[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
  // Anchor messageId of the branch request in flight; the matching row shows
  // a spinner and every branch button disables until it settles.
  branchPendingMessageId?: string | null;
  resendCreatesBranch?: boolean;
  onSuggestionSelect?: (text: string) => void;
  onQuoteSelection?: (text: string) => void;
  onCommentSelection?: TranscriptCommentHandler;
  readOnly?: boolean;
  redactToolContent?: boolean;
};

// Stream-born rows keep Streamdown's streaming render mode forever — even
// after their turn folds — so the streaming→static mode flip (and its full
// re-parse) can never happen. History-born rows render static from the
// start.
function rowRenderMode(row: Extract<TranscriptRow, { kind: "assistant" }>) {
  return row.origin === "stream" ? ("streaming" as const) : ("static" as const);
}

export type GatewayTranscriptNavHandle = TranscriptNavigationHandle;

const TRANSCRIPT_ROW_ESTIMATED_HEIGHT = 260;
const TRANSCRIPT_ROW_GAP = 18;

// Bump when the transcript row model or its measurement semantics change:
// persisted snapshots outlive releases, and stale heights keyed only by
// widths would seed wrong layouts (and scroll-compensation churn) after an
// upgrade. Mirrors the GUI's versioned key.
const TRANSCRIPT_MEASUREMENT_LAYOUT_VERSION = "gateway-rows-v2";

function buildVersionedTranscriptLayoutKey(
  viewportWidth: number,
  contentWidth: number,
  assistantLiveMode: "retained" | "streaming",
) {
  const layoutKey = buildTranscriptLayoutKey(viewportWidth, contentWidth);
  return layoutKey
    ? `${layoutKey}:${TRANSCRIPT_MEASUREMENT_LAYOUT_VERSION}${assistantLiveMode === "streaming" ? ":cloud-settled-v1" : ""}`
    : "";
}

// Measured row heights survive conversation switches: saved on unmount,
// restored (width-gated) on the next open so the switch lays out with exact
// heights instead of estimates. Persisted so revisited conversations skip
// the estimate→measure correction churn across page reloads too.
const transcriptMeasurementsLru = createTranscriptMeasurementsLru({
  persistNamespace: "webui-transcript",
});

type GatewayTranscriptVirtualItem =
  | { key: string; kind: "loadRemoteHistory" }
  | { key: string; kind: "row"; row: TranscriptRow }
  | { key: string; kind: "pendingBubble" }
  | (ScheduledPreviewRow & { kind: "scheduledPreview" });

function resolveNearestScrollViewport(element: HTMLElement | null) {
  return element?.closest("[data-scroll-viewport]") as HTMLDivElement | null;
}

function HistoryLoadingState(props: { title?: string }) {
  const title = props.title?.trim();
  return (
    <div className={GATEWAY_TRANSCRIPT_SHELL_CLASS}>
      <div
        className={cn(
          GATEWAY_CHAT_COLUMN_CLASS,
          GATEWAY_EMPTY_STATE_CLASS,
          "relative col-[2] flex items-center justify-center overflow-hidden",
          "px-0 pt-24px pb-0 max-640:pt-8px",
        )}
      >
        <div className="flex min-h-280px w-full flex-col items-center justify-center px-4 text-center">
          <div
            className={cn(
              "mb-4 flex size-10 items-center justify-center",
              "rounded-xl border border-border/70 bg-background/80 shadow-sm",
            )}
          >
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
          <div className="max-w-112 text-sm font-medium text-foreground/90">正在加载会话历史</div>
          {title ? (
            <div className="mt-1 max-w-112 truncate text-xs text-muted-foreground">{title}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CheckpointCard(props: {
  item: Extract<TranscriptRow, { kind: "checkpoint" }>;
  readOnly?: boolean;
}) {
  const { item, readOnly = false } = props;

  return (
    <div className="flex max-w-full items-start gap-3 w-full max-640:block">
      <div className="mt-0.5 size-6 shrink-0 max-640:hidden" aria-hidden="true" />
      <div className="min-w-0 flex-1 w-full">
        <ContextCheckpointCard
          content={item.content}
          coveredMessageCount={item.coveredMessageCount}
          generatedBy={item.generatedBy}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}

function GatewayUserMessageBubbleBody(props: {
  text: string;
  attachments: PendingUploadedFile[];
  workspaceRoot?: string;
  onOpenAttachment?: (file: PendingUploadedFile) => void;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  loadCommitDetails?: CommitDetailsLoader;
}) {
  const { text, attachments, workspaceRoot, onLoadUploadedImagePreview, loadCommitDetails } = props;
  const { visibleFiles, pastedTextFiles } = splitUserAttachmentsForDisplay(attachments, text);

  const imageStrip = onLoadUploadedImagePreview
    ? visibleFiles.filter((file) => file.kind === "image" && (file.absolutePath || workspaceRoot))
    : [];
  const bubbleFiles = visibleFiles.filter((file) => !imageStrip.includes(file));

  return (
    <>
      <UserAttachmentCards
        files={imageStrip}
        workspaceRoot={workspaceRoot}
        onLoadUploadedImagePreview={onLoadUploadedImagePreview}
        imagePreviewMode="imageKind"
        imageStrip
      />
      {(text || bubbleFiles.length > 0) && (
        <div
          className={cn(
            "ml-auto w-fit max-w-full",
            "whitespace-pre-wrap rounded-2xl rounded-br-md bg-[hsl(var(--chat-user-bg))] px-4 py-2.5",
            "font-chat text-sm leading-relaxed break-words text-[hsl(var(--chat-user-fg))] [overflow-wrap:anywhere]",
          )}
        >
          <UserAttachmentCards
            files={bubbleFiles}
            onOpen={props.onOpenAttachment}
            workspaceRoot={workspaceRoot}
            onLoadUploadedImagePreview={onLoadUploadedImagePreview}
            imagePreviewMode="imageKind"
          />
          {text ? (
            <UserMessageContent
              text={text}
              pastedTextFiles={pastedTextFiles}
              loadCommitDetails={loadCommitDetails}
              legacyInlineFileMentions
            />
          ) : null}
        </div>
      )}
    </>
  );
}

// Shared user-row body: the bubble plus hover actions (copy / edit), or the
// inline editor while this row is being edited. Both transcript regions
// render it; the per-row copied/editing state lives in the owning region so
// folds and conversation switches reset it there.
// Memoized with per-row `isCopied`/`isEditing` booleans (instead of the raw
// region-level ids) so copying or editing one row never re-renders the
// others, and streaming flushes bail on every settled user row.
const GatewayUserMessageRowBody = memo(function GatewayUserMessageRowBody(props: {
  row: Extract<TranscriptRow, { kind: "user" }>;
  isStreaming: boolean;
  readOnly?: boolean;
  isCopied: boolean;
  isEditing: boolean;
  setCopiedMessageId: Dispatch<SetStateAction<string | null>>;
  setEditingMessageId: Dispatch<SetStateAction<string | null>>;
  workspaceRoot?: string;
  onOpenAttachment?: (file: PendingUploadedFile) => void;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  loadCommitDetails?: CommitDetailsLoader;
  onResendFromEdit?: (
    messageRef: HistoryMessageRef,
    text: string,
    uploadedFiles: PendingUploadedFile[],
    referencedConversations: ConversationMentionReference[],
  ) => void;
  onLoadContent?: () => void;
}) {
  const {
    row,
    isStreaming,
    readOnly = false,
    isCopied,
    isEditing,
    setCopiedMessageId,
    setEditingMessageId,
    workspaceRoot,
    onOpenAttachment,
    onLoadUploadedImagePreview,
    loadCommitDetails,
    onResendFromEdit,
    onLoadContent,
  } = props;
  const { locale, t } = useLocale();
  const effectiveMessageRef = row.messageRef;
  const revision =
    row.documentRevision ?? parseDocumentRevisionMessage(row.inlineEditText ?? row.text);
  const missingStableRef = !effectiveMessageRef;
  const editDisabled =
    readOnly ||
    isStreaming ||
    !onResendFromEdit ||
    Boolean(revision) ||
    missingStableRef ||
    Boolean(row.contentOmitted || (row.contentPreview && row.inlineEditText === undefined));
  const editTitle = row.contentOmitted
    ? locale === "en-US"
      ? "Load the full message before editing."
      : "请先读取完整消息再编辑"
    : row.contentPreview && row.inlineEditText === undefined
      ? locale === "en-US"
        ? "This message is too long for inline editing. View it in sections or download the complete text."
        : "消息较长，请分段查看或下载完整正文；暂不支持直接编辑长消息"
      : isStreaming
        ? locale === "en-US"
          ? "Wait for this reply to finish before editing."
          : "回复进行中，完成后可编辑重发"
        : missingStableRef
          ? locale === "en-US"
            ? "This older message cannot be edited because it has no stable message identifier."
            : "旧历史缺少稳定消息标识，无法编辑重发"
          : t("chat.edit");

  if (row.backgroundNotice) {
    return <BackgroundNoticeMessage text={row.text} />;
  }

  if (isEditing && effectiveMessageRef && !editDisabled) {
    return (
      <EditableUserMessageBubble
        initialText={row.inlineEditText ?? row.text}
        attachments={row.attachments}
        onOpenAttachment={onOpenAttachment}
        workspaceRoot={workspaceRoot}
        onLoadUploadedImagePreview={onLoadUploadedImagePreview}
        imagePreviewMode="imageKind"
        attachmentRemoveLabel={t("settings.delete")}
        className="shadow-chat-user-bubble-editor max-640:max-w-chat-user-bubble-editor-max-w"
        textareaClassName="overflow-hidden block min-h-72px whitespace-pre-wrap wrap-anywhere [word-break:break-word]"
        textareaSizing="content"
        onCancel={() => setEditingMessageId(null)}
        onSubmit={(text, attachments) => {
          setEditingMessageId(null);
          onResendFromEdit?.(effectiveMessageRef, text, attachments, row.referencedConversations);
        }}
      />
    );
  }

  return (
    <div
      className="chat-user-bubble-wrap group relative ml-auto max-w-user-bubble-web"
      data-user-bubble-wrap
    >
      {revision ? (
        <DocumentRevisionMessageBody
          revision={revision}
          attachments={row.attachments}
          workspaceRoot={workspaceRoot}
          onOpenAttachment={onOpenAttachment}
          onLoadUploadedImagePreview={onLoadUploadedImagePreview}
        />
      ) : (
        <GatewayUserMessageBubbleBody
          text={row.text}
          attachments={row.attachments}
          onOpenAttachment={onOpenAttachment}
          workspaceRoot={workspaceRoot}
          onLoadUploadedImagePreview={onLoadUploadedImagePreview}
          loadCommitDetails={loadCommitDetails}
        />
      )}
      {!revision && (row.contentOmitted || row.contentPreview) && onLoadContent ? (
        <button
          type="button"
          className="mt-8px rounded-md border border-border px-10px py-6px text-xs hover:bg-accent"
          onClick={onLoadContent}
        >
          {row.contentPreview
            ? locale === "en-US"
              ? "View complete text in sections"
              : "分段查看完整正文"
            : locale === "en-US"
              ? "View message content"
              : "查看消息正文"}
        </button>
      ) : null}
      <TranscriptUserMessageActions
        timestamp={row.timestamp}
        copied={isCopied}
        copyDisabled={!revision && (row.contentOmitted || (row.contentPreview && !row.copyContent))}
        copyTitle={revision ? undefined : row.copyDisabledReason}
        onCopy={() => {
          const copy = revision
            ? copyTextToClipboard(copyDocumentRevision(revision))
            : (row.copyContent?.() ?? copyTextToClipboard(row.text));
          void copy.then((copied) => {
            if (!copied) return;
            setCopiedMessageId(row.key);
            window.setTimeout(() => {
              setCopiedMessageId((current) => (current === row.key ? null : current));
            }, 1500);
          });
        }}
        editDisabled={editDisabled}
        editTitle={editTitle}
        onEdit={() => {
          if (effectiveMessageRef) setEditingMessageId(row.key);
        }}
        rewindTurnId={effectiveMessageRef?.messageId}
        readOnly={readOnly}
      />
    </div>
  );
});

function findRetryTarget(rows: readonly TranscriptRow[], assistantIndex: number) {
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "user" && !row.backgroundNotice) return row;
  }
  return null;
}

// Compact assistant footer: primary reply actions stay one click away while
// detailed usage remains behind the info popover.
const GatewayAssistantMessageActions = memo(function GatewayAssistantMessageActions(props: {
  row: Extract<TranscriptRow, { kind: "assistant" }>;
  retryTarget: Extract<TranscriptRow, { kind: "user" }> | null;
  isStreaming: boolean;
  showUsage?: boolean;
  usageContextWindow?: number;
  isCopied: boolean;
  setCopiedMessageId: Dispatch<SetStateAction<string | null>>;
  onResendFromEdit?: (
    messageRef: HistoryMessageRef,
    text: string,
    uploadedFiles: PendingUploadedFile[],
    referencedConversations: ConversationMentionReference[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
  branchPendingMessageId?: string | null;
  resendCreatesBranch?: boolean;
}) {
  const {
    row,
    retryTarget,
    isStreaming,
    showUsage,
    usageContextWindow,
    isCopied,
    setCopiedMessageId,
    onResendFromEdit,
    onBranchConversation,
    branchPendingMessageId,
    resendCreatesBranch,
  } = props;
  const { locale, t } = useLocale();
  const replyText = row.rounds
    .map((round) => getRoundText(round).trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
  const usageEntries = useMemo(
    () =>
      showUsage
        ? row.rounds.flatMap((round) =>
            round.meta?.usage || round.meta?.tokenUsage || round.meta?.model
              ? [
                  {
                    key: `round-${round.round}`,
                    usage: round.meta.tokenUsage ?? round.meta.usage,
                    model: round.meta.model,
                    reasoningEffort: round.meta.reasoningEffort,
                    outcome: round.meta.outcome,
                    durationMs: round.meta.durationMs,
                  },
                ]
              : [],
          )
        : undefined,
    [row.rounds, showUsage],
  );
  const retryMessageRef = retryTarget?.messageRef;
  const retryPrompt = retryTarget?.inlineEditText ?? retryTarget?.text;
  const shareSource = useMemo<ReplyShareSource | undefined>(
    () =>
      (row.contentPreview && row.shareText === undefined) ||
      row.contentOmitted ||
      (retryTarget?.contentPreview && retryTarget.inlineEditText === undefined) ||
      retryTarget?.contentOmitted
        ? undefined
        : { reply: row.shareText ?? replyText, prompt: retryPrompt, timestamp: row.timestamp },
    [
      replyText,
      retryPrompt,
      row.timestamp,
      row.contentPreview,
      row.shareText,
      row.contentOmitted,
      retryTarget?.contentPreview,
      retryTarget?.inlineEditText,
      retryTarget?.contentOmitted,
    ],
  );
  const retryDisabled =
    isStreaming || !onResendFromEdit || !retryMessageRef || Boolean(retryTarget?.contentOmitted);
  const retryTitle = !retryTarget
    ? locale === "en-US"
      ? "Load the earlier prompt before regenerating."
      : "请先加载更早的原问题，再重新生成"
    : retryTarget?.contentOmitted
      ? locale === "en-US"
        ? "Load the prompt before regenerating."
        : "请先读取原问题正文再重新生成"
      : isStreaming
        ? locale === "en-US"
          ? "Wait for this reply to finish before retrying."
          : "回复进行中，完成后可重新生成"
        : retryMessageRef
          ? t("chat.retry")
          : locale === "en-US"
            ? "This reply cannot be retried because its prompt has no stable message identifier."
            : "旧历史缺少稳定消息标识，无法重试";
  const branchPending = branchPendingMessageId != null;
  const isRowBranchPending =
    branchPending && !!retryMessageRef && branchPendingMessageId === retryMessageRef.messageId;
  const branchDisabled = isStreaming || !onBranchConversation || !retryMessageRef || branchPending;
  const branchTitle = !retryTarget
    ? locale === "en-US"
      ? "Load the earlier prompt before branching."
      : "请先加载更早的原问题，再创建分支"
    : retryMessageRef
      ? t("chat.branch")
      : t("chat.branchUnavailable");

  return (
    <TranscriptAssistantMessageActions
      timestamp={row.timestamp}
      copied={isCopied}
      copyDisabled={!replyText || row.contentOmitted || (row.contentPreview && !row.copyContent)}
      copyTitle={row.copyDisabledReason}
      onCopy={() => {
        void (row.copyContent?.() ?? copyTextToClipboard(replyText)).then((copied) => {
          if (!copied) return;
          setCopiedMessageId(row.key);
          window.setTimeout(() => {
            setCopiedMessageId((current) => (current === row.key ? null : current));
          }, 1500);
        });
      }}
      usageEntries={usageEntries}
      usageContextWindow={showUsage ? usageContextWindow : undefined}
      retryDisabled={retryDisabled}
      retryTitle={retryTitle}
      retryConfirmDescription={
        resendCreatesBranch
          ? locale === "en-US"
            ? "Keep this conversation and regenerate the reply in a new branch."
            : "保留当前对话，并在新分支中重新生成回复。"
          : undefined
      }
      onRetry={() => {
        if (!retryTarget || !retryMessageRef) return;
        onResendFromEdit?.(
          retryMessageRef,
          retryTarget.retryText ?? retryTarget.text,
          retryTarget.attachments,
          retryTarget.referencedConversations,
        );
      }}
      branchDisabled={branchDisabled}
      branchTitle={branchTitle}
      branchPending={isRowBranchPending}
      onBranch={() => {
        if (retryMessageRef) onBranchConversation?.(retryMessageRef);
      }}
      shareSource={shareSource}
      withAvatarSpacer
    />
  );
});

const rowEstimateCache = new WeakMap<TranscriptRow, number>();

// Content-shaped height estimates: only ever used for rows the virtualizer
// has never measured (the measurement cache is keyed by row key and survives
// folding), but a shaped guess keeps scroll corrections small while reading
// unmeasured history.
function estimateRowHeight(row: TranscriptRow): number {
  const cached = rowEstimateCache.get(row);
  if (cached !== undefined) {
    return cached;
  }
  let estimate: number;
  if (row.kind === "user") {
    estimate = estimateUserRowHeight(row.text.length, row.attachments.length);
  } else if (row.kind === "assistant") {
    let proseChars = 0;
    let codeLines = 0;
    let codeFences = 0;
    let toolCount = 0;
    let thinkingCount = 0;
    for (const round of row.rounds) {
      for (const block of round.blocks) {
        if (block.kind === "text") {
          const measured = measureEstimateText(block.text);
          proseChars += measured.proseChars;
          codeLines += measured.codeLines;
          codeFences += measured.codeFences;
        } else if (block.kind === "thinking") {
          thinkingCount += 1;
        } else {
          toolCount += 1;
        }
      }
    }
    estimate =
      estimateAssistantRowHeight({
        proseChars,
        codeLines,
        codeFences,
        toolCount,
        thinkingCount,
      }) +
      Math.min(row.deliverables?.length ?? 0, 4) * 88;
  } else if (row.kind === "checkpoint") {
    estimate = CHECKPOINT_ROW_ESTIMATE_PX;
  } else {
    estimate = 120;
  }
  rowEstimateCache.set(row, estimate);
  return estimate;
}

function estimateVirtualItemHeight(item: GatewayTranscriptVirtualItem): number {
  if (item.kind === "loadRemoteHistory") return 44;
  if (item.kind === "pendingBubble") return 56;
  if (item.kind === "scheduledPreview") return 132;
  return estimateRowHeight(item.row);
}

const GatewayTranscriptListRegion = memo(function GatewayTranscriptListRegion(props: {
  editRequest?: { token: string; messageId: string } | null;
  onEditRequestHandled?: (token: string) => void;
  conversationId?: string;
  rows: readonly TranscriptRow[];
  scheduledTurn?: GatewayScheduledTurn;
  liveStartIndex: number;
  activeTurnKey?: string | null;
  contentWidth: number;
  scrollViewport: HTMLDivElement | null;
  isViewportFollowing?: () => boolean;
  viewportFollowing: boolean;
  navRef?: MutableRefObject<GatewayTranscriptNavHandle | null>;
  onAnchorUserRowChange?: (rowKey: string | null) => void;
  hasMoreHistory?: boolean;
  isLoadingMoreHistory?: boolean;
  onLoadEarlierHistory?: () => void;
  isStreaming: boolean;
  assistantLiveMode: "retained" | "streaming";
  showUsage: boolean;
  usageContextWindow?: number;
  workspaceRoot?: string;
  imagePreviewScope?: string;
  gitClient?: GitClient | null;
  onOpenFileLink?: (link: ChatFileLink) => void;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
  onResendFromEdit?: (
    messageRef: HistoryMessageRef,
    text: string,
    uploadedFiles: PendingUploadedFile[],
    referencedConversations: ConversationMentionReference[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
  branchPendingMessageId?: string | null;
  resendCreatesBranch?: boolean;
  toolStatus?: string | null;
  toolStatusIsCompaction: boolean;
  retryAttempts?: readonly RetryAttemptRecord[];
  readOnly?: boolean;
  redactToolContent?: boolean;
}) {
  const {
    editRequest,
    onEditRequestHandled,
    conversationId,
    rows,
    scheduledTurn,
    liveStartIndex,
    activeTurnKey,
    contentWidth,
    scrollViewport,
    isViewportFollowing,
    viewportFollowing,
    navRef,
    onAnchorUserRowChange,
    hasMoreHistory,
    isLoadingMoreHistory,
    onLoadEarlierHistory,
    isStreaming,
    assistantLiveMode,
    showUsage,
    usageContextWindow,
    workspaceRoot,
    imagePreviewScope,
    gitClient,
    onOpenFileLink,
    onLoadUploadedImagePreview,
    onResendFromEdit,
    onBranchConversation,
    branchPendingMessageId,
    resendCreatesBranch,
    toolStatus,
    toolStatusIsCompaction,
    retryAttempts,
    readOnly = false,
    redactToolContent = false,
  } = props;
  const { locale } = useLocale();
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const consumedEditRequestRef = useRef<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const historyIdentityKey = `${conversationId ?? ""}\n${rows[0]?.key ?? ""}`;
  const loadCommitDetails = useCommitDetailsLoader(workspaceRoot, gitClient, historyIdentityKey);

  // biome-ignore lint/correctness/useExhaustiveDependencies: transcript identity changes intentionally cancel the current edit
  useEffect(() => {
    setEditingMessageId(null);
  }, [historyIdentityKey]);

  useEffect(() => {
    if (!editingMessageId) {
      return;
    }
    const hasEditingRow = rows.some((row) => row.kind === "user" && row.key === editingMessageId);
    if (!hasEditingRow) {
      setEditingMessageId(null);
    }
  }, [editingMessageId, rows]);

  const displayedToolStatus = useMemo(
    () => normalizeLiveToolStatus(toolStatus ?? null),
    [toolStatus],
  );
  const displayedToolStatusIsCompaction = toolStatusIsCompaction;

  // The live article: the streaming turn's trailing assistant row while a
  // run is active, else the trailing assistant row. It keeps its in-flight
  // structural state regardless of `isStreaming` (folding happens at the
  // next run_started); the caret tracks `isStreaming` separately so it hides
  // cleanly once the stream actually ends.
  const liveAssistantIndex = useMemo(() => {
    if (activeTurnKey) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (row?.kind === "assistant" && row.turnKey === activeTurnKey) {
          return index;
        }
      }
      return -1;
    }
    return rows.length > 0 && rows[rows.length - 1]?.kind === "assistant" ? rows.length - 1 : -1;
  }, [activeTurnKey, rows]);

  // The pending bubble (typing dots / vibing / compacting) shows while busy
  // and the transcript has no assistant output for the active exchange yet.
  const shouldShowPendingLiveBubble = useMemo(() => {
    if (readOnly || !isStreaming) {
      return false;
    }
    if (liveAssistantIndex >= 0) {
      return false;
    }
    if (displayedToolStatusIsCompaction) {
      return true;
    }
    const lastRowKind = rows[rows.length - 1]?.kind;
    return !lastRowKind || lastRowKind === "user" || lastRowKind === "checkpoint";
  }, [displayedToolStatusIsCompaction, isStreaming, liveAssistantIndex, readOnly, rows]);

  // Row keys are unique by construction (the row builder's single canonical
  // pass) and feed both React reconciliation and the virtualizer's
  // measurement cache directly.
  const virtualItems = useMemo<GatewayTranscriptVirtualItem[]>(() => {
    const next: GatewayTranscriptVirtualItem[] = [];
    if (!readOnly && hasMoreHistory) {
      next.push({ key: "load-remote-history", kind: "loadRemoteHistory" });
    }
    const promptKey = scheduledTurn ? `${scheduledTurn.key}:prompt` : undefined;
    for (const row of rows) {
      // The replacement inherits the measured preview's key. Detached
      // readers keep their offset inside the same turn across the handoff.
      const key =
        row.key === scheduledTurn?.replyHistoryKey
          ? scheduledTurn.key
          : row.key === scheduledTurn?.promptHistoryKey && promptKey
            ? promptKey
            : row.key;
      next.push({ key, kind: "row", row });
    }
    if (shouldShowPendingLiveBubble) {
      next.push({ key: "live-pending-bubble", kind: "pendingBubble" });
    }
    if (scheduledTurn?.prompt && promptKey)
      next.push({ key: promptKey, content: scheduledTurn.prompt, kind: "scheduledPreview" });
    if (scheduledTurn?.reply)
      next.push({ key: scheduledTurn.key, content: scheduledTurn.reply, kind: "scheduledPreview" });
    return next;
  }, [hasMoreHistory, scheduledTurn, rows, readOnly, shouldShowPendingLiveBubble]);

  const leadingOffset = !readOnly && hasMoreHistory ? 1 : 0;
  // Everything at or after the live boundary (including the pending bubble)
  // is force-mounted: a streaming reply must never unmount mid-run.
  const forceMountStart =
    liveStartIndex >= 0
      ? liveStartIndex + leadingOffset
      : shouldShowPendingLiveBubble || scheduledTurn?.reply
        ? virtualItems.length - (scheduledTurn?.prompt ? 2 : 1)
        : -1;
  const forceMountStartRef = useRef(forceMountStart);
  forceMountStartRef.current = forceMountStart;
  const pendingScheduledKeyRef = useRef<string | undefined>(undefined);
  const scheduledHandoffKeyRef = useRef<string | undefined>(undefined);
  const settledScheduledKey = scheduledTurn?.replyHistoryKey ? scheduledTurn.key : undefined;
  if (scheduledTurn?.reply) {
    pendingScheduledKeyRef.current = scheduledTurn.key;
    scheduledHandoffKeyRef.current = undefined;
  } else if (settledScheduledKey && pendingScheduledKeyRef.current === settledScheduledKey) {
    pendingScheduledKeyRef.current = undefined;
    scheduledHandoffKeyRef.current = settledScheduledKey;
  } else if (!settledScheduledKey) {
    scheduledHandoffKeyRef.current = undefined;
  }
  useLayoutEffect(() => {
    if (!settledScheduledKey || scheduledHandoffKeyRef.current !== settledScheduledKey) return;
    // Keep the initial ResizeObserver delivery in the handoff window.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (scheduledHandoffKeyRef.current === settledScheduledKey)
          scheduledHandoffKeyRef.current = undefined;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [settledScheduledKey]);
  const virtualItemsRef = useRef(virtualItems);
  virtualItemsRef.current = virtualItems;
  const getVirtualItemRenderCost = useCallback((index: number) => {
    const item = virtualItemsRef.current[index];
    if (!item) return 1;
    // Height is already identity-cached per transcript row. It is a useful
    // proxy for Markdown/tool mount cost and avoids a second block traversal.
    return Math.max(1, Math.ceil(estimateVirtualItemHeight(item) / 480));
  }, []);
  const extractTranscriptRange = useCallback(
    (range: Range) => extractLiveRange(range, forceMountStartRef.current, getVirtualItemRenderCost),
    [getVirtualItemRenderCost],
  );

  const getTranscriptItemKey = useCallback(
    // The index branch is unreachable (count === virtualItems.length); it
    // only satisfies the type.
    (index: number) => virtualItems[index]?.key ?? `virtual-${index}`,
    [virtualItems],
  );

  // Restored once per mount: at conversation-switch remounts the viewport is
  // already live, so a same-width snapshot skips straight to exact layout.
  const [initialMeasurementsCache] = useState(
    () =>
      (conversationId && scrollViewport
        ? transcriptMeasurementsLru.restore(
            conversationId,
            buildVersionedTranscriptLayoutKey(
              scrollViewport.clientWidth,
              contentWidth,
              assistantLiveMode,
            ),
          )
        : null) ?? [],
  );

  const transcriptVirtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => scrollViewport,
    estimateSize: (index) => {
      const item = virtualItems[index];
      return item ? estimateVirtualItemHeight(item) : TRANSCRIPT_ROW_ESTIMATED_HEIGHT;
    },
    getItemKey: getTranscriptItemKey,
    gap: TRANSCRIPT_ROW_GAP,
    overscan: 0,
    enabled: scrollViewport !== null,
    // End anchoring is enabled only for a detached reader so keyed prepends
    // preserve the visible row. While following, start anchoring disables the
    // virtualizer's bottom correction and leaves live growth to useScrollFollow.
    anchorTo: viewportFollowing ? "start" : "end",
    scrollEndThreshold: 8,
    // Above-viewport estimate corrections and history-page prepends are
    // absorbed into the layout origin instead of written to scrollTop, so
    // no programmatic scroll can race the user's wheel gesture; the debt
    // settles with one verified write when scrolling is idle.
    scrollAnchoring: "origin",
    // Compositors paint scrolls ahead of the main thread; keep roughly half
    // a viewport of pre-rendered rows toward the scroll direction so fast
    // wheel ticks reveal content instead of blank space.
    directionalOverscanPx: 480,
    initialMeasurementsCache,
    rangeExtractor: extractTranscriptRange,
  });

  useEffect(() => {
    if (!editRequest || consumedEditRequestRef.current === editRequest.token) return;
    consumedEditRequestRef.current = editRequest.token;
    onEditRequestHandled?.(editRequest.token);
    if (readOnly || isStreaming || !onResendFromEdit) return;
    const index = rows.findIndex((row) => row.kind === "user" && row.key === editRequest.messageId);
    const row = rows[index];
    if (
      !row ||
      row.kind !== "user" ||
      !row.messageRef ||
      row.contentOmitted ||
      (row.contentPreview && row.inlineEditText === undefined)
    )
      return;
    setEditingMessageId(row.key);
    transcriptVirtualizer.scrollToIndex?.(index + leadingOffset, { align: "center" });
  }, [
    editRequest,
    onEditRequestHandled,
    readOnly,
    isStreaming,
    onResendFromEdit,
    rows,
    transcriptVirtualizer,
    leadingOffset,
  ]);

  // TanStack exposes the resize-compensation predicate as an instance field,
  // not an option; reassigning per render keeps the closure's inputs current.
  // While following it rejects every virtualizer correction; while detached
  // it retains estimate/measurement anchoring for rows above the viewport.
  const shouldAdjustForResize = createLiveRowScrollAdjustPolicy<HTMLDivElement, Element>({
    getLiveStartIndex: () => forceMountStartRef.current,
    isFollowing: () => isViewportFollowing?.() ?? false,
  });
  transcriptVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
    const top = instance.scrollOffset ?? 0;
    // The settled footer changes the height below a reader inside this reply.
    if (item.key === scheduledHandoffKeyRef.current && item.start < top && item.end > top)
      return false;
    return shouldAdjustForResize(item, delta, instance);
  };

  // Every mounted row is already tracked by the virtualizer's ResizeObserver,
  // which updates its measured height as the centered transcript reflows.
  // Do not call measure() on width commits: it clears those fresh measurements
  // after the DOM has already resized, so estimate-based row positions can
  // overlap without another resize event to repopulate the cache.

  // 楼层跳转：scrollToIndex(align:"start") 后连续几帧重对齐——目标行远处的
  // 估高行在滚动后被真实测量，落点会漂移；对准同一 index 是收敛操作，不会
  // 震荡。收敛期间用户的滚轮/触摸/按键立即取消收敛；新跳转替换旧收敛。
  // 楼层导航当前楼层：以「视口顶缘（+8px 容差）」所落在的用户消息为准——与
  // 跳转的 align:"start" 落位一致，跳转后高亮的必然是刚点的楼层；视口贴近
  // 内容底部时直接取最后一层（否则短对话拼满一屏时底部楼层永远无法成为当前
  // 层）。贴底判定用 scrollHeight（与 scrollTop/clientHeight 同一坐标系，
  // 含底部保留区），避免与 getTotalSize 的列表局部坐标错位。
  useTranscriptNavigation({
    items: virtualItems,
    getItemKey: (item) => (item.kind === "row" ? item.row.key : item.key),
    getAnchorKey: (itemList, anchorIndex) => {
      for (let index = anchorIndex; index >= 0; index -= 1) {
        const item = itemList[index];
        if (item?.kind === "row" && item.row.kind === "user") {
          return item.row.key;
        }
      }
      return null;
    },
    virtualizer: transcriptVirtualizer,
    scrollViewport,
    navRef,
    onAnchorChange: onAnchorUserRowChange,
  });

  // Infinite upward paging: scrolling within one viewport of the top requests
  // the previous page through the same handler as the "load earlier history"
  // button (which stays as the visible affordance and loading indicator).
  // Only scroll events trigger it — opening a conversation lands at the
  // bottom and never auto-fetches — and after a page lands the keyed
  // anchoring parks the viewport about a page below the top, so walking
  // further back keeps paging one request at a time: readers load exactly as
  // far as they scroll, servers transfer only the pages actually walked to,
  // and a failed fetch retries only on the next user scroll (no hammering).
  // The distance is read from the virtualizer's settled offset, not DOM
  // scrollTop: a page anchored through the 'origin' keeps scrollTop parked
  // near the top until the rebase lands, and a raw scrollTop check would
  // re-arm on every wheel tick and stack page after page. The hard top (DOM
  // scrollTop 0) is a trigger of its own: WebKit defers the rebase until the
  // gesture settles, so a fling can pin the viewport at 0 with unsettled
  // debt still above it — the reader is pushing against the top and cannot
  // scroll into that debt until the rebase lands. Fire once per visit there;
  // rubber-band scroll events at 0 must not re-fire it.
  const autoLoadEarlierInFlightRef = useRef(false);
  const hardTopLatchedRef = useRef(false);
  const maybeAutoLoadEarlierRef = useRef(() => {});
  maybeAutoLoadEarlierRef.current = () => {
    if (!scrollViewport) return;
    const atHardTop = scrollViewport.scrollTop <= 1;
    if (!atHardTop) hardTopLatchedRef.current = false;
    if (
      readOnly ||
      isStreaming ||
      !hasMoreHistory ||
      !onLoadEarlierHistory ||
      isLoadingMoreHistory ||
      autoLoadEarlierInFlightRef.current
    ) {
      return;
    }
    const nearSettledTop =
      transcriptVirtualizer.getSettledScrollOffset() <= scrollViewport.clientHeight;
    if (!nearSettledTop && (!atHardTop || hardTopLatchedRef.current)) return;
    if (atHardTop) hardTopLatchedRef.current = true;
    autoLoadEarlierInFlightRef.current = true;
    onLoadEarlierHistory();
  };
  useEffect(() => {
    if (!scrollViewport || readOnly) return;
    const handler = () => maybeAutoLoadEarlierRef.current();
    scrollViewport.addEventListener("scroll", handler, { passive: true });
    return () => scrollViewport.removeEventListener("scroll", handler);
  }, [scrollViewport, readOnly]);
  useEffect(() => {
    // The latch guards the gap between firing and the loading flag landing;
    // it releases whenever a load cycle is not (or no longer) running.
    if (!isLoadingMoreHistory) {
      autoLoadEarlierInFlightRef.current = false;
    }
  }, [isLoadingMoreHistory]);

  // First paint of a conversation lands at the bottom before the user sees
  // anything: scrollToEnd re-targets as dynamic measurements land. The region
  // remounts per conversation (keyed by the parent), so this runs once per
  // open; read-only shared views keep their own initial position.
  const scrollToEndOnceRef = useRef(false);
  useLayoutEffect(() => {
    if (
      scrollToEndOnceRef.current ||
      readOnly ||
      scrollViewport === null ||
      virtualItems.length === 0
    ) {
      return;
    }
    scrollToEndOnceRef.current = true;
    transcriptVirtualizer.scrollToEnd();
  }, [readOnly, scrollViewport, virtualItems.length, transcriptVirtualizer]);

  // Snapshot measured heights for the next open of this conversation.
  const saveMeasurementsRef = useRef(() => {});
  saveMeasurementsRef.current = () => {
    if (!conversationId || !scrollViewport) return;
    transcriptMeasurementsLru.save(
      conversationId,
      buildVersionedTranscriptLayoutKey(
        scrollViewport.clientWidth,
        contentWidth,
        assistantLiveMode,
      ),
      transcriptVirtualizer.takeSnapshot(),
    );
  };
  useEffect(() => () => saveMeasurementsRef.current(), []);

  const virtualRows = transcriptVirtualizer.getVirtualItems();

  return (
    <div className="relative" style={{ height: transcriptVirtualizer.getTotalSize() }}>
      {virtualRows.map((virtualRow) => {
        const virtualItem = virtualItems[virtualRow.index];
        if (!virtualItem) return null;

        if (virtualItem.kind === "loadRemoteHistory") {
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="absolute inset-x-0 top-0 flex justify-center"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <button
                type="button"
                onClick={onLoadEarlierHistory}
                disabled={isLoadingMoreHistory || !onLoadEarlierHistory}
                className={cn(
                  "rounded-full border border-border/60 bg-background/80 px-4 py-1.5 text-xs text-muted-foreground",
                  "transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {isLoadingMoreHistory
                  ? locale === "en-US"
                    ? "Loading earlier history..."
                    : "正在加载更早历史..."
                  : locale === "en-US"
                    ? "Load earlier history"
                    : "加载更早历史"}
              </button>
            </div>
          );
        }

        if (virtualItem.kind === "scheduledPreview") {
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {virtualItem.content}
            </article>
          );
        }

        if (virtualItem.kind === "pendingBubble") {
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className={`${GATEWAY_TRANSCRIPT_ROW_CLASS} absolute inset-x-0 top-0`}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <div className="w-full max-w-full">
                <div className="min-w-0 space-y-2 pt-1">
                  <div className="flex w-full items-center py-1">
                    <LiveAssistantStatus
                      status={displayedToolStatus}
                      isCompaction={displayedToolStatusIsCompaction}
                      className={displayedToolStatusIsCompaction ? "w-full" : undefined}
                    />
                  </div>
                  {retryAttempts && retryAttempts.length > 0 ? (
                    <RetryDetailsBlock attempts={retryAttempts} />
                  ) : null}
                </div>
              </div>
            </article>
          );
        }

        const row = virtualItem.row;
        if (row.kind === "user") {
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
              data-row-key={row.key}
              ref={transcriptVirtualizer.measureElement}
              className={`${GATEWAY_TRANSCRIPT_ROW_CLASS} absolute inset-x-0 top-0 justify-end!`}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <GatewayUserMessageRowBody
                row={row}
                isStreaming={isStreaming}
                readOnly={readOnly}
                isCopied={copiedMessageId === row.key}
                isEditing={editingMessageId === row.key}
                setCopiedMessageId={setCopiedMessageId}
                setEditingMessageId={setEditingMessageId}
                workspaceRoot={imagePreviewScope ?? workspaceRoot}
                onLoadUploadedImagePreview={onLoadUploadedImagePreview}
                loadCommitDetails={loadCommitDetails}
                onResendFromEdit={onResendFromEdit}
                onOpenAttachment={
                  onOpenFileLink
                    ? (file) =>
                        onOpenFileLink(
                          imagePreviewScope &&
                            /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(file.relativePath)
                            ? { path: `cloud-files/${file.relativePath}`, source: "relative" }
                            : chatAttachmentFileLink(file),
                        )
                    : undefined
                }
                onLoadContent={
                  (row.contentOmitted || row.contentPreview) && onOpenFileLink
                    ? () =>
                        onOpenFileLink({ path: `cloud-messages/${row.key}`, source: "relative" })
                    : undefined
                }
              />
            </article>
          );
        }

        if (row.kind === "assistant") {
          const rowIndex = virtualRow.index - leadingOffset;
          const isLatestLiveAssistant =
            rowIndex === liveAssistantIndex && (assistantLiveMode === "retained" || isStreaming);
          const isLatestLiveStreaming = isStreaming && isLatestLiveAssistant;
          const retryTarget = findRetryTarget(rows, rowIndex);
          const turnError = readOnly || isLatestLiveStreaming ? null : turnErrorOf(row.rounds);
          const retryRef = retryTarget?.messageRef;
          const durationMs = chatDuration(retryTarget?.timestamp, row.timestamp);
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
              data-row-key={row.key}
              ref={transcriptVirtualizer.measureElement}
              className={`${GATEWAY_TRANSCRIPT_ROW_CLASS} absolute inset-x-0 top-0`}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <div
                className="group/assistant min-w-0 w-full max-w-full space-y-1"
                data-assistant-row
              >
                <AssistantBubble
                  rounds={row.rounds}
                  isLive={isLatestLiveAssistant}
                  isStreaming={isLatestLiveStreaming}
                  renderMode={rowRenderMode(row)}
                  toolStatus={isLatestLiveStreaming ? displayedToolStatus : null}
                  toolStatusVariant={displayedToolStatusIsCompaction ? "compaction" : "default"}
                  durationMs={durationMs}
                  startedAtMs={
                    isLatestLiveStreaming ? findLiveTurnStartTimestamp(rows, rowIndex) : undefined
                  }
                  readOnly={readOnly}
                  redactToolContent={redactToolContent}
                  workdir={workspaceRoot}
                  onOpenFileLink={onOpenFileLink}
                />
                {row.deliverables?.length ? (
                  <AssistantDeliverables items={row.deliverables} onOpenFileLink={onOpenFileLink} />
                ) : null}
                <AssistantVisualActivity messageId={row.key} />
                {turnError ? (
                  <TurnErrorNotice
                    error={turnError}
                    errorDetail={turnErrorDetailOf(row.rounds)}
                    retryDisabled={isStreaming}
                    onRetry={
                      !resendCreatesBranch &&
                      retryTarget &&
                      retryRef &&
                      !retryTarget.contentOmitted &&
                      onResendFromEdit
                        ? () =>
                            onResendFromEdit(
                              retryRef,
                              retryTarget.retryText ?? retryTarget.text,
                              retryTarget.attachments,
                              retryTarget.referencedConversations,
                            )
                        : undefined
                    }
                  />
                ) : null}
                {isLatestLiveStreaming &&
                !shouldShowPendingLiveBubble &&
                retryAttempts &&
                retryAttempts.length > 0 ? (
                  <div className="ml-9 pt-1">
                    <RetryDetailsBlock attempts={retryAttempts} />
                  </div>
                ) : null}
                {!readOnly && !isLatestLiveStreaming ? (
                  <GatewayAssistantMessageActions
                    row={row}
                    retryTarget={retryTarget}
                    isStreaming={isStreaming}
                    showUsage={showUsage}
                    usageContextWindow={usageContextWindow}
                    isCopied={copiedMessageId === row.key}
                    setCopiedMessageId={setCopiedMessageId}
                    onResendFromEdit={onResendFromEdit}
                    onBranchConversation={onBranchConversation}
                    branchPendingMessageId={branchPendingMessageId}
                    resendCreatesBranch={resendCreatesBranch}
                  />
                ) : null}
              </div>
            </article>
          );
        }

        if (row.kind === "checkpoint") {
          return (
            <article
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={transcriptVirtualizer.measureElement}
              className={`${GATEWAY_TRANSCRIPT_ROW_CLASS} absolute inset-x-0 top-0 w-full`}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <CheckpointCard item={row} readOnly={readOnly} />
            </article>
          );
        }

        return (
          <article
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={transcriptVirtualizer.measureElement}
            className={`${GATEWAY_TRANSCRIPT_ROW_CLASS} absolute inset-x-0 top-0`}
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            <div
              className={cn(
                "w-gateway-bubble-w rounded-22px border border-solid shadow-gateway-bubble backdrop-blur-18px px-18px py-16px",
                "border-destructive/30 bg-destructive/5",
              )}
            >
              <div className="text-xs font-bold tracking-0p12em uppercase text-muted-foreground">
                Error
              </div>
              <div className="gateway-bubble-content mt-10px text-sm leading-1p72 text-foreground">
                <pre>{row.text}</pre>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
});

export function GatewayTranscript({
  editRequest,
  onEditRequestHandled,
  emptyState,
  footer,
  scheduledTurn,
  conversationId,
  rows,
  liveStartIndex = -1,
  activeTurnKey = null,
  contentWidth = DEFAULT_CHAT_TRANSCRIPT_WIDTH,
  isViewportFollowing,
  viewportFollowing = false,
  expandProcessByDefault = false,
  detailedProgress = false,
  navRef,
  onAnchorUserRowChange,
  error,
  toolStatus,
  toolStatusIsCompaction = false,
  retryAttempts,
  isStreaming = false,
  assistantLiveMode = "retained",
  isLoading = false,
  loadingTitle,
  hasModels = true,
  onOpenSettings,
  hasMoreHistory = false,
  isLoadingMoreHistory = false,
  onLoadEarlierHistory,
  showUsage = false,
  usageContextWindow,
  workspaceRoot,
  imagePreviewScope,
  gitClient,
  onOpenFileLink,
  onLoadUploadedImagePreview,
  onResendFromEdit,
  onBranchConversation,
  branchPendingMessageId,
  resendCreatesBranch = false,
  onSuggestionSelect,
  onQuoteSelection,
  onCommentSelection,
  readOnly = false,
  redactToolContent = false,
}: GatewayTranscriptProps) {
  const transcriptListRef = useRef<HTMLDivElement | null>(null);
  const [transcriptScrollViewport, setTranscriptScrollViewport] = useState<HTMLDivElement | null>(
    null,
  );
  const rowCount = rows.length;
  const inlineErrorText = error?.trim() ?? "";
  const shouldShowInlineError = useMemo(() => {
    if (inlineErrorText.length === 0) {
      return false;
    }
    return !rows.some(
      (row) =>
        (row.kind === "error" && row.text.trim() === inlineErrorText) ||
        (!readOnly &&
          row.kind === "assistant" &&
          turnErrorOf(row.rounds)?.trim() === inlineErrorText),
    );
  }, [rows, inlineErrorText, readOnly]);

  useLayoutEffect(() => {
    const nextViewport = resolveNearestScrollViewport(transcriptListRef.current);
    setTranscriptScrollViewport((current) => (current === nextViewport ? current : nextViewport));
  });

  if (rowCount === 0 && isLoading) {
    return <HistoryLoadingState title={loadingTitle} />;
  }

  if (rowCount === 0 && !isStreaming && !scheduledTurn?.reply) {
    const showNoModelsState = !hasModels;
    return (
      <div className={GATEWAY_TRANSCRIPT_SHELL_CLASS}>
        <div
          className={cn(
            GATEWAY_CHAT_COLUMN_CLASS,
            GATEWAY_EMPTY_STATE_CLASS,
            "relative col-[2] flex items-center justify-center overflow-hidden",
            "px-0 pt-24px pb-0 max-640:pt-8px",
          )}
        >
          {/* Keyed per conversation so the hero entrance replays when
              switching between empty conversations, not just on mount. */}
          {!showNoModelsState && emptyState ? (
            emptyState
          ) : (
            <ChatEmptyState
              key={conversationId ?? "shared"}
              variant={showNoModelsState ? "no-models" : "start-chat"}
              onOpenSettings={onOpenSettings}
              onSuggestionSelect={readOnly ? undefined : onSuggestionSelect}
            />
          )}
        </div>
      </div>
    );
  }

  const comments = readOnly || isLoading ? undefined : onCommentSelection;
  return (
    <TranscriptCommentProvider onComment={comments}>
      <div className={GATEWAY_TRANSCRIPT_SHELL_CLASS}>
        <div
          ref={transcriptListRef}
          className={`${GATEWAY_CHAT_COLUMN_CLASS} gateway-transcript-list col-[2] flex min-w-0 select-text flex-col gap-18px max-640:gap-14px`}
        >
          {/* Keyed remount per conversation: per-conversation state (measured
            heights, scroll-to-end latch) initializes fresh, and row keys can
            never collide across conversations in the itemSizeCache. */}
          <ProcessDisclosureProvider
            expandByDefault={expandProcessByDefault}
            detailedProgress={detailedProgress}
            isViewportFollowing={isViewportFollowing}
          >
            <GatewayTranscriptListRegion
              key={conversationId ?? "shared"}
              conversationId={conversationId}
              editRequest={editRequest}
              onEditRequestHandled={onEditRequestHandled}
              rows={rows}
              scheduledTurn={scheduledTurn}
              liveStartIndex={liveStartIndex}
              activeTurnKey={activeTurnKey}
              contentWidth={contentWidth}
              scrollViewport={transcriptScrollViewport}
              isViewportFollowing={isViewportFollowing}
              viewportFollowing={viewportFollowing}
              navRef={navRef}
              onAnchorUserRowChange={onAnchorUserRowChange}
              hasMoreHistory={hasMoreHistory}
              isLoadingMoreHistory={isLoadingMoreHistory}
              onLoadEarlierHistory={onLoadEarlierHistory}
              isStreaming={isStreaming}
              assistantLiveMode={assistantLiveMode}
              showUsage={showUsage}
              usageContextWindow={usageContextWindow}
              workspaceRoot={workspaceRoot}
              imagePreviewScope={imagePreviewScope}
              gitClient={gitClient}
              onOpenFileLink={onOpenFileLink}
              onLoadUploadedImagePreview={onLoadUploadedImagePreview}
              onResendFromEdit={onResendFromEdit}
              onBranchConversation={onBranchConversation}
              branchPendingMessageId={branchPendingMessageId}
              resendCreatesBranch={resendCreatesBranch}
              toolStatus={toolStatus}
              toolStatusIsCompaction={toolStatusIsCompaction}
              retryAttempts={retryAttempts}
              readOnly={readOnly}
              redactToolContent={redactToolContent}
            />
          </ProcessDisclosureProvider>
          {shouldShowInlineError ? (
            <div
              className={cn(
                "rounded-14px border border-solid border-destructive/16 bg-destructive/8 px-12px py-10px",
                "text-sm text-destructive",
              )}
            >
              {inlineErrorText}
            </div>
          ) : null}
          {footer}
        </div>
        <div className="col-2 h-gateway-transcript-bottom-spacer-h" />
        {!readOnly && !isLoading && onQuoteSelection ? (
          <TranscriptQuoteSelection
            rootRef={transcriptListRef}
            scopeKey={JSON.stringify([imagePreviewScope, conversationId])}
            onQuote={onQuoteSelection}
            onComment={comments}
          />
        ) : null}
        <ChatFileLinkContextMenuHost />
      </div>
    </TranscriptCommentProvider>
  );
}
