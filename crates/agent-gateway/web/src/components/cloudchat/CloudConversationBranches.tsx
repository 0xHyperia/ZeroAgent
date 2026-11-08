import { ArrowLeft, GitBranch, Loader2 } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@liveagent/ui/components/ui/popover";
import { useLocale } from "@liveagent/ui/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CloudConversationBranches as BranchPage,
  CloudChatConversationsClient,
} from "@/lib/cloudChatConversations";

export type CloudConversationBranchesProps = {
  conversationId: string;
  client: CloudChatConversationsClient;
  onNavigate: (conversationId: string, messageId?: string) => void;
};

/** An on-demand view of persisted lineage, shared by wide and narrow CloudChat layouts. */
export function CloudConversationBranches({
  conversationId,
  client,
  onNavigate,
}: CloudConversationBranchesProps) {
  const { locale } = useLocale();
  const zh = locale.startsWith("zh");
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<BranchPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const sequenceRef = useRef(0);
  const load = useCallback(
    async (cursor?: string) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const sequence = ++sequenceRef.current;
      setLoading(true);
      setError(false);
      try {
        const next = await client.branches(conversationId, { cursor, signal: controller.signal });
        if (controller.signal.aborted || sequence !== sequenceRef.current) return;
        setPage((current) =>
          cursor && current
            ? {
                ...next,
                children: [
                  ...new Map(
                    [...current.children, ...next.children].map((item) => [
                      item.conversation.id,
                      item,
                    ]),
                  ).values(),
                ],
              }
            : next,
        );
      } catch {
        if (!controller.signal.aborted && sequence === sequenceRef.current) setError(true);
      } finally {
        if (!controller.signal.aborted && sequence === sequenceRef.current) setLoading(false);
      }
    },
    [client, conversationId],
  );
  useEffect(() => {
    setPage(null);
    setError(false);
    if (open) void load();
    return () => {
      sequenceRef.current++;
      controllerRef.current?.abort();
    };
  }, [open, load]);
  const navigate = (id: string, messageId?: string) => {
    setOpen(false);
    onNavigate(id, messageId);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={zh ? "查看对话分支" : "Conversation branches"}
            className="gap-1.5 rounded-full text-muted-foreground hover:text-foreground"
          />
        }
      >
        <GitBranch className="size-4" />
        <span className="hidden sm:inline">{zh ? "分支" : "Branches"}</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(340px,calc(100vw-24px))] p-2">
        <h2 className="px-2 py-2 text-sm font-medium">
          {zh ? "相关对话" : "Related conversations"}
        </h2>
        {loading && !page ? (
          <div
            role="status"
            className="space-y-2 p-2"
            aria-label={zh ? "正在读取分支" : "Loading branches"}
          >
            {[1, 2, 3].map((item) => (
              <div
                key={item}
                className="h-10 animate-pulse rounded-xl bg-muted motion-reduce:animate-none"
              />
            ))}
          </div>
        ) : null}
        {page?.source ? (
          <div className="mb-2 border-b border-border/60 pb-2">
            <div className="px-2 py-1 text-xs text-muted-foreground">{zh ? "来源" : "Source"}</div>
            {page.source.available ? (
              <button
                type="button"
                onClick={() =>
                  page.source && navigate(page.source.conversation_id, page.source.message_id)
                }
                className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              >
                <ArrowLeft className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {page.source.title || (zh ? "未命名对话" : "Untitled conversation")}
                </span>
              </button>
            ) : (
              <p className="px-2 py-2 text-sm text-muted-foreground">
                {zh ? "原对话已不可访问" : "The source is no longer available"}
              </p>
            )}
          </div>
        ) : null}
        <div
          className="max-h-[min(48dvh,360px)] overflow-y-auto overscroll-contain"
          aria-busy={loading}
        >
          {page?.children.map((item) => (
            <button
              key={item.conversation.id}
              type="button"
              onClick={() => navigate(item.conversation.id)}
              className="flex w-full items-center gap-2 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            >
              <GitBranch className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{item.conversation.title}</span>
                <span className="text-xs text-muted-foreground">
                  {zh ? "从此处分支" : "Forked here"}
                  {item.conversation.archived ? (zh ? " · 已归档" : " · Archived") : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
        {page && !page.children.length ? (
          <p className="px-2 py-5 text-center text-sm text-muted-foreground">
            {zh ? "尚未创建子分支" : "No branches yet"}
          </p>
        ) : null}
        {error ? (
          <div className="px-2 py-2 text-center">
            <p role="alert" className="mb-2 text-xs text-destructive">
              {zh ? "暂时无法读取分支" : "Unable to load branches"}
            </p>
            <Button size="sm" variant="ghost" onClick={() => void load(page?.nextCursor)}>
              {zh ? "重试" : "Retry"}
            </Button>
          </div>
        ) : null}
        {page?.hasMore && !error ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 w-full"
            disabled={loading}
            onClick={() => void load(page.nextCursor)}
          >
            {loading ? (
              <Loader2 className="mr-2 size-3.5 animate-spin motion-reduce:animate-none" />
            ) : null}
            {zh ? "加载更多" : "Load more"}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
