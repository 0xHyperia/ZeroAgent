import { isDesktopChatHeaderInset } from "@liveagent/adapters/chatHeaderChrome";
import type { AppSettings } from "@liveagent/app/lib/settings";
import { PanelLeft, Settings } from "@liveagent/ui/components/IconSet";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, type ReactNode } from "react";
import { ThemeToggleButton } from "../ThemeToggleButton";

export type ChatHeaderProps = {
  settings: AppSettings;
  sidebarOpen: boolean;
  onOpenSettings: (section?: "providers", providerId?: string) => void;
  onToggleTheme: () => void;
  onOpenSidebar: () => void;
  navigationActions?: ReactNode;
  /** CloudChat may replace the collapsed navigation slot with a new-chat action. */
  navigationMode?: "sidebar" | "new-chat";
  leadingActions?: ReactNode;
  preThemeActions?: ReactNode;
  trailingActions?: ReactNode;
  windowControls?: ReactNode;
  className?: string;
};

export const ChatHeader = memo(function ChatHeader(props: ChatHeaderProps) {
  const {
    settings,
    sidebarOpen,
    onOpenSettings,
    onToggleTheme,
    onOpenSidebar,
    navigationActions,
    navigationMode = "sidebar",
    leadingActions,
    preThemeActions,
    trailingActions,
    windowControls,
    className,
  } = props;
  const { t } = useLocale();
  const desktopTitleBarInset = isDesktopChatHeaderInset();

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex items-center gap-4 pl-4 pr-4 has-[[data-windows-window-controls]]:pr-0",
        className,
      )}
    >
      <div
        data-app-header-navigation=""
        className={cn(
          "flex min-w-0 shrink-0 items-center gap-1.5 transition-[min-width] duration-200 ease-out motion-reduce:transition-none",
          sidebarOpen && !desktopTitleBarInset && "hidden",
          sidebarOpen &&
            desktopTitleBarInset &&
            "desktop:min-[768px]:min-w-[calc(var(--sidebar-width)-1rem)]",
        )}
      >
        {navigationActions}
        {!desktopTitleBarInset && navigationMode === "sidebar" ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onOpenSidebar}
            title={t(sidebarOpen ? "sidebar.closeSidebar" : "tooltip.openSidebar")}
            aria-expanded={sidebarOpen}
            data-cloud-sidebar-open=""
            aria-label={t(sidebarOpen ? "sidebar.closeSidebar" : "tooltip.openSidebar")}
            className={cn(
              "rounded-lg text-muted-foreground hover:text-foreground",
              // The open sidebar owns its collapse button beside search.
              sidebarOpen && "hidden",
            )}
          >
            <PanelLeft className="size-4.5" />
          </Button>
        ) : null}
      </div>
      <div
        data-conversation-header=""
        data-tauri-drag-region
        className="flex h-full min-w-0 flex-1 items-center gap-1.5"
      >
        {leadingActions}
      </div>

      <div
        data-app-workbench-actions=""
        className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      >
        {preThemeActions}
        <ThemeToggleButton theme={settings.theme} onToggle={onToggleTheme} />
        {!sidebarOpen && !desktopTitleBarInset ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onOpenSettings()}
            title={t("tooltip.settings")}
            aria-label={t("tooltip.settings")}
            className="rounded-lg text-muted-foreground hover:text-foreground"
          >
            <Settings className="size-4" />
          </Button>
        ) : null}
        {trailingActions}
      </div>
      {windowControls}
    </header>
  );
});
