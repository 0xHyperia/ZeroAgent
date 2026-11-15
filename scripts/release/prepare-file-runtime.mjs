import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawnSync } from "node:child_process";
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [sourceArgument, stageArgument, target, expectedManifestHash] = process.argv.slice(2);
const supported = new Set([
  "x86_64-pc-windows-msvc",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-unknown-linux-gnu",
]);
if (!sourceArgument || !stageArgument || !supported.has(target) || !/^[a-f0-9]{64}$/.test(expectedManifestHash ?? "")) {
  throw new Error("Usage: node prepare-file-runtime.mjs <prepared dependency tree> <new staging dir> <target> <manifest sha256>");
}

const source = await realpath(sourceArgument);
const stage = path.resolve(stageArgument);
if (stage === source || stage.startsWith(source + path.sep) || source.startsWith(stage + path.sep)) {
  throw new Error("Runtime staging and source trees must be separate");
}
const manifestBytes = await readFile(path.join(source, "runtime.json"));
if (createHash("sha256").update(manifestBytes).digest("hex") !== expectedManifestHash) {
  throw new Error("Runtime manifest checksum mismatch");
}
const manifest = JSON.parse(manifestBytes);
const components = ["node", "python", "git", "soffice", "pdfium", "tesseract", "cjk_font", "latin_font",
  "artifact_tool", "unzip", "heif_convert", "jxr_decoder"];
