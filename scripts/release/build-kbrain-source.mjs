import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { defaultArtifact, platformFor, readLock, resolveTarget } from "./prepare-kbrain.mjs";
import { readPatchSet } from "./kbrain-patches.mjs";

// Build a detached checkout, never the developer's uncommitted working tree.
export async function buildSource(options = {}) {
  const lock = await readLock(options.lock);
  if (typeof lock.sourceGoVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(lock.sourceGoVersion)) {
    throw new Error("K-brain source build requires a pinned Go toolchain version");
  }
  const target = resolveTarget(options.target);
  const platform = platformFor(lock, target);
  const output = resolve(options.output || defaultArtifact);
  const scratchRoot = await realpath(tmpdir());
  const temporary = await mkdtemp(join(scratchRoot, "liveagent-kbrain-"));
  const ownedTemporary = await realpath(temporary);
  const verifyTemporary = (target) => {
    const child = relative(scratchRoot, target);
    if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)
      || !basename(target).startsWith("liveagent-kbrain-")) {
      throw new Error("K-brain build temporary directory is outside its owned root");
    }
  };
  verifyTemporary(ownedTemporary);
  const source = join(temporary, "source");
  const run = options.run || execFileSync;
  try {
    await mkdir(output, { recursive: true });
    await rm(join(output, "kbrain-artifact.json"), { force: true });
    const patches = options.patchManifest ? await readPatchSet(options.patchManifest, lock) : null;
    const verifiedFiles = [];
    if (patches) {
      const patchDirectory = join(temporary, "verified-patches");
      await mkdir(patchDirectory);
      for (const entry of patches.entries) {
        const file = join(patchDirectory, entry.file);
        await writeFile(file, entry.data);
        verifiedFiles.push(file);
      }
    }
    run("git", ["clone", "--no-checkout", "--no-hardlinks", "--", options.sourceDir ? resolve(options.sourceDir) : lock.repository, source], { stdio: "inherit" });
    // Patches are canonical LF bytes. Do not inherit Windows global checkout
    // conversion, which changes the tree to which dependent deltas are applied.
    run("git", ["-C", source, "config", "core.autocrlf", "false"], { stdio: "inherit" });
    run("git", ["-C", source, "checkout", "--detach", lock.sourceRevision], { stdio: "inherit" });
    if (patches) {
      for (const file of verifiedFiles) {
        run("git", ["-C", source, "apply", "--check", "--", file], { stdio: "inherit" });
        run("git", ["-C", source, "apply", "--", file], { stdio: "inherit" });
      }
    }
    const env = {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: platform.goos,
      GOARCH: platform.goarch,
      GOTOOLCHAIN: `go${lock.sourceGoVersion}`,
    };
    const sha256 = {};
    const buildVersion = patches ? `${lock.sourceRevision}+zeroagent.${patches.receipt.manifestSha256.slice(0, 12)}` : lock.sourceRevision;
    for (const [kind, command] of [["backend", "./cmd/kn"], ["computer", "./cmd/k-brain-computer"]]) {
      const destination = join(output, platform.assets[kind]);
      run("go", ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${buildVersion} -X main.revision=${lock.sourceRevision}`, "-o", destination, command], { cwd: source, env, stdio: "inherit" });
      sha256[kind] = createHash("sha256").update(await readFile(destination)).digest("hex");
    }
    const record = { schemaVersion: 1, repository: lock.repository, sourceRevision: lock.sourceRevision, protocol: lock.protocol, platforms: { [target]: { assets: platform.assets, sha256 } } };
    if (patches) Object.assign(record, { origin: "zeroagent-patched-source", buildVersion, zeroagentPatchSet: patches.receipt });
    await writeFile(join(output, "kbrain-artifact.json"), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } finally {
    const cleanupTarget = await realpath(temporary);
    verifyTemporary(cleanupTarget);
    if (cleanupTarget !== ownedTemporary) throw new Error("K-brain build temporary directory changed ownership");
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      lock: { type: "string" }, target: { type: "string" }, "source-dir": { type: "string" }, "output-dir": { type: "string" }, "patch-manifest": { type: "string" },
    } });
    await buildSource({ lock: values.lock, target: values.target, sourceDir: values["source-dir"], output: values["output-dir"], patchManifest: values["patch-manifest"] });
    console.log(values["patch-manifest"] ? "Built ZeroAgent-adapted K-brain source artifact with patch provenance." : "Built locked K-brain source artifact. Run pnpm prepare:kbrain to install the sidecars.");
  } catch (error) {
    console.error(`K-brain source build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
