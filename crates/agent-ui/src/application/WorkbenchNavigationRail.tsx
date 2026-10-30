import { ApplicationRail } from "@liveagent/ui/application/ApplicationRail";
import type { ApplicationViewId } from "@liveagent/ui/application/ApplicationView";
import { PanelLeftClose } from "@liveagent/ui/components/IconSet";
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import { useLocale } from "@liveagent/ui/i18n";
import type { SidebarShortcuts } from "@liveagent/ui/lib/settings/sidebarShortcuts";
import type { ReactNode } from "react";
import {
  createWorkbenchNavigationItem,
  getWorkbenchFeatureNavigation,
} from "./workbenchNavigation";

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
        createWorkbenchNavigationItem("chat", t("sidebar.navigation"), () => onSelectView("chat")),
        ...getWorkbenchFeatureNavigation(shortcuts).map(({ view, labelKey }) =>
          createWorkbenchNavigationItem(view, t(labelKey), () => onSelectView(view)),
        ),
      ]}
      footer={footer}
    />
  );
}
