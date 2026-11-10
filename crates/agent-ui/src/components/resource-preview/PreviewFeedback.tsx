import { type CSSProperties, useContext, useId, useRef } from "react";
import { Circle } from "../IconSet";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewIdentityContext } from "./PreviewChrome";
import { type ResourcePreviewKind, resourcePreviewKind } from "./previewPolicy";
import "./preview-loading.css";

export type PreviewRecovery = { onDownload?: () => void; onRetry?: () => void };

const codeWidths = [55, 35, 70, 45, 60, 30, 50, 65, 40, 25];
const documentWidths = [93, 66, 84, 72, 89, 61, 96, 76, 69, 83];

function PreviewSkeleton({ kind }: { kind: "code" | "document" | "media" }) {
  const widths = kind === "code" ? codeWidths : documentWidths;
  return (
    <div className="za-preview-skeleton" data-skeleton-kind={kind} aria-hidden="true">
      {kind === "media" ? (
        <div className="za-preview-skeleton-bar" />
      ) : (
        widths.map((width, index) => (
          <div className="za-preview-skeleton-row" key={width}>
            <div
              className="za-preview-skeleton-bar"
              style={
                {
                  width: `${width}%`,
                  "--za-skeleton-delay": `${-120 * index}ms`,
                } as CSSProperties
              }
            />
          </div>
        ))
      )}
    </div>
  );
}

function FileLoadingGlyph({ kind }: { kind: ResourcePreviewKind }) {
  const id = useId();
  const glyph = `${id}-glyph`;
  const mask = `${id}-mask`;
  const highlight = `${id}-highlight`;
  const badge = kind === "docx" ? "W" : kind === "sheet" ? "X" : kind === "pptx" ? "P" : null;
  return (
    <svg className="za-preview-file-loading" viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <g
          id={glyph}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {kind === "pptx" ? (
            <>
              <circle cx="12.4" cy="12" r="9.5" />
              <path d="M12.4 2.5v7a2.5 2.5 0 0 0 2.5 2.5h7" />
            </>
          ) : kind === "docx" || kind === "sheet" ? (
            <>
              <rect x="5" y="3.4" width="14" height="17.2" rx="2.2" />
              <path
                d={
                  kind === "docx"
                    ? "M8.5 8h7M8.5 12h7M8.5 16h7"
                    : "M5 8h14M5 12h14M5 16h14M12 8v12.6"
                }
              />
            </>
          ) : kind === "pdf" ? (
            <>
              <path d="M4.5 13V5a1.7 1.7 0 0 1 1.7-1.7h8l5.3 5.2V13m-5.3-9.7v5.2h5.3" />
              <path d="M6 20v-5h1.5a1.25 1.25 0 0 1 0 2.5H6m5 2.5v-5h1a2.5 2.5 0 0 1 0 5h-1m6 0v-5h2.5M17 17.5h2" />
            </>
          ) : kind === "image" || kind === "svg" ? (
            <>
              <rect x="2.5" y="3.5" width="19" height="17" rx="3" />
              <circle cx="15" cy="9" r="2" />
              <path d="m2.5 15 3.6-3.7a1.7 1.7 0 0 1 2.4 0l8.8 9.2" />
            </>
          ) : (
            <path d="M6.5 3.5h7.7L19 8.4v10.4a1.7 1.7 0 0 1-1.7 1.7H6.5a1.7 1.7 0 0 1-1.7-1.7V5.2a1.7 1.7 0 0 1 1.7-1.7Zm7.7 0v4.9H19M8 12h8m-8 4h8" />
          )}
          {badge ? (
            <rect x="1" y="8.4" width="7.2" height="7.2" rx="1" fill="currentColor" stroke="none" />
          ) : null}
        </g>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <use href={`#${glyph}`} color="white" />
        </mask>
        <linearGradient
          id={highlight}
          className="za-preview-file-shimmer-highlight"
          x1="0%"
          y1="0%"
          x2="100%"
          y2="44%"
        >
          <stop offset="0%" stopColor="currentColor" stopOpacity="0" />
          <stop offset="43%" stopColor="currentColor" stopOpacity=".04" />
          <stop offset="52%" stopColor="currentColor" stopOpacity=".48" />
          <stop offset="58%" stopColor="currentColor" stopOpacity=".08" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <use href={`#${glyph}`} className="za-preview-file-loading-base" />
      <g mask={`url(#${mask})`}>
        <rect
          className="za-preview-file-shimmer"
          width="52.8"
          height="24"
          fill={`url(#${highlight})`}
        />
      </g>
      {badge ? (
        <text x="4.6" y="14.1" textAnchor="middle" className="za-preview-file-loading-badge">
          {badge}
        </text>
      ) : null}
    </svg>
  );
}

export function PreviewLoading({
  message = "正在准备预览…",
  onCancel,
  variant,
  skeleton,
}: {
  message?: string;
  onCancel?: () => void;
  variant?: "reader" | "thumbnail";
  skeleton?: "code" | "document" | "media";
}) {
  const identity = useContext(PreviewIdentityContext);
  const elapsed = useRef(
    performance.now() - (identity.loadingStartedAt ?? performance.now()),
  ).current;
  const thumbnail = variant ? variant === "thumbnail" : identity.thumbnail;
  const kind = resourcePreviewKind(identity);
  const loadingSkeleton = skeleton ?? identity.loadingSkeleton;
  return (
    <div
      className="za-preview-loading"
      data-loading-variant={thumbnail ? "thumbnail" : "reader"}
      data-loading-kind={thumbnail ? undefined : (loadingSkeleton ?? kind)}
      role="status"
      aria-live="polite"
      style={{ "--za-loading-elapsed": `${-elapsed}ms` } as CSSProperties}
    >
      {thumbnail ? (
        <span className="za-preview-cover-ring" aria-hidden="true">
          <Circle className="za-preview-cover-ring-track" />
          <Circle className="za-preview-cover-ring-arc" />
        </span>
      ) : loadingSkeleton ? (
        <PreviewSkeleton kind={loadingSkeleton} />
      ) : (
        <FileLoadingGlyph kind={kind} />
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
