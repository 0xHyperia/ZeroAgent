import type { ImageStudioHost } from "@liveagent/ui/application/imageStudioHost";
import type { DeviceConversationImageHost } from "@liveagent/ui/components/resource-preview/DeviceConversationImageSurface";
import { createContext, useCallback, useContext } from "react";

export const DesktopConversationImageHost = createContext<{
  studio: ImageStudioHost;
  configure: () => void;
  fileReaderOpen: boolean;
  closeFileReader: () => void;
  submit: (
    conversationId: string,
    workdir: string,
    ...args: Parameters<NonNullable<DeviceConversationImageHost["submit"]>>
  ) => ReturnType<NonNullable<DeviceConversationImageHost["submit"]>>;
} | null>(null);

export function useDesktopConversationImages(
  conversationId: string,
  workdir: string,
  enabled: boolean,
): DeviceConversationImageHost | undefined {
  const host = useContext(DesktopConversationImageHost);
  const client = enabled ? host?.studio.client : undefined;
  const read = useCallback<DeviceConversationImageHost["read"]>(
    (id, variant, signal) =>
      client?.readAsset(id, variant, signal) ?? Promise.reject(new Error("Image unavailable")),
    [client],
  );
  if (!client || !host) return undefined;
  return {
    scope: JSON.stringify([host.studio.scopeKey, conversationId, workdir]),
    read,
    configure: host.configure,
    fileReaderOpen: host.fileReaderOpen,
    closeFileReader: host.closeFileReader,
    check: (id) => client.getJob(id),
    submit: (...args) => host.submit(conversationId, workdir, ...args),
    download: async (item, signal) => {
      signal.throwIfAborted();
      await client.exportAsset(item.id, "download");
    },
  };
}
