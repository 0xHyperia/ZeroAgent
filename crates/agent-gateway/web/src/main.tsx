import { startConfiguredCatalogLive } from "@liveagent/ui/lib/models/catalogLive";
import { GATEWAY_WEBUI_MARKER } from "@liveagent/ui/lib/runtimeEnv";
import { installReactDevTimelineLimit } from "@liveagent/ui/lib/system/reactDevTimeline";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installBrowserMobileBack } from "./lib/browserMobileBack";
import {
  bootstrapEmbeddedMobileRuntime,
  installMobileViewport,
  isEmbeddedMobileRuntime,
} from "./lib/mobileRuntime";
import "./index.css";
import "katex/dist/katex.min.css";
import "react-complex-tree/lib/style-modern.css";
import "streamdown/styles.css";

const stopCatalogRefresh = startConfiguredCatalogLive(
  import.meta.env.VITE_ZEROAGENT_MODEL_CATALOG_URL,
  true,
);
import.meta.hot?.dispose(stopCatalogRefresh);

// 渲染前写入 WebUI 运行时标记（isGatewayWebuiRuntime 的唯一权威写入点）。
async function start() {
  await bootstrapEmbeddedMobileRuntime();
  const mobile = isEmbeddedMobileRuntime();
  if (!mobile && window.matchMedia("(pointer: coarse)").matches) {
    installMobileViewport();
    installBrowserMobileBack();
  }
  document.documentElement.dataset.liveagentWebui = GATEWAY_WEBUI_MARKER;
  const MobileAppExperience = mobile
    ? (await import("./components/mobile/MobileAppExperience")).MobileAppExperience
    : React.Fragment;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <MobileAppExperience>
        <App />
      </MobileAppExperience>
    </React.StrictMode>,
  );
}

if (import.meta.env.DEV) {
  const stopReactTimelineLimit = installReactDevTimelineLimit();
  import.meta.hot?.dispose(stopReactTimelineLimit);
}

void start();
