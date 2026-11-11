import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const argument = process.argv[2];
if (!argument) throw new Error("Usage: node verify-installed-file-runtime.mjs <installed file-runtime directory>");
const runtime = realpathSync(resolve(argument));
const manifest = JSON.parse(readFileSync(join(runtime, "runtime.json"), "utf8"));
if (manifest.format !== 1) throw new Error("Installed runtime manifest is invalid");

function runtimeMember(name, directory = false) {
  const entry = manifest[name];
  if (typeof entry !== "string" || !entry || isAbsolute(entry)) {
    throw new Error(`Installed runtime manifest is missing a valid ${name} entry`);
  }
  const absolute = realpathSync(join(runtime, entry));
  const member = relative(runtime, absolute);
  if (!member || isAbsolute(member) || member === ".." || member.startsWith(`..${sep}`)) {
    throw new Error(`Installed ${name} resolves outside the file runtime`);
  }
  const stat = statSync(absolute);
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`Installed ${name} has the wrong type`);
  }
  return absolute;
}

const python = runtimeMember("python");
const soffice = runtimeMember("soffice");
const poppler = runtimeMember("poppler_bin", true);
const scratch = mkdtempSync(join(tmpdir(), "zeroagent-installed-file-runtime-"));
try {
  const env = {
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
    HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch, XDG_CONFIG_HOME: scratch,
    PATH: scratch, PIP_NO_INDEX: "1",
    ZEROAGENT_FILE_SOFFICE: soffice, ZEROAGENT_FILE_POPPLER_BIN: poppler,
  };
  const script = fileURLToPath(new URL("./verify-file-runtime.py", import.meta.url));
  const check = spawnSync(python, ["-IB", script, runtime], {
    env, cwd: scratch, stdio: "inherit", timeout: 150_000, windowsHide: true,
  });
  if (check.status !== 0) {
    const reason = check.error?.message ?? check.signal ?? `exit ${check.status}`;
    throw new Error(`Installed file runtime acceptance failed (${reason})`, { cause: check.error });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
