import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useLocale } from "../../i18n";
import type { AssistantDeliverable } from "../../lib/chat/assistantResources";
import { cn } from "../../lib/shared/utils";
import { ArrowUpRight, ImageIcon, RotateCcw, Settings2, SquarePen } from "../IconSet";
import {
  type ConversationImageSources,
  useConversationImageSource,
} from "../resource-preview/conversationImageSources";
import { LabelTooltip } from "../ui/label-tooltip";
import { TooltipButton as Button } from "../ui/tooltip-button";
import "./assistant-visuals.css";

/** Host adapters own authentication and bytes; the shared surface owns interaction. */
export const AssistantVisualContext = createContext<{
  sources: ConversationImageSources;
  editImage?: (item: AssistantDeliverable, trigger?: HTMLElement) => void;
  openImage?: (item: AssistantDeliverable, trigger?: HTMLElement) => void;
  registerImages?: (items: readonly AssistantDeliverable[]) => void;
  configureImage?: () => void;
  checkImage?: (jobId: string) => Promise<{ status: string; assetIds: string[] }>;
  activity: (messageId: string) => ReactNode;
} | null>(null);

export function AssistantVisualActivity({ messageId }: { messageId: string }) {
  return useContext(AssistantVisualContext)?.activity(messageId) ?? null;
}

export function VisualCreationSettingsNotice({
  message,
  description,
  onConfigure,
}: {
  message: string;
  description: string;
  onConfigure?: () => void;
}) {
  const { locale } = useLocale();
  return (
    <div className="my-3 flex max-w-lg flex-wrap items-center justify-between gap-3 rounded-2xl bg-muted/50 px-4 py-3">
      <div role="status" className="text-sm">
        <p className="font-medium">{message}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      {onConfigure && (
        <Button
          variant="outline"
          size="sm"
          className="rounded-full bg-background"
          onClick={onConfigure}
        >
          <Settings2 className="size-3.5" />
          {locale === "zh-CN" ? "生图设置" : "Image settings"}
        </Button>
      )}
    </div>
  );
}

export function VisualCreationPending({
  label,
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  const { locale } = useLocale();
  const status = label ?? (locale === "zh-CN" ? "正在创作图像" : "Creating image");
  return (
    <div
      className={cn("za-visual-pending", compact && "is-compact")}
      role="status"
      aria-label={status}
    >
      <div className="za-visual-dots" aria-hidden="true" />
      <div className="za-visual-pending-label">
        <ImageIcon className="size-4" />
        <span>{status}</span>
        <span className="za-visual-ellipsis" aria-hidden="true">
          ···
        </span>
      </div>
    </div>
  );
}

function VisualImage({
  item,
  active,
  onOpen,
}: {
  item: AssistantDeliverable;
  active: boolean;
  onOpen: (trigger: HTMLElement) => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const openLabel = zh ? "打开图片" : "Open image";
  const host = useContext(AssistantVisualContext)!;
  const { source, failed, retry } = useConversationImageSource(host.sources, item.id, "original");
  const [decodeError, setDecodeError] = useState(false);
  const [hasAlpha, setHasAlpha] = useState(false);
  return (
    <div className="za-visual-image" data-image-preview-origin={item.id} hidden={!active}>
      {source && !decodeError ? (
        <>
          <button
            className="za-visual-open"
            data-image-alpha={hasAlpha || undefined}
            type="button"
            onClick={(event) => onOpen(event.currentTarget)}
            aria-label={zh ? `查看图片：${item.name}` : `View image: ${item.name}`}
          >
            <img
              src={source.url}
              alt={item.name}
              onLoad={(event) => setHasAlpha(hasVisibleImageAlpha(event.currentTarget))}
              onError={() => setDecodeError(true)}
            />
          </button>
          <div className="za-visual-image-actions">
            {host.editImage && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(event) => host.editImage?.(item, event.currentTarget)}
                title={zh ? "使用这张图片继续创作" : "Create from this image"}
              >
                <SquarePen className="size-3.5" />
                {zh ? "修改" : "Edit"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={(event) => onOpen(event.currentTarget)}
              title={openLabel}
              aria-label={openLabel}
            >
              <ArrowUpRight className="size-3.5" />
              {zh ? "画布" : "Canvas"}
            </Button>
          </div>
        </>
      ) : failed || decodeError ? (
        <div className="za-visual-unavailable">
          <ImageIcon className="size-7 text-muted-foreground" />
          <span>{zh ? "图片暂未载入" : "The image could not be loaded"}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDecodeError(false);
              retry();
            }}
          >
            <RotateCcw className="size-3.5" />
            {zh ? "重新读取" : "Retry"}
          </Button>
        </div>
      ) : (
        <VisualCreationPending label={zh ? "正在载入图片" : "Loading image"} />
      )}
    </div>
  );
}

/** Look at decoded pixels so an opaque PNG never gets a transparency treatment. */
function hasVisibleImageAlpha(image: HTMLImageElement) {
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!width || !height) return false;
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 160 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    return data.some((channel, index) => index % 4 === 3 && channel < 255);
  } catch {
    return false;
  }
}

export function AssistantImageGallery({
  items,
  onOpen,
}: {
  items: readonly AssistantDeliverable[];
  onOpen: (item: AssistantDeliverable, trigger?: HTMLElement) => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const registerImages = useContext(AssistantVisualContext)?.registerImages;
  useEffect(() => registerImages?.(items), [registerImages, items]);
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, items.length - 1);
  return (
    <section
      className="za-visual-gallery"
      aria-label={zh ? "生成的图片" : "Generated images"}
      data-multiple={items.length > 1 || undefined}
    >
      <div className="za-visual-main">
        {items[index] ? (
          <VisualImage
            key={items[index].id}
            item={items[index]}
            active
            onOpen={(trigger) => onOpen(items[index], trigger)}
          />
        ) : null}
      </div>
      {items.length > 1 ? (
        <div
          className="za-visual-thumbnails"
          role="group"
          aria-label={zh ? "切换设计方案" : "Choose a variation"}
        >
          {items.map((item, i) => (
            <VisualThumbnail
              key={item.id}
              item={item}
              selected={i === index}
              onSelect={() => setSelected(i)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function VisualThumbnail({
  item,
  selected,
  onSelect,
}: {
  item: AssistantDeliverable;
  selected: boolean;
  onSelect: () => void;
}) {
  const host = useContext(AssistantVisualContext)!;
  const { source } = useConversationImageSource(host.sources, item.id, host.sources.thumbnail);
  return (
    <LabelTooltip
      label={item.name}
      side="right"
      render={
        <button
          type="button"
          aria-label={item.name}
          aria-pressed={selected}
          onClick={onSelect}
          className={cn("za-visual-thumbnail", selected && "is-selected")}
        >
          {source ? <img src={source.url} alt="" /> : <ImageIcon className="size-5" />}
        </button>
      }
    />
  );
}
