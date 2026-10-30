import { GATEWAY_WEBUI_MARKER } from "@liveagent/ui/lib/runtimeEnv";
import ReactDOM from "react-dom/client";
import GatewayApp from "./app/GatewayApp";
import { bindAccountRequests } from "./lib/accountRequest";
import {
  type DesktopRemoteHost,
  installDesktopRemoteHost,
  requireCurrentDesktopRemoteHost,
} from "./lib/desktopRemoteHost";
import { encodeSelectionCredential } from "./lib/executionTargets";
import { resetGatewayWebSocketClient } from "./lib/gatewaySocket";
import { setEphemeralCredential } from "./lib/storage";
import "./index.css";
import "katex/dist/katex.min.css";
import "react-complex-tree/lib/style-modern.css";
import "streamdown/styles.css";

export type { DesktopRemoteHost } from "./lib/desktopRemoteHost";

/** A fresh factory/module instance belongs to exactly one authorized device mount. */
export function mount(container: HTMLElement, host: DesktopRemoteHost): { dispose(): void } {
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
