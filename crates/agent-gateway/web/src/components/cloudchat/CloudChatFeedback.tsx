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

/** Presentation only: callers own recovery actions and whether a notice may close. */
export function CloudChatFeedback({
  message,
  description,
  actions,
  tone = "info",
  compact = false,
  busy = false,
  onDismiss,
  className = "",
  role,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  message: string;
  description?: ReactNode;
  actions?: ReactNode;
  tone?: "info" | "success" | "warning" | "error";
  compact?: boolean;
  busy?: boolean;
  onDismiss?: () => void;
}) {
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
    <div
      {...props}
      role={role ?? (tone === "error" ? "alert" : "status")}
      aria-atomic="true"
      data-cloud-feedback={tone}
      data-compact={compact || undefined}
      className={`cloud-feedback ${className}`}
    >
      <Icon
        className={`cloud-feedback-icon${busy ? " cloud-feedback-busy" : ""}`}
        aria-hidden="true"
      />
      <div className="cloud-feedback-body">
        <p className="cloud-feedback-message">{message}</p>
        {description ? <div className="cloud-feedback-description">{description}</div> : null}
        {actions ? <div className="cloud-feedback-actions">{actions}</div> : null}
      </div>
      {onDismiss ? (
        <TooltipButton
          type="button"
          variant="ghost"
          size="icon-sm"
          title="关闭提示"
          aria-label="关闭提示"
          className="cloud-feedback-dismiss"
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </TooltipButton>
      ) : null}
    </div>
  );
}
