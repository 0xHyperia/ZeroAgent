import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resourcePreviewAssets } from "../../scripts/vite-resource-preview-assets.mjs";
import { lazyDiffHighlightGrammars } from "../agent-ui/build/lazyDiffGrammars";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };

const env = process.env as Record<string, string | undefined>;
const appVersion = env.ZEROAGENT_APP_VERSION?.trim() || packageJson.version || "0.0.0";
const usaZeroOrigin =
  env.ZEROAGENT_USA_ZERO_ORIGIN?.trim() || env.VITE_USA_ZERO_ORIGIN?.trim() || "https://usa0.top";
const host = env.TAURI_DEV_HOST;
const desktopDevPort = Number(env.ZEROAGENT_DEV_DESKTOP_PORT || 2120);
if (!Number.isInteger(desktopDevPort) || desktopDevPort < 1 || desktopDevPort > 65534) {
  throw new Error("ZEROAGENT_DEV_DESKTOP_PORT must be an integer between 1 and 65534");
}

// https://vite.dev/config/
export default defineConfig(async () => {
  return {
  plugins: [react(), Icons({ compiler: "jsx", jsx: "react" }), resourcePreviewAssets(), lazyDiffHighlightGrammars()],
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@bufbuild/protobuf",
      "@earendil-works/pi-ai",
      "@sinclair/typebox",
    ],
    alias: {
      "@": fileURLToPath(new URL("../agent-gateway/web/src", import.meta.url)),
      "@liveagent/app": fileURLToPath(new URL("./src", import.meta.url)),
      "@liveagent/adapters": fileURLToPath(new URL("./src/agent-ui-adapters", import.meta.url)),
      "@liveagent/ui": fileURLToPath(new URL("../agent-ui/src", import.meta.url)),
      "node:fs": fileURLToPath(new URL("../agent-ui/src/shims/nodeFs.ts", import.meta.url)),
    },
  },
  define: {
    __LIVEAGENT_APP_VERSION__: JSON.stringify(appVersion),
    __ZEROAGENT_USA_ZERO_ORIGIN__: JSON.stringify(usaZeroOrigin),
  },
  optimizeDeps: {
    // @tanstack/react-virtual imports the vendored @tanstack/virtual-core
    // fork (crates/virtual-core, via the root pnpm override). Pre-bundling
    // the adapter inlines the fork's source into node_modules/.vite, where
    // it is keyed on the lockfile/config only — edits to the fork would
    // silently keep running the stale copy until a `--force`. Serve it as
    // source instead so the fork is always live (and HMR-able) in dev.
    exclude: ["@tanstack/react-virtual", "@extend-ai/react-xlsx", "@extend-ai/react-xlsx/vanilla", "@extend-ai/react-xlsx/internal"],
    include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  },
  build: {
    // Monaco language workers are emitted as indivisible lazy assets (largest
    // is the TypeScript worker at ~6.6 MB). Bump the warning limit so those
    // known-large chunks don't drown out real regressions in the console.
    chunkSizeWarningLimit: 7_000,
    // Keep the CommonJS style-parser chain with its Markdown consumer. A size-
    // based split separated its initializers and crashed the production app.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "markdown-style-cjs",
              test: /[\\/]node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(?:style-to-js|style-to-object|inline-style-parser|hast-util-to-jsx-runtime)[\\/]/,
            },
          ],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: desktopDevPort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: desktopDevPort + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  };
});
