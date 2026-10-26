import {
  ArrowDownAZ,
  Check,
  ChevronRight,
  Funnel,
  Layers,
  RefreshCw,
  Search,
  SquarePen,
} from "@liveagent/ui/components/IconSet";
import { ProviderBrandIcon } from "@liveagent/ui/components/ProviderBrandIcon";
import { useLocale } from "@liveagent/ui/i18n/index";
import { type Ref, useId, useState } from "react";
import {
  type ProviderSortMode,
  persistProviderSortMode,
  readStoredProviderSortMode,
} from "../../lib/models/modelOptions";
import {
  buildModelPickerGroups,
  type ModelPickerOption,
  type ModelPickerView,
  modelIdOf,
  persistModelPickerView,
  readModelPickerView,
} from "../../lib/models/modelPickerOptions";
import { cn } from "../../lib/shared/utils";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

export function ModelPickerContent(props: {
  options: readonly ModelPickerOption[];
  value?: string;
  onSelect: (value: string) => void;
  searchInputRef?: Ref<HTMLInputElement>;
  noneLabel?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  collapsibleGroups?: boolean;
  selectionKind?: "model" | "provider";
  onOpenProvider?: (id: string) => void;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
}) {
  const { t } = useLocale();
  const id = useId();
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState<ModelPickerView>(readModelPickerView);
  const [sort, setSort] = useState<ProviderSortMode>(readStoredProviderSortMode);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const providerOnly = props.selectionKind === "provider";
  const activeView = providerOnly ? "provider" : view;
  const groups = buildModelPickerGroups(props.options, activeView, search, providerFilter, sort);
  const providers = buildModelPickerGroups(props.options, "provider", "", "", sort);
  const routes =
    pendingModel === null
      ? []
      : (groups.flatMap((group) => group.entries).find((entry) => entry.id === pendingModel)
          ?.options ?? []);
  const searching = search.trim().length > 0;

  function changeView(next: ModelPickerView) {
    setView(next);
    persistModelPickerView(next);
    setExpanded(new Set());
    setPendingModel(null);
  }

  function choose(option: ModelPickerOption) {
    props.onSelect(option.value);
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: A fieldset's anonymous box prevents this constrained scroll viewport from shrinking.
    <div
      role="group"
      aria-label={t("chat.selectModel")}
      className="m-0 flex min-h-0 min-w-0 flex-1 flex-col border-0 p-0 text-xs"
      data-model-picker-content
      data-model-picker-view={activeView}
      onKeyDown={(event) => {
        if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
        if (event.key === "Escape" && pendingModel !== null) {
          event.preventDefault();
          event.stopPropagation();
          setPendingModel(null);
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const items = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button[data-model-option]:not(:disabled), button[data-model-group]:not(:disabled)",
          ),
        );
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          current < 0
            ? event.key === "ArrowDown"
              ? 0
              : items.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        event.preventDefault();
        event.stopPropagation();
        items[next].focus();
      }}
    >
      {!providerOnly && (
        <fieldset
          aria-label={t("chat.modelPickerView")}
          className="mb-2 flex min-w-0 shrink-0 rounded-lg border-0 bg-muted/60 p-0.5"
        >
          {(
            [
              ["provider", "chat.modelPickerByGroup"],
              ["vendor", "chat.modelPickerByVendor"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={activeView === mode}
              onClick={() => changeView(mode)}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-xs transition-colors",
                activeView === mode
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(label)}
            </button>
          ))}
        </fieldset>
      )}
      {pendingModel === null ? (
        <div data-model-picker-toolbar className="mb-1.5 flex shrink-0 items-center gap-1.5">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-settings-tile-hover px-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={props.searchInputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={props.searchPlaceholder ?? t("chat.searchModel")}
              aria-label={props.searchPlaceholder ?? t("chat.searchModel")}
              className="w-full min-w-0 bg-transparent outline-none"
            />
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0 bg-settings-tile-hover"
                />
              }
              title={t("settings.modelAllProviders")}
              aria-label={t("settings.modelAllProviders")}
            >
              <Funnel className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              variant="soft"
              align="start"
              className="max-h-64 w-56 overflow-y-auto text-xs"
            >
              <DropdownMenuRadioGroup value={providerFilter} onValueChange={setProviderFilter}>
                <DropdownMenuRadioItem value="">
                  {t("settings.modelAllProviders")}
                </DropdownMenuRadioItem>
                {providers.map((group) => (
                  <DropdownMenuRadioItem key={group.id} value={group.id}>
                    <span className="min-w-0 truncate">{group.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 bg-settings-tile-hover"
            title={t(sort === "alpha" ? "chat.sortProvidersByName" : "chat.sortProvidersByType")}
            aria-label={t(
              sort === "alpha" ? "chat.sortProvidersByName" : "chat.sortProvidersByType",
            )}
            aria-pressed={sort === "alpha"}
            onClick={() => {
              const next = sort === "alpha" ? "type" : "alpha";
              setSort(next);
              persistProviderSortMode(next);
            }}
          >
            {sort === "alpha" ? (
              <ArrowDownAZ className="size-3.5" />
            ) : (
              <Layers className="size-3.5" />
            )}
          </Button>
          {props.onRefresh && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 bg-settings-tile-hover"
              disabled={props.refreshing}
              title={t("chat.refreshModels")}
              aria-label={t("chat.refreshModels")}
              onClick={() => void props.onRefresh?.()}
            >
              <RefreshCw className={cn("size-3.5", props.refreshing && "animate-spin")} />
            </Button>
          )}
        </div>
      ) : (
        <div className="mb-2 shrink-0 border-b border-border/60 pb-2">
          <button
            type="button"
            data-model-route-back
            onClick={() => setPendingModel(null)}
            className="mb-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className="size-3 rotate-180" />
            {t("chat.selectModel")}
          </button>
          <p className="truncate font-medium" title={pendingModel}>
            {routes[0]?.label ?? pendingModel}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t("chat.modelPickerChooseGroup")}</p>
        </div>
      )}
      <div
        className="max-h-[min(17.5rem,50dvh)] min-h-0 w-full overflow-x-hidden overflow-y-auto overscroll-contain scroll-pb-2 pb-2 pr-1 [scrollbar-gutter:stable]"
        data-model-picker-list
      >
        {pendingModel !== null ? (
          routes.length ? (
            routes.map((option) => (
              <button
                key={option.value}
                type="button"
                data-model-option
                data-model-route={option.value}
                aria-pressed={option.value === props.value}
                onClick={() => choose(option)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-settings-tile-hover focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ProviderBrandIcon
                  type={option.providerType}
                  model={modelIdOf(option)}
                  className="size-3.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.providerName}</span>
                  {option.label !== routes[0]?.label && (
                    <span className="block truncate text-tiny text-muted-foreground">
                      {option.label}
                    </span>
                  )}
                  {option.description && (
                    <span className="block truncate text-tiny text-muted-foreground">
                      {option.description}
                    </span>
                  )}
                </span>
                {option.contextWindow && (
                  <span className="shrink-0 text-tiny text-muted-foreground">
                    {new Intl.NumberFormat("en", {
                      notation: "compact",
                      maximumFractionDigits: 1,
                    }).format(option.contextWindow)}
                  </span>
                )}
                {option.value === props.value && <Check className="size-3.5 shrink-0" />}
              </button>
            ))
          ) : (
            <p className="px-3 py-6 text-center text-muted-foreground">
              {props.emptyLabel ?? t("chat.noModelFound")}
            </p>
          )
        ) : (
          <>
            {props.noneLabel && !searching && (
              <button
                type="button"
                data-model-option
                onClick={() => props.onSelect("")}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left hover:bg-settings-tile-hover"
              >
                {props.noneLabel}
                {!props.value && <Check className="size-3.5" />}
              </button>
            )}
            {!groups.length && (
              <p className="px-3 py-6 text-center text-muted-foreground">
                {props.emptyLabel ?? t("chat.noModelFound")}
              </p>
            )}
            {groups.map((group) => {
              const isExpanded =
                props.collapsibleGroups === false || searching || expanded.has(group.id);
              const listId = `${id}-${encodeURIComponent(group.id)}`;
              return (
                <div key={group.id} className="group/provider space-y-0.5 pb-1.5 last:pb-0">
                  <div className="sticky top-0 z-10 flex items-center gap-1 bg-popover py-1">
                    <button
                      type="button"
                      data-model-group={group.id}
                      disabled={props.collapsibleGroups === false}
                      aria-expanded={isExpanded}
                      aria-controls={listId}
                      onClick={() =>
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          if (next.has(group.id)) next.delete(group.id);
                          else next.add(group.id);
                          return next;
                        })
                      }
                      className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2.5 text-left font-medium text-muted-foreground hover:bg-settings-tile-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {props.collapsibleGroups !== false && (
                        <ChevronRight
                          className={cn("size-3 shrink-0", isExpanded && "rotate-90")}
                        />
                      )}
                      {activeView === "vendor" && group.name === "其他" ? (
                        <Layers className="size-3.5 opacity-90" />
                      ) : (
                        <ProviderBrandIcon
                          type={group.providerType}
                          model={group.iconModel}
                          className="size-3.5 opacity-90"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {group.name === "其他" ? t("chat.modelPickerOtherVendor") : group.name}
                      </span>
                      <span className="tabular-nums">{group.entries.length}</span>
                    </button>
                    {activeView === "provider" && props.onOpenProvider && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="mr-1 size-5 shrink-0 opacity-0 group-hover/provider:opacity-100 focus-visible:opacity-100"
                        aria-label={`${t("settings.editProvider")}: ${group.name}`}
                        onClick={() => props.onOpenProvider?.(group.id)}
                      >
                        <SquarePen className="size-3" />
                      </Button>
                    )}
                  </div>
                  <div
                    id={listId}
                    data-model-group-list
                    className="ml-4 space-y-0.5 border-l border-border/60 pl-1.5"
                  >
                    {isExpanded &&
                      group.entries.map((entry) => {
                        const option = entry.options[0];
                        const isSelected = entry.options.some((item) => item.value === props.value);
                        const contextWindow = entry.options.every(
                          (item) => item.contextWindow === option.contextWindow,
                        )
                          ? option.contextWindow
                          : undefined;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            data-model-option
                            data-model-id={modelIdOf(option)}
                            aria-pressed={isSelected}
                            onClick={() =>
                              activeView === "vendor" ? setPendingModel(entry.id) : choose(option)
                            }
                            className={cn(
                              "flex h-8 w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              isSelected
                                ? "bg-settings-active font-medium text-foreground hover:bg-settings-active"
                                : "text-foreground/90 hover:bg-settings-tile-hover hover:text-foreground",
                            )}
                          >
                            <span className="flex min-w-0 flex-1 items-center gap-2">
                              <ProviderBrandIcon
                                type={option.providerType}
                                model={providerOnly ? undefined : modelIdOf(option)}
                                className={cn("size-3", isSelected ? "opacity-80" : "opacity-45")}
                              />
                              <span className="min-w-0 flex-1 truncate" title={modelIdOf(option)}>
                                {entry.label}
                              </span>
                              {activeView === "provider" && option.description && (
                                <span className="max-w-24 truncate text-muted-foreground">
                                  {option.description}
                                </span>
                              )}
                            </span>
                            <span className="flex shrink-0 items-center gap-1 text-tiny text-muted-foreground">
                              {option.reasoning && (
                                <span className="rounded bg-muted/60 px-1 py-px">
                                  {t("settings.modelBadgeReasoning")}
                                </span>
                              )}
                              {option.vision && (
                                <span className="rounded bg-muted/60 px-1 py-px">
                                  {t("settings.modelBadgeVision")}
                                </span>
                              )}
                              {contextWindow && (
                                <span>
                                  {new Intl.NumberFormat("en", {
                                    notation: "compact",
                                    maximumFractionDigits: 1,
                                  }).format(contextWindow)}
                                </span>
                              )}
                              {activeView === "vendor" ? (
                                <ChevronRight className="size-3.5" />
                              ) : isSelected ? (
                                <Check className="size-3.5" />
                              ) : null}
                            </span>
                          </button>
                        );
                      })}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
