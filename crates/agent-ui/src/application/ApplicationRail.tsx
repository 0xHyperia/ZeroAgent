import type { ReactNode } from "react";
import { TooltipProvider } from "../components/ui/tooltip";
import { TooltipButton as Button } from "../components/ui/tooltip-button";
import { useLocale } from "../i18n";

export type ApplicationRailItem = {
  id: string;
  label: string;
  icon: ReactNode;
  /** A library-provided solid variant; selection must not fill an outline path. */
  activeIcon?: ReactNode;
  onSelect: () => void;
};

/** Host-owned destinations; this presentation never selects an execution target. */
export function ApplicationRail({
  brand,
  items,
  activeId,
  previewId,
  previewableIds,
  footer,
}: {
  brand: ReactNode;
  items: readonly ApplicationRailItem[];
  activeId: string;
  previewId?: string;
  previewableIds?: readonly string[];
  footer?: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <TooltipProvider>
      <nav aria-label={t("sidebar.applicationNavigation")} className="application-rail">
        <div className="application-rail-brand">{brand}</div>
        <div className="application-rail-destinations">
          {items.map((item) => {
            const previewable = previewableIds?.includes(item.id);
            return (
              <Button
                key={item.id}
                data-rail-item={item.id}
                variant="ghost"
                size="icon"
                title={item.label}
                aria-expanded={previewable || previewId ? item.id === previewId : undefined}
                data-previewed={item.id === previewId ? "true" : undefined}
                tooltipSide="right"
                tooltipDescription={previewable ? t("sidebar.previewSidebar") : undefined}
                tooltipShortcut={previewable ? "→" : undefined}
                aria-keyshortcuts={previewable ? "ArrowRight" : undefined}
                aria-label={item.label}
                aria-current={item.id === activeId ? "page" : undefined}
                onClick={item.onSelect}
                className="application-rail-item size-10 rounded-xl"
              >
                {item.id === activeId ? (item.activeIcon ?? item.icon) : item.icon}
              </Button>
            );
          })}
        </div>
        <div className="mt-auto flex flex-col items-center gap-2">{footer}</div>
      </nav>
    </TooltipProvider>
  );
}