const sources = manifest.components ?? {};
const expected = manifest.files ?? {};
if (manifest.format !== 1 || manifest.target !== target || typeof manifest.tessdata !== "string") {
  throw new Error("Runtime manifest has the wrong format or target");
}
if (typeof manifest.artifact_tool !== "string" ||
    !manifest.artifact_tool.endsWith("node_modules/@oai/artifact-tool/dist/artifact_tool.mjs") ||
    !["2.8.145", "2.8.146"].includes(sources.artifact_tool?.version) || sources.node?.version !== "24.22.1") {
  throw new Error("Runtime must contain the pinned Node and Artifact Tool in their installed package layout");
}
for (const name of components) {
  const details = sources[name];
  if (!details?.version || !details?.license || !details?.source?.startsWith("https://") ||
      !Object.hasOwn(expected, details.license) || !Object.hasOwn(expected, manifest[name])) {
    throw new Error(`Runtime component metadata is incomplete: ${name}`);
  }
}
for (const language of ["eng", "chi_sim", "chi_tra"]) {
  if (!Object.hasOwn(expected, `${manifest.tessdata}/${language}.traineddata`)) {
    throw new Error(`Runtime OCR model is missing: ${language}`);
  }
}
const executableSuffix = target.includes("windows") ? ".exe" : "";
if (typeof manifest.poppler_bin !== "string" || !sources.poppler?.version ||
    !sources.poppler.source?.startsWith("https://") || !Object.hasOwn(expected, sources.poppler.license) ||
    !["pdfinfo", "pdftoppm", "pdftotext", "pdfimages"].every((name) =>
      Object.hasOwn(expected, `${manifest.poppler_bin}/${name}${executableSuffix}`))) {
  throw new Error("Runtime Poppler metadata or executables are missing");
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const actual = new Set();
async function checkTree(directory, prefix = "") {
  for (const entry of await readdir(directory)) {
    const relative = prefix + entry;
    if (relative === "runtime.json") continue;
    if (relative === "tools" || !/^[^:\\]+$/.test(entry) || entry.endsWith(".") || entry.endsWith(" ")) {
      throw new Error(`Invalid dependency path: ${relative}`);
    }
    const filename = path.join(directory, entry);
    const info = await lstat(filename);
    if (info.isSymbolicLink() || await realpath(filename) !== filename) {
      throw new Error(`Linked runtime entries must be materialized: ${relative}`);
    }
    if (info.isDirectory()) {
      await checkTree(filename, relative + "/");
    } else if (!info.isFile() || await hashFile(filename) !== expected[relative]) {
      throw new Error(`Runtime file checksum mismatch: ${relative}`);
    } else {
      actual.add(relative);
    }
  }
}

await checkTree(source);
if (actual.size !== Object.keys(expected).length) throw new Error("Runtime manifest lists missing files");
await mkdir(stage);
const runtime = path.join(stage, "file-runtime");
await cp(source, runtime, { recursive: true, errorOnExist: true, force: false });
const tools = path.join(runtime, "tools");
await mkdir(tools);
const repoTools = fileURLToPath(new URL("../../crates/file-runtime/", import.meta.url));
for (const name of ["file_tool.py", "office.py", "document_review.py", "pdf_tools.py", "runtime_common.py", "artifact_tool.mjs"]) {
  await copyFile(path.join(repoTools, name), path.join(tools, name));
}
const runtimeEnvironment = {
  ...process.env,
  ZEROAGENT_FILE_NODE: path.join(runtime, manifest.node),
  ZEROAGENT_FILE_ARTIFACT_ENTRY: path.join(runtime, manifest.artifact_tool),
  ZEROAGENT_FILE_SOFFICE: path.join(runtime, manifest.soffice),
  ZEROAGENT_FILE_TESSERACT: path.join(runtime, manifest.tesseract),
  ZEROAGENT_FILE_CJK_FONT: path.join(runtime, manifest.cjk_font),
  ZEROAGENT_FILE_POPPLER_BIN: path.join(runtime, manifest.poppler_bin),
  ZEROAGENT_FILE_UNZIP: path.join(runtime, manifest.unzip),
  ZEROAGENT_FILE_GIT: path.join(runtime, manifest.git),
  ZEROAGENT_FILE_HEIF_CONVERT: path.join(runtime, manifest.heif_convert),
  ZEROAGENT_FILE_JXR_DECODER: path.join(runtime, manifest.jxr_decoder),
  ZEROAGENT_FILE_SKILL_ROOT: fileURLToPath(new URL("../../crates/agent-gateway/internal/account/skills/", import.meta.url)),
  RUNTIME_NODE: path.join(runtime, manifest.node),
  RUNTIME_PYTHON: path.join(runtime, manifest.python),
  RUNTIME_NODE_MODULES: path.join(runtime, path.dirname(manifest.artifact_tool), "../../.."),
  TESSDATA_PREFIX: path.join(runtime, manifest.tessdata),
};
const nodeVersion = spawnSync(runtimeEnvironment.ZEROAGENT_FILE_NODE, ["--version"], {
  env: runtimeEnvironment, encoding: "utf8", timeout: 10_000,
});
if (nodeVersion.status !== 0 || nodeVersion.stdout.trim() !== "v24.22.1") {
  throw new Error("The staged Node executable does not match the runtime lock", { cause: nodeVersion.error });
}
const probe = spawnSync(runtimeEnvironment.ZEROAGENT_FILE_NODE, [path.join(tools, "artifact_tool.mjs"), "--probe"], {
  env: runtimeEnvironment, encoding: "utf8", timeout: 30_000,
});
if (probe.status !== 0) throw new Error("The staged Artifact Tool failed to load", { cause: probe.error ?? probe.stderr });
const capabilities = JSON.parse(probe.stdout);
if (!capabilities.workbook || !capabilities.presentation) throw new Error("The staged Artifact Tool is incomplete");
const acceptance = spawnSync(path.join(runtime, manifest.python), ["-IB", path.join(repoTools, "test_file_tool.py")], {
  env: runtimeEnvironment, stdio: "inherit", timeout: 180_000,
});
if (acceptance.status !== 0) throw new Error("The staged file runtime failed its offline acceptance", { cause: acceptance.error });
const verifyInstalled = fileURLToPath(new URL("./verify-installed-file-runtime.mjs", import.meta.url));
const offlineRevision = spawnSync(process.execPath, [verifyInstalled, runtime], { stdio: "inherit", timeout: 260_000 });
if (offlineRevision.status !== 0) throw new Error("The staged runtime failed the clean-profile file acceptance", { cause: offlineRevision.error });
await writeFile(path.join(stage, "tauri.file-runtime.conf.json"), JSON.stringify({
  bundle: { resources: { [runtime]: "file-runtime" } },
}) + "\n", { flag: "wx" });
