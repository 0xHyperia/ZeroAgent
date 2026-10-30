import type { ComponentProps } from "react";
import { cn } from "../../lib/shared/utils";
import { NoticeSurface } from "../ui/status-notice";

const variants = {
  "action-error": "flex items-center gap-2 text-xs",
  "compact-error": "flex items-center gap-2",
  "multiline-error": "whitespace-pre-wrap text-xs",
  validation: "flex items-start gap-2 text-xs",
  warning: "text-xs leading-relaxed",
  "installation-warning": "text-sm",
  "inline-error": "flex items-center gap-1.5 text-xs text-destructive",
} as const;

/** Presentation only; callers retain content, semantics and state. */
export function SettingsNotice({
  variant,
  className,
  ...props
}: ComponentProps<"div"> & { variant: keyof typeof variants }) {
  return (
    <NoticeSurface
      {...props}
      tone={variant.includes("warning") ? "warning" : "error"}
      density={variant === "inline-error" ? "compact" : undefined}
      className={cn(variants[variant], className)}
    />
  );
}
