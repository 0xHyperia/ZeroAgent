import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const argument = process.argv[2];
if (!argument) throw new Error("Usage: node verify-installed-file-runtime.mjs <installed file-runtime directory>");
const runtime = realpathSync.native(resolve(argument));
const manifest = JSON.parse(readFileSync(join(runtime, "runtime.json"), "utf8"));
if (manifest.format !== 1) throw new Error("Installed runtime manifest is invalid");

function runtimeMember(name, directory = false) {
  const entry = manifest[name];
  if (typeof entry !== "string" || !entry || isAbsolute(entry)) {
    throw new Error(`Installed runtime manifest is missing a valid ${name} entry`);
  }
  const absolute = realpathSync.native(join(runtime, entry));
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
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "za-file-qa-"));
try {
  const env = {
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      ComSpec: process.env.ComSpec, PATHEXT: ".COM;.EXE;.BAT;.CMD" } : {}),
    HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch, XDG_CONFIG_HOME: scratch,
    // LibreOffice's POSIX launcher calls base utilities such as dirname and uname.
    // Python and both renderers still run by verified absolute path.
    PATH: process.platform === "win32" ? scratch : "/usr/bin:/bin", PIP_NO_INDEX: "1",
    ZEROAGENT_FILE_SOFFICE: soffice, ZEROAGENT_FILE_POPPLER_BIN: poppler,
  };
  const script = fileURLToPath(new URL("./verify-file-runtime.py", import.meta.url));
  let executable = python;
  let args = ["-IB", script, runtime];
  if (process.env.ZEROAGENT_REQUIRE_OFFLINE_FILE_QA === "1") {
    if (process.platform === "win32") {
      executable = process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
      const firewall = fileURLToPath(new URL("./file-runtime/windows-offline.ps1", import.meta.url));
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", firewall, runtime, python, script];
    } else if (process.platform === "darwin") {
      executable = "/usr/bin/sandbox-exec";
      const profile = `(version 1)
        (allow default)
        (deny network*)
        (deny system-socket (socket-domain AF_INET))
        (deny system-socket (socket-domain AF_INET6))
        (allow network* (local unix-socket (path-regex #"^/(private/)?(var/)?tmp/OSL_PIPE_")))
        (allow network* (remote unix-socket (path-regex #"^/(private/)?(var/)?tmp/OSL_PIPE_")))`;
      args = ["-p", profile, python, ...args];
    } else if (process.platform === "linux") {
      executable = "/usr/bin/sudo";
      const settings = Object.entries(env).map(([key, value]) => `${key}=${value}`);
      args = ["-n", "/usr/bin/unshare", "--net", "--setuid", String(process.getuid()),
        "--setgid", String(process.getgid()), "--", "/usr/bin/env", "-i", ...settings, python, ...args];
    } else {
      throw new Error(`Offline file-runtime QA is unavailable on ${process.platform}`);
    }
  }
  const check = spawnSync(executable, args, {
    env, cwd: process.platform === "win32" ? dirname(script) : scratch,
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 240_000, windowsHide: true,
  });
  if (check.status !== 0) {
    const reason = check.error?.message ?? check.signal ?? `exit ${check.status}`;
    throw new Error(`Installed file runtime acceptance failed (${reason})`, { cause: check.error });
  }
  if (!check.stdout.trim()) throw new Error("Bundled Python did not report an acceptance result");
  const proof = JSON.parse(check.stdout);
  if (relative(python, realpathSync.native(proof.python)) ||
      relative(soffice, realpathSync.native(proof.libreoffice)) ||
      ![proof.docx, proof.pdf, proof.word_render, proof.word_pdf].every((result) => result === "passed")) {
    throw new Error("Installed file runtime returned an incomplete acceptance result");
  }
  console.log(JSON.stringify(proof));
} catch (error) {
  console.error(error.message);
  throw error;
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}
