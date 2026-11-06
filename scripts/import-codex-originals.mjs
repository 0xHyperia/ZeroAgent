import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const embedded = join(root, "crates/agent-gateway/internal/account/codex-packages");
const codex = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const lock = JSON.parse(readFileSync(join(embedded, "sources.json"), "utf8"));

function filesAt(base, relative = "") {
  const full = join(base, relative);
  const stat = lstatSync(full);
  if (stat.isDirectory()) {
    return readdirSync(full).flatMap((name) => filesAt(base, relative ? relative + "/" + name : name));
  }
  if (!stat.isFile()) throw new Error(`Non-regular path in Codex package: ${relative}`);
  return [relative];
}

function packageDigest(base, files) {
  const hash = createHash("sha256");
  for (const name of files) {
    hash.update(name + "\0");
    hash.update(createHash("sha256").update(readFileSync(join(base, name))).digest());
  }
  return hash.digest("hex");
}

const imports = Object.entries(lock).map(([id, spec]) => {
  const source = join(codex, spec.source);
  const dest = join(spec.local ? join(root, ".codex-originals") : embedded, id);
  const files = filesAt(source).sort();
  if (packageDigest(source, files) !== spec.sha256) {
    throw new Error(`Unexpected bytes in ${id}; verify the installed release before changing the pinned snapshot.`);
  }
  if (existsSync(dest) && packageDigest(dest, filesAt(dest).sort()) !== spec.sha256) {
    throw new Error(`Refusing to overwrite a different package at ${dest}.`);
  }
  return { id, source, dest, files };
});
for (const { id, source, dest, files } of imports) {
  for (const name of files) {
    const target = join(dest, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, name), target);
  }
  console.log(`${id}: ${files.length} original files verified and copied`);
}
