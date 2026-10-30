import type { ReactNode, Ref } from "react";

/** The same rail + rounded settings canvas in desktop and device WebUI. */
export function SettingsWorkspace({
  navigationRef,
  windowControls,
  children,
}: {
  navigationRef: Ref<HTMLDivElement>;
  windowControls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-settings-workspace="">
      <div ref={navigationRef} data-settings-navigation="" />
      <div data-settings-canvas="">
        {windowControls}
        {children}
      </div>
    </div>
  );
}
