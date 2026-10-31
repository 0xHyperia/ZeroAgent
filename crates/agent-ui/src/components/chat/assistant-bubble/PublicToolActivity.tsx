import { formatElapsedTime } from "@liveagent/ui/components/chat/AssistantWorkTrace";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ToolTraceItem } from "@liveagent/ui/lib/chat/assistantBubbleAdapter";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { ArrowUpRight, CircleHelp, FileText, Globe, Loader2, Wrench } from "../../IconSet";

/** A host's public receipt is a status, never a native tool result or approval. */
export function PublicToolActivity({
  item,
  isRunning,
  onOpenFileLink,
}: {
  item: ToolTraceItem;
  isRunning?: boolean;
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const { t } = useLocale();
  const activity = item.publicStatus;
  if (!activity) return null;
  const active = isRunning && ["prepared", "executing"].includes(activity.state);
  const stateKey = active
    ? activity.state === "prepared"
      ? "waiting"
      : "running"
    : activity.state === "succeeded"
      ? "success"
      : activity.state === "failed"
        ? "failed"
        : activity.state === "cancelled"
          ? "cancelled"
          : "unknown";
  const Icon = active
    ? Loader2
    : activity.state === "unknown"
      ? CircleHelp
      : ["web_search", "fetch_page", "read_source", "publish_site"].includes(item.toolCall.name)
        ? Globe
        : ["read_file", "write_file", "load_uploaded_file", "publish_artifact"].includes(
              item.toolCall.name,
            )
          ? FileText
          : Wrench;
  return (
    <div data-public-tool-activity={activity.state} className="min-w-0">
      <div className="flex min-h-8 min-w-0 items-center gap-2 py-1 text-sm text-foreground/65">
        <Icon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-foreground/45",
            active && "animate-spin motion-reduce:animate-none",
          )}
        />
        <span className={cn("min-w-0 flex-1 break-words", active && "shimmer")}>
          {activity.label}
        </span>
        <span
          className={cn(
            "shrink-0 text-xs",
            activity.state === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {t(`chat.tool.${stateKey}`)}
        </span>
        {activity.durationMs !== undefined ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatElapsedTime(activity.durationMs)}
          </span>
        ) : null}
      </div>
      {activity.resources?.some((resource) => resource.role !== "output") ? (
        <ul
          aria-label={t("chat.tool.resources")}
          className="mb-1 ml-5 flex min-w-0 list-none flex-wrap gap-1 p-0"
        >
          {activity.resources
            .filter((resource) => resource.role !== "output")
            .map((resource) => (
              <li key={`${resource.kind}:${resource.id}`} className="min-w-0 max-w-full">
                <button
                  type="button"
                  disabled={!onOpenFileLink}
                  aria-label={`${t("chat.tool.openResource")}: ${resource.name}`}
                  onClick={() => onOpenFileLink?.(resource.link)}
                  className="flex min-h-9 max-w-full items-center gap-1.5 rounded-lg border border-border/50 bg-background/60 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors enabled:hover:bg-muted/50 enabled:hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11"
                >
                  {resource.kind === "source" || resource.kind === "site" ? (
                    <Globe aria-hidden="true" className="size-3 shrink-0" />
                  ) : (
                    <FileText aria-hidden="true" className="size-3 shrink-0" />
                  )}
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {resource.name}
                  </span>
                  <ArrowUpRight aria-hidden="true" className="size-3 shrink-0" />
                </button>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
