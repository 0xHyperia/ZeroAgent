#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = "Stack-Cairn/LiveAgent";
const semverTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-((?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)\.)*(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export function validateRelease(release, tag, allowPrerelease = false) {
  const match = semverTag.exec(tag);
  if (!match) throw new Error("Expected an exact v-prefixed SemVer release tag");
  if (release.tag_name !== tag || release.draft !== false || !release.published_at ||
      !Number.isFinite(Date.parse(release.published_at))) {
    throw new Error("Target must be the exact published, non-draft GitHub Release");
  }
  if (typeof release.prerelease !== "boolean") throw new Error("Missing release channel metadata");
  if ((release.prerelease || match[1]) && !allowPrerelease) {
    throw new Error("Preview integration requires explicit --allow-prerelease authorization");
  }
  return { repository, tag, prerelease: release.prerelease, publishedAt: release.published_at };
}

export async function peelTag(object, getTag) {
  const seen = new Set();
  while (object?.type === "tag") {
    if (!/^[0-9a-f]{40}$/.test(object.sha) || seen.has(object.sha) || seen.size >= 8) {
      throw new Error("Invalid or cyclic annotated release tag");
    }
    seen.add(object.sha);
    object = (await getTag(object.sha)).object;
  }
  if (object?.type !== "commit" || !/^[0-9a-f]{40}$/.test(object.sha)) {
    throw new Error("Release tag does not resolve to a commit");
  }
  return object.sha;
}

export function assertPinnedCommit(remoteCommit, localCommit) {
  if (remoteCommit !== localCommit) throw new Error("Local release ref differs from the published GitHub tag");
}

async function main(argv) {
  let repo = ".", tag, allowPrerelease = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") repo = argv[++i];
    else if (argv[i] === "--tag") tag = argv[++i];
    else if (argv[i] === "--allow-prerelease") allowPrerelease = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!tag || !semverTag.test(tag) || !repo) throw new Error("Usage: verify-release.mjs --repo PATH --tag vX.Y.Z [--allow-prerelease]");
  const cwd = resolve(repo);
  const api = (path) => JSON.parse(execFileSync("gh", ["api", `repos/${repository}/${path}`], { cwd, encoding: "utf8" }));
  const metadata = validateRelease(api(`releases/tags/${encodeURIComponent(tag)}`), tag, allowPrerelease);
  const commit = await peelTag(api(`git/ref/tags/${encodeURIComponent(tag)}`).object,
    (sha) => api(`git/tags/${sha}`));
  const ref = `refs/upstream/releases/${tag}`;
  const localCommit = execFileSync("git", ["rev-parse", `${ref}^{}`], { cwd, encoding: "utf8" }).trim();
  assertPinnedCommit(commit, localCommit);
  process.stdout.write(`${JSON.stringify({ ...metadata, commit, ref }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
