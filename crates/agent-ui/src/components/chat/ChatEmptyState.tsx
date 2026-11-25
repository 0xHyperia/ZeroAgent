import { BrandMark } from "@liveagent/ui/application/BrandMark";
import { FolderTree, Lightbulb, Settings, Wrench } from "@liveagent/ui/components/IconSet";
import { useIsMobile } from "@liveagent/ui/hooks/use-mobile";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useEffect, useState } from "react";
import { ConversationStarter } from "./ConversationStarter";

type GreetingPeriod = "morning" | "noon" | "afternoon" | "evening" | "night";

const GREETING_KEYS: Record<GreetingPeriod, string> = {
  morning: "chat.greetingMorning",
  noon: "chat.greetingNoon",
  afternoon: "chat.greetingAfternoon",
  evening: "chat.greetingEvening",
  night: "chat.greetingNight",
};

function resolveGreetingPeriod(hour: number): GreetingPeriod {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 14) return "noon";
  if (hour >= 14 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

function useGreetingPeriod() {
  const [period, setPeriod] = useState<GreetingPeriod>(() =>
    resolveGreetingPeriod(new Date().getHours()),
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPeriod(resolveGreetingPeriod(new Date().getHours()));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return period;
}

const SUGGESTION_CARDS = [
  {
    key: "explore",
    icon: FolderTree,
    chipClassName: "text-sky-600 dark:text-sky-400",
    titleKey: "chat.suggestExploreTitle",
    hintKey: "chat.suggestExploreHint",
    promptKey: "chat.suggestExplorePrompt",
  },
  {
    key: "fix",
    icon: Wrench,
    chipClassName: "text-amber-600 dark:text-amber-400",
    titleKey: "chat.suggestFixTitle",
    hintKey: "chat.suggestFixHint",
    promptKey: "chat.suggestFixPrompt",
  },
  {
    key: "ideate",
    icon: Lightbulb,
    chipClassName: "text-emerald-600 dark:text-emerald-400",
    titleKey: "chat.suggestIdeateTitle",
    hintKey: "chat.suggestIdeateHint",
    promptKey: "chat.suggestIdeatePrompt",
  },
] as const;

export type ChatEmptyStateProps = {
  variant: "no-models" | "start-chat";
  onOpenSettings?: (section?: "providers") => void;
  onSuggestionSelect?: (text: string) => void;
};

export function ChatEmptyState({
  variant,
  onOpenSettings,
  onSuggestionSelect,
}: ChatEmptyStateProps) {
  const { t } = useLocale();
  const period = useGreetingPeriod();
  const compact = useIsMobile() && variant === "start-chat";

  return (
    <div className="conversation-starter-container relative flex w-full flex-col items-center" data-compact-starters={compact ? "" : undefined}>
      <BrandMark
        alt=""
        aria-hidden="true"
        className={cn(compact ? "mb-3 size-10" : "mb-5 size-12")}
      />

      {variant === "no-models" ? (
        <>
          <div className="mb-1.5 text-center text-2xl font-semibold leading-7 tracking-tight text-foreground">
            {t("chat.welcome")}
          </div>
          <div className="mb-0.5 text-center text-sm leading-5 text-muted-foreground">
            {t("chat.noModelSelected")}
          </div>
          <div className="text-center text-sm leading-5 text-muted-foreground">
            {t("chat.configureModel")}
          </div>
          {onOpenSettings ? (
            <button
              type="button"
              onClick={() => onOpenSettings("providers")}
              className={cn(
                "mt-5 inline-flex h-8 items-center gap-2 rounded-lg bg-foreground/[0.05] px-3",
                "text-sm font-normal text-foreground/85 transition-colors",
                "hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              )}
            >
              <Settings className="size-4 text-foreground/65" />
              {t("chat.goToSettings")}
            </button>
          ) : null}
        </>
      ) : (
        <>
          <div className="text-balance text-center text-2xl font-normal leading-8 tracking-tight text-foreground">
            {t(GREETING_KEYS[period])}，{t("chat.greetingSubtitle")}
          </div>
          {onSuggestionSelect ? (
            <div className={cn("conversation-starter-grid w-full", compact ? "mt-3" : "mt-7 max-w-768px px-4")}>
              {SUGGESTION_CARDS.map((card) => (
                <ConversationStarter
                  key={card.key}
                  title={t(card.titleKey)}
                  description={t(card.hintKey)}
                  layout="inline"
                  icon={<card.icon className={cn("size-5", card.chipClassName)} />}
                  onSelect={() => onSuggestionSelect(t(card.promptKey))}
                />
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
