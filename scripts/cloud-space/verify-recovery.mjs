import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const taskID = randomBytes(8).toString("hex");
const name = `za-recovery-${taskID}`;
const directory = join(root, ".codex-artifacts", "space-seaweedfs-20261030", name);
const seaweed = "chrislusf/seaweedfs@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8";
const pgImage = "postgres:18.6-bookworm";
const redisImage = "redis:8.2.10-bookworm";
const secrets = Array.from({ length: 5 }, () => randomBytes(32).toString("hex"));
const sanitize = (value) => secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
const containers = [];
const volumes = [];
let helperImage = false;

async function run(executable, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd ?? root, env: { ...process.env, ...options.env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (data) => { output = (output + data.toString()).slice(-1024 * 1024); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), options.timeout ?? 120_000);
    child.on("error", reject);
    child.on("close", async (code) => {
      clearTimeout(timer);
      output = sanitize(output);
      if (options.log) await writeFile(join(directory, options.log), output);
      if (code === 0 || options.allowFailure) done(output.trim());
      else reject(new Error(`${executable} failed (${code}), ${options.log ?? "command"}: ${output.slice(-2500)}`));
    });
  });
}
async function start(service, args) {
  const container = `${name}-${service}`;
  await run("docker", ["run", "--detach", "--name", container, "--label", `zeroagent.recovery=${taskID}`, ...args]);
  containers.push(container);
  return container;
}
async function wait(service, args) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await run("docker", ["exec", service, ...args], { allowFailure: true });
    if (result.includes("READY")) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Recovery fixture ${service} readiness timed out`);
}

await mkdir(directory, { recursive: false });
await writeFile(join(directory, "postgres.private.env"), `POSTGRES_PASSWORD=${secrets[0]}\n`, { mode: 0o600 });
await writeFile(join(directory, "recovery.private.json"), JSON.stringify({ TaskID: taskID, SourceKey: secrets[1], SourceSecret: secrets[2], TargetKey: secrets[3], TargetSecret: secrets[4] }), { mode: 0o600 });
await writeFile(join(directory, "s3.json"), JSON.stringify({ identities: [
  { name: "source", credentials: [{ accessKey: secrets[1], secretKey: secrets[2] }], actions: ["Admin", "Read", "Write", "List", "Tagging"].map((action) => `${action}:za-backup-source-${taskID}`) },
  { name: "target", credentials: [{ accessKey: secrets[3], secretKey: secrets[4] }], actions: ["Admin", "Read", "Write", "List", "Tagging"].map((action) => `${action}:za-backup-target-${taskID}`) },
] }), { mode: 0o600 });
await writeFile(join(directory, "filer.toml"), '[leveldb2]\nenabled = true\ndir = "/data/filer"\n');
await writeFile(join(directory, "Verifier.Dockerfile"), `FROM node:24.14.1-bookworm-slim AS node\nFROM ${pgImage}\nCOPY --from=node /usr/local/bin/node /usr/local/bin/node\nUSER 10001:10001\nENTRYPOINT ["/verify.test"]\n`);
await writeFile(join(directory, "test.private.env"), [
  `ZEROAGENT_SEAWEEDFS_RECOVERY_CONFIG=/private/recovery.private.json`,
  `ZEROAGENT_SEAWEEDFS_RECOVERY_EVIDENCE=/evidence/receipt.json`,
  `ZEROAGENT_BACKUP_TEST_DATABASE_URL=postgres://postgres:${secrets[0]}@127.0.0.1:5432/postgres?sslmode=disable`,
  `ZEROAGENT_BACKUP_TEST_REDIS_URL=redis://127.0.0.1:6379/0`,
  `ZEROAGENT_BACKUP_TEST_NODE=/usr/local/bin/node`,
  `ZEROAGENT_BACKUP_TEST_PG_BIN=/usr/lib/postgresql/18/bin`,
  `ZEROAGENT_BACKUP_TEST_JOURNAL_HELPER=/repo/deploy/cloudchat/backup/journal.mjs`,
  `ZEROAGENT_BACKUP_TEST_LEDGER=/repo/crates/cloud-executor/src/ledger.ts`,
].join("\n") + "\n", { mode: 0o600 });

