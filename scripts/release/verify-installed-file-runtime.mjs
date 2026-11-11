import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const argument = process.argv[2];
if (!argument) throw new Error("Usage: node verify-installed-file-runtime.mjs <installed file-runtime directory>");
const runtime = realpathSync(resolve(argument));
const manifest = JSON.parse(readFileSync(join(runtime, "runtime.json"), "utf8"));
if (manifest.format !== 1 || typeof manifest.python !== "string" || isAbsolute(manifest.python)) {
  throw new Error("Installed runtime manifest is invalid");
}
const python = realpathSync(join(runtime, manifest.python));
const member = relative(runtime, python);
if (!member || isAbsolute(member) || member === ".." || member.startsWith(`..${sep}`)) {
  throw new Error("Installed Python resolves outside the file runtime");
}
const scratch = mkdtempSync(join(tmpdir(), "zeroagent-installed-file-runtime-"));
try {
  const env = {
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
    HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch, XDG_CONFIG_HOME: scratch,
    PATH: scratch, PIP_NO_INDEX: "1",
  };
  const script = fileURLToPath(new URL("./verify-file-runtime.py", import.meta.url));
  const check = spawnSync(python, ["-IB", script, runtime], {
    env, cwd: scratch, stdio: "inherit", timeout: 90_000, windowsHide: true,
  });
  if (check.status !== 0) throw new Error("Installed file runtime acceptance failed", { cause: check.error });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
