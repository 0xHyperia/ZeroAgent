import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Disposable, authenticated storage acceptance. Never reads application keys or
// touches an existing bucket/container. Evidence contains no credentials.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const image = "chrislusf/seaweedfs@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8";
const taskID = randomBytes(8).toString("hex");
const name = `za-space-test-${taskID}`;
const volume = `${name}-data`;
const directory = join(root, ".codex-artifacts", "space-seaweedfs-20261030", taskID);
const secrets = [randomBytes(16).toString("hex"), randomBytes(32).toString("hex")];
const clean = (text) => secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function command(executable, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (data) => { output = (output + data.toString()).slice(-512 * 1024); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), options.timeout ?? 120_000);
    child.on("error", reject);
    child.on("close", async (code) => {
      clearTimeout(timer);
      const safe = clean(output);
      if (options.log) await writeFile(join(directory, options.log), safe);
      if (code === 0 || options.allowFailure) done(safe.trim());
      else reject(new Error(`${executable} exited ${code}; ${options.log ?? "command"}: ${safe.slice(-3000)}`));
    });
  });
}

await mkdir(directory, { recursive: true });
await writeFile(join(directory, "s3.json"), JSON.stringify({ identities: [{
  name: "disposable-acceptance",
  credentials: [{ accessKey: secrets[0], secretKey: secrets[1] }],
  actions: ["Admin", "Read", "Write", "List", "Tagging"].map((action) => `${action}:za-seaweed-test-${taskID}`),
}] }), { mode: 0o600 });
await writeFile(join(directory, "filer.toml"), '[leveldb2]\nenabled = true\ndir = "/data/filer"\n');
let createdVolume = false;
let createdContainer = false;
let verifiedStorage = false;
try {
  await command("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { log: "image.txt" });
  await command("docker", ["volume", "create", "--label", `zeroagent.acceptance=${taskID}`, volume]);
  createdVolume = true;
  await command("docker", ["run", "--rm", "--network", "none", "--user", "0:0", "--entrypoint", "/bin/sh", "--mount", `type=volume,source=${volume},target=/data`, image,
    "-c", "mkdir -p /data/master /data/volumes /data/filer && chown 10001:10001 /data /data/master /data/volumes /data/filer"]);
  await command("docker", ["run", "--detach", "--name", name, "--label", `zeroagent.acceptance=${taskID}`,
    "--user", "10001:10001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", "128", "--memory", "1g", "--cpus", "2", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=0700",
    "--mount", `type=volume,source=${volume},target=/data`, "--mount", `type=bind,source=${directory},target=/etc/seaweedfs,readonly`,
    "--publish", "127.0.0.1::18333", image, "server", "-dir=/data/volumes", "-master.dir=/data/master", "-ip=127.0.0.1", "-ip.bind=127.0.0.1",
    "-volume.port=18080", "-volume.max=16", "-master.volumeSizeLimitMB=128", "-filer", "-filer.exposeDirectoryData=false", "-filer.disableDirListing",
    "-s3", "-s3.port=18333", "-s3.ip.bind=0.0.0.0", "-s3.config=/etc/seaweedfs/s3.json", "-s3.port.iceberg=0", "-s3.port.lance=0"]);
  createdContainer = true;
  const binding = await command("docker", ["port", name, "18333/tcp"]);
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error("Unexpected storage listener");
  let endpoint = `http://${binding}`;
  const configPath = join(directory, "client.private.json");
  await writeFile(configPath, JSON.stringify({ Endpoint: endpoint, Bucket: `za-seaweed-test-${taskID}`, Region: "us-east-1", AccessKeyID: secrets[0], SecretAccessKey: secrets[1], TaskID: taskID }), { mode: 0o600 });
  async function ready() {
    const deadline = Date.now() + 90_000;
    let lastResult = "not listening";
    while (Date.now() < deadline) {
      try {
        // Unsigned root must deny anonymous access once IAM is initialized.
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(1500) });
        lastResult = `HTTP ${response.status}`;
        await response.arrayBuffer();
        if (response.status === 403) return;
        if (response.ok) throw new Error("Anonymous S3 root unexpectedly allowed");
      } catch (cause) {
        lastResult = cause.code ?? cause.message;
        if (cause.message === "Anonymous S3 root unexpectedly allowed") throw cause;
      }
      await delay(500);
    }
    throw new Error(`Authenticated storage readiness timed out: ${lastResult}`);
  }
  async function phase(value) {
    await command("go", ["test", "./test/cloudchat", "-run", "^TestSeaweedFSStorageContract$", "-count=1", "-timeout=4m", "-v"], {
      cwd: join(root, "crates", "agent-gateway"), timeout: 250_000, log: `${value}.log`,
      env: { ZEROAGENT_SEAWEEDFS_TEST_CONFIG_FILE: configPath, ZEROAGENT_SEAWEEDFS_TEST_PHASE: value, ZEROAGENT_SEAWEEDFS_TEST_EVIDENCE_FILE: join(directory, `${value}.json`) },
    });
    return JSON.parse(await readFile(join(directory, `${value}.json`), "utf8"));
  }
  await ready();
  await command("go", ["run", "./cmd/cloud-space-storage", "--create-bucket", "--verify-conditional-writes"], {
    cwd: join(root, "crates", "agent-gateway"), log: "initializer.log",
    env: {
      ZEROAGENT_OBJECT_STORAGE_ENDPOINT: endpoint,
      ZEROAGENT_OBJECT_STORAGE_BUCKET: `za-seaweed-test-${taskID}`,
      ZEROAGENT_OBJECT_STORAGE_REGION: "us-east-1",
      ZEROAGENT_OBJECT_STORAGE_ACCESS_KEY_ID: secrets[0],
      ZEROAGENT_OBJECT_STORAGE_SECRET_ACCESS_KEY: secrets[1],
      ZEROAGENT_OBJECT_STORAGE_ALLOW_LOOPBACK_HTTP: "true",
    },
  });
  const prepared = await phase("prepare");
  console.log(`SeaweedFS: uploaded and verified ${prepared.object_bytes} bytes; restarting persistent storage.`);
  await command("docker", ["restart", "--time", "20", name]);
  const restartedBinding = await command("docker", ["port", name, "18333/tcp"]);
  if (!/^127\.0\.0\.1:\d+$/.test(restartedBinding)) throw new Error("Unexpected restarted storage listener");
  endpoint = `http://${restartedBinding}`;
  await writeFile(configPath, JSON.stringify({ Endpoint: endpoint, Bucket: `za-seaweed-test-${taskID}`, Region: "us-east-1", AccessKeyID: secrets[0], SecretAccessKey: secrets[1], TaskID: taskID }), { mode: 0o600 });
  await ready();
  const verified = await phase("verify");
  await writeFile(join(directory, "receipt.json"), JSON.stringify({ image, taskID, persistentRestart: true, prepared, verified }, null, 2));
  verifiedStorage = true;
  console.log(`SeaweedFS: restart, account isolation, conditional writes and deletion verified. Evidence: ${directory}`);
} finally {
  if (createdContainer) {
    await command("docker", ["logs", name], { allowFailure: true, log: "storage.log" });
    if (!process.argv.includes("--keep") || !verifiedStorage) await command("docker", ["rm", "--force", name], { allowFailure: true });
  }
  if (createdVolume && (!process.argv.includes("--keep") || !verifiedStorage)) await command("docker", ["volume", "rm", volume], { allowFailure: true });
  if (verifiedStorage && process.argv.includes("--keep")) console.log(`Kept only disposable fixture ${name}, volume ${volume}. Private client config: ${join(directory, "client.private.json")}`);
}
