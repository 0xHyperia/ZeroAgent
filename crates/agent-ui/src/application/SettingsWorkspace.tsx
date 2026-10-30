import type { ReactNode, Ref } from "react";
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
  return (
    <WorkbenchShell
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
  );
}
