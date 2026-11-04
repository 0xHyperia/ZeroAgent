import {
  AssistantVisualContext,
  VisualCreationPending,
} from "@liveagent/ui/components/chat/AssistantVisuals";
import { Settings2 } from "@liveagent/ui/components/IconSet";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import type { AssistantDeliverable } from "@liveagent/ui/lib/chat/assistantResources";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { captureAccountRequestGuard } from "@/lib/accountRequest";
import type { CloudChatArtifactsClient } from "@/lib/cloudChatArtifacts";
import type { CloudChatMessage } from "@/lib/cloudChatHistory";

export function CloudChatVisualProvider({
  children,
  messages,
  client,
  running,
  onConfigure,
  onEdit,
}: {
  children: ReactNode;
  messages: readonly CloudChatMessage[];
  client: CloudChatArtifactsClient;
  running: boolean;
  onConfigure: () => void;
  onEdit: (item: AssistantDeliverable) => void;
}) {
  const cache = useRef(new Map<string, Promise<Blob>>());
  const lifecycle = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => {
      controller.abort();
      cache.current.clear();
    };
  }, []);
  const loadImage = useCallback(
    async (id: string, signal: AbortSignal) => {
      const guard = captureAccountRequestGuard();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      let pending = cache.current.get(id);
      if (!pending) {
        pending = (async () => {
          const version = await client.get(id, lifecycle.current?.signal);
          const result = await client.image(version, lifecycle.current?.signal);
          result.guard();
          return result.blob;
        })();
        cache.current.set(id, pending);
        // Eight decoded receipts at most; consumers own and release their object URLs.
        while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
        void pending.catch(() => {
          if (cache.current.get(id) === pending) cache.current.delete(id);
        });
      }
      const blob = await pending;
      guard();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return blob;
    },
    [client],
  );
  const value = useMemo(
    () => ({
      loadImage,
      editImage: onEdit,
      activity: (messageId: string) => {
        const message = messages.find((message) => message.id === messageId);
        const tools =
          message?.presentation?.blocks.filter(
            (block) => block.type === "tool" && block.name === "generate_image",
          ) ?? [];
        const pending = tools.some(
          (tool) => tool.state === "prepared" || tool.state === "executing",
        );
        if (pending && running)
          return (
            <div className="py-3">
              <VisualCreationPending
                compact={tools.some((tool) =>
                  tool.resources?.some((resource) => resource.role === "output"),
                )}
              />
            </div>
          );
        const last = tools.at(-1);
        if (
          !last ||
          last.state === "succeeded" ||
          last.resources?.some((resource) => resource.role === "output")
        )
          return null;
        if (last.state === "cancelled")
          return (
            <p role="status" className="py-2 text-sm text-muted-foreground">
              图像创作已停止
            </p>
          );
        if (last.state === "unknown" || pending)
          return (
            <p role="status" className="py-2 text-sm text-muted-foreground">
              生图结果尚未确认，当前请求不会自动重复提交。
            </p>
          );
        return (
          <div className="my-3 flex max-w-lg flex-wrap items-center justify-between gap-3 rounded-2xl bg-muted/50 px-4 py-3">
            <div className="text-sm">
              <p className="font-medium">
                {last.status === "请先选择默认生图模型"
                  ? last.status
                  : last.status === "资料空间容量不足"
                    ? last.status
                    : "图像尚未生成"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {last.status === "请先选择默认生图模型"
                  ? "设置完成后，回到当前对话继续创作。"
                  : last.status === "资料空间容量不足"
                    ? "整理资料空间后，再继续创作。"
                    : "请检查默认生图模型与可用额度，再继续创作。"}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="rounded-full bg-background"
              onClick={onConfigure}
            >
              <Settings2 className="size-3.5" />
              生图设置
            </Button>
          </div>
        );
      },
    }),
    [loadImage, messages, running, onEdit, onConfigure],
  );
  return (
    <AssistantVisualContext.Provider value={value}>{children}</AssistantVisualContext.Provider>
  );
}
