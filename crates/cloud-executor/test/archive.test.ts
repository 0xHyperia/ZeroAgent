import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { archiveExtractor, archiveInput } from "../src/file-broker.ts";
import { readConfig } from "../src/config.ts";
import { operation } from "../src/protocol.ts";

test("archive.extract protocol fixes fields, paths, source digest and stdin transport", () => {
  const cfg = readConfig({ ZEROAGENT_CLOUD_EXECUTOR_TOKEN: "test-only-archive-0123456789-abcdef-0123456789", ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR: tmpdir() });
  const input = { path: "uploads/code-task.zip", destination: "source", source_sha256: "a".repeat(64) };
  const raw = { operation_id: "extract-one", owner_scope: "account-one", workspace_ref: "workspace-one", sandbox_id: "sandbox-one", action: "archive.extract", input };
  assert.equal(operation(raw, cfg).action, "archive.extract");
  for (const path of ["/abs", "../escape", "C:/drive", "x\\y", "x\0y", "x\ny", "x\u0085y", "a//b", "x:stream", ".zeroagent-archive-x/file", "e\u0301", Array(34).fill("a").join("/")]) {
    for (const key of ["path", "destination"]) assert.throws(() => operation({ ...raw, input: { ...input, [key]: path } }, cfg), /invalid_path/);
  }
  assert.throws(() => operation({ ...raw, input: { ...input, max_entries: 9999 } }, cfg), /unsupported_field/);
  assert.throws(() => operation({ ...raw, input: { ...input, source_sha256: "wrong" } }, cfg), /invalid_digest/);
  const invocation = archiveInput(input);
  assert(!invocation.command.includes(input.path));
  assert.deepEqual(JSON.parse(Buffer.from(invocation.input).toString()), input);
  assert(invocation.command.startsWith("python3 -I -c"));
});

const executable = process.platform === "win32" ? "wsl.exe" : "python3";
const prefix = process.platform === "win32" ? ["-d", "Ubuntu", "--", "python3"] : [];
const available = spawnSync(executable, [...prefix, "--version"], { timeout: 10000, windowsHide: true }).status === 0;
test("real isolated Linux ZIP guest extracts code as data and rejects traversal, bomb, CRC, links, collisions and limits atomically", { skip: !available }, () => {
  const harness = readFileSync(new URL("./archive-fixture.py", import.meta.url), "utf8");
  const output = execFileSync(executable, [...prefix, "-I", "-c", harness, Buffer.from(archiveExtractor).toString("base64")], { timeout: 120000, windowsHide: true, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  const result = JSON.parse(output);
  assert(result.passed);
  assert(result.cases.length >= 35);
  assert.equal(result.executed_archive_code, false);
});
