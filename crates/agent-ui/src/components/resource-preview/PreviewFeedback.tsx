import { type CSSProperties, useContext, useRef } from "react";
import { Circle, File } from "../IconSet";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewIdentityContext } from "./PreviewChrome";
import { getResourceFileIcon } from "./ResourceFileIcon";
import "./preview-loading.css";

export type PreviewRecovery = { onDownload?: () => void; onRetry?: () => void };

export function PreviewLoading({
  message = "正在准备预览…",
  onCancel,
  variant,
}: {
  message?: string;
  onCancel?: () => void;
  variant?: "reader" | "thumbnail";
}) {
  const identity = useContext(PreviewIdentityContext);
  const elapsed = useRef(
    performance.now() - (identity.loadingStartedAt ?? performance.now()),
  ).current;
  const thumbnail = variant ? variant === "thumbnail" : identity.thumbnail;
  const Icon = /\.(md|mdx|txt|log|json|ya?ml)$/i.test(identity.name)
    ? File
    : getResourceFileIcon(identity.name);
  return (
    <div
      className="za-preview-loading"
      data-loading-variant={thumbnail ? "thumbnail" : "reader"}
      role="status"
      aria-live="polite"
      style={{ "--za-loading-elapsed": `${-elapsed}ms` } as CSSProperties}
    >
      {thumbnail ? (
        <span className="za-preview-cover-ring" aria-hidden="true">
          <Circle className="za-preview-cover-ring-track" />
          <Circle className="za-preview-cover-ring-arc" />
        </span>
      ) : (
        <span className="za-preview-file-loading" aria-hidden="true">
          <Icon />
        </span>
      )}
      <p className="sr-only">{message}</p>
      {onCancel ? (
        <Button className="za-preview-loading-cancel" variant="ghost" size="sm" onClick={onCancel}>
          取消读取
        </Button>
      ) : null}
    </div>
  );
}

export function PreviewUnavailable({
  message,
  onDownload,
  onRetry,
}: PreviewRecovery & { message: string }) {
  return (
    <div className="za-preview-unavailable" role="status">
      <p>{message}</p>
      {onDownload || onRetry ? (
        <div className="za-preview-actions">
          {onRetry ? (
            <Button variant="ghost" size="sm" onClick={onRetry}>
              重试预览
            </Button>
          ) : null}
          {onDownload ? (
            <Button variant="outline" size="sm" onClick={onDownload}>
              下载原件
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
