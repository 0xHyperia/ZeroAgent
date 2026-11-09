import type { ImageStudioHost } from "@liveagent/ui/application/imageStudioHost";
import type { AssistantVisualContext } from "@liveagent/ui/components/chat/AssistantVisuals";
import {
  ConversationImagePreview,
  useConversationImagePreview,
} from "@liveagent/ui/components/resource-preview/ConversationImagePreview";
import type {
  ConversationImageEdit,
  ConversationImageEditReceipt,
} from "@liveagent/ui/components/resource-preview/conversationImageAnnotation";
import { useConversationImageSources } from "@liveagent/ui/components/resource-preview/conversationImageSources";
import type { AssistantDeliverable } from "@liveagent/ui/lib/chat/assistantResources";
import { type ContextType, createContext, useCallback, useContext, useEffect } from "react";

export const DesktopConversationImageHost = createContext<{
  studio: ImageStudioHost;
  configure: () => void;
  fileReaderOpen: boolean;
  closeFileReader: () => void;
  submit: (
    conversationId: string,
    workdir: string,
    text: string,
    instruction: string,
    files: File[],
    signal: AbortSignal,
    keepPreview?: boolean,
  ) => Promise<boolean | ConversationImageEditReceipt>;
} | null>(null);

export function useDesktopConversationImages(
  conversationId: string,
  workdir: string,
  enabled: boolean,
) {
  const host = useContext(DesktopConversationImageHost);
  const client = enabled ? host?.studio.client : undefined;
  const scope = JSON.stringify([enabled, host?.studio.scopeKey, conversationId, workdir]);
  const preview = useConversationImagePreview(scope);
  const { close } = preview;
  useEffect(() => {
    if (host?.fileReaderOpen) close();
  }, [host?.fileReaderOpen, close]);
  const load = useCallback(
    (id: string, variant: "original" | "thumbnail", signal: AbortSignal) =>
      client?.readAsset(id, variant, signal) ?? Promise.reject(new Error("Image unavailable")),
    [client],
  );
  const sources = useConversationImageSources(scope, load, "thumbnail");
  if (!client || !host) return {};

  const onEdit = async (
    item: AssistantDeliverable,
    edit: ConversationImageEdit,
    signal: AbortSignal,
  ) => {
    const files: File[] = [];
    if (workdir) {
      const blob = await sources.read(item.id, signal);
      signal.throwIfAborted();
      const extension =
        blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
      files.push(new File([blob], `image-${item.id}.${extension}`, { type: blob.type }));
      if (edit.region) files.push(edit.region.file);
    }
    signal.throwIfAborted();
    return host.submit(
      conversationId,
      workdir,
      edit.text,
      `${edit.instruction}\nUse edit_image with the original asset ${item.id} if offered, or the original image in attachment:1.${edit.region ? " A separate selection attachment is only a locator." : ""}`,
      files,
      signal,
      edit.keepPreview,
    );
  };
  const openImage = (item: AssistantDeliverable, edit: boolean, trigger?: HTMLElement) => {
    host.closeFileReader();
    preview.open(item, edit, trigger);
  };
  const visuals: ContextType<typeof AssistantVisualContext> = {
    sources,
    openImage: (item, trigger) => openImage(item, false, trigger),
    editImage: (item, trigger) => openImage(item, true, trigger),
    registerImages: preview.register,
    configureImage: host.configure,
    checkImage: (id) => client.getJob(id),
    activity: () => null,
  };
  return {
    visuals,
    panel: preview.panel,
    reader: preview.item && (
      <ConversationImagePreview
        key={scope}
        item={preview.item}
        items={preview.items}
        panel={preview.panel}
        origin={preview.origin}
        edit={preview.edit}
        onPanel={() => preview.setPanel(true)}
        onPreview={() => preview.setPanel(false)}
        onClose={preview.close}
        onSelect={preview.select}
        waitingSelected={preview.waitingSelected}
        onSelectWaiting={preview.selectWaiting}
        onTrackRun={preview.trackRun}
        onStopRun={preview.stopRun}
        run={preview.run}
        draft={preview.draft}
        updateDraft={preview.updateDraft}
        sources={sources}
        onEdit={onEdit}
        onDownload={async (item, signal) => {
          signal.throwIfAborted();
          await client.exportAsset(item.id, "download");
        }}
      />
    ),
  };
}
