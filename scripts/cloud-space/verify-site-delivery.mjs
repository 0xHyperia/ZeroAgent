import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const index = process.argv.indexOf("--seaweed-config");
if (index < 0 || !process.argv[index + 1])
  throw new Error(
    "Provide --seaweed-config pointing to an isolated SeaweedFS client.private.json.",
  );
const storagePath = resolve(process.argv[index + 1]);
const storage = JSON.parse(await readFile(storagePath, "utf8"));
const task = randomBytes(8).toString("hex");
const name = "za-site-delivery-" + task;
const directory = join(root, ".codex-artifacts", "space-seaweedfs-20261030", name);
await mkdir(directory, { recursive: true });
const password = randomBytes(32).toString("hex");
const redact = (value) =>
  [password, storage.AccessKeyID, storage.SecretAccessKey]
    .filter(Boolean)
    .reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
async function run(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk) => {
      output = (output + chunk.toString()).slice(-2 * 1024 * 1024);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => child.kill(), options.timeout ?? 30_000);
    child.on("error", reject);
    child.on("close", async (code) => {
      clearTimeout(timer);
      output = redact(output);
      try {
        if (options.log) await writeFile(join(directory, options.log), output);
        if (code === 0 || options.allowFailure) done({ code, output: output.trim() });
        else reject(new Error(command + " failed (" + code + "): " + output.slice(-1800)));
      } catch (error) {
        reject(error);
      }
    });
  });
}
let created = false;
try {
  const privateEnv = join(directory, "postgres.private.env");
  await writeFile(privateEnv, "POSTGRES_PASSWORD=" + password + "\n", { mode: 0o600 });
  await run("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    "zeroagent.fixture=site-delivery",
    "--label",
    "zeroagent.task=" + task,
    "--publish",
    "127.0.0.1::5432",
    "--env-file",
    privateEnv,
    "--tmpfs",
    "/var/lib/postgresql",
    "postgres:18.6-bookworm",
  ]);
  created = true;
  const binding = (await run("docker", ["port", name, "5432/tcp"])).output;
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error("Unexpected PostgreSQL listener.");
  const dsn = "postgres://postgres:" + password + "@" + binding + "/postgres?sslmode=disable";
  await writeFile(join(directory, "database.private.json"), JSON.stringify({ dsn }), {
    mode: 0o600,
  });
  const deadline = Date.now() + 40_000;
  for (;;) {
    const ready = await run("docker", ["exec", name, "pg_isready", "-U", "postgres"], {
      allowFailure: true,
    });
    if (ready.code === 0) break;
    if (Date.now() > deadline) throw new Error("Owned PostgreSQL failed readiness.");
    await new Promise((done) => setTimeout(done, 500));
  }
  console.log(
    "Owned PostgreSQL ready; verifying guest delivery, SeaweedFS and persistence contracts.",
  );
  await run(
    "go",
    [
      "test",
      "./internal/account",
      "./internal/cloudexecutor",
      "./internal/cloudsite",
      "./internal/server",
      "./cmd/gateway",
      "-count=1",
      "-timeout=2m",
    ],
    {
      cwd: join(root, "crates", "agent-gateway"),
      timeout: 150_000,
      log: "gateway-regression.log",
      env: {
        ZEROAGENT_CLOUD_RUN_TEST_DATABASE_URL: dsn,
        ZEROAGENT_SITE_DELIVERY_TEST_CONFIG: storagePath,
        ZEROAGENT_SITE_DELIVERY_TEST_EVIDENCE: join(directory, "delivery-receipt.json"),
      },
    },
  );
  console.log(
    "Verified actual Linux site build, production packager and SeaweedFS delivery. Evidence: " +
      directory,
  );
} finally {
  if (created) {
    const labels = JSON.parse(
      (await run("docker", ["inspect", name, "--format", "{{json .Config.Labels}}"])).output,
    );
    if (
      labels["zeroagent.fixture"] !== "site-delivery" ||
      labels["zeroagent.task"] !== task ||
      !/^za-site-delivery-[a-f0-9]{16}$/.test(name)
    )
      throw new Error("Refusing cleanup of a container without exact fixture ownership.");
    await run("docker", ["rm", "--force", "--volumes", name]);
    console.log(
      "Removed only the owned PostgreSQL fixture; existing services and SeaweedFS preserved.",
    );
  }
}
