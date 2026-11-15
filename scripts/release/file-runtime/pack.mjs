import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [target, input, output] = process.argv.slice(2);
if (!target || !input || !output) {
  throw new Error("Usage: node pack.mjs <target> <assembled runtime directory> <output directory>");
}

async function sha256(filename) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest("hex");
}

const scratch = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "za-pack-"));
try {
  const runtime = resolve(input);
  const prepare = fileURLToPath(new URL("../prepare-file-runtime.mjs", import.meta.url));
  const manifestSha256 = await sha256(join(runtime, "runtime.json"));
  execFileSync(process.execPath, [prepare, runtime, join(scratch, "stage"), target, manifestSha256], {
    env: { ...process.env, ZEROAGENT_REQUIRE_OFFLINE_FILE_QA: "1" },
    stdio: "inherit",
  });

  await mkdir(output);
  const archive = resolve(output, "file-runtime.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", runtime, "."], { stdio: "inherit" });
  const receipt = {
    format: 1,
    target,
    source_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sha256: await sha256(archive),
    manifestSha256,
  };
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}
