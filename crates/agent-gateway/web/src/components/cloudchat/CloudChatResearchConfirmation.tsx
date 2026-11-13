import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useMemo, useState } from "react";
import {
  CLOUD_PUBLIC_RESEARCH_TOPIC_BYTES,
  type CloudChatPublicResearch,
  parseCloudChatPublicResearch,
} from "@/lib/cloudChatResearch";

export function CloudChatResearchConfirmation({
  initialTopic,
  onConfirm,
  onCancel,
}: {
  initialTopic: string;
  onConfirm: (research: CloudChatPublicResearch) => void;
  onCancel: () => void;
}) {
  const [topic, setTopic] = useState(initialTopic);
  const validation = useMemo(() => {
    try {
      return { research: parseCloudChatPublicResearch({ topic }) };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : "请填写公开检索主题。" };
    }
  }, [topic]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="flex max-h-[min(85dvh,calc(var(--zeroagent-visual-viewport-height,100dvh)-24px))] w-full max-w-640px flex-col gap-16px overflow-auto p-20px">
        <DialogTitle>确认公开检索主题</DialogTitle>
        <DialogDescription>
          下面这段主题可用于公开搜索和网页查询。公开研究无法看到对话历史、项目资料、记忆或附件；完成检索后，再结合你的私有资料作答。请移除不希望发送到搜索服务或网页站点的信息。
        </DialogDescription>
        {!initialTopic ? (
          <p className="text-sm text-muted-foreground">
            请填写一段简短的公开主题。原消息和附件会保留，用于后续私有分析。
          </p>
        ) : null}
        <label className="flex flex-col gap-8px text-sm">
          可用于公开检索的主题
          <textarea
            aria-label="可用于公开检索的主题"
            value={topic}
            maxLength={CLOUD_PUBLIC_RESEARCH_TOPIC_BYTES}
            onChange={(event) => setTopic(event.target.value)}
            rows={6}
            className="rounded-xl border border-border bg-background p-12px"
          />
        </label>
        {validation.error && topic ? (
          <p role="alert" className="text-sm text-destructive">
            {validation.error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-8px">
          <button
            type="button"
            className="rounded-lg border border-border px-12px py-6px text-sm max-820:min-h-11"
            onClick={onCancel}
          >
            取消联网发送
          </button>
          <button
            type="button"
            disabled={!validation.research}
            className="rounded-lg bg-primary px-12px py-6px text-sm text-primary-foreground disabled:opacity-50 max-820:min-h-11"
            onClick={() => {
              if (validation.research) onConfirm(validation.research);
            }}
          >
            确认公开主题并继续
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
