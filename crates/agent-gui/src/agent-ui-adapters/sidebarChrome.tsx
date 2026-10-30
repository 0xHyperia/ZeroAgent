import { BrandMark } from "@liveagent/ui/application/BrandMark";
import { useSidebar } from "@liveagent/ui/components/ui/sidebar";
import { useState } from "react";
import { isMacOsTauri } from "../components/MacOsTitleBarSpacer";

// 宽布局的侧栏在应用标题栏下方，不需要额外留白；窄布局（<768px）侧栏改为
// 从窗口顶边开始的浮层，原生红绿灯会压在品牌行上，需要让出一个标题栏高度。
export function DesktopSidebarTitleBar() {
  const { isMobile } = useSidebar();
  const [isMacOs] = useState(isMacOsTauri);
  if (!isMacOs || !isMobile) return null;
  return (
    <div
      data-tauri-drag-region
      aria-hidden="true"
      className="shrink-0"
      style={{ height: "var(--app-header-height, 48px)" }}
    />
  );
}

export function DesktopSidebarBrand() {
  return (
    <div data-app-sidebar-brand="" className="flex min-w-0 -translate-y-0.5 items-center gap-2">
      <BrandMark alt="" aria-hidden="true" className="rounded-xl" />
      <div className="min-w-0">
        <div className="truncate font-semibold tracking-tight">ZeroAgent</div>
      </div>
    </div>
  );
}

export function hideDesktopSidebarCloseButton() {
  return isMacOsTauri();
}
