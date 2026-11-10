import { BackgroundNoticeMessage } from "@liveagent/ui/components/chat/BackgroundNoticeMessage";
import { DocumentRevisionMessageBody } from "@liveagent/ui/components/chat/DocumentRevisionMessageChip";
import { EditableUserMessageBubble } from "@liveagent/ui/components/chat/EditableUserMessageBubble";
import { type ChatFileLink, chatAttachmentFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import {
  copyDocumentRevision,
  parseDocumentRevisionMessage,
} from "@liveagent/ui/lib/chat/documentRevisionMessage";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import {
  type PendingUploadedFile,
  splitUserAttachmentsForDisplay,
} from "@liveagent/ui/lib/chat/uploadedFiles";
import {
  type CommitDetailsLoader,
  UserMessageContent,
} from "@liveagent/ui/lib/chat/userMessageContent";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo } from "react";
import { loadComposerUploadedImagePreview } from "../../../agent-ui-adapters/composerImagePreview";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import { UserRowFooter } from "./RowActions";
import type { UserRow } from "./rowModel";
import { UserAttachmentCards } from "./UserAttachmentCards";

export type UserMessageRowProps = {
  row: UserRow;
  isEditing: boolean;
  workspaceRoot?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
  loadCommitDetails: CommitDetailsLoader;
  onStartEdit: (key: string) => void;
  onCancelEdit: () => void;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
    referencedConversations: ConversationMentionReference[],
  ) => void;
};

export const UserMessageRow = memo(function UserMessageRow(props: UserMessageRowProps) {
  const {
    row,
    isEditing,
    workspaceRoot,
    loadCommitDetails,
    onStartEdit,
    onCancelEdit,
    onResendFromEdit,
  } = props;
  const item = row.item;
  const openAttachment = props.onOpenFileLink
    ? (file: PendingUploadedFile) => props.onOpenFileLink?.(chatAttachmentFileLink(file))
    : undefined;

  const effectiveMessageRef = item.messageRef;
  const compactedClass = item.isFromCompactedSegment ? "opacity-70" : "";
  const { visibleFiles, pastedTextFiles } = splitUserAttachmentsForDisplay(
    item.attachments,
    item.text,
  );

  if (item.backgroundNotice) {
    return <BackgroundNoticeMessage text={item.text} className={compactedClass} />;
  }

  const revision = parseDocumentRevisionMessage(item.text);
  if (revision) {
    return (
      <div
        className={cn(
          "chat-user-bubble-wrap group relative ml-auto max-w-user-bubble-web",
          compactedClass,
        )}
        data-user-bubble-wrap
      >
        <DocumentRevisionMessageBody
          revision={revision}
          attachments={item.attachments}
          workspaceRoot={workspaceRoot}
          onOpenAttachment={openAttachment}
          onLoadUploadedImagePreview={loadComposerUploadedImagePreview}
        />
        <UserRowFooter
          itemKey={item.key}
          text={copyDocumentRevision(revision)}
          timestamp={item.timestamp}
          hasStableRef={false}
          messageId={effectiveMessageRef?.messageId}
          onStartEdit={onStartEdit}
        />
      </div>
    );
  }

  if (isEditing && effectiveMessageRef) {
    return (
      <EditableUserMessageBubble
        initialText={item.text}
        attachments={item.attachments}
        onOpenAttachment={openAttachment}
        workspaceRoot={workspaceRoot}
        className={compactedClass}
        preserveViewportScrollOnFocus
        onLoadUploadedImagePreview={loadComposerUploadedImagePreview}
        onCancel={onCancelEdit}
        onSubmit={(newText, nextAttachments) => {
          onCancelEdit();
          onResendFromEdit(
            effectiveMessageRef,
            newText,
            nextAttachments,
            item.referencedConversations,
          );
        }}
      />
    );
  }

  const imageStrip = visibleFiles.filter((file) => file.kind === "image" && file.absolutePath);
  const bubbleFiles = visibleFiles.filter((file) => !imageStrip.includes(file));

  return (
    <div
      className={cn(
        "chat-user-bubble-wrap group relative ml-auto max-w-user-bubble-web",
        compactedClass,
      )}
      data-user-bubble-wrap
    >
      <UserAttachmentCards
        files={imageStrip}
        workspaceRoot={workspaceRoot}
        onOpen={openAttachment}
        imageStrip
      />
      {(item.text || bubbleFiles.length > 0) && (
        <div
          className={cn(
            "ml-auto w-fit max-w-full",
            "whitespace-pre-wrap rounded-2xl rounded-br-md bg-[hsl(var(--chat-user-bg))] px-4 py-2.5",
            "font-chat text-sm leading-relaxed break-words text-[hsl(var(--chat-user-fg))] [overflow-wrap:anywhere]",
          )}
        >
          <UserAttachmentCards
            files={bubbleFiles}
            workspaceRoot={workspaceRoot}
            onOpen={openAttachment}
          />
          {item.text ? (
            <UserMessageContent
              text={item.text}
              pastedTextFiles={pastedTextFiles}
              loadCommitDetails={loadCommitDetails}
            />
          ) : null}
        </div>
      )}
      <UserRowFooter
        itemKey={item.key}
        text={item.text}
        timestamp={item.timestamp}
        hasStableRef={!!effectiveMessageRef}
        messageId={effectiveMessageRef?.messageId}
        onStartEdit={onStartEdit}
      />
    </div>
  );
});
