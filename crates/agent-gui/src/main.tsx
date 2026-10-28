import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import { installReactDevTimelineLimit } from "@liveagent/ui/lib/system/reactDevTimeline";
import { isTauriHost } from "./lib/host";
import {
  connectKBrainBackendWithRetry,
  createKBrainBootstrapRunner,
  isNativeProfileAuthenticationError,
  notifyFrontendReady,
} from "./lib/kbrain/bootstrap";
import { type NativeProfileCredential, setBootProfileScope } from "./lib/kbrain/profile";
import {
  getNativeProfileCredential,
  nativeProfileCredentialMatches,
  RELAY_SESSION_CHANGED_EVENT,
  rejectNativeProfileCredential,
} from "./lib/relay/client";
import { installNativeGatewaySockets } from "./lib/relay/nativeGatewaySocket";
import { inferRuntimePlatform } from "./lib/runtimePlatform";
import { createStartupRenderer } from "./lib/startup/render";
import { installWebviewNavigationGuard } from "./lib/system/webviewNavigationGuard";

if (import.meta.env.DEV) {
  const stopReactTimelineLimit = installReactDevTimelineLimit();
  import.meta.hot?.dispose(stopReactTimelineLimit);
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

let currentBootstrap: Promise<void> | undefined;
let profileReloadInstalled = false;

const bootstrap = createKBrainBootstrapRunner(async () => {
  const screen = createStartupRenderer();
  let accountCredential: NativeProfileCredential | null = null;
  try {
    const native = isTauriHost();
    if (native) await installNativeGatewaySockets();
    accountCredential = native ? await getNativeProfileCredential() : null;
    const connection = await connectKBrainBackendWithRetry(
      undefined,
      native ? { accountCredential } : {},
    );
    const accountScope = native ? connection.accountScope : null;
    if (native) {
      if (accountScope === undefined || !nativeProfileCredentialMatches(accountCredential)) {
        throw new Error("USA-Zero account changed during native profile verification");
      }
      setBootProfileScope(accountScope);
      if (!profileReloadInstalled) {
        // Expiry/logout disposes every old client before the next profile is activated. Token
        // refresh uses a separate event, so ordinary refreshes do not discard conversation drafts.
        window.addEventListener(RELAY_SESSION_CHANGED_EVENT, () => window.location.reload());
        profileReloadInstalled = true;
      }
    }
    screen.phase("opening");
    const { default: App } = await import("./App");
    screen.dispose();
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  } catch (error) {
    console.error("Application startup failed", error);
    const needsLogin =
      isNativeProfileAuthenticationError(error) && rejectNativeProfileCredential(accountCredential);
    screen.fail(
      () => {
        void (currentBootstrap ?? Promise.resolve()).then(() => {
          currentBootstrap = bootstrap();
        });
      },
      needsLogin ? "authentication" : "startup",
    );
  } finally {
    await notifyFrontendReady().catch(() => undefined);
  }
});

// F5/Ctrl+R 等 webview 内置浏览器行为会把整个应用当网页刷新/导航走——在 React
// 挂载前安装守卫。dev 下放行刷新组合键，保留本地整页重载的调试手段。
installWebviewNavigationGuard({
  isMac: inferRuntimePlatform() === "macos",
  allowReloadChords: import.meta.env.DEV,
});

if (import.meta.env.DEV) {
  // Dev console hook for transcript perf work: window.__seedLongConversation()
  void import("./lib/debug/seedLongConversation").then(({ seedLongConversation }) => {
    const devWindow = window as Window & { __seedLongConversation?: typeof seedLongConversation };
    devWindow.__seedLongConversation = seedLongConversation;
  });
}

currentBootstrap = bootstrap();
