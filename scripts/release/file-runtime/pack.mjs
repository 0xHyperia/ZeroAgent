import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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

  const pack = fileURLToPath(new URL("./managed_pack.py", import.meta.url));
  execFileSync("python", ["-B", pack, "pack", target, join(scratch, "stage", "file-runtime"), resolve(output)], {
    stdio: "inherit",
  });
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}
