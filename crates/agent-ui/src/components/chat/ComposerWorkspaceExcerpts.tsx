import { useLocale } from "../../i18n";
import type { WorkspaceExcerpt } from "../../lib/chat/workspaceExcerpt";
import { MessageSquareText, X } from "../IconSet";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../ui/popover";

export function ComposerWorkspaceExcerpts({
  excerpts,
  onRemove,
}: {
  excerpts: readonly WorkspaceExcerpt[];
  onRemove: (id?: string) => void;
}) {
  const { locale, t } = useLocale();
  const count = excerpts.length;
  const label = t(
    count === 1 ? "chat.composer.workspaceExcerpt" : "chat.composer.workspaceExcerpts",
  ).replace("{count}", String(count));
  const removeLabel = t("chat.composer.removeWorkspaceExcerpts");
  return (
    <div className="mb-1.5 flex max-w-full" data-composer-workspace-excerpts="">
      <div className="inline-flex max-w-full items-center rounded-full border border-border bg-background p-0.5">
        <Popover>
          <PopoverTrigger
            openOnHover
            delay={160}
            closeDelay={140}
            className="inline-flex min-h-6 min-w-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium hover:bg-accent focus-visible:outline-ring"
          >
            <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={6}
            className="max-h-[min(50vh,22rem)] w-[min(23rem,var(--available-width))] overflow-auto rounded-xl p-0"
          >
            <PopoverTitle className="sr-only">{label}</PopoverTitle>
            <ul className="divide-y divide-border/70">
              {excerpts.map(({ id, path, text, comment }) => (
                <li key={id} className="min-w-0 space-y-1.5 px-3 py-2.5">
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
                      {path}
                    </span>
                    {count > 1 && (
                      <button
                        type="button"
                        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full hover:bg-accent focus-visible:outline-ring"
                        aria-label={`${t("chat.composer.removeWorkspaceExcerpt")} ${path}`}
                        onClick={() => onRemove(id)}
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </div>
                  <blockquote className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {text}
                  </blockquote>
                  {comment && (
                    <p className="whitespace-pre-wrap border-s-2 border-border ps-2 [overflow-wrap:anywhere]">
                      <span className="sr-only">{locale === "zh-CN" ? "评论 " : "Comment "}</span>
                      {comment}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
        <button
          type="button"
          aria-label={removeLabel}
          className="me-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-background hover:opacity-75 focus-visible:outline-ring"
          onClick={() => onRemove()}
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  );
}
