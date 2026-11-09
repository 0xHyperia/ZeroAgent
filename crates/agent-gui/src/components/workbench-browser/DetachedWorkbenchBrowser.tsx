import { LocaleContext, useLocaleContextValue } from "@liveagent/ui/i18n/index";
import { useLayoutEffect } from "react";
import { submitDetachedBrowserAnnotations, WorkbenchBrowserPane } from "./WorkbenchBrowserPane";

export default function DetachedWorkbenchBrowser({ lease }: { lease: string }) {
  const appearance = (
    window as Window & {
      __ZEROAGENT_BROWSER_APPEARANCE__?: { locale: "en-US" | "zh-CN"; dark: boolean };
    }
  ).__ZEROAGENT_BROWSER_APPEARANCE__;
  const locale = useLocaleContextValue(appearance?.locale === "zh-CN" ? "zh-CN" : "en-US");
  const dark = appearance?.dark === true;
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return (
    <LocaleContext.Provider value={locale}>
      <main className="flex h-dvh min-h-0 flex-col">
        <WorkbenchBrowserPane
          id={lease}
          detachedLease={lease}
          url=""
          active
          onNavigate={(_url, title) => {
            document.title = title ? `${title} · ZeroAgent` : "ZeroAgent";
          }}
          onOpenTab={() => {}}
          onAnnotate={(annotations) => submitDetachedBrowserAnnotations(lease, annotations)}
        />
      </main>
    </LocaleContext.Provider>
  );
}
