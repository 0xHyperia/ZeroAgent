import { type Ref, useLayoutEffect, useRef } from "react";
import { useLocale } from "../../i18n";
import { Button } from "../ui/button";

type Version = { id: string; number: number; created_at: string };
export type ResourceVersionHistory = {
  pending: boolean;
  hasMore: boolean;
  failure?: "first" | "older" | "changed";
  onRead: () => void;
};

/** Metadata-only history; selecting a point never changes the current head. */
export function ResourceVersionTimeline(props: {
  versions: readonly Version[];
  selected: string;
  selectedNumber?: number;
  busy: boolean;
  selectedRowRef?: Ref<HTMLButtonElement>;
  opening?: string;
  onSelect: (id: string) => void;
  history?: ResourceVersionHistory;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const copy = (chinese: string, english: string) => (zh ? chinese : english);
  const latestLabel = zh ? "最新" : "Latest";
  const originalLabel = zh ? "初始版本" : "Original";
  const openingVersion = props.versions.find((version) => version.id === props.opening);
  const { history } = props;
  const hasPageAction = Boolean(history?.hasMore || history?.failure);
  const failure = history?.failure;
  const failureText =
    failure &&
    {
      first: copy("暂时无法读取版本历史。", "Couldn't load version history."),
      older: copy("暂时无法加载更早的版本。", "Couldn't load older versions."),
      changed: copy("版本列表已变化，请重新读取。", "The history changed. Reload it to continue."),
    }[failure];
  const timeline = useRef<HTMLElement>(null);
  const returnFocus = useRef(false);
  useLayoutEffect(() => {
    if (hasPageAction || !returnFocus.current) return;
    returnFocus.current = false;
    if (document.activeElement === document.body) {
      const current = timeline.current?.querySelector<HTMLElement>('[aria-current="true"]');
      (current ?? timeline.current)?.focus({ preventScroll: true });
    }
  }, [hasPageAction]);
  const groups = new Map<string, Version[]>();
  const today = new Date().toLocaleDateString(locale);
  for (const version of props.versions) {
    const date = new Date(version.created_at).toLocaleDateString(locale);
    const group = groups.get(date);
    if (group) group.push(version);
    else groups.set(date, [version]);
  }
  return (
    <>
      <p role="status" className="sr-only">
        {openingVersion &&
          (zh ? `正在打开 v${openingVersion.number}…` : `Opening v${openingVersion.number}…`)}
      </p>
      <section
        ref={timeline}
        aria-label={zh ? "版本列表" : "Versions"}
        tabIndex={-1}
        className="za-reader-timeline"
        aria-busy={props.busy || history?.pending}
      >
        {props.selectedNumber &&
        !props.versions.some((version) => version.id === props.selected) ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {zh ? `正在查看 v${props.selectedNumber}` : `Viewing v${props.selectedNumber}`}
          </p>
        ) : null}
        {[...groups].map(([date, versions]) => (
          <section key={date} aria-label={date}>
            <h4>{date === today ? (zh ? "今天" : "Today") : date}</h4>
            <ol>
              {versions.map((version) => {
                const number = `v${version.number}`;
                const latest =
                  version.id === props.versions[0]?.id &&
                  version.number >= (props.selectedNumber ?? 1);
                const label = latest ? latestLabel : version.number === 1 ? originalLabel : "";
                const name = label ? `${number} · ${label}` : number;
                return (
                  <li key={version.id}>
                    <button
                      ref={version.id === props.selected ? props.selectedRowRef : undefined}
                      type="button"
                      className="za-reader-timeline-point"
                      data-version-id={version.id}
                      aria-label={zh ? `查看版本 ${name}` : `View version ${name}`}
                      aria-current={version.id === props.selected ? "true" : undefined}
                      aria-disabled={props.busy || undefined}
                      onClick={() => {
                        if (!props.busy) props.onSelect(version.id);
                      }}
                    >
                      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
                        {name}
                        {version.id === props.opening ? (
                          <span aria-hidden="true" className="text-xs text-muted-foreground">
                            {zh ? "正在打开…" : "Opening…"}
                          </span>
                        ) : null}
                      </span>
                      <time dateTime={version.created_at}>
                        {new Date(version.created_at).toLocaleTimeString(locale, {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </time>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </section>
      {history && (history.pending || hasPageAction || props.versions.length === 0) ? (
        <div className="space-y-2 px-2 py-3 text-xs text-muted-foreground">
          {history.pending ? (
            <p role="status">{zh ? "正在读取版本历史…" : "Loading version history…"}</p>
          ) : failureText ? (
            <p role="alert">{failureText}</p>
          ) : !props.versions.length ? (
            <p role="status">{zh ? "暂无可显示的版本记录。" : "No version records to display."}</p>
          ) : null}
          {hasPageAction ? (
            <Button
              size="sm"
              variant="ghost"
              className="min-h-11 sm:min-h-8"
              aria-disabled={props.busy || history.pending}
              onClick={(event) => {
                if (props.busy || history.pending) return;
                returnFocus.current = document.activeElement === event.currentTarget;
                history.onRead();
              }}
            >
              {failure === "older"
                ? copy("重试加载更早版本", "Retry older versions")
                : failure
                  ? copy("重新读取版本历史", "Retry version history")
                  : copy("加载更早版本", "Load older versions")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
