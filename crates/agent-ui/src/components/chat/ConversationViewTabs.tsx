import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";
import type { ConversationViewId } from "../../lib/trajectory/conversationViewState";
import { MessageSquareText, Waypoints } from "../IconSet";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";

export type { ConversationViewId } from "../../lib/trajectory/conversationViewState";

export function ConversationViewTabs(props: {
  active: ConversationViewId;
  onChange: (view: ConversationViewId) => void;
  className?: string;
}) {
  const { t } = useLocale();
  const tabs = [
    {
      id: "conversation",
      labelKey: "trajectory.tab.conversation",
      icon: MessageSquareText,
    },
    { id: "trajectory", labelKey: "trajectory.tab.trajectory", icon: Waypoints },
  ] as const;

  return (
    <Tabs
      value={props.active}
      onValueChange={(value) => {
        if ((value === "conversation" || value === "trajectory") && value !== props.active) {
          props.onChange(value);
        }
      }}
      render={<TabsList variant="plain" activateOnFocus={false} loopFocus={false} />}
      className={cn(
        "flex h-8 shrink-0 items-center gap-0.5",
        "rounded-lg border border-border/60 bg-muted/40 p-0.5",
        props.className,
      )}
    >
      {tabs.map((tab) => {
        const selected = props.active === tab.id;
        const Icon = tab.icon;
        return (
          <TabsTrigger
            key={tab.id}
            value={tab.id}
            variant="plain"
            className={cn(
              "flex h-full min-w-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors max-[520px]:justify-center max-[520px]:px-1.5",
              "text-muted-foreground hover:bg-background/70 hover:text-foreground",
              selected && "bg-background font-medium text-foreground shadow-sm",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="max-[520px]:sr-only">{t(tab.labelKey)}</span>
          </TabsTrigger>
        );
      })}
    </Tabs>
  );
}
