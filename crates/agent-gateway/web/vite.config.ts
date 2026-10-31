import path from "node:path";
import { readFileSync } from "node:fs";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { resourcePreviewAssets } from "../../../scripts/vite-resource-preview-assets.mjs";

const DEFAULT_PROXY_API = "http://127.0.0.1:50052";
const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };
const appVersion = process.env.ZEROAGENT_APP_VERSION?.trim() || packageJson.version || "0.0.0";

function resolveProxyTarget() {
  const cliArg = process.argv.find((arg) => arg.startsWith("--proxy-api="));
  if (cliArg) {
    return cliArg.slice("--proxy-api=".length) || DEFAULT_PROXY_API;
  }
  return process.env.npm_config_proxy_api || DEFAULT_PROXY_API;
}

export default defineConfig(({ mode }) => ({
  base: mode === "embedded-desktop" ? "/remote-device/" : "/",
  publicDir: mode === "embedded-desktop" ? false : "public",
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" }), resourcePreviewAssets()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@liveagent/app": path.resolve(__dirname, "./src"),
      "@liveagent/adapters": path.resolve(__dirname, "./src/agent-ui-adapters"),
      "@liveagent/ui": path.resolve(__dirname, "../../agent-ui/src"),
      "@tauri-apps/api/core": path.resolve(__dirname, "./src/shims/tauriCore.ts"),
      "@tauri-apps/api/event": path.resolve(__dirname, "./src/shims/tauriEvent.ts"),
      "@tauri-apps/plugin-opener": path.resolve(__dirname, "./src/shims/tauriOpener.ts"),
      "node:fs": path.resolve(__dirname, "../../agent-ui/src/shims/nodeFs.ts"),
      react: path.resolve(__dirname, "./node_modules/react"),
      "react/jsx-runtime": path.resolve(__dirname, "./node_modules/react/jsx-runtime.js"),
      "react/jsx-dev-runtime": path.resolve(__dirname, "./node_modules/react/jsx-dev-runtime.js"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
    },
  },
  optimizeDeps: {
    // @tanstack/react-virtual imports the vendored @tanstack/virtual-core
    // fork (crates/virtual-core, via the root pnpm override). Pre-bundling
    // the adapter inlines the fork's source into node_modules/.vite, where
    // it is keyed on the lockfile/config only — edits to the fork would
    // silently keep running the stale copy until a `--force`. Serve it as
    // source instead so the fork is always live (and HMR-able) in dev.
    exclude: ["@tanstack/react-virtual"],
  },
  build: {
    // Gateway embeds the web build; an Android build must not replace it with mobile bridges.
    outDir:
      mode === "embedded-desktop"
        ? "../../agent-gui/public/remote-device"
        : mode === "embedded-mobile" ? "dist-mobile" : "dist",
    emptyOutDir: true,
    ...(mode === "embedded-desktop" ? {
      lib: {
        entry: path.resolve(__dirname, "src/desktopRemoteEntry.tsx"),
        formats: ["es" as const],
        fileName: () => "runtime.module.js",
        cssFileName: "style",
      },
      cssCodeSplit: false,
      rolldownOptions: { output: { codeSplitting: false } },
    } : {}),
    // Monaco language workers are emitted as indivisible lazy assets (largest
    // is the TypeScript worker at ~6.6 MB). Bump the warning limit so those
    // known-large chunks don't drown out real regressions in the console.
    chunkSizeWarningLimit: 7_000,
    // Do not restore `rolldownOptions.output.codeSplitting` with a
    // `liveagent-webui` group / `maxSize: 450_000`. That size-based split cut
    // `GatewayTerminalStreamHandle extends TerminalStreamBuffer` across chunks
    // and created a circular ESM cycle, crashing load with
    // "Class extends value undefined is not a constructor or null".
    // `codeSplitting: false` (used by the GUI in #613) inlines every overlay
    // into a ~23 MB main bundle, which is fine for Tauri but not for WebUI.
  },
  define: {
    // Vite library mode leaves this flag for consumers to replace. The
    // standalone WebView runtime has no second bundling step or Node globals.
    ...(mode === "embedded-desktop"
      ? { "process.env.NODE_ENV": JSON.stringify("production") }
      : {}),
    __ZEROAGENT_EMBEDDED_MOBILE__: JSON.stringify(mode === "embedded-mobile"),
    __ZEROAGENT_APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    host: mode === "embedded-mobile" ? process.env.TAURI_DEV_HOST || false : undefined,
    port: mode === "embedded-mobile" ? 2120 : undefined,
    strictPort: mode === "embedded-mobile",
    hmr:
      mode === "embedded-mobile"
        ? {
            protocol: "ws",
            host: process.env.TAURI_DEV_HOST || "localhost",
            port: 2120,
            clientPort: 2120,
          }
        : undefined,
    proxy: {
      "/api": {
        target: resolveProxyTarget(),
        changeOrigin: true,
      },
      "/ws": {
        target: resolveProxyTarget(),
        // Preserve the browser-facing Host so Gateway's strict same-origin
        // WebSocket check can compare it with the Origin header.
        changeOrigin: false,
        ws: true,
      },
      "/image-proxy": {
        target: resolveProxyTarget(),
        changeOrigin: true,
      },
    },
  },
}));
