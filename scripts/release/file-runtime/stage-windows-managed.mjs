import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants, copyFileSync, createReadStream, lstatSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseReleaseVersion } from "../release-version.mjs";

const target = "x86_64-pc-windows-msvc";
const maximumArchiveBytes = 2 * 1024 ** 3;
const [packDirectory, output, tag, repository] = process.argv.slice(2);
if (!packDirectory || !output || !tag) {
  throw new Error("Usage: node stage-windows-managed.mjs <pack-directory> <new-output-directory> <tag> [public-repository]");
}

const { releaseTag, publishPublic } = parseReleaseVersion(tag);
assert(releaseTag.length <= 100, "Windows file tool tag exceeds the runtime descriptor limit");
const repositorySegment = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const segments = repository?.split("/") ?? [];
if (repository) {
  assert(publishPublic && segments.length === 2 && segments.every((segment) => repositorySegment.test(segment)),
    "A Windows file tools download URL requires a public release tag and repository");
}
const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const receiptPath = join(packDirectory, "receipt.json");
const receiptFile = lstatSync(receiptPath);
assert(receiptFile.isFile() && receiptFile.size <= 4096, "Invalid Windows file runtime receipt file");
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
assert(receipt.format === 1 && receipt.target === target && receipt.source_sha === source,
  "Windows file tools were built for a different source commit or target");

const archivePath = join(packDirectory, "file-runtime.zip");
const archiveFile = lstatSync(archivePath);
assert(archiveFile.isFile() && Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0
  && archiveFile.size === receipt.bytes && receipt.bytes <= maximumArchiveBytes,
  "Windows file tools ZIP does not match the recorded size or size limit");
assert(typeof receipt.sha256 === "string" && /^[0-9a-f]{64}$/.test(receipt.sha256),
  "Invalid Windows file tools ZIP checksum");
const hash = createHash("sha256");
for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
assert.equal(hash.digest("hex"), receipt.sha256, "Windows file tools ZIP checksum mismatch");

const name = `ZeroAgent-${releaseTag}-Windows-x64-file-tools.zip`;
const archive = { name, bytes: receipt.bytes, sha256: receipt.sha256 };
if (repository) archive.url = `https://github.com/${repository}/releases/download/${releaseTag}/${name}`;
mkdirSync(output);
copyFileSync(archivePath, join(output, name), constants.COPYFILE_EXCL);
writeFileSync(join(output, "descriptor.json"),
  JSON.stringify({ format: 1, target, version: releaseTag, archive }, null, 2) + "\n", { flag: "wx" });
console.log(`Windows file tools: ${name} (${archive.bytes} bytes)`);