try {
  await run("go", ["test", "-c", "./internal/cloudbackup", "-o", join(directory, "verify.test")], { cwd: join(root, "crates", "agent-gateway"), env: { GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" }, log: "compile.log" });
  await run("docker", ["build", "--label", `zeroagent.recovery=${taskID}`, "--tag", name, "--file", join(directory, "Verifier.Dockerfile"), directory], { timeout: 180_000, log: "image-build.log" });
  helperImage = true;
  const pg = await start("postgres", ["--network", "none", "--env-file", join(directory, "postgres.private.env"), "--memory", "1g", "--cpus", "2", pgImage]);
  await wait(pg, ["/bin/sh", "-c", "pg_isready -h 127.0.0.1 -U postgres >/dev/null && echo READY"]);
  const redis = await start("redis", ["--network", `container:${pg}`, "--memory", "128m", redisImage, "redis-server", "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"]);
  await wait(redis, ["/bin/sh", "-c", "redis-cli -h 127.0.0.1 ping | sed 's/PONG/READY/'"]);
  const volume = `${name}-data`;
  await run("docker", ["volume", "create", "--label", `zeroagent.recovery=${taskID}`, volume]);
  volumes.push(volume);
  await run("docker", ["run", "--rm", "--network", "none", "--user", "0:0", "--entrypoint", "/bin/sh", "--mount", `type=volume,source=${volume},target=/data`, seaweed, "-c", "mkdir -p /data/master /data/volumes /data/filer && chown 10001:10001 /data /data/master /data/volumes /data/filer"]);
  const storage = await start("storage", ["--network", `container:${pg}`, "--user", "10001:10001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", "1g", "--cpus", "2", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=0700", "--mount", `type=volume,source=${volume},target=/data`, "--mount", `type=bind,source=${directory},target=/etc/seaweedfs,readonly`, seaweed, "server", "-dir=/data/volumes", "-master.dir=/data/master", "-ip=127.0.0.1", "-ip.bind=127.0.0.1", "-volume.port=18080", "-volume.max=16", "-master.volumeSizeLimitMB=128", "-filer", "-filer.exposeDirectoryData=false", "-filer.disableDirListing", "-s3", "-s3.port=18333", "-s3.ip.bind=127.0.0.1", "-s3.config=/etc/seaweedfs/s3.json", "-s3.port.iceberg=0", "-s3.port.lance=0"]);
  await wait(storage, ["/bin/sh", "-c", "test \"$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18333/)\" = 403 && echo READY"]);
  console.log("Isolated PostgreSQL, Redis and two authenticated SeaweedFS buckets ready; running production recovery engine.");
  await run("docker", ["run", "--rm", "--network", `container:${pg}`, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:rw,exec,nosuid,size=256m,uid=10001,gid=10001,mode=1777", "--env-file", join(directory, "test.private.env"), "--mount", `type=bind,source=${directory},target=/private,readonly`, "--mount", `type=bind,source=${directory},target=/evidence`, "--mount", `type=bind,source=${root},target=/repo,readonly`, "--mount", `type=bind,source=${join(directory, "verify.test")},target=/verify.test,readonly`, name, "-test.run=^TestCloudBackupSeaweedFSRecovery$", "-test.v", "-test.timeout=4m"], { timeout: 250_000, log: "recovery.log" });
  const evidence = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
  if (!evidence.restored || !evidence.source_preserved || !evidence.conditional_writes_verified) throw new Error("Recovery evidence incomplete");
  console.log(`Real SeaweedFS backup/restore verified; source bytes, organization, auth fences and no-overwrite preserved. Evidence: ${directory}`);
} finally {
  for (const container of [...containers].reverse()) {
    await run("docker", ["logs", container], { allowFailure: true, log: `${container}.log` });
    await run("docker", ["rm", "--force", container], { allowFailure: true });
  }
  for (const volume of volumes) await run("docker", ["volume", "rm", volume], { allowFailure: true });
  if (helperImage) await run("docker", ["image", "rm", name], { allowFailure: true });
}
