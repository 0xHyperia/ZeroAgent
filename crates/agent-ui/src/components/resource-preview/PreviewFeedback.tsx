import { useContext } from "react";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewIdentityContext } from "./PreviewChrome";
import { getResourceFileIcon } from "./ResourceFileIcon";

export type PreviewRecovery = { onDownload?: () => void; onRetry?: () => void };

export function PreviewLoading({
  message = "正在准备预览…",
  onCancel,
}: {
  message?: string;
  onCancel?: () => void;
}) {
  const { name } = useContext(PreviewIdentityContext);
  const Icon = getResourceFileIcon(name);
  return (
    <div className="za-preview-loading" role="status" aria-live="polite">
      <span className="za-preview-file-loading" aria-hidden="true">
        <Icon />
      </span>
      <p className="sr-only">{message}</p>
      {onCancel ? (
        <Button variant="ghost" size="sm" onClick={onCancel}>
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
