import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const source = "https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi";
const sha256 = "20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079";
const [output, tauriVersion] = process.argv.slice(2);
if (!output || tauriVersion !== "2.11.4") {
  throw new Error("Update the verified stock NSIS template for the installed Tauri CLI version");
}

const response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`Stock NSIS template download failed (HTTP ${response.status})`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
  throw new Error("Stock NSIS template checksum mismatch");
}

// Solid compression first puts the entire installer payload in one signed 32-bit
// data block. Compress each resource individually and retain Tauri's install logic.
const stock = bytes.toString("utf8");
const solid = 'SetCompressor /SOLID "{{compression}}"';
if (stock.split(solid).length !== 2) throw new Error("Stock NSIS compression directive changed");
const directory = resolve(output);
await mkdir(directory);
const template = join(directory, "installer.nsi");
await writeFile(template, stock.replace(solid, 'SetCompressor "{{compression}}"'), { flag: "wx" });
await writeFile(join(directory, "tauri.nsis.conf.json"), JSON.stringify({
  bundle: { windows: { nsis: { template } } },
}) + "\n", { flag: "wx" });
