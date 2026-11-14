import { isConversationImageTool } from "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils";
import {
  conversationImageDeliverables,
  parseConversationImageResult,
} from "@liveagent/ui/components/chat/assistant-bubble/ConversationImageTool";
import type { DeviceConversationImageHost } from "@liveagent/ui/components/resource-preview/DeviceConversationImageSurface";
import { toolResultMessageToText } from "@liveagent/ui/lib/chat/uiMessages";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { UploadedImagePreviewScope } from "@liveagent/ui/lib/chat/uploadedImagePreview";
import { useCallback, useContext } from "react";
import type { SendChatFn } from "@/app/types";
import type { TranscriptStore } from "@/lib/chat/transcript/transcriptStore";
import type { GatewayWebSocketClient } from "@/lib/gatewaySocket";

export type ImportDeviceConversationFiles = (
  workdir: string,
  files: File[],
  signal: AbortSignal,
) => Promise<PendingUploadedFile[]>;

function waitForImageResult(
  api: GatewayWebSocketClient,
  store: TranscriptStore,
  runId: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
  zh: boolean,
) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]);
  return new Promise<ReturnType<typeof conversationImageDeliverables>[number] | undefined>(
    (resolve) => {
      const finish = (image?: ReturnType<typeof conversationImageDeliverables>[number]) => {
        timeout.removeEventListener("abort", onAbort);
        unsubscribe();
        unsubscribeUpdates();
        resolve(image);
      };
      const onAbort = () => finish();
      const check = () => {
        if (!isCurrent() || timeout.aborted) return finish();
        const turn = store.getTurn(runId);
        if (!turn || turn.phase !== "settled") return;
        for (const entry of turn.entries) {
          if (entry.kind !== "tool_result" || !isConversationImageTool(entry.toolResult.toolName))
            continue;
          const [image] = conversationImageDeliverables(
            parseConversationImageResult(toolResultMessageToText(entry.toolResult)),
            zh,
          );
          if (image) return finish(image);
        }
        if (turn.contentConfirmed || turn.entries.some((entry) => entry.kind === "error")) finish();
      };
      const unsubscribe = store.subscribe(check);
      const unsubscribeUpdates = api.subscribeChatCommandUpdates((update) => {
        if (update.runId === runId && update.phase === "failed") finish();
      });
      timeout.addEventListener("abort", onAbort, { once: true });
      check();
    },
  );
}

export function useGatewayDeviceImages(options: {
  api: GatewayWebSocketClient | null;
  conversationId: string;
  workdir: string;
  enabled: boolean;
  offline: boolean;
  zh: boolean;
  store: TranscriptStore;
  importFiles: ImportDeviceConversationFiles;
  send: SendChatFn;
  isRunning: () => boolean;
  fileReaderOpen?: boolean;
  closeFileReader?: () => void;
}): DeviceConversationImageHost | undefined {
  const {
    api,
    conversationId,
    workdir,
    enabled,
    offline,
    zh,
    store,
    importFiles,
    send,
    isRunning,
  } = options;
  const owner = useContext(UploadedImagePreviewScope);
  const read = useCallback<DeviceConversationImageHost["read"]>(
    async (id, variant, signal) => {
      if (!api || !conversationId) throw new Error("The conversation image is unavailable.");
      const isCurrent = api.captureActiveAgentScope();
      signal.throwIfAborted();
      const { data, mimeType } = await api.readConversationImage(conversationId, id, variant);
      signal.throwIfAborted();
      if (
        !isCurrent() ||
        !data ||
        data.length > Math.ceil((8 * 1024 * 1024) / 3) * 4 ||
        !/^image\/(?:png|jpeg|webp)$/.test(mimeType)
      ) {
        throw new Error("The conversation image is unavailable.");
      }
      return new Blob([Uint8Array.from(atob(data), (character) => character.charCodeAt(0))], {
        type: mimeType,
      });
    },
    [api, conversationId],
  );
  if (!api || !conversationId || !enabled) return undefined;
  return {
    scope: JSON.stringify([owner, conversationId, workdir]),
    read,
    fileReaderOpen: options.fileReaderOpen,
    closeFileReader: options.closeFileReader,
    download: async (item, signal) => {
      const blob = await read(item.id, "original", signal);
      const extension =
        blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "image-" + item.id + "." + extension;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    submit: offline
      ? undefined
      : async (text, instruction, files, signal, keepPreview) => {
          const isCurrentAgent = api.captureActiveAgentScope();
          const uploadedFiles = files.length ? await importFiles(workdir, files, signal) : [];
          signal.throwIfAborted();
          if (!isCurrentAgent() || files.length !== uploadedFiles.length) return false;
          const busy = isRunning();
          const outcome = await send(text, {
            conversationId,
            workdir,
            uploadedFiles,
            isCurrentAgent,
            imageEditInstruction: instruction,
            preserveComposerOnStart: true,
            optimisticEcho: !busy,
            queuePolicy: busy ? "append" : "auto",
          });
          if (!isCurrentAgent() || !outcome || outcome.kind === "failed") return false;
          if (!keepPreview || busy || outcome.kind !== "accepted") return true;
          const { runId } = outcome.accepted;
          return {
            result: waitForImageResult(api, store, runId, signal, isCurrentAgent, zh),
            stop: async () => {
              if (!isCurrentAgent() || signal.aborted || store.getTurn(runId)?.phase === "settled")
                return false;
              const stopped = await api.cancelChat(conversationId, runId);
              return stopped && isCurrentAgent() && !signal.aborted;
            },
          };
        },
  };
}
