import assert from "node:assert/strict";
import test from "node:test";
import { validateUpstreamRelease } from "./upstream-release.mjs";

const stable = { repository: "Stack-Cairn/LiveAgent", tag: "v1.2.6", base_commit: "a".repeat(40), commit: "b".repeat(40) };
const preview = { ...stable, tag: "v2.0.0-beta.20", channel: "preview", prerelease: true,
  release_url: "https://github.com/Stack-Cairn/LiveAgent/releases/tag/v2.0.0-beta.20", published_at: "2026-10-21T12:35:14Z" };
test("existing stable metadata remains valid and exact pins are required", () => {
  assert.deepEqual(validateUpstreamRelease(stable), []);
  for (const tag of ["main", "v1.02.3", "v2.0.0-beta.01"]) assert.notEqual(validateUpstreamRelease({ ...stable, tag }).length, 0);
  assert.notEqual(validateUpstreamRelease({ ...stable, commit: "HEAD" }).length, 0);
  assert.notEqual(validateUpstreamRelease({ ...stable, repository: "other/LiveAgent" }).length, 0);
});
test("preview channel cannot silently become stable or lack published provenance", () => {
  assert.deepEqual(validateUpstreamRelease(preview), []);
  for (const change of [{ channel: "stable" }, { prerelease: false }, { release_url: "https://example.com" }, { published_at: null }]) {
    assert.notEqual(validateUpstreamRelease({ ...preview, ...change }).length, 0);
  }
  assert.notEqual(validateUpstreamRelease({ ...stable, tag: preview.tag }).length, 0);
});
