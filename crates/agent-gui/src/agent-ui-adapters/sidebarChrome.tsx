import { AppUpdateButton } from "../components/AppUpdateButton";
import { isMacOsTauri, MacOsTitleBarSpacer } from "../components/MacOsTitleBarSpacer";
import type { AppUpdateController } from "../lib/appUpdates";

export function DesktopSidebarTitleBar() {
  return <MacOsTitleBarSpacer className="bg-[hsl(var(--sidebar-bg))]" />;
}

export function DesktopSidebarBrand() {
  return (
    <div className="flex min-w-0 -translate-y-0.5 items-center gap-2">
      <img
        src="/zeroagent-logo.png"
        alt=""
        aria-hidden="true"
        draggable={false}
        className="h-8 w-8 shrink-0 select-none rounded-xl object-contain"
      />
      <div className="min-w-0">
        <div className="truncate font-semibold tracking-tight">ZeroAgent</div>
      </div>
    </div>
  );
}

export function DesktopSidebarUpdate({ appUpdate }: { appUpdate?: AppUpdateController }) {
  return appUpdate?.showUpdateButton ? <AppUpdateButton appUpdate={appUpdate} iconOnly /> : null;
}

export function hideDesktopSidebarCloseButton() {
  return isMacOsTauri();
}
