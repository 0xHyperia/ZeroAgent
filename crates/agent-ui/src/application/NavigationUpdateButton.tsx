import { Download, Loader2, RefreshCw } from "../components/IconSet";
import { TooltipButton } from "../components/ui/tooltip-button";

/** The host owns checking, downloads and restart confirmation. */
export function NavigationUpdateButton({
  label,
  busy = false,
  restart = false,
  error = false,
  onClick,
}: {
  label: string;
  busy?: boolean;
  restart?: boolean;
  error?: boolean;
  onClick: () => void;
}) {
  const Icon = busy ? Loader2 : restart ? RefreshCw : Download;
  return (
    <TooltipButton
      type="button"
      variant="ghost"
      size="icon"
      className="application-rail-update"
      data-update-state={busy ? "busy" : error ? "error" : restart ? "restart" : "available"}
      title={label}
      tooltipSide="right"
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={onClick}
    >
      <span className="application-update-glyph">
        <Icon className={busy ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"} />
      </span>
    </TooltipButton>
  );
}
