import type { CSSProperties, ReactNode } from "react";
import {
  Blend,
  Clock3,
  Globe,
  Layers,
  Package,
  PanelLeft,
  SquarePen,
  Star,
  Trash2,
} from "../components/IconSet";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarHeaderRow,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../components/ui/sidebar";
import { useLocale } from "../i18n";
import {
  SIDEBAR_SHORTCUTS,
  type SidebarShortcutId,
  type SidebarShortcuts,
} from "../lib/settings/sidebarShortcuts";
import type { ApplicationViewId } from "./ApplicationView";
import { getWorkbenchFeatureNavigation } from "./workbenchNavigation";

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
  onPinPreview,
}: {
  activeView: ApplicationViewId;
  shortcuts?: SidebarShortcuts;
  onOpenResourceHub: (resource: SidebarShortcutId) => void;
  onNewConversation: () => void;
  mobileRail?: ReactNode;
  previewOpen?: boolean;
  headerTop?: ReactNode;
  fontScale?: number;
  onPinPreview?: () => void;
}) {
  const { t } = useLocale();
  const { isMobile, setOpenMobile } = useSidebar();
  const select = (action: () => void) => {
    action();
    if (isMobile) setOpenMobile(false);
  };
  const current = SIDEBAR_SHORTCUTS.find(({ id }) => activeView === `${id}-hub`);
  return (
    <Sidebar
      mobileRail={mobileRail}
      previewOpen={previewOpen}
      className="workbench-feature-sidebar zone-font-scale"
      data-sidebar-preview-region=""
      style={{ "--zone-font-scale": fontScale } as CSSProperties}
    >
      {headerTop}
      <SidebarHeader className="px-3 pt-2.5">
        <SidebarHeaderRow
          actions={
            <SidebarTrigger
              showShortcut={!previewOpen}
              title={t(previewOpen ? "tooltip.openSidebar" : "sidebar.closeSidebar")}
              aria-label={t(previewOpen ? "tooltip.openSidebar" : "sidebar.closeSidebar")}
              onClick={(event) => {
                if (previewOpen && onPinPreview) {
                  event.preventDefault();
                  onPinPreview();
                }
              }}
            >
              {previewOpen ? <PanelLeft className="size-4" /> : undefined}
            </SidebarTrigger>
          }
        >
          <h2 className="min-w-0 truncate text-base font-semibold">
            {current ? t(current.labelKey) : t("sidebar.navigation")}
          </h2>
        </SidebarHeaderRow>
        <SidebarMenu className="mt-2.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              variant="navigation"
              className="sidebar-list-row min-h-9"
              onClick={() => select(onNewConversation)}
            >
              <SquarePen className="size-4" />
              <span>{t("chat.newConversation")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label={t("sidebar.navigation")} className="flex flex-col gap-1 px-3">
          <div className="my-2 border-t border-border/60" />
          <SidebarMenu>
            {getWorkbenchFeatureNavigation(shortcuts).map(({ id, labelKey, icon: Icon }) => {
              const active = activeView === `${id}-hub`;
              return (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    variant="navigation"
                    isActive={active}
                    aria-current={active ? "page" : undefined}
                    className="sidebar-list-row min-h-9"
                    onClick={() => select(() => onOpenResourceHub(id))}
                  >
                    <Icon className="size-4" />
                    <span>{t(labelKey)}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </nav>
      </SidebarContent>
    </Sidebar>
  );
}

/** Account destinations can expose their links without opening the account page. */
export function WorkbenchDestinationPreview({
  title,
  entries,
  onPin,
  fontScale,
  previewOpen = true,
  mobileRail,
}: {
  title: string;
  entries: readonly { label: string; icon?: ReactNode; onSelect: () => void }[];
  onPin: () => void;
  fontScale: number;
  previewOpen?: boolean;
  mobileRail?: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <Sidebar
      label={title}
      previewOpen={previewOpen}
      mobileRail={mobileRail}
      className="workbench-feature-sidebar zone-font-scale bg-background"
      data-sidebar-preview-region=""
      style={{ "--zone-font-scale": fontScale } as CSSProperties}
    >
      <SidebarHeader className="px-3 pt-2.5">
        <SidebarHeaderRow
          actions={
            <SidebarTrigger
              showShortcut={!previewOpen}
              aria-label={t(previewOpen ? "tooltip.openSidebar" : "sidebar.closeSidebar")}
              onClick={(event) => {
                if (!previewOpen) return;
                event.preventDefault();
                onPin();
              }}
            >
              {previewOpen ? <PanelLeft className="size-4" /> : undefined}
            </SidebarTrigger>
          }
        >
          <h2 className="min-w-0 truncate text-base font-semibold">{title}</h2>
        </SidebarHeaderRow>
      </SidebarHeader>
      <SidebarContent className="px-3 pt-2.5">
        <SidebarMenu>
          {entries.map((entry) => (
            <SidebarMenuItem key={entry.label}>
              <SidebarMenuButton
                variant="navigation"
                className="sidebar-list-row min-h-9"
                onClick={entry.onSelect}
              >
                {entry.icon}
                <span>{entry.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>
    </Sidebar>
  );
}

/** Navigation remains available before the Web view loads or when it cannot connect. */
export function WorkbenchAccountSidebar({
  destination,
  onNavigate,
  ...props
}: Omit<Parameters<typeof WorkbenchDestinationPreview>[0], "title" | "entries"> & {
  destination: "library" | "customize";
  onNavigate: (href: string) => void;
}) {
  const { locale } = useLocale();
  const text = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const links =
    destination === "library"
      ? [
          { label: text("最近", "Recent"), href: "/space?category=recent", Icon: Clock3 },
          { label: text("全部资料", "All files"), href: "/space", Icon: Layers },
          { label: text("收藏", "Starred"), href: "/space?scope=starred", Icon: Star },
          { label: text("站点", "Sites"), href: "/space?category=sites", Icon: Globe },
          { label: text("回收站", "Trash"), href: "/space?scope=trash", Icon: Trash2 },
        ]
      : [
          { label: text("插件", "Plugins"), href: "/plugins", Icon: Blend },
          { label: text("技能", "Skills"), href: "/skills", Icon: Package },
        ];
  return (
    <WorkbenchDestinationPreview
      {...props}
      title={destination === "library" ? text("资料空间", "Library") : text("自定义", "Customize")}
      entries={links.map(({ label, href, Icon }) => ({
        label,
        icon: <Icon className="size-4" />,
        onSelect: () => onNavigate(href),
      }))}
    />
  );
}
