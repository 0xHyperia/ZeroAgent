import { X } from "@liveagent/ui/components/IconSet";
import { Skeleton } from "@liveagent/ui/components/ui/skeleton";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { PendingUploadedFile } from "../../lib/chat/uploadedFiles";
import { ImagePreview, type ImagePreviewSlide } from "./ImagePreview";
import { ImagePreviewActionFeedback, ImagePreviewContextMenu } from "./ImagePreviewMenu";
import { getCompletedImageLoadState } from "./imageLoadState";
import "./composer-attachments.css";

export function ComposerAttachmentCard(props: {
  file?: PendingUploadedFile;
  workspaceRoot?: string;
  fileName: string;
  pathTitle: string;
  imageSrc?: string | null;
  isImageLoading?: boolean;
  fallbackIcon: ReactNode;
  disabled: boolean;
  removeLabel: string;
  previewLabel?: string;
  closePreviewLabel?: string;
  onRemove: () => void;
  onOpen?: () => void;
  previewContent?: ReactNode;
}) {
  const {
    file,
    workspaceRoot,
    fileName,
    pathTitle,
    imageSrc,
    isImageLoading = false,
    fallbackIcon,
    disabled,
    removeLabel,
    previewLabel,
    closePreviewLabel,
    onRemove,
    onOpen,
    previewContent,
  } = props;
  const format = fileName.split(".").pop()?.toUpperCase() || "文件";
  const fileSize = file?.sizeBytes
    ? file.sizeBytes >= 1024 * 1024
      ? `${(file.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(file.sizeBytes / 1024))} KB`
    : "";
  const [previewOpen, setPreviewOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [imageLoadState, setImageLoadState] = useState<{
    src: string | null;
    status: "loaded" | "error";
  } | null>(null);
  useEffect(() => {
    if (!imageSrc) return;
    const status = getCompletedImageLoadState(imageRef.current);
    if (status) setImageLoadState({ src: imageSrc, status });
  }, [imageSrc]);
  const previewSlides = useMemo<ImagePreviewSlide[]>(() => {
    if (!imageSrc) return [];
    const workdir = workspaceRoot?.trim() ?? "";
    const absolutePath = file?.absolutePath?.trim() ?? "";
    const relativePath = file?.relativePath.trim() ?? "";
    return [
      {
        src: imageSrc,
        alt: fileName,
        title: fileName,
        fileName,
        sizeBytes: file?.sizeBytes,
        ...(file && workdir && absolutePath && relativePath
          ? {
              attachment: {
                workdir,
                absolutePath,
                relativePath,
              },
            }
          : {}),
      },
    ];
  }, [file, fileName, imageSrc, workspaceRoot]);
  const previewSlide = previewSlides[0];
  const imageLoadFailed = Boolean(
    imageSrc && imageLoadState?.src === imageSrc && imageLoadState.status === "error",
  );
  const canPreview = Boolean(
    imageSrc && imageLoadState?.src === imageSrc && imageLoadState.status === "loaded",
  );

  // 图片附件：纯缩略图方块，点击放大预览，文件名放悬浮提示，角标删除。
  if (!previewContent && (imageSrc || isImageLoading)) {
    return (
      <div
        title={fileName}
        className={cn(
          "group za-composer-image-attachment relative size-24 shrink-0 overflow-hidden",
          "rounded-lg border border-black/[0.075] bg-black/[0.035] transition-[border-color]",
          "hover:border-black/[0.16] dark:border-white/[0.11] dark:bg-white/[0.065] dark:hover:border-white/[0.22]",
        )}
      >
        {imageSrc && !imageLoadFailed ? (
          <ImagePreviewContextMenu
            slide={previewSlide}
            disabled={!canPreview}
            onOpen={() => setPreviewOpen(true)}
            onActionError={setActionError}
            trigger={
              <button
                type="button"
                disabled={!canPreview}
                onClick={() => setPreviewOpen(true)}
                className={cn(
                  "block size-full outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60",
                  canPreview ? "cursor-zoom-in" : "cursor-default",
                )}
                aria-label={previewLabel ? `${previewLabel}: ${fileName}` : fileName}
                title={previewLabel}
              >
                <img
                  ref={imageRef}
                  src={imageSrc}
                  alt=""
                  draggable={false}
                  className="block size-full object-cover"
                  onLoad={() => setImageLoadState({ src: imageSrc, status: "loaded" })}
                  onError={() => {
                    setImageLoadState({ src: imageSrc, status: "error" });
                  }}
                />
              </button>
            }
          />
        ) : imageLoadFailed ? (
          <span className="flex size-full items-center justify-center text-muted-foreground">
            {fallbackIcon}
          </span>
        ) : (
          <Skeleton
            render={<span />}
            className="block size-full bg-black/[0.055] dark:bg-white/[0.09]"
          />
        )}
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          className="za-composer-attachment-remove"
          aria-label={`${removeLabel} ${fileName}`}
          title={removeLabel}
        >
          <X className="size-2.5" />
        </button>
        {previewOpen ? (
          <ImagePreview
            open={previewOpen}
            slides={previewSlides}
            closeLabel={closePreviewLabel}
            onClose={() => setPreviewOpen(false)}
          />
        ) : null}
        <ImagePreviewActionFeedback message={actionError} onDismiss={() => setActionError(null)} />
      </div>
    );
  }

  return (
    <div className="za-composer-attachment" data-cover={Boolean(previewContent)} title={pathTitle}>
      {previewContent ? <div className="za-composer-attachment-cover">{previewContent}</div> : null}
      <div className="za-composer-attachment-info">
        <span className="za-composer-attachment-icon">{fallbackIcon}</span>
        <div className="min-w-0 flex-1">
          <span className="za-composer-attachment-name">{fileName}</span>
          {!previewContent ? (
            <span className="za-composer-attachment-meta">
              {file?.statusText || [format, fileSize].filter(Boolean).join(" · ")}
            </span>
          ) : null}
        </div>
      </div>
      {onOpen ? (
        <button
          type="button"
          className="za-composer-attachment-open"
          disabled={disabled}
          onClick={onOpen}
          aria-label={`预览 ${fileName}`}
        />
      ) : null}
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="za-composer-attachment-remove"
        aria-label={`${removeLabel} ${fileName}`}
        title={removeLabel}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
