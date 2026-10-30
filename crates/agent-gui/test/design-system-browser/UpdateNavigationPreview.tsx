import "../../../agent-gateway/web/src/zeroagent.css";
import { MobileUpdateDialog } from "../../../agent-gateway/web/src/components/mobile/MobileUpdateDialog";
import { ApplicationRail } from "@liveagent/ui/application/ApplicationRail";
import { NavigationUpdateButton } from "@liveagent/ui/application/NavigationUpdateButton";
import { BookOpen, MessageSquare, PanelLeft, X } from "@liveagent/ui/components/IconSet";
import { AccountAvatar } from "@liveagent/ui/components/ui/account-identity";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarProvider,
  useSidebar,
} from "@liveagent/ui/components/ui/sidebar";
import { TooltipProvider } from "@liveagent/ui/components/ui/tooltip";
import { LocaleContext } from "@liveagent/ui/i18n/LocaleContext";
import { t } from "@liveagent/app/i18n/config";
import { useState } from "react";

const update = {
  currentVersion: "1.0.0",
  version: "1.1.0",
  title: "ZeroAgent v1.1.0",
  notes: "统一侧边栏更新入口。\n优化移动端导航和对话体验。",
  apkUrl: "https://example.invalid/preview.apk",
  releaseUrl: "https://example.invalid/release",
};

function Preview() {
  const sidebar = useSidebar();
  const [details, setDetails] = useState(false);
  const [receipt, setReceipt] = useState("");
  const rail = (mobile = false) => (
    <ApplicationRail
      brand={
        mobile ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="关闭边栏"
            onClick={() => sidebar.setOpenMobile(false)}
          >
            <PanelLeft className="size-5" />
          </Button>
        ) : (
          <strong>Z</strong>
        )
      }
      activeId="chat"
      items={[
        {
          id: "chat",
          label: "对话",
          icon: <MessageSquare className="size-5" />,
          onSelect: () => {},
        },
        {
          id: "space",
          label: "资料空间",
          icon: <BookOpen className="size-5" />,
          onSelect: () => {},
        },
      ]}
      footer={
        <>
          <NavigationUpdateButton label="有可用更新 · v1.1.0" onClick={() => setDetails(true)} />
          <AccountAvatar label="Z" />
        </>
      }
    />
  );
  return (
    <div className="app-workspace-shell relative flex h-dvh w-full overflow-hidden">
      {!sidebar.isMobile ? rail() : null}
      <Sidebar label="导航与会话" mobileRail={sidebar.isMobile ? rail(true) : undefined}>
        <SidebarHeader>
          <div className="flex items-center justify-between p-2">
            <strong>ZeroAgent</strong>
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭导航"
              onClick={() =>
                sidebar.isMobile ? sidebar.setOpenMobile(false) : sidebar.setOpen(false)
              }
            >
              <X className="size-4" />
            </Button>
          </div>
        </SidebarHeader>
        <SidebarContent className="gap-3 p-4">
          <Button variant="ghost">新对话</Button>
          <p className="text-xs text-muted-foreground">最近会话</p>
          <Button variant="ghost">工作计划</Button>
        </SidebarContent>
      </Sidebar>
      <main className="relative flex min-w-0 flex-1 flex-col bg-background p-4">
        <header className="flex h-11 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label="打开边栏"
            onClick={() => (sidebar.isMobile ? sidebar.setOpenMobile(true) : sidebar.setOpen(true))}
          >
            <PanelLeft className="size-5" />
          </Button>
          <span>导航更新示例</span>
        </header>
        <div className="m-auto flex w-full max-w-lg flex-col gap-4 p-4">
          <h1 className="text-xl font-medium">继续当前工作</h1>
          <p className="text-sm text-muted-foreground">
            更新入口位于左侧导航底部。此页面只检查共享组件，不发起更新请求。
          </p>
          <textarea
            className="za-text-field min-h-28 rounded-2xl border p-4"
            placeholder="草稿会在关闭更新详情后保留"
          />
          <p role="status" className="text-sm">
            {receipt}
          </p>
        </div>
      </main>
      <MobileUpdateDialog
        update={update}
        open={details}
        downloading={false}
        onClose={() => setDetails(false)}
        onDownload={() => {
          setReceipt("已触发下载样例，没有真实下载");
          setDetails(false);
        }}
      />
    </div>
  );
}

export function UpdateNavigationPreview() {
  return (
    <LocaleContext.Provider value={{ locale: "zh-CN", t: (key) => t(key, "zh-CN") }}>
      <TooltipProvider>
        <SidebarProvider>
          <Preview />
        </SidebarProvider>
      </TooltipProvider>
    </LocaleContext.Provider>
  );
}
