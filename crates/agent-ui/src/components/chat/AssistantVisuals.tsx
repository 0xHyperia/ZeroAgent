import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { AssistantDeliverable } from "../../lib/chat/assistantResources";
import { ArrowUpRight, ImageIcon, RotateCcw, SquarePen } from "../IconSet";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { LabelTooltip } from "../ui/label-tooltip";
import { cn } from "../../lib/shared/utils";
import "./assistant-visuals.css";

/** Host adapters own authentication and bytes; the shared surface owns interaction. */
export const AssistantVisualContext = createContext<{
  loadImage: (id: string, signal: AbortSignal) => Promise<Blob>;
  editImage: (item: AssistantDeliverable) => void;
  activity: (messageId: string) => ReactNode;
} | null>(null);

export function AssistantVisualActivity({ messageId }: { messageId: string }) {
  return useContext(AssistantVisualContext)?.activity(messageId) ?? null;
}

export function VisualCreationPending({
  label = "正在创作图像",
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn("za-visual-pending", compact && "is-compact")}
      role="status"
      aria-label={label}
    >
      <div className="za-visual-dots" aria-hidden="true" />
      <div className="za-visual-pending-label">
        <ImageIcon className="size-4" />
        <span>{label}</span>
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
  onOpen: () => void;
}) {
  const host = useContext(AssistantVisualContext)!;
  const [state, setState] = useState<{ id: string; url?: string; error?: boolean }>({
    id: item.id,
  });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    setState({ id: item.id });
    void host
      .loadImage(item.id, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setState({ id: item.id, url });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ id: item.id, error: true });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [host.loadImage, item.id, retry]);
  const current = state.id === item.id ? state : { id: item.id };
  return (
    <div className="za-visual-image" hidden={!active}>
      {current.url ? (
        <>
          <button
            className="za-visual-open"
            type="button"
            onClick={onOpen}
            aria-label={`查看图片：${item.name}`}
          >
            <img
              src={current.url}
              alt={item.name}
              onError={() => setState({ id: item.id, error: true })}
            />
          </button>
          <div className="za-visual-image-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => host.editImage(item)}
              title="使用这张图片继续创作"
            >
              <SquarePen className="size-3.5" />
              修改
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onOpen}
              title="打开图片"
              aria-label="打开图片"
            >
              <ArrowUpRight className="size-4" />
            </Button>
          </div>
        </>
      ) : current.error ? (
        <div className="za-visual-unavailable">
          <ImageIcon className="size-7 text-muted-foreground" />
          <span>图片暂未载入</span>
          <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>
            <RotateCcw className="size-3.5" />
            重新读取
          </Button>
        </div>
      ) : (
        <VisualCreationPending label="正在载入图片" />
      )}
    </div>
  );
}

export function AssistantImageGallery({
  items,
  onOpen,
}: {
  items: readonly AssistantDeliverable[];
  onOpen: (item: AssistantDeliverable) => void;
}) {
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, items.length - 1);
  return (
    <section
      className="za-visual-gallery"
      aria-label="生成的图片"
      data-multiple={items.length > 1 || undefined}
    >
      <div className="za-visual-main">
        {items[index] ? (
          <VisualImage
            key={items[index].id}
            item={items[index]}
            active
            onOpen={() => onOpen(items[index])}
          />
        ) : null}
      </div>
      {items.length > 1 ? (
        <div className="za-visual-thumbnails" role="group" aria-label="切换设计方案">
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
  const [url, setUrl] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let objectURL = "";
    void host
      .loadImage(item.id, controller.signal)
      .then((blob) => {
        if (!controller.signal.aborted) {
          objectURL = URL.createObjectURL(blob);
          setUrl(objectURL);
        }
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [host.loadImage, item.id]);
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
          {url ? <img src={url} alt="" /> : <ImageIcon className="size-5" />}
        </button>
      }
    />
  );
}
