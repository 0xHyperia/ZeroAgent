import { type ContextType, type ReactNode, useCallback, useContext, useEffect } from "react";
import type { AssistantDeliverable } from "../../lib/chat/assistantResources";
import { AssistantVisualContext } from "../chat/AssistantVisuals";
import type { ImageJob } from "../../lib/imaging/types";
import { ConversationImagePreview, useConversationImagePreview } from "./ConversationImagePreview";
import { ConversationReaderWorkbench } from "./ConversationReaderWorkbench";
import type { ConversationImageEditReceipt } from "./conversationImageAnnotation";
import { useConversationImageSources } from "./conversationImageSources";

export type DeviceConversationImageHost = {
  scope: string;
  read(id: string, variant: "original" | "thumbnail", signal: AbortSignal): Promise<Blob>;
  download(item: AssistantDeliverable, signal: AbortSignal): Promise<void>;
  configure?: () => void;
  check?: (jobId: string) => Promise<Pick<ImageJob, "status" | "assetIds">>;
  fileReaderOpen?: boolean;
  closeFileReader?: () => void;
  submit?: (
    text: string,
    instruction: string,
    files: File[],
    signal: AbortSignal,
    keepPreview?: boolean,
  ) => Promise<boolean | ConversationImageEditReceipt>;
};

export function DeviceConversationImageSurface(props: {
  host?: DeviceConversationImageHost;
  includeAttachments: boolean;
  children: ReactNode;
}) {
  const { host, includeAttachments, children } = props;
  const scope = host?.scope ?? "";
  const read = host?.read;
  const load = useCallback(
    (id: string, variant: "original" | "thumbnail", signal: AbortSignal) =>
      read?.(id, variant, signal) ?? Promise.reject(new Error("Image unavailable")),
    [read],
  );
  const sources = useConversationImageSources(scope, load, "thumbnail");
  const preview = useConversationImagePreview(scope);
  const inherited = useContext(AssistantVisualContext);
  const { close } = preview;
  useEffect(() => {
    if (host?.fileReaderOpen) close();
  }, [host?.fileReaderOpen, close]);

  const open = (item: AssistantDeliverable, edit: boolean, trigger?: HTMLElement) => {
    host?.closeFileReader?.();
    preview.open(item, edit, trigger);
  };
  const visuals: ContextType<typeof AssistantVisualContext> = host
    ? {
        sources,
        openImage: (item, trigger) => open(item, false, trigger),
        editImage: host.submit ? (item, trigger) => open(item, true, trigger) : undefined,
        registerImages: preview.register,
        configureImage: host.configure,
        checkImage: host.check,
        activity: () => null,
      }
    : inherited;
  const submit = host?.submit;
  return (
    <ConversationReaderWorkbench
      open={preview.panel === true}
      primaryVisible
      readingScope={scope}
      primary={
        <AssistantVisualContext.Provider value={visuals}>
          {children}
        </AssistantVisualContext.Provider>
      }
    >
      {host && preview.item && (
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
          onDownload={host.download}
          onEdit={
            submit
              ? async (item, edit, signal) => {
                  const files: File[] = [];
                  if (includeAttachments) {
                    const blob = await sources.read(item.id, signal);
                    signal.throwIfAborted();
                    const extension =
                      blob.type === "image/jpeg"
                        ? "jpg"
                        : blob.type === "image/webp"
                          ? "webp"
                          : "png";
                    files.push(
                      new File([blob], "image-" + item.id + "." + extension, { type: blob.type }),
                    );
                    if (edit.region) files.push(edit.region.file);
                  }
                  signal.throwIfAborted();
                  const instruction =
                    edit.instruction +
                    "\nUse edit_image with the original asset " +
                    item.id +
                    " if offered, or the original image in attachment:1." +
                    (edit.region ? " A separate selection attachment is only a locator." : "");
                  return submit(edit.text, instruction, files, signal, edit.keepPreview);
                }
              : undefined
          }
        />
      )}
    </ConversationReaderWorkbench>
  );
}
