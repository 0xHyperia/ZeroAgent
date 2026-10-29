import type { ReactNode } from "react";
import { TooltipProvider } from "../components/ui/tooltip";
import { TooltipButton as Button } from "../components/ui/tooltip-button";

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
  footer,
}: {
  brand: ReactNode;
  items: readonly ApplicationRailItem[];
  activeId: string;
  previewId?: string;
  footer?: ReactNode;
}) {
  return (
    <TooltipProvider>
      <nav aria-label="应用导航" className="application-rail">
        <div className="application-rail-brand">{brand}</div>
        <div className="flex flex-col items-center gap-2">
          {items.map((item) => (
            <Button
              key={item.id}
              data-rail-item={item.id}
              variant="ghost"
              size="icon"
              title={item.label}
              aria-expanded={previewId ? item.id === previewId : undefined}
              data-previewed={item.id === previewId ? "true" : undefined}
              tooltipSide="right"
              aria-label={item.label}
              aria-current={item.id === activeId ? "page" : undefined}
              onClick={item.onSelect}
              className="application-rail-item size-10 rounded-xl"
            >
              {item.id === activeId ? (item.activeIcon ?? item.icon) : item.icon}
            </Button>
          ))}
        </div>
        <div className="mt-auto flex flex-col items-center gap-2">{footer}</div>
      </nav>
    </TooltipProvider>
  );
}
