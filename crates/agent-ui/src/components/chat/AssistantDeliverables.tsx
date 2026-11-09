import { useLocale } from "@liveagent/ui/i18n/index";
import type { AssistantDeliverable } from "@liveagent/ui/lib/chat/assistantResources";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useContext, useState } from "react";
import { ArrowUpRight, CircleHelp, Globe, SquarePen } from "../IconSet";
import { AssistantImageGallery, AssistantVisualContext } from "./AssistantVisuals";
import { getFileTypeIcon } from "./fileTypeIcons";

/** Confirmed outputs live beside the reply, outside collapsible tool activity. */
export function AssistantDeliverables({
  items,
  onOpenFileLink,
}: {
  items: readonly AssistantDeliverable[];
  onOpenFileLink?: (link: ChatFileLink) => void;
}) {
  const visualHost = useContext(AssistantVisualContext);
  const images = visualHost
    ? items
        .filter(
          (item) =>
            item.kind === "artifact" &&
            item.status === "saved" &&
            /^(image\/png|image\/jpeg)$/.test(item.mime ?? ""),
        )
        .slice(0, 8)
    : [];
  const files = images.length ? items.filter((item) => !images.includes(item)) : items;
  const { t } = useLocale();
  const [requestedPage, setPage] = useState(0);
  const pageSize = 8;
  const pages = Math.ceil(files.length / pageSize);
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const offset = page * pageSize;
  if (!items.length) return null;
  return (
    <section aria-label={t("chat.deliverables.title")} className="min-w-0 py-2">
      {images.length ? (
        <AssistantImageGallery
          items={images}
          onOpen={visualHost?.openImage ?? ((item) => onOpenFileLink?.(item.link))}
        />
      ) : null}
      {files.length ? (
        <ul className="grid list-none gap-2 p-0 [grid-template-columns:repeat(auto-fit,minmax(min(100%,17rem),1fr))]">
          {files.slice(offset, offset + pageSize).map((item) => {
            const draft = item.status === "draft";
            const Icon = draft
              ? SquarePen
              : item.kind === "site"
                ? Globe
                : getFileTypeIcon(item.name, "file");
            const confirmed = item.status === "saved";
            const kind = t(
              draft
                ? "chat.deliverables.extensionDraft"
                : item.kind === "site"
                  ? "chat.deliverables.site"
                  : "chat.deliverables.file",
            );
            return (
              <li key={`${item.kind}:${item.id}`} className="min-w-0">
                <button
                  type="button"
                  disabled={!onOpenFileLink}
                  aria-label={`${t("chat.deliverables.open")}: ${item.name}`}
                  onClick={() => onOpenFileLink?.(item.link)}
                  data-assistant-deliverable={item.kind}
                  data-deliverable-status={item.status}
                  className={cn(
                    "group/deliverable flex min-h-20 w-full items-center gap-3 rounded-2xl border border-border/65 bg-background px-3.5 py-3 text-left",
                    "transition-[background-color,border-color,box-shadow] duration-150 motion-reduce:transition-none",
                    "enabled:hover:border-foreground/15 enabled:hover:bg-muted/35 enabled:hover:shadow-sm",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default",
                  )}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-foreground/75">
                    <Icon aria-hidden="true" className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 break-words text-sm font-medium leading-5 text-foreground">
                      {item.name}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs leading-4 text-muted-foreground">
                      <span>{kind}</span>
                      {item.version !== undefined ? (
                        <span className="tabular-nums">v{item.version}</span>
                      ) : null}
                      <span className="inline-flex items-center gap-1">
                        {!confirmed && !draft ? (
                          <CircleHelp aria-hidden="true" className="size-3" />
                        ) : null}
                        {t(
                          draft
                            ? "chat.deliverables.reviewDraft"
                            : confirmed
                              ? "chat.deliverables.saved"
                              : "chat.tool.unknown",
                        )}
                      </span>
                    </span>
                  </span>
                  <ArrowUpRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground transition-colors group-hover/deliverable:text-foreground motion-reduce:transition-none"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {pages > 1 ? (
        <nav
          aria-label={t("chat.deliverables.pages")}
          className="mt-2 flex flex-wrap items-center justify-end gap-2 text-xs text-muted-foreground"
        >
          <span role="status" className="mr-auto tabular-nums">
            {offset + 1}–{Math.min(offset + pageSize, files.length)} / {files.length}
          </span>
          <button
            type="button"
            disabled={page === 0}
            className="min-h-11 rounded-lg px-2 transition-colors enabled:hover:bg-muted/40 enabled:hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setPage(page - 1)}
          >
            {t("chat.deliverables.previous")}
          </button>
          <button
            type="button"
            disabled={page === pages - 1}
            className="min-h-11 rounded-lg px-2 transition-colors enabled:hover:bg-muted/40 enabled:hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setPage(page + 1)}
          >
            {t("chat.deliverables.next")}
          </button>
        </nav>
      ) : null}
    </section>
  );
}
