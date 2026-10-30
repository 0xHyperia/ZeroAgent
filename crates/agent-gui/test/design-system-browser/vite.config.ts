import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import gui from "../../vite.config";

export default defineConfig(async (env) =>
  mergeConfig(await gui(env), {
    root: path.resolve(__dirname),
    publicDir: false,
    cacheDir: path.resolve(__dirname, ".vite"),
    server: {
      host: "127.0.0.1",
      port: 18481,
      strictPort: true,
      proxy: {},
      fs: { allow: [path.resolve(__dirname, "../../../..")] },
    },
    build: {
      outDir: path.resolve(__dirname, "../../../../.codex-artifacts/design-system-browser"),
    },
  }),
);
