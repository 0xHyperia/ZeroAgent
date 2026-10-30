import { ApplicationRail } from "@liveagent/ui/application/ApplicationRail";
import type { ApplicationViewId } from "@liveagent/ui/application/ApplicationView";
import {
  Blend,
  Brain,
  Cable,
  CalendarDays,
  Clock3,
  ImageIcon,
  MessageSquare,
  NavigationChatFilled,
  PanelLeftClose,
} from "@liveagent/ui/components/IconSet";
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import { useLocale } from "@liveagent/ui/i18n";
import {
  SIDEBAR_SHORTCUTS,
  type SidebarShortcuts,
} from "@liveagent/ui/lib/settings/sidebarShortcuts";
import type { ReactNode } from "react";

/** Navigation only. Local execution and the selected device remain host-owned. */
export function WorkbenchNavigationRail({
  activeView,
  shortcuts,
  onSelectView,
  onClose,
  brand,
  footer,
}: {
  activeView: ApplicationViewId;
  shortcuts: SidebarShortcuts;
  onSelectView: (view: ApplicationViewId) => void;
  onClose?: () => void;
  footer: ReactNode;
  brand: ReactNode;
}) {
  const { t } = useLocale();
  const icons = {
    skills: Blend,
    mcp: Cable,
    cron: Clock3,
    planning: CalendarDays,
    "image-studio": ImageIcon,
    memory: Brain,
  };
  return (
    <ApplicationRail
      activeId={activeView}
      brand={
        onClose ? (
          <TooltipButton
            variant="ghost"
            size="icon"
            title={t("sidebar.closeSidebar")}
            aria-label={t("sidebar.closeSidebar")}
            onClick={onClose}
          >
            <PanelLeftClose className="size-5" />
          </TooltipButton>
        ) : (
          brand
        )
      }
      items={[
        {
          id: "chat",
          label: t("sidebar.navigation"),
          icon: <MessageSquare className="size-5" />,
          activeIcon: <NavigationChatFilled className="size-5" />,

          onSelect: () => onSelectView("chat"),
        },
        ...SIDEBAR_SHORTCUTS.filter(({ id }) => shortcuts[id]).map(({ id, labelKey }) => {
          const Icon = icons[id];
          return {
            id: `${id}-hub`,
            label: t(labelKey),
            icon: <Icon className="size-5" />,
            onSelect: () => onSelectView(`${id}-hub`),
          };
        }),
      ]}
      footer={footer}
    />
  );
}
