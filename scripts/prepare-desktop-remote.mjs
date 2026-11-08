import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(root, "crates/agent-gui/public/remote-device");

export function wrapDesktopRemoteRuntime(source) {
  const exported = /export\s*\{\s*([$\w]+)(?:\s+as\s+mount)?\s*\}\s*;?\s*$/.exec(source);
  if (!exported || (!exported[0].includes(" as ") && exported[1] !== "mount"))
    throw new Error("Desktop WebUI must export exactly one mount function");
  // Each call owns its React, adapters and module stores. The imported ESM only
  // retains this factory's code; disposed device instances can be collected.
  // No eval, iframe, per-device ESM cache entry or GUI adapter alias is involved.
  return `export function createDesktopRemoteRuntime() {\n${source.slice(0, exported.index)}\nreturn { mount: ${exported[1]} };\n}\n`;
}

export async function prepareDesktopRemote() {
  const windows = process.platform === "win32";
  await new Promise((resolveBuild, reject) => {
    const child = spawn(
      windows ? "pnpm --filter @liveagent/gateway-webui exec vite build --mode embedded-desktop" : "pnpm",
      windows ? [] : ["--filter", "@liveagent/gateway-webui", "exec", "vite", "build", "--mode", "embedded-desktop"],
      { cwd: root, stdio: "inherit", shell: windows, windowsHide: true },
    );
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveBuild() : reject(new Error(`Desktop WebUI build failed (${code})`)));
  });
  const modulePath = join(output, "runtime.module.js");
  const wrapped = wrapDesktopRemoteRuntime(await readFile(modulePath, "utf8"));
  // Parse as ESM without executing it: an unbundled import/export left inside
  // the factory is a build failure, while import.meta.url remains valid for workers.
  await new Promise((resolveCheck, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--check"], { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveCheck() : reject(new Error("Desktop WebUI factory is not self-contained")));
    child.stdin.end(wrapped);
  });
  await writeFile(join(output, "runtime.js"), wrapped);
  // Run the actual factory without Node globals: importing it in Node alone
  // masks browser-only failures such as an untransformed process.env.NODE_ENV.
  await new Promise((resolveProbe, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-vm-modules",
      join(root, "crates/agent-gui/test/providers/fixtures/desktop-remote-browser-probe.mjs"),
      join(output, "runtime.js"),
    ], { cwd: root, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveProbe() : reject(new Error("Desktop WebUI browser bootstrap failed")));
  });
  await rm(modulePath);
  const styles = (await readdir(output)).filter((name) => name.endsWith(".css")).sort();
  if (styles.length !== 1) throw new Error("Desktop WebUI must have one removable stylesheet");
  await writeFile(join(output, "manifest.json"), `${JSON.stringify({
    schemaVersion: 2, entry: "runtime.js", styles,
    sha256: createHash("sha256").update(wrapped).digest("hex"),
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareDesktopRemote();
}
