import {
  Clock3,
  Loader2,
  MessageSquareText,
  Pin,
  Search,
  X,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandDialogDescription,
  CommandDialogPopup,
  CommandDialogTitle,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "@liveagent/ui/components/ui/command";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type PersistedConversationSearchResult,
  searchPersistedConversations,
} from "@liveagent/ui/lib/chat/conversationSearch";
import { setSearchJumpTarget } from "@liveagent/ui/lib/chat/searchJumpTarget";
import { cachedDateTimeFormat } from "@liveagent/ui/lib/shared/intlFormatters";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  Fragment,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConversationOpenOptions } from "../../lib/sidebar/openController";
import type { SidebarConversation } from "../../lib/sidebar/types";

export type ConversationSearchResult = PersistedConversationSearchResult & {
  matchType?: "title" | "message";
  archived?: boolean;
};
export type ConversationSearchPage = {
  items: ConversationSearchResult[];
  nextCursor?: string;
  hasMore?: boolean;
};
/** A host owns its data source and navigation. Cloud search never calls device RPC. */
export type ConversationSearchAdapter = {
  search: (
    query: string,
    options: { cursor?: string; signal: AbortSignal },
  ) => Promise<ConversationSearchPage>;
  onSelectResult: (item: ConversationSearchResult) => void;
};

type ConversationSearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: readonly SidebarConversation[];
  currentWorkdir?: string;
  onSelectConversation: (id: string, options?: ConversationOpenOptions) => void;
  searchAdapter?: ConversationSearchAdapter;
  returnFocus?: RefObject<HTMLElement | null>;
};

type SearchStatus = "idle" | "loading" | "ready" | "error";

type SearchGroup = {
  id: "pinned" | "recent" | "results";
  label: string;
  icon: typeof Pin;
  items: readonly ConversationSearchResult[];
};

const SEARCH_DEBOUNCE_MS = 180;
const EMPTY_STATE_RECENT_LIMIT = 12;
const resultKey = (item: ConversationSearchResult) => `${item.id}:${item.messageId ?? "title"}`;

function toSearchResult(item: SidebarConversation): PersistedConversationSearchResult {
  return {
    id: item.id,
    title: item.title,
    cwd: item.cwd,
    updatedAt: item.updatedAt,
  };
}

