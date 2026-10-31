import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { siteBundleInput, siteBundler } from "../src/file-broker.ts";
import { readConfig } from "../src/config.ts";
import { operation } from "../src/protocol.ts";

test("site.bundle takes only a selected build directory and fixed output path via isolated stdin", () => {
  const cfg = readConfig({
    ZEROAGENT_CLOUD_EXECUTOR_TOKEN: "test-site-bundler-0123456789abcdef-0123456789",
    ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR: tmpdir(),
  });
  const input = { path: "project/dist", output_path: `site-bundles/${"a".repeat(64)}.zip` };
  const raw = {
    operation_id: "site-one",
    owner_scope: "owner",
    workspace_ref: "work",
    sandbox_id: "guest",
    action: "site.bundle",
    input,
  };
  assert.equal(operation(raw, cfg).action, "site.bundle");
  for (const path of [
    ".",
    "../dist",
    "/dist",
    "node_modules",
    ".private",
    "project/.env",
    "site-bundles",
    "x%2fy",
    "x?y",
    "x#y",
  ]) {
    assert.throws(() => operation({ ...raw, input: { ...input, path } }, cfg), /invalid_path/);
  }
  assert.throws(
    () => operation({ ...raw, input: { ...input, output_path: "dist/site.zip" } }, cfg),
    /invalid_path/,
  );
  assert.throws(
    () => operation({ ...raw, input: { ...input, execute: true } }, cfg),
    /unsupported_field/,
  );
  const call = siteBundleInput(input);
  assert(call.command.startsWith("python3 -I -c"));
  assert(!call.command.includes(input.path));
  assert.deepEqual(JSON.parse(Buffer.from(call.input).toString()), input);
});
const executable = process.platform === "win32" ? "wsl.exe" : "python3";
const prefix = process.platform === "win32" ? ["-d", "Ubuntu", "--", "python3"] : [];
const available =
  spawnSync(executable, [...prefix, "--version"], { timeout: 10000, windowsHide: true }).status ===
  0;
test("actual Linux site packager excludes unrelated files and rejects links, hidden files, traversal, limits and overwrite", {
  skip: !available,
}, () => {
  const harness = readFileSync(new URL("./site-bundle-fixture.py", import.meta.url), "utf8");
  const output = execFileSync(
    executable,
    [...prefix, "-I", "-c", harness, Buffer.from(siteBundler).toString("base64")],
    { timeout: 120000, windowsHide: true, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  const result = JSON.parse(output);
  assert.equal(result.passed, true);
  assert(result.cases.length >= 35);
  assert.equal(result.executes_build_code, false);
  assert(Buffer.from(result.sample_zip_base64, "base64").length > 0);
});
