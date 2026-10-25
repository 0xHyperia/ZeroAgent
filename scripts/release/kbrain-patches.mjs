import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const hash = (data) => createHash("sha256").update(data).digest("hex");

// A patch is build input tied to the exact published dependency revision. The
// manifest is data only: it cannot provide commands, absolute paths or symlinks.
export async function readPatchSet(file, lock) {
  const manifest = resolve(file);
  const stat = await lstat(manifest);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Invalid K-brain patch manifest file");
  const bytes = await readFile(manifest);
  const data = JSON.parse(bytes);
  if (data.schemaVersion !== 1 || data.repository !== lock.repository || data.sourceRevision !== lock.sourceRevision || data.protocol !== lock.protocol ||
      !Array.isArray(data.patches) || !data.patches.length || data.patches.length > 32 ||
      !Array.isArray(data.capabilities) || !data.capabilities.length || new Set(data.capabilities).size !== data.capabilities.length ||
      data.capabilities.some(value => typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(value))) {
    throw new Error("K-brain patch manifest does not match locked source/protocol");
  }
  const directory = await realpath(dirname(manifest));
  const seen = new Set();
  const entries = [];
  for (const patch of data.patches) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.patch$/.test(patch.file || "") || seen.has(patch.file) || !/^[a-f0-9]{64}$/.test(patch.sha256 || "")) throw new Error("Invalid K-brain patch identity");
    seen.add(patch.file);
    const candidate = join(directory, patch.file);
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8 * 1024 * 1024 || dirname(await realpath(candidate)) !== directory) throw new Error("Invalid K-brain patch file");
    const data = await readFile(candidate);
    if (hash(data) !== patch.sha256) throw new Error(`K-brain patch SHA-256 mismatch: ${patch.file}`);
    entries.push({ file: patch.file, data });
  }
  return { entries, receipt: { schemaVersion: 1, repository: data.repository, sourceRevision: data.sourceRevision, protocol: data.protocol,
    manifestSha256: hash(bytes), capabilities: data.capabilities, patches: data.patches.map(({ file, sha256 }) => ({ file, sha256 })) } };
}

export function checkPatchReceipt(actual, expected) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error("K-brain artifact patch provenance mismatch");
}
