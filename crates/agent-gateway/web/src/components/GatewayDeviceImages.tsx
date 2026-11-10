import { AssistantVisualContext } from "@liveagent/ui/components/chat/AssistantVisuals";
import { ImagePreview } from "@liveagent/ui/components/chat/ImagePreview";
import {
  useConversationImageSource,
  useConversationImageSources,
} from "@liveagent/ui/components/resource-preview/conversationImageSources";
import type { AssistantDeliverable } from "@liveagent/ui/lib/chat/assistantResources";
import { UploadedImagePreviewScope } from "@liveagent/ui/lib/chat/uploadedImagePreview";
import { type ContextType, createContext, useCallback, useContext, useState } from "react";
import type { GatewayWebSocketClient } from "@/lib/gatewaySocket";

export const GatewayDeviceImageClient = createContext<Pick<
  GatewayWebSocketClient,
  "readConversationImage"
> | null>(null);

export function useGatewayDeviceImages(conversationId: string | undefined, readOnly: boolean) {
  const client = useContext(GatewayDeviceImageClient);
  const owner = useContext(UploadedImagePreviewScope);
  const inheritedVisuals = useContext(AssistantVisualContext);
  const enabled = Boolean(client && conversationId && !readOnly);
  const scope = JSON.stringify([enabled, owner, conversationId]);
  const [selection, setSelection] = useState<{ scope: string; item: AssistantDeliverable }>();
  const item = selection?.scope === scope ? selection.item : undefined;
  const load = useCallback(
    async (id: string, variant: "original" | "thumbnail", signal: AbortSignal) => {
      if (!client || !conversationId) throw new Error("The conversation image is unavailable.");
      signal.throwIfAborted();
      const { data, mimeType } = await client.readConversationImage(conversationId, id, variant);
      signal.throwIfAborted();
      if (
        !data ||
        data.length > Math.ceil((8 * 1024 * 1024) / 3) * 4 ||
        !/^image\/(?:png|jpeg|webp)$/.test(mimeType)
      ) {
        throw new Error("The conversation image is unavailable.");
      }
      const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      return new Blob([bytes], { type: mimeType });
    },
    [client, conversationId],
  );
  const sources = useConversationImageSources(scope, load);
  const { source } = useConversationImageSource(sources, item?.id ?? "", "original", Boolean(item));
  const visuals: ContextType<typeof AssistantVisualContext> = enabled
    ? {
        sources,
        activity: () => null,
        openImage: (next) => setSelection({ scope, item: next }),
      }
    : inheritedVisuals;
  const preview = item && source && (
    <ImagePreview
      open
      slides={[{ src: source.url, alt: item.name, title: item.name }]}
      onClose={() => setSelection(undefined)}
    />
  );
  return { visuals, preview };
}
