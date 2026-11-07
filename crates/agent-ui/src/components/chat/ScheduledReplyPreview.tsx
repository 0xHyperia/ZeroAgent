import { useLocale } from "@liveagent/ui/i18n/index";
import type { ScheduledRunPreview } from "@liveagent/ui/lib/automation/types";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { ReactNode } from "react";
import { AssistantBubble } from "./AssistantBubble";
import { UserMessageBubbleBody } from "./UserMessageBubbleBody";

export type ScheduledPreviewRow = { key: string; content: ReactNode };
const NO_ATTACHMENTS: PendingUploadedFile[] = [];

export function ScheduledPromptPreview({
  prompt,
}: {
  prompt: NonNullable<ScheduledRunPreview["prompt"]>;
}) {
  return (
    <div
      data-scheduled-prompt-preview=""
      className="chat-user-bubble-wrap relative ml-auto max-w-user-bubble-web"
    >
      <UserMessageBubbleBody
        messageKey={prompt.messageId}
        text={prompt.truncated ? `${prompt.text}…` : prompt.text}
        attachments={NO_ATTACHMENTS}
      />
    </div>
  );
}

export function ScheduledReplyPreview({
  preview,
  startedAt,
  streaming,
  showPrompt,
}: {
  preview: ScheduledRunPreview;
  startedAt: number;
  streaming: boolean;
  showPrompt: boolean;
}) {
  const { locale } = useLocale();
  const prompt = showPrompt ? preview.prompt : undefined;
  return (
    <div className="min-w-0 space-y-4">
      {prompt && <ScheduledPromptPreview prompt={prompt} />}
      <div data-scheduled-reply-preview="" className="min-w-0 space-y-2">
        <AssistantBubble
          rounds={
            preview.text
              ? [
                  {
                    round: 1,
                    blocks: [{ kind: "text", id: "scheduled-answer", text: preview.text }],
                  },
                ]
              : []
          }
          isLive
          isStreaming={streaming}
          renderMode="streaming"
          startedAtMs={startedAt}
          readOnly
        />
        {preview.truncated && (
          <p className="text-xs text-muted-foreground">
            {locale === "zh-CN"
              ? "生成内容较长，运行结束后可查看完整结果。"
              : "This reply is long. The full result will appear when the run finishes."}
          </p>
        )}
      </div>
    </div>
  );
}
