import { randomBytes } from "node:crypto";
import { chown, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";

// Run once in an explicitly named private config directory, outside the repo.
// Exclusive creation never overwrites existing storage/account credentials.
const destination = process.argv[2];
if (!destination || process.argv.length !== 3) throw new Error("Usage: node scripts/cloud-space/init-seaweedfs.mjs /absolute/private/seaweedfs-config");
if (process.platform !== "win32" && process.getuid?.() !== 0) throw new Error("Create the private configuration as root so UID 10001 can read its own keys.");
if (!isAbsolute(destination)) throw new Error("Configuration directory must be absolute");
const directory = resolve(destination);
if (/[\r\n"'$`]/.test(directory)) throw new Error("Unsupported configuration path");
await mkdir(directory, { recursive: false, mode: 0o700 });
const accessKey = randomBytes(16).toString("hex");
const secretKey = randomBytes(32).toString("hex");
await writeFile(join(directory, "s3.json"), JSON.stringify({ identities: [{
  name: "zeroagent-storage", credentials: [{ accessKey, secretKey }],
  actions: ["Admin:zeroagent-space", "Read:zeroagent-space", "Write:zeroagent-space", "List:zeroagent-space", "Tagging:zeroagent-space"],
}] }), { flag: "wx", mode: 0o600 });
await writeFile(join(directory, "filer.toml"), '[leveldb2]\nenabled = true\ndir = "/data/filer"\n', { flag: "wx", mode: 0o600 });
const environment = {
  SEAWEEDFS_CONFIG_DIR: directory.replaceAll("\\", "/"),
  ZEROAGENT_OBJECT_STORAGE_ENDPOINT: "http://127.0.0.1:18333",
  ZEROAGENT_OBJECT_STORAGE_BUCKET: "zeroagent-space",
  ZEROAGENT_OBJECT_STORAGE_REGION: "us-east-1",
  ZEROAGENT_OBJECT_STORAGE_ACCESS_KEY_ID: accessKey,
  ZEROAGENT_OBJECT_STORAGE_SECRET_ACCESS_KEY: secretKey,
  ZEROAGENT_OBJECT_STORAGE_ALLOW_LOOPBACK_HTTP: "true",
};
await writeFile(join(directory, "gateway.private.env"), Object.entries(environment).map(([key, value]) => `${key}='${value}'`).join("\n") + "\n", { flag: "wx", mode: 0o600 });
if (process.platform !== "win32") {
  await chown(directory, 10001, 10001);
  for (const filename of ["s3.json", "filer.toml"]) await chown(join(directory, filename), 10001, 10001);
}
console.log(`Created private configuration in ${directory}. No values printed; no services started.`);