function formatChineseUpdatedAt(date: Date, locale: string) {
  const parts = cachedDateTimeFormat(locale, "search-updated-at-zh", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: "month" | "day" | "hour" | "minute") =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("month")}月${read("day")}日 ${read("hour")}:${read("minute")}`;
}

function formatUpdatedAt(value: number | undefined, locale: string) {
  if (!value || !Number.isFinite(value)) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (locale.toLowerCase().startsWith("zh")) {
    return formatChineseUpdatedAt(date, locale);
  }
  return cachedDateTimeFormat(locale, "search-updated-at", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function renderSearchPreview(value: string | undefined, plainQuery?: string): ReactNode {
  if (!value) return null;
  if (plainQuery) {
    const offset = value.toLocaleLowerCase().indexOf(plainQuery.toLocaleLowerCase());
    if (offset < 0) return value;
    return (
      <>
        {value.slice(0, offset)}
        <mark className="rounded-sm bg-primary/10 px-0.5 text-foreground">
          {value.slice(offset, offset + plainQuery.length)}
        </mark>
        {value.slice(offset + plainQuery.length)}
      </>
    );
  }
  const parts = value.split(/(\[[^\]]+\])/g).filter(Boolean);
  return parts.map((part, index) => {
    const highlighted = part.startsWith("[") && part.endsWith("]");
    return highlighted ? (
      <mark
        // The snippet comes from SQLite FTS and has no stable text identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: duplicate text fragments are valid.
        key={index}
        className="rounded-sm bg-primary/10 px-0.5 text-foreground"
      >
        {part.slice(1, -1)}
      </mark>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: duplicate text fragments are valid.
      <Fragment key={index}>{part}</Fragment>
    );
  });
}

export function ConversationSearchDialog({
  open,
  onOpenChange,
  conversations,
  currentWorkdir,
  onSelectConversation,
  searchAdapter,
  returnFocus,
}: ConversationSearchDialogProps) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConversationSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [moreStatus, setMoreStatus] = useState<SearchStatus>("idle");
  const controllerRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const paginationFocus = useRef<HTMLButtonElement | null>(null);
  const resultSelected = useRef(false);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const requestSequenceRef = useRef(0);
  const normalizedQuery = query.trim();

  const performSearch = useCallback(
    async (searchQuery: string, cursor?: string) => {
      const requestSequence = ++requestSequenceRef.current;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      if (cursor) setMoreStatus("loading");
      else {
        setResults([]);
        setNextCursor(undefined);
        setStatus("loading");
      }
      try {
        const page: ConversationSearchPage = searchAdapter
          ? await searchAdapter.search(searchQuery, { cursor, signal: controller.signal })
          : { items: await searchPersistedConversations({ query: searchQuery, currentWorkdir }) };
        if (requestSequence !== requestSequenceRef.current || controller.signal.aborted) return;
        setResults((current) =>
          cursor
            ? [
                ...new Map(
                  [...current, ...page.items].map((item) => [resultKey(item), item]),
                ).values(),
              ]
            : page.items,
        );
        const next = page.hasMore ? page.nextCursor : undefined;
        if (cursor && !next) {
          const origin = paginationFocus.current;
          if (origin?.ownerDocument.activeElement === origin)
            inputRef.current?.focus({ preventScroll: true });
          paginationFocus.current = null;
        }
        setNextCursor(next);
        setStatus("ready");
        setMoreStatus("ready");
      } catch {
        if (requestSequence !== requestSequenceRef.current || controller.signal.aborted) return;
        if (cursor) setMoreStatus("error");
        else {
          setResults([]);
          setStatus("error");
        }
      }
    },
    [currentWorkdir, searchAdapter],
  );

  useEffect(() => () => controllerRef.current?.abort(), []);

  useEffect(() => {
    if (open) {
      resultSelected.current = false;
      return;
    }
    paginationFocus.current = null;
    requestSequenceRef.current += 1;
    controllerRef.current?.abort();
    setQuery("");
    setResults([]);
    setStatus("idle");
  }, [open]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    controllerRef.current?.abort();
    setNextCursor(undefined);
    setMoreStatus("idle");
    if (!open || !normalizedQuery) {
      setResults([]);
      setStatus("idle");
      return;
    }

    setResults([]);
    setStatus("loading");
    const timer = window.setTimeout(() => {
      void performSearch(normalizedQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery, open, performSearch]);

  const groups = useMemo<SearchGroup[]>(() => {
    if (normalizedQuery) {
      return [
        {
          id: "results",
          label: t("chat.conversationSearchResults"),
          icon: Search,
          items: results,
        },
      ];
    }

    const pinned = conversations.filter((item) => item.isPinned).map(toSearchResult);
    const recent = conversations
      .filter((item) => !item.isPinned)
      .slice(0, EMPTY_STATE_RECENT_LIMIT)
      .map(toSearchResult);
    return [
      ...(pinned.length > 0
        ? [
            {
              id: "pinned" as const,
              label: t("chat.pinnedConversations"),
              icon: Pin,
              items: pinned,
            },
          ]
        : []),
      {
        id: "recent",
        label: t("chat.recentConversation"),
        icon: Clock3,
        items: recent,
      },
    ];
  }, [conversations, normalizedQuery, results, t]);

  const selectableItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  const selectConversation = (item: ConversationSearchResult) => {
    const { id } = item;
    resultSelected.current = true;
    onOpenChange(false);
    if (normalizedQuery && searchAdapter) {
      searchAdapter.onSelectResult(item);
      return;
    }
    setSearchJumpTarget(null);
    const isLocalDraft =
      !normalizedQuery && conversations.some((item) => item.id === id && item.isPending);
    const hasMessageTarget = normalizedQuery && (item.messageId || item.messageIndex !== undefined);
    onSelectConversation(
      id,
      isLocalDraft
        ? undefined
        : {
            source: "search",
            ...(hasMessageTarget && {
              afterCommit: () =>
                setSearchJumpTarget({
                  conversationId: id,
                  messageId: item.messageId,
                  messageIndex: item.messageIndex,
                }),
            }),
          },
    );
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup
        data-conversation-search-dialog=""
        className="min-820:max-h-[min(640px,80dvh)]"
        layout="visual-viewport"
        finalFocus={() => {
          if (!returnFocus || resultSelected.current) return true;
          const origin = returnFocus.current;
          return origin?.isConnected && origin.getClientRects().length && !origin.closest("[inert]")
            ? origin
            : false;
        }}
      >
        <CommandDialogTitle className="sr-only">{t("chat.searchConversations")}</CommandDialogTitle>
        <CommandDialogDescription className="sr-only">
          {t("chat.searchConversationsDescription")}
        </CommandDialogDescription>
        <Command
          items={selectableItems}
          value={query}
          onValueChange={setQuery}
          itemToStringValue={(item) => item.title}
          filter={null}
          mode="none"
          loopFocus={false}
        >
          <CommandInput
            inputRef={inputRef}
            endAddon={
              <div className="flex shrink-0 items-center gap-0.5">
                {query.length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="rounded-lg text-muted-foreground max-820:size-11 pointer-coarse:size-11"
                    title={t("chat.clearConversationSearch")}
                    aria-label={t("chat.clearConversationSearch")}
                    onClick={() => {
                      setQuery("");
                      inputRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="rounded-lg text-muted-foreground max-820:min-h-11 max-820:min-w-11 max-820:px-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                  onClick={() => onOpenChange(false)}
                >
                  {t("chat.conversationSearchClose")}
                </Button>
              </div>
            }
            onKeyDownCapture={(event) => {
              if (
                event.nativeEvent.isComposing ||
                event.keyCode === 229 ||
                event.key === "Home" ||
                event.key === "End"
              )
                event.stopPropagation();
            }}
            aria-label={t("chat.searchConversations")}
            placeholder={t("chat.searchConversationsPlaceholder")}
            startAddon={
              status === "loading" ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
              ) : undefined
            }
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onOpenChange(false);
              }
            }}
          />
          <CommandPanel aria-busy={status === "loading"}>
            {status === "error" ? (
              <div
                role="alert"
                data-conversation-search-status=""
                className="flex shrink flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-8 text-center text-sm min-820:min-h-200px max-820:py-4"
              >
                <span className="text-destructive">{t("chat.conversationSearchFailed")}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 max-820:min-h-11 pointer-coarse:min-h-11"
                  onClick={(event) => {
                    if (event.detail === 0) inputRef.current?.focus({ preventScroll: true });
                    void performSearch(normalizedQuery);
                  }}
                >
                  {t("chat.retryConversationSearch")}
                </Button>
              </div>
            ) : status === "loading" ? (
              <div
                role="status"
                data-conversation-search-status=""
                className="flex shrink items-center justify-center px-4 py-8 text-sm text-muted-foreground min-820:min-h-200px max-820:py-4"
              >
                {t("chat.conversationSearchLoading")}
              </div>
            ) : selectableItems.length === 0 ? (
              <div
                role="status"
                data-conversation-search-status=""
                className="flex shrink flex-col items-center justify-center gap-2 overflow-y-auto px-6 py-8 text-center text-sm text-muted-foreground min-820:min-h-200px max-820:py-4"
              >
                <MessageSquareText className="size-8 opacity-40" />
                {normalizedQuery
                  ? t("chat.noConversationSearchResults")
                  : t("chat.searchConversationsDescription")}
              </div>
            ) : null}
            <CommandList
              aria-label={t("chat.searchConversations")}
              className={cn(
                "min-820:max-h-[min(52vh,440px)]",
                selectableItems.length === 0 && "p-0",
              )}
            >
              {groups
                .filter((group) => group.items.length > 0)
                .map((group) => {
                  const GroupIcon = group.icon;
                  return (
                    <CommandGroup key={group.id} items={group.items}>
                      <CommandGroupLabel>
                        <GroupIcon className="size-3.5" />
                        {group.label}
                      </CommandGroupLabel>
                      {group.items.map((item) => {
                        const updatedAt = formatUpdatedAt(item.updatedAt, locale);
                        return (
                          <CommandItem
                            key={resultKey(item)}
                            value={item}
                            className="max-820:min-h-11 max-820:justify-center pointer-coarse:min-h-11"
                            onClick={() => selectConversation(item)}
                          >
                            <div className="flex w-full min-w-0 items-baseline gap-2">
                              <div className="min-w-0 flex-1 truncate font-medium leading-5">
                                {searchAdapter && normalizedQuery
                                  ? renderSearchPreview(item.title, normalizedQuery)
                                  : item.title}
                              </div>
                              {updatedAt ? (
                                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                  {updatedAt}
                                </span>
                              ) : null}
                            </div>
                            {item.matchType || item.cwd ? (
                              <div
                                data-conversation-search-result-meta=""
                                className="flex w-full min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground"
                              >
                                {item.matchType ? (
                                  <span className="shrink-0">
                                    {item.matchType === "message"
                                      ? locale.startsWith("zh")
                                        ? "正文匹配"
                                        : "Message match"
                                      : locale.startsWith("zh")
                                        ? "标题匹配"
                                        : "Title match"}
                                    {item.archived
                                      ? locale.startsWith("zh")
                                        ? " · 已归档"
                                        : " · Archived"
                                      : ""}
                                  </span>
                                ) : null}
                                {item.cwd ? (
                                  <span className="min-w-0 flex-1 truncate" title={item.cwd}>
                                    {item.cwd}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                            {item.searchPreview ? (
                              <div
                                data-conversation-search-result-preview=""
                                className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground"
                              >
                                {renderSearchPreview(
                                  item.searchPreview,
                                  searchAdapter ? normalizedQuery : undefined,
                                )}
                              </div>
                            ) : null}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  );
                })}
            </CommandList>
            {nextCursor && status === "ready" ? (
              <div data-conversation-search-pagination="" className="shrink-0 px-3 pb-3 text-center max-820:pb-1.5">
                {moreStatus === "error" ? (
                  <p role="alert" className="mb-2 text-xs text-destructive">
                    {t("chat.conversationSearchFailed")}
                  </p>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  className="aria-disabled:opacity-60 max-820:min-h-11 pointer-coarse:min-h-11"
                  aria-disabled={moreStatus === "loading"}
                  aria-busy={moreStatus === "loading"}
                  onClick={(event) => {
                    if (moreStatus === "loading") return;
                    paginationFocus.current = event.detail === 0 ? event.currentTarget : null;
                    void performSearch(normalizedQuery, nextCursor);
                  }}
                >
                  {moreStatus === "loading" ? (
                    <Loader2 className="mr-2 size-3.5 animate-spin motion-reduce:animate-none" />
                  ) : null}
                  {moreStatus === "error"
                    ? t("chat.retryConversationSearch")
                    : locale.startsWith("zh")
                      ? "加载更多"
                      : "Load more"}
                </Button>
              </div>
            ) : null}
          </CommandPanel>
          <CommandFooter className="max-820:hidden pointer-coarse:hidden">
            <div className="flex items-center gap-4">
              <span>
                <kbd className="mr-1.5 rounded border border-foreground/10 px-1">↑ ↓</kbd>
                {t("chat.conversationSearchNavigate")}
              </span>
              <span>
                <kbd className="mr-1.5 rounded border border-foreground/10 px-1">↵</kbd>
                {t("chat.conversationSearchOpen")}
              </span>
            </div>
            <span>
              <kbd className="mr-1.5 rounded border border-foreground/10 px-1">Esc</kbd>
              {t("chat.conversationSearchClose")}
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
