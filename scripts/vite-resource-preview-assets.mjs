import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const requireUI = createRequire(new URL("../crates/agent-ui/package.json", import.meta.url));
const pdfRoot = dirname(requireUI.resolve("pdfjs-dist/package.json"));
const pdfVersion = JSON.parse(readFileSync(join(pdfRoot, "package.json"), "utf8")).version;
const prefix = `resource-preview/pdf/${pdfVersion}/`;
const directories = ["cmaps", "standard_fonts", "wasm", "iccs"];
const assets = new Map();
for (const directory of directories) {
  for (const entry of readdirSync(join(pdfRoot, directory), { withFileTypes: true })) {
    if (entry.isFile()) assets.set(`${directory}/${entry.name}`, join(pdfRoot, directory, entry.name));
  }
}

// The same packaged PDF resources are emitted for Web, mobile and both desktop
// runtimes. No CDN requests, user files, arbitrary paths or credentials.
export function resourcePreviewAssets() {
  let base = "/";
  return {
    name: "zeroagent-resource-preview-assets",
    configResolved(config) { base = config.base; },
    generateBundle() {
      for (const [name, path] of assets) this.emitFile({ type: "asset", fileName: prefix + name, source: readFileSync(path) });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? "").split("?")[0];
        const route = `${base}${prefix}`;
        if (!pathname.startsWith(route)) return next();
        const name = pathname.slice(route.length);
        const source = assets.get(name);
        if (!source) { response.statusCode = 404; response.end(); return; }
        response.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.end(readFileSync(source));
      });
    },
  };
}
