import { TooltipButton as Button } from "../ui/tooltip-button";

export type PreviewRecovery = { onDownload?: () => void; onRetry?: () => void };

export function PreviewLoading({
  message = "正在准备预览…",
  onCancel,
}: {
  message?: string;
  onCancel?: () => void;
}) {
  return (
    <div className="za-preview-loading" role="status" aria-live="polite">
      <span className="za-preview-loading-mark" aria-hidden="true" />
      <p>{message}</p>
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
