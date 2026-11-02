import { type CSSProperties, type ReactNode, type Ref, useRef } from "react";
import { SidebarResizeContext, useSidebarWidthLayout } from "../components/ui/sidebar-resize";
import { WorkbenchCanvas, WorkbenchShell } from "./WorkbenchShell";

/** The same rail + rounded settings canvas in desktop and device WebUI. */
export function SettingsWorkspace({
  navigationRef,
  navigation = "portal",
  className,
  windowControls,
  children,
}: {
  navigationRef?: Ref<HTMLDivElement>;
  /** CloudChat keeps its owning rail outside the settings page. */
  navigation?: "portal" | "external";
  className?: string;
  windowControls?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const layout = useSidebarWidthLayout(ref, false, 820);
  return (
    <SidebarResizeContext.Provider value={layout}>
      <WorkbenchShell
        ref={ref}
        style={{ "--sidebar-width": `${layout.width}px` } as CSSProperties}
        layout="page"
        data-settings-workspace=""
        data-settings-navigation-mode={navigation}
        className={className}
      >
        {navigation === "portal" ? <div ref={navigationRef} data-settings-navigation="" /> : null}
        <WorkbenchCanvas data-settings-canvas="">
          {windowControls}
          {children}
        </WorkbenchCanvas>
      </WorkbenchShell>
    </SidebarResizeContext.Provider>
  );
}
