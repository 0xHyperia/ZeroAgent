import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const requireUI = createRequire(new URL("../crates/agent-ui/package.json", import.meta.url));
const pdfRoot = dirname(requireUI.resolve("pdfjs-dist/package.json"));
const pdfVersion = JSON.parse(readFileSync(join(pdfRoot, "package.json"), "utf8")).version;
const sheetRoot = dirname(requireUI.resolve("@extend-ai/react-xlsx/package.json"));
const xmlRoot = dirname(requireUI.resolve("linkedom/package.json"));
const sheetNotices = [
  ["@extend-ai/react-xlsx 0.19.0 (modified for ZeroAgent)", join(sheetRoot, "LICENSE")],
  ["@dukelib/sheets-wasm 0.1.23", new URL("../docs/licenses/duke-sheets-MIT.txt", import.meta.url)],
  ["LinkeDOM 0.18.12", join(xmlRoot, "LICENSE")],
  ["Carlito font", join(sheetRoot, "dist/Carlito-OFL.txt")],
].map(([name, file]) => `${name}\n${readFileSync(file, "utf8")}`).join("\n\n");
const prefix = `resource-preview/pdf/${pdfVersion}/`;
const directories = ["cmaps", "standard_fonts", "wasm", "iccs"];
const assets = new Map();
for (const directory of directories) {
  for (const entry of readdirSync(join(pdfRoot, directory), { withFileTypes: true })) {
    if (entry.isFile()) assets.set(`${directory}/${entry.name}`, join(pdfRoot, directory, entry.name));
  }
}

// Workbook licenses and the same packaged PDF resources are emitted for Web, mobile and both desktop
// runtimes. No CDN requests, user files, arbitrary paths or credentials.
export function resourcePreviewAssets() {
  let base = "/";
  return {
    name: "zeroagent-resource-preview-assets",
    configResolved(config) { base = config.base; },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "resource-preview/sheet/THIRD_PARTY_NOTICES.txt", source: sheetNotices });
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
