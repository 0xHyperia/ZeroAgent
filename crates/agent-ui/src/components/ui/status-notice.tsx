import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  LoaderCircle,
  X,
} from "@liveagent/ui/components/IconSet";
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import type { ComponentProps, ReactNode } from "react";
import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";

export type NoticeTone = "info" | "success" | "warning" | "error";

/** A surface only. The host retains the notice's content, urgency and lifetime. */
export function NoticeSurface({
  tone = "info",
  density,
  className,
  ...props
}: ComponentProps<"div"> & {
  tone?: NoticeTone;
  density?: "compact";
}) {
  return (
    <div
      {...props}
      data-tone={tone}
      data-density={density}
      className={cn("app-notice", className)}
    />
  );
}

export type StatusNoticeProps = Omit<ComponentProps<"div">, "children"> & {
  message: string;
  description?: ReactNode;
  actions?: ReactNode;
  stackActions?: boolean;
  tone?: NoticeTone;
  compact?: boolean;
  busy?: boolean;
  onDismiss?: () => void;
  dismissLabel?: string;
};

/** Presentation only: no timers, retries, storage, account or execution state. */
export function StatusNotice({
  message,
  description,
  actions,
  stackActions = false,
  tone = "info",
  compact = false,
  busy = false,
  onDismiss,
  dismissLabel,
  className,
  role,
  ...props
}: StatusNoticeProps) {
  const { t } = useLocale();
  const label = dismissLabel ?? t("common.dismissNotification");
  const Icon = busy
    ? LoaderCircle
    : tone === "error"
      ? AlertCircle
      : tone === "warning"
        ? AlertTriangle
        : tone === "success"
          ? CheckCircle2
          : Info;
  return (
    <NoticeSurface
      {...props}
      tone={tone}
      density={compact ? "compact" : undefined}
      data-stack-actions={stackActions ? "" : undefined}
      role={role ?? (tone === "error" ? "alert" : "status")}
      aria-atomic="true"
      className={cn("app-status-notice", className)}
    >
      <Icon className={cn("app-status-icon", busy && "app-status-busy")} aria-hidden="true" />
      <div className="app-status-body">
        <p className="app-status-message">{message}</p>
        {description ? <div className="app-status-description">{description}</div> : null}
        {actions ? <div className="app-status-actions">{actions}</div> : null}
      </div>
      {onDismiss ? (
        <TooltipButton
          type="button"
          variant="ghost"
          size="icon-sm"
          title={label}
          aria-label={label}
          className="app-status-dismiss"
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </TooltipButton>
      ) : null}
    </NoticeSurface>
  );
}
