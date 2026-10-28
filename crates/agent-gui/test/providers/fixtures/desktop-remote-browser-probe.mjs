// Explicit post-build check, also required by prepare-desktop-remote.mjs.
// Execute real ESM in jsdom's browser realm, without borrowing Node globals.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SourceTextModule, runInContext } from "node:vm";

const requireGui = createRequire(new URL("../../../package.json", import.meta.url));
const { JSDOM } = requireGui("jsdom");

test("the shipped remote factory initializes in a browser realm without Node globals", async () => {
  const bundle = resolve(process.argv[2] ?? process.env.ZEROAGENT_DESKTOP_REMOTE_BUNDLE ??
    fileURLToPath(new URL("../../../public/remote-device/runtime.js", import.meta.url)));
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://desktop-shell.invalid/remote-device/",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  try {
    const context = dom.getInternalVMContext();
    dom.window.TextEncoder = TextEncoder;
    dom.window.TextDecoder = TextDecoder;
    // jsdom has no canvas renderer; dependencies use this as a feature probe.
    dom.window.HTMLCanvasElement.prototype.getContext = () => null;
    const module = new SourceTextModule(await readFile(bundle, "utf8"), {
      context,
      identifier: pathToFileURL(bundle).href,
      initializeImportMeta(meta) { meta.url = pathToFileURL(bundle).href; },
    });
    await module.link((specifier) => { throw new Error(`Unexpected unbundled import: ${specifier}`); });
    await module.evaluate();
    for (const name of ["process", "require", "Buffer", "module"])
      assert.equal(runInContext(`typeof ${name}`, context), "undefined", `${name} must not come from Node`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const runtime = module.namespace.createDesktopRemoteRuntime();
      assert.equal(typeof runtime.mount, "function");
      assert.equal(runInContext("typeof process", context), "undefined", "bootstrap must not install a process shim");
    }
  } finally {
    dom.window.close();
  }
});
