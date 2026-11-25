#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const release = readJson(".github/upstream-sync.json");
const prefix = `docs/upstream/${release.tag}`;
const inventory = readJson(`${prefix}-inventory.json`);
const ownershipRulesFile = ".github/upstream-ownership.yaml";
const { rules: ownershipRules } = readJson(ownershipRulesFile);
const reportPath = `${prefix}-fork-diff.json`;
const protectedGlobs = ["**/*licensee*", "**/*licensee*/**"];
const protectedPaths = protectedGlobs.map((glob) => `:(glob,icase)${glob}`);
const excludedProtectedPaths = protectedGlobs.map((glob) => `:(glob,icase,exclude)${glob}`);
const diffArguments = ["--name-status", "--no-ext-diff", "--no-textconv", "--no-renames", "-z"];

function nulFields(output) {
  return output ? output.slice(0, -1).split("\0") : [];
}

function statuses(output) {
  const fields = nulFields(output);
  const result = new Map();
  for (let index = 0; index < fields.length; index += 2) {
    result.set(fields[index + 1], fields[index]);
  }
  return result;
}

if (inventory.release !== release.tag || inventory.upstream_commit !== release.commit ||
    inventory.previous_upstream !== release.previous_upstream_commit) {
  throw new Error("Release metadata and upstream changed-path inventory use different revisions");
}
git("merge-base", "--is-ancestor", release.integration_commit, "HEAD");
const [, ...parents] = git("rev-list", "--parents", "-n", "1", release.integration_commit).trim().split(" ");
if (parents.length < 2 || !parents.includes(release.commit)) {
  throw new Error("Integration commit lacks the exact release as a merge parent");
}
const upstreamChanges = statuses(git("diff", ...diffArguments, release.previous_upstream_commit, release.commit));
const decisions = new Map(inventory.entries.map((entry) => [entry.path, entry]));
if (decisions.size !== upstreamChanges.size || decisions.size !== inventory.entries.length) {
  throw new Error("Upstream changed-path inventory has a missing, extra, or duplicate path");
}
const decisionCounts = {};
for (const [path, status] of upstreamChanges) {
  const entry = decisions.get(path);
  if (!entry || entry.upstream_change !== status ||
      !["adopt", "adapt", "replace", "partial", "reject", "defer"].includes(entry.decision)) {
    throw new Error(`Upstream changed-path inventory disagrees with Git for ${path}`);
  }
  decisionCounts[entry.decision] = (decisionCounts[entry.decision] ?? 0) + 1;
}
for (const [decision, count] of Object.entries({ ...inventory.counts, ...decisionCounts })) {
  if ((inventory.counts[decision] ?? 0) !== (decisionCounts[decision] ?? 0)) {
    throw new Error(`Inventory count disagrees with its ${decision} paths (${count})`);
  }
}

// Compare the actual checkout to the exact release without mutating the Git index.
// For user-restricted files use Git index metadata only.
const fork = statuses(git("diff", ...diffArguments, release.commit, "--", ".", ...excludedProtectedPaths));
for (const [path, status] of statuses(git("diff", "--cached", ...diffArguments, release.commit, "--", ...protectedPaths))) {
  fork.set(path, status);
}

const checkFileMode = git("config", "--type=bool", "--default=false", "--get", "core.filemode").trim() === "true";
for (const path of nulFields(git("ls-files", "--others", "--exclude-standard", "-z"))) {
  // An untracked file may have restored a path dropped from the index.
  if (fork.get(path) === "D" && !/licensee/i.test(path)) {
    const upstreamEntry = git("--literal-pathspecs", "ls-tree", release.commit, "--", path);
    const [mode, type, object] = upstreamEntry.split(/\s+/, 4);
    const file = lstatSync(join(root, path));
    if (type !== "blob" || !file.isFile()) {
      fork.set(path, "T");
    } else if (git("hash-object", "--", path).trim() !== object ||
        (checkFileMode && (mode === "100755") !== Boolean(file.mode & 0o100))) {
      fork.set(path, "M");
    } else {
      fork.delete(path);
    }
  } else {
    fork.set(path, fork.get(path) === "D" ? "M" : "A");
  }
}
fork.delete(reportPath);

function topNamespaces(status) {
  const counts = new Map();
  for (const [file, kind] of fork) {
    if (kind !== status) continue;
    const segments = file.split("/");
    const depth = segments[0] === "crates" ? 3 : 2;
    const key = segments.slice(0, Math.max(1, Math.min(depth, segments.length - 1))).join("/");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.keys()].sort()
    .map((key) => [key, counts.get(key)])
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12));
}

const forkStatuses = {};
const ownershipCounts = {};
const ownershipByStatus = {};
const entries = [...fork.keys()].sort().map((path) => {
  const status = fork.get(path);
  const ruleIndex = ownershipRules.findIndex(({ glob }) => posix.matchesGlob(path, glob));
  const owner = ownershipRules[ruleIndex]?.ownership ?? "unassigned";
  forkStatuses[status] = (forkStatuses[status] ?? 0) + 1;
  ownershipCounts[owner] = (ownershipCounts[owner] ?? 0) + 1;
  const byStatus = ownershipByStatus[status] ??= {};
  byStatus[owner] = (byStatus[owner] ?? 0) + 1;
  const releaseEntry = decisions.get(path);
  const row = [status, path, owner, ruleIndex === -1 ? null : ruleIndex + 1];
  return releaseEntry ? [...row, releaseEntry.decision] : row;
});
const report = {
  release: release.tag,
  upstreamCommit: release.commit,
  previousUpstreamCommit: release.previous_upstream_commit,
  integrationCommit: release.integration_commit,
  comparison: "Exact upstream tree to the checkout, including staged, unstaged, and untracked nonignored files. Renames are listed as deletions and additions.",
  exclusions: [reportPath, "Worktree changes to Licensee paths use index metadata only."],
  upstreamChangedPaths: upstreamChanges.size,
  upstreamDecisionCounts: Object.fromEntries(Object.entries(decisionCounts).sort()),
  forkChangedPaths: entries.length,
  forkStatusCounts: forkStatuses,
  ownershipRules: `${ownershipRulesFile}: first matching glob in file order, with a one-based rule number`,
  forkOwnershipCounts: ownershipCounts,
  forkOwnershipByStatus: ownershipByStatus,
  topForkOnlyNamespaces: topNamespaces("A"),
  topUpstreamOnlyNamespaces: topNamespaces("D"),
  columns: ["status", "path", "ownership", "rule", "upstreamReleaseDecision (when the release changed this path)"],
};
const output = `${JSON.stringify(report, null, 2).slice(0, -2)},\n  "entries": [\n${entries.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n")}\n  ]\n}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(join(root, reportPath), "utf8").replace(/\r\n/g, "\n") !== output) {
    throw new Error(`${reportPath} is stale. Run node scripts/report-upstream-fork-diff.mjs`);
  }
} else {
  writeFileSync(join(root, reportPath), output);
}
console.log(`${release.tag}: verified ${upstreamChanges.size} upstream paths and ${entries.length} ZeroAgent differences`);
