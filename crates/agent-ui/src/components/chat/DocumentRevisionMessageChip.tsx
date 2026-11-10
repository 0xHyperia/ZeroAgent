import { useLocale } from "../../i18n";
import {
  type DocumentRevisionMessage,
  documentRevisionEvidence,
  documentRevisionSource,
} from "../../lib/chat/documentRevisionMessage";
import type { PendingUploadedFile } from "../../lib/chat/uploadedFiles";
import type { UploadedImagePreviewLoader } from "../../lib/chat/uploadedImagePreview";
import { MessageSquareText } from "../IconSet";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { getFileTypeIcon } from "./fileTypeIcons";
import { UserAttachmentCards } from "./UserAttachmentCards";

export function DocumentRevisionMessageBody({
  revision,
  attachments,
  workspaceRoot,
  onOpenAttachment,
  onLoadUploadedImagePreview,
}: {
  revision: DocumentRevisionMessage;
  attachments: readonly PendingUploadedFile[];
  workspaceRoot?: string;
  onOpenAttachment?: (file: PendingUploadedFile) => void;
  onLoadUploadedImagePreview?: UploadedImagePreviewLoader;
}) {
  const source = documentRevisionSource(revision, attachments);
  return (
    <>
      <UserAttachmentCards
        files={documentRevisionEvidence(revision, attachments)}
        workspaceRoot={workspaceRoot}
        onLoadUploadedImagePreview={onLoadUploadedImagePreview}
        imagePreviewMode="imageKind"
        imageStrip
      />
      <DocumentRevisionMessageChip
        revision={revision}
        onOpenSource={source && onOpenAttachment ? () => onOpenAttachment(source) : undefined}
      />
    </>
  );
}

function DocumentRevisionMessageChip({
  revision,
  onOpenSource,
}: {
  revision: DocumentRevisionMessage;
  onOpenSource?: () => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const count = revision.comments.length;
  const label = zh ? `${count} 条注释` : `${count} ${count === 1 ? "comment" : "comments"}`;
  const FileIcon = getFileTypeIcon(revision.name, "file");

  return (
    <div className="ml-auto flex w-fit max-w-full justify-end" data-document-revision-message="">
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={180}
          closeDelay={140}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border bg-background px-2.5 text-sm font-medium hover:bg-accent focus-visible:outline-ring"
        >
          <MessageSquareText className="size-3.5 text-muted-foreground" />
          {label}
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={6}
          className="max-h-[min(60vh,32rem)] w-[min(24rem,var(--available-width))] overflow-auto rounded-2xl p-1"
        >
          <PopoverTitle className="sr-only">{label}</PopoverTitle>
          <ul className="divide-y divide-border/70">
            {revision.comments.map(({ ordinal, page, location, quote, comment }) => (
              <li key={ordinal} className="min-w-0 space-y-1.5 px-2.5 py-2">
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  {onOpenSource ? (
                    <button
                      type="button"
                      onClick={onOpenSource}
                      className="flex min-w-0 items-center gap-1.5 text-primary hover:underline"
                    >
                      <FileIcon className="size-3.5 shrink-0" />
                      <span className="truncate">{revision.name}</span>
                    </button>
                  ) : (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <FileIcon className="size-3.5 shrink-0" />
                      <span className="truncate">{revision.name}</span>
                    </span>
                  )}
                  <span
                    className="min-w-0 shrink-0 truncate text-muted-foreground"
                    style={{ maxWidth: "45%" }}
                  >
                    {location ||
                      (revision.kind === "presentation"
                        ? zh
                          ? `第 ${page} 张`
                          : `Slide ${page}`
                        : zh
                          ? `第 ${page} 页`
                          : `Page ${page}`)}
                  </span>
                </div>
                {quote && (
                  <p className="line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {quote}
                  </p>
                )}
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{comment}</p>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
