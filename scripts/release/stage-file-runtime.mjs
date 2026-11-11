import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";

const [target, destination] = process.argv.slice(2);
const validHash = (value) => /^[0-9a-f]{64}$/.test(value ?? "");
if (!["x86_64-pc-windows-msvc", "x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-unknown-linux-gnu"].includes(target) || !destination) {
  throw new Error("Usage: node stage-file-runtime.mjs <desktop target> <new staging directory>");
}
const prepare = fileURLToPath(new URL("./prepare-file-runtime.mjs", import.meta.url));
function stage(source, manifestSha256) {
  execFileSync(process.execPath, [prepare, source, resolve(destination), target, manifestSha256], { stdio: "inherit" });
}

const source = process.env.ZEROAGENT_FILE_RUNTIME_SOURCE;
if (source) {
  const manifestSha256 = process.env.ZEROAGENT_FILE_RUNTIME_MANIFEST_SHA256;
  if (!validHash(manifestSha256)) throw new Error("Set ZEROAGENT_FILE_RUNTIME_MANIFEST_SHA256 to the reviewed runtime manifest digest");
  stage(resolve(source), manifestSha256);
} else {
  const pack = JSON.parse(process.env.ZEROAGENT_FILE_RUNTIME_PACKS || "{}")[target];
  if (!pack || !validHash(pack.sha256) || !validHash(pack.manifestSha256)) {
    throw new Error(`No reviewed file runtime pack configured for ${target}`);
  }
  const url = new URL(pack.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("File runtime pack requires an HTTPS download URL");
  const scratch = await mkdtemp(join(tmpdir(), "zeroagent-file-runtime-"));
  try {
    const archive = join(scratch, "pack.tar.gz");
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error(`File runtime download failed (HTTP ${response.status})`);
    const hash = createHash("sha256");
    await pipeline(response.body, new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }), createWriteStream(archive, { flags: "wx" }));
    if (hash.digest("hex") !== pack.sha256) throw new Error("File runtime archive checksum mismatch");
    const tree = join(scratch, "pack");
    await mkdir(tree);
    execFileSync("tar", ["-xzf", archive, "-C", tree], { stdio: "inherit" });
    stage(tree, pack.manifestSha256);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
