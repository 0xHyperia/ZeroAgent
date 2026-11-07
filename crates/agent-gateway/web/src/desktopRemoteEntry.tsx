import { AppErrorBoundary } from "@liveagent/ui/components/AppErrorBoundary";
import { SidebarProvider } from "@liveagent/ui/components/ui/sidebar";
import { LocaleContext, useLocaleContextValue } from "@liveagent/ui/i18n";
import { GATEWAY_WEBUI_MARKER } from "@liveagent/ui/lib/runtimeEnv";
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import GatewayApp from "./app/GatewayApp";
import { bindAccountRequests } from "./lib/accountRequest";
import {
  type DesktopAccountLayout,
  type DesktopCloudHost,
  type DesktopRemoteHost,
  type DesktopTaskConversation,
  installDesktopCloudHost,
  installDesktopRemoteHost,
  requireCurrentDesktopRemoteHost,
} from "./lib/desktopRemoteHost";
import { encodeSelectionCredential } from "./lib/executionTargets";
import { resetGatewayWebSocketClient } from "./lib/gatewaySocket";
import { setEphemeralCredential } from "./lib/storage";
import { loadWebSettings, persistWebSettings } from "./lib/webSettings";
import { CloudChatPage } from "./pages/CloudChatPage";
import "./index.css";
import "katex/dist/katex.min.css";
import "react-complex-tree/lib/style-modern.css";
import "streamdown/styles.css";

export type { DesktopCloudHost, DesktopRemoteHost } from "./lib/desktopRemoteHost";

function EmbeddedCloud({
  host,
  active,
  taskConversation,
  accountLayout,
}: {
  host: DesktopCloudHost;
  active: boolean;
  taskConversation?: DesktopTaskConversation;
  accountLayout?: DesktopAccountLayout;
}) {
  const [settings, setSettings] = useState(() => ({
    ...loadWebSettings(""),
    ...host.clientPreferences?.(),
  }));
  const [user, setUser] = useState(host.accountUser);
  const locale = useLocaleContextValue(settings.locale);
  useEffect(() => {
    if (!active || !host.isCurrent()) return;
    const preferences = host.clientPreferences?.();
    if (preferences) {
      setSettings((current) =>
        current.locale === preferences.locale && current.theme === preferences.theme
          ? current
          : { ...current, ...preferences },
      );
    }
  }, [active, host]);
  useEffect(() => {
    if (!host.isCurrent()) return;
    persistWebSettings(settings);
    const preferences = host.clientPreferences?.();
    if (
      preferences &&
      (preferences.locale !== settings.locale || preferences.theme !== settings.theme)
    ) {
      host.updateClientPreferences?.({ locale: settings.locale, theme: settings.theme });
    }
  }, [host, settings]);
  return (
    <LocaleContext.Provider value={locale}>
      <SidebarProvider
        defaultOpen={!taskConversation}
        open={accountLayout?.sidebarOpen}
        onOpenChange={accountLayout?.onSidebarOpenChange}
        keyboardShortcutEnabled={active && !taskConversation && !accountLayout}
      >
        <AppErrorBoundary>
          <CloudChatPage
            user={user}
            onUserChange={(next) => {
              setUser(next);
              host.onUserChange(next);
            }}
            environments={host.getEnvironments()}
            selection={null}
            settings={settings}
            setSettings={setSettings}
            settingsSaveState={{ status: "idle" }}
            onSwitch={(environment) => host.onSwitch(environment)}
            onOpenDeviceTasks={(environment) => host.onOpenDeviceTasks(environment)}
            onLogout={host.onLogout}
            desktopCloudHost={host}
            workbenchActive={active}
            embeddedTaskConversation={taskConversation}
            desktopAccountLayout={accountLayout}
          />
        </AppErrorBoundary>
      </SidebarProvider>
    </LocaleContext.Provider>
  );
}

/** A fresh factory/module instance belongs to exactly one authorized device mount. */
export function mount(
  container: HTMLElement,
  host: DesktopRemoteHost | DesktopCloudHost,
): {
  dispose(): void;
  setActive?(active: boolean): void;
  setAccountLayout?(layout: DesktopAccountLayout): void;
  setTaskConversation?(conversation: DesktopTaskConversation): void;
} {
  if ("kind" in host) {
    const releaseHost = installDesktopCloudHost(host);
    bindAccountRequests(host.accountUser.id);
    const root = ReactDOM.createRoot(container);
    const doc = document.documentElement;
    let marker: string | undefined;
    let ownsMarker = false;
    let isActive = host.initialActive ?? true;
    let taskConversation = host.taskConversation;
    let accountLayout = host.accountLayout;
    const restoreMarker = () => {
      if (!ownsMarker) return;
      if (marker === undefined) delete doc.dataset.liveagentWebui;
      else doc.dataset.liveagentWebui = marker;
      ownsMarker = false;
    };
    const render = (active: boolean) => {
      isActive = active;
      if (!taskConversation && !accountLayout && active && !ownsMarker) {
        marker = doc.dataset.liveagentWebui;
        doc.dataset.liveagentWebui = GATEWAY_WEBUI_MARKER;
        ownsMarker = true;
      } else if (!active) restoreMarker();
      root.render(
        <EmbeddedCloud
          host={host}
          active={active}
          taskConversation={taskConversation}
          accountLayout={accountLayout}
        />,
      );
    };
    render(isActive);
    return {
      setActive: render,
      setAccountLayout(layout) {
        accountLayout = layout;
        render(isActive);
      },
      setTaskConversation(conversation) {
        taskConversation = conversation;
        render(isActive);
      },
      dispose() {
        releaseHost();
        bindAccountRequests(null);
        root.unmount();
        restoreMarker();
        host.onHeaderTarget(null);
      },
    };
  }
  const releaseHost = installDesktopRemoteHost(host);
  requireCurrentDesktopRemoteHost();
  setEphemeralCredential(encodeSelectionCredential(host.selection));
  const documentRoot = document.documentElement;
  const previousMarker = documentRoot.dataset.liveagentWebui;
  const previousAttributes = new Map(
    ["class", "style", "lang"].map((name) => [name, documentRoot.getAttribute(name)] as const),
  );
  const previousTitle = document.title;
  documentRoot.dataset.liveagentWebui = GATEWAY_WEBUI_MARKER;
  container.dataset.zeroagentDesktopRemote = "";
  const root = ReactDOM.createRoot(container);
  root.render(<GatewayApp />);
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      // Close the request gate before unmount cleanups/late promises can run.
      releaseHost();
      root.unmount();
      resetGatewayWebSocketClient();
      setEphemeralCredential(null);
      bindAccountRequests(null);
      host.onHeaderTarget?.(null);
      host.onAccountTarget?.(null);
      host.onWindowControlsTarget?.(null);
      host.onUpdateTarget?.(null);
      for (const [name, value] of previousAttributes) {
        if (value === null) documentRoot.removeAttribute(name);
        else documentRoot.setAttribute(name, value);
      }
      document.title = previousTitle;
      if (previousMarker === undefined) delete documentRoot.dataset.liveagentWebui;
      else documentRoot.dataset.liveagentWebui = previousMarker;
      delete container.dataset.zeroagentDesktopRemote;
    },
  };
}
