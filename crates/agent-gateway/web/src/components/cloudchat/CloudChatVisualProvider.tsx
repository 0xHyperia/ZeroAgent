import {
  AssistantVisualContext,
  VisualCreationPending,
  VisualCreationSettingsNotice,
} from "@liveagent/ui/components/chat/AssistantVisuals";
import {
  type ConversationImageSources,
  useConversationImageSources,
} from "@liveagent/ui/components/resource-preview/conversationImageSources";
import type { AssistantDeliverable } from "@liveagent/ui/lib/chat/assistantResources";
import { type ReactNode, useCallback, useMemo } from "react";
import { captureAccountRequestGuard } from "@/lib/accountRequest";
import type { CloudChatArtifactsClient } from "@/lib/cloudChatArtifacts";
import type { CloudChatMessage } from "@/lib/cloudChatHistory";

export function useCloudChatImageSources(client: CloudChatArtifactsClient, scope: string) {
  const load = useCallback(
    async (id: string, _variant: "original" | "thumbnail", signal: AbortSignal) => {
      const version = await client.get(id, signal);
      const result = await client.image(version, signal);
      result.guard();
      return result.blob;
    },
    [client],
  );
  return useConversationImageSources(scope, load, "original", captureAccountRequestGuard);
}
export function CloudChatVisualProvider({
  children,
  messages,
  running,
  onConfigure,
  onOpen,
  onEdit,
  registerImages,
  sources,
}: {
  children: ReactNode;
  messages: readonly CloudChatMessage[];
  running: boolean;
  onConfigure: () => void;
  onOpen: (item: AssistantDeliverable, trigger?: HTMLElement) => void;
  onEdit: (item: AssistantDeliverable, trigger?: HTMLElement) => void;
  registerImages: (items: readonly AssistantDeliverable[]) => void;
  sources: ConversationImageSources;
}) {
  const value = useMemo(
    () => ({
      sources,
      openImage: onOpen,
      editImage: onEdit,
      registerImages,
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
          <VisualCreationSettingsNotice
            message={
              last.status === "请先选择默认生图模型" || last.status === "资料空间容量不足"
                ? last.status
                : "图像尚未生成"
            }
            description={
              last.status === "请先选择默认生图模型"
                ? "设置完成后，回到当前对话继续创作。"
                : last.status === "资料空间容量不足"
                  ? "整理资料空间后，再继续创作。"
                  : "请检查默认生图模型与可用额度，再继续创作。"
            }
            onConfigure={onConfigure}
          />
        );
      },
    }),
    [sources, messages, running, onOpen, onEdit, onConfigure, registerImages],
  );
  return (
    <AssistantVisualContext.Provider value={value}>{children}</AssistantVisualContext.Provider>
  );
}
