import assert from "node:assert/strict";
import test from "node:test";
import { assertPinnedCommit, peelTag, validateRelease } from "./verify-release.mjs";

const published = { tag_name: "v2.0.0", draft: false, prerelease: false, published_at: "2026-10-21T12:35:14Z" };
test("only an exact published non-draft release is accepted", () => {
  assert.equal(validateRelease(published, "v2.0.0").tag, "v2.0.0");
  for (const change of [{ draft: true }, { published_at: null }, { tag_name: "v2.0.1" }, { prerelease: undefined }]) {
    assert.throws(() => validateRelease({ ...published, ...change }, "v2.0.0"));
  }
  for (const tag of ["main", "v02.0.0", "v2.0.0-beta.01", "v2.0.0/other"]) {
    assert.throws(() => validateRelease({ ...published, tag_name: tag }, tag, true));
  }
});
test("preview requires authorization even if tag or metadata alone denotes preview", () => {
  for (const release of [{ ...published, prerelease: true }, { ...published, tag_name: "v2.0.0-beta.20" }]) {
    assert.throws(() => validateRelease(release, release.tag_name), /Preview integration/);
    assert.equal(validateRelease(release, release.tag_name, true).tag, release.tag_name);
  }
});
test("annotated tag is peeled and invalid object chains fail closed", async () => {
  const sha = "a".repeat(40), commit = "b".repeat(40);
  assert.equal(await peelTag({ type: "tag", sha }, async () => ({ object: { type: "commit", sha: commit } })), commit);
  await assert.rejects(peelTag({ type: "tag", sha }, async () => ({ object: { type: "tag", sha } })), /cyclic/);
  await assert.rejects(peelTag({ type: "tree", sha: commit }, async () => {}), /commit/);
  await assert.rejects(peelTag({ type: "commit", sha: "bad" }, async () => {}), /commit/);
});
test("a moved or stale local release ref is rejected", () => {
  assertPinnedCommit("a".repeat(40), "a".repeat(40));
  assert.throws(() => assertPinnedCommit("a".repeat(40), "b".repeat(40)), /differs/);
});
