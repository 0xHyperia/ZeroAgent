import type { CSSProperties, ReactNode } from "react";
import {
  Blend,
  Brain,
  Cable,
  CalendarDays,
  Clock3,
  ImageIcon,
  SquarePen,
} from "../components/IconSet";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarTrigger,
  useSidebar,
} from "../components/ui/sidebar";
import { useLocale } from "../i18n";
import {
  normalizeSidebarShortcuts,
  SIDEBAR_SHORTCUTS,
  type SidebarShortcutId,
  type SidebarShortcuts,
} from "../lib/settings/sidebarShortcuts";
import { cn } from "../lib/shared/utils";
import type { ApplicationViewId } from "./ApplicationView";

/** Feature navigation replaces workspace/history navigation outside a conversation. */
export function WorkbenchFeatureSidebar({
  activeView,
  shortcuts,
  onOpenResourceHub,
  onNewConversation,
  mobileRail,
  previewOpen,
  headerTop,
  fontScale = 1,
}: {
  activeView: ApplicationViewId;
  shortcuts?: SidebarShortcuts;
  onOpenResourceHub: (resource: SidebarShortcutId) => void;
  onNewConversation: () => void;
  mobileRail?: ReactNode;
  previewOpen?: boolean;
  headerTop?: ReactNode;
  fontScale?: number;
}) {
  const { t } = useLocale();
  const { isMobile, setOpenMobile } = useSidebar();
  const select = (action: () => void) => {
    action();
    if (isMobile) setOpenMobile(false);
  };
  const enabled = normalizeSidebarShortcuts(shortcuts);
  const icons = {
    skills: Blend,
    mcp: Cable,
    cron: Clock3,
    planning: CalendarDays,
    "image-studio": ImageIcon,
    memory: Brain,
  };
  const current = SIDEBAR_SHORTCUTS.find(({ id }) => activeView === `${id}-hub`);
  const rowClass =
    "sidebar-list-row flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-foreground/75 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <Sidebar
      mobileRail={mobileRail}
      previewOpen={previewOpen}
      className="workbench-feature-sidebar zone-font-scale"
      data-sidebar-preview-region=""
      style={{ "--zone-font-scale": fontScale } as CSSProperties}
    >
      {headerTop}
      <SidebarHeader>
        <div className="flex h-9 items-center justify-between gap-2 px-2">
          <h2 className="min-w-0 truncate text-base font-semibold">
            {current ? t(current.labelKey) : t("sidebar.navigation")}
          </h2>
          <SidebarTrigger />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label={t("sidebar.navigation")} className="flex flex-col gap-1 px-3">
          <button type="button" className={rowClass} onClick={() => select(onNewConversation)}>
            <SquarePen className="size-4 shrink-0" />
            {t("chat.newConversation")}
          </button>
          <div className="my-2 border-t border-border/60" />
          {SIDEBAR_SHORTCUTS.filter(({ id }) => enabled[id]).map(({ id, labelKey }) => {
            const Icon = icons[id];
            return (
              <button
                key={id}
                type="button"
                aria-current={activeView === `${id}-hub` ? "page" : undefined}
                data-active={activeView === `${id}-hub` ? "true" : "false"}
                className={cn(
                  rowClass,
                  activeView === `${id}-hub` && "bg-foreground/8 font-medium text-foreground",
                )}
                onClick={() => select(() => onOpenResourceHub(id))}
              >
                <Icon className="size-4 shrink-0" />
                {t(labelKey)}
              </button>
            );
          })}
        </nav>
      </SidebarContent>
    </Sidebar>
  );
}
