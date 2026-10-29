// Explicit local-only container acceptance. No builds, pulls, published ports,
// real credentials or operations against existing Docker resources.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(directory, "../..");
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw Error("invalid_arguments");
  return args[index + 1];
}
for (let i = 0; i < args.length; i += 2) if (!["--image", "--output"].includes(args[i])) throw Error("invalid_arguments");
const task = randomUUID();
const short = task.replaceAll("-", "").slice(0, 16);
const label = "top.usa0.zeroagent.cloudchat-smoke";
const volume = `zeroagent-cloudchat-smoke-${short}`;
const output = resolve(option("--output", join(repository, ".codex-artifacts", "cloudchat-container-smoke-20261029", task)));
const log = join(output, "events.jsonl");
const token = randomBytes(32).toString("hex");
const rotatedToken = randomBytes(32).toString("hex");
const scopeKey = randomBytes(32).toString("hex");
const wrongScopeKey = randomBytes(32).toString("hex");
const secrets = [token, rotatedToken, scopeKey, wrongScopeKey];
const containers = new Map();
const envFiles = [];
let volumeCreated = false;
let failure;
const manifest = { format: 1, task_id: task, started_at: new Date().toISOString(), local_only: true, real_e2b_key: false, published_ports: false, stages: {}, resources: { volume, containers: [] }, cleanup: { containers: [], volume_removed: false, credential_files_removed: false }, complete: false };
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await mkdir(output, { recursive: false, mode: 0o700 });
function redact(text) { for (const secret of secrets) text = String(text).split(secret).join("[redacted]"); return String(text); }
function check(value, reason) { if (!value) throw Error(reason); }
async function event(phase, data = {}) { await appendFile(log, `${JSON.stringify({ at: new Date().toISOString(), phase, ...data })}\n`, { mode: 0o600 }); }
async function docker(arguments_, phase, { input, allowFailure = false, timeout = 20000, env = process.env } = {}) {
  const result = spawnSync("docker", arguments_, { input, env, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false });
  await event(phase, { exit_code: result.status, signal: result.signal, stderr: redact(result.stderr || "").slice(-2048) });
  if (!allowFailure && (result.error || result.status !== 0)) throw Error(`docker_${phase}_failed`);
  return { status: result.status, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}
async function inspect(name) { const result = await docker(["container", "inspect", "--format", "{{json .}}", name], "inspect_container", { allowFailure: true }); return result.status === 0 ? JSON.parse(result.stdout) : null; }
async function owned(name) {
  const info = await inspect(name);
  check(info?.Config?.Labels?.[label] === task && info.Name === `/${name}`, "container_ownership_changed");
  const expected = containers.get(name);
  if (expected) check(info.Id === expected, "container_identity_changed");
  return info;
}
async function envFile(stage, currentToken, currentScopeKey, oldToken) {
  const path = join(output, `${stage}.private.env`);
  const lines = [
    `ZEROAGENT_CLOUD_EXECUTOR_TOKEN=${currentToken}`,
    `ZEROAGENT_CLOUD_EXECUTOR_SCOPE_KEY=${currentScopeKey}`,
    `ZEROAGENT_CLOUD_EXECUTOR_NAMESPACE=zeroagent-smoke-${short}`,
    "ZEROAGENT_CLOUD_EXECUTOR_HOST=127.0.0.1",
    "ZEROAGENT_CLOUD_EXECUTOR_PORT=17843",
    "ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR=/var/lib/zeroagent/cloud-executor",
    "ZEROAGENT_E2B_API_KEY=", "ZEROAGENT_E2B_TEMPLATE=", "E2B_API_KEY=",
  ];
  if (oldToken) lines.push(`ZEROAGENT_SMOKE_OLD_TOKEN=${oldToken}`);
  await writeFile(path, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" }); envFiles.push(path); return path;
}
let imageRef;
async function launch(stage, environment, command = [], fixture = false) {
  const name = `zeroagent-smoke-${short}-${stage}`;
  containers.set(name, null);
  const flags = ["run", "--detach", "--pull", "never", "--name", name, "--hostname", `${stage}-${short}`, "--label", `${label}=${task}`, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", "10001:10001", "--pids-limit", "64", "--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=0700", "--mount", `type=volume,src=${volume},dst=/var/lib/zeroagent/cloud-executor`, "--env-file", environment];
  if (fixture) flags.push("--no-healthcheck");
  else flags.push("--health-interval", "2s", "--health-timeout", "2s", "--health-start-period", "1s", "--health-retries", "2");
  const result = await docker([...flags, imageRef, ...command], `launch_${stage}`);
  containers.set(name, result.stdout.trim());
  const info = await owned(name);
  check(info.HostConfig.ReadonlyRootfs && info.HostConfig.NetworkMode === "none" && info.HostConfig.Memory === 268435456 && info.HostConfig.MemorySwap === 268435456 && info.HostConfig.NanoCpus === 1000000000 && info.HostConfig.PidsLimit === 64, "docker_boundary_not_applied");
  check((info.HostConfig.CapDrop || []).includes("ALL") && (info.HostConfig.SecurityOpt || []).some((value) => value.startsWith("no-new-privileges")) && !Object.keys(info.HostConfig.PortBindings || {}).length, "privilege_or_port_boundary_missing");
  check(info.Mounts.some((mount) => mount.Type === "volume" && mount.Name === volume && mount.Destination === "/var/lib/zeroagent/cloud-executor"), "unexpected_persistent_volume");
  if (!fixture) check(info.Config.Healthcheck.Interval===2000000000 && info.Config.Healthcheck.StartPeriod===1000000000 && info.Config.Healthcheck.Retries===2,"healthcheck_override_not_applied");
  manifest.resources.containers.push({ name, id: info.Id, hostname: info.Config.Hostname, readonly_root: true, network_mode: "none", uid: info.Config.User, memory_bytes: info.HostConfig.Memory, pids_limit: info.HostConfig.PidsLimit, nano_cpus: info.HostConfig.NanoCpus });
  return name;
}
async function logs(name) { await owned(name); const result = await docker(["logs", name], "read_logs"); const combined = result.stdout + result.stderr; check(!secrets.some((secret) => combined.includes(secret)), "credential_logged"); await writeFile(join(output, `${name}.log`), redact(combined), { mode: 0o600 }); return combined; }
async function waitFor(predicate, reason, limit = 15000) { const until = Date.now() + limit; while (Date.now() < until) { const value = await predicate(); if (value) return value; await new Promise((accept) => setTimeout(accept,250)); } throw Error(reason); }
async function ready(name) { return waitFor(async () => { const info = await owned(name); if (!info.State.Running) { await logs(name); throw Error("main_exited_before_ready"); } const text = await logs(name); return text.includes('"enabled":false') ? true : false; }, "main_ready_timeout"); }
async function probe(name) { await owned(name); const result = await docker(["exec", "--interactive", "--user", "10001:10001", name, "node", "--input-type=module"], "run_protocol_probe", { input: await readFile(join(directory, "smoke", "probe.mjs"), "utf8") }); check(!secrets.some((secret) => result.stdout.includes(secret)), "probe_credential_leak"); return JSON.parse(result.stdout.trim()); }
async function stop(name) { await owned(name); await docker(["stop", "--time", "5", name], "graceful_stop"); const info = await owned(name); check(info.State.ExitCode === 0 && !info.State.OOMKilled, "main_did_not_stop_cleanly"); await logs(name); }

try {
  console.log(`CloudChat isolated container smoke ${task}: verifying local image`);
  const context = (await docker(["context", "show"], "context_show")).stdout.trim();
  const endpoint = JSON.parse((await docker(["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"], "context_endpoint")).stdout);
  for (const host of [endpoint, process.env.DOCKER_HOST].filter(Boolean)) check(host.startsWith("npipe://") || host.startsWith("unix://"), "local_docker_engine_required");
  check(JSON.parse((await docker(["info", "--format", "{{json .OSType}}"], "engine_os")).stdout) === "linux", "linux_engine_required");
  const image = JSON.parse((await docker(["image", "inspect", option("--image", "zeroagent-cloud-executor:cloudchat-local"), "--format", "{{json .}}"], "inspect_image")).stdout);
  check(image.Os === "linux" && image.Config.Healthcheck && !image.Config.Env.some((entry) => /^ZEROAGENT_E2B_API_KEY=.+/.test(entry)), "image_boundary_invalid");
  imageRef = image.RepoDigests?.[0] || image.Id;
  manifest.image = { id: image.Id, reference: imageRef, architecture: image.Architecture, size_bytes: image.Size, image_user: image.Config.User, healthcheck: image.Config.Healthcheck };
  manifest.host_sources_sha256 = {};
  for (const path of ["container-smoke.mjs", "smoke/fixture.mjs", "smoke/probe.mjs", "Executor.Dockerfile", "compose.yaml"]) manifest.host_sources_sha256[path] = createHash("sha256").update(await readFile(join(directory, path))).digest("hex");
  await docker(["volume", "create", "--label", `${label}=${task}`, volume], "create_volume"); volumeCreated = true;
  const fixtureCode = await readFile(join(directory, "smoke", "fixture.mjs"), "utf8");
  const a = await launch("a", await envFile("a", token, scopeKey), ["node", "--input-type=module", "--eval", fixtureCode], true);
  const fixture = await waitFor(async () => { const info = await owned(a); const text = await logs(a); if (!info.State.Running) throw Error("fixture_exited"); const line = text.split("\n").find((line) => line.startsWith("ZEROAGENT_SMOKE_READY ")); return line ? JSON.parse(line.slice("ZEROAGENT_SMOKE_READY ".length)) : null; }, "fixture_ready_timeout");
  for (const [path, actual] of Object.entries(fixture.source_sha256)) { const host = path === "executor-healthcheck.mjs" ? join(directory, path) : join(repository, "crates", "cloud-executor", path); check(createHash("sha256").update(await readFile(host)).digest("hex") === actual, "image_source_mismatch"); }
  manifest.stages.fixture = fixture;
  await owned(a); await docker(["kill", "--signal", "KILL", a], "true_sigkill");
  const killed = await owned(a); check(killed.State.ExitCode === 137 && !killed.State.OOMKilled, "fixture_not_true_sigkill");
  manifest.stages.true_sigkill = { exit_code: killed.State.ExitCode, oom_killed: false };
  console.log("Crash fixture killed; verifying persisted facts in replacement hostname");
  const bEnvironment=await envFile("b",token,scopeKey);
  const b = await launch("b", bEnvironment); await ready(b); manifest.stages.restart = await probe(b);
  const healthCommand=await docker(["exec",b,"node","/app/executor-healthcheck.mjs"],"disabled_healthcheck_command",{allowFailure:true}); check(healthCommand.status===1,"disabled_healthcheck_command_claimed_healthy");
  const unhealthy = await waitFor(async () => { const info = await owned(b); manifest.stages.disabled_healthcheck_observed={status:info.State.Health?.Status,failing_streak:info.State.Health?.FailingStreak}; return info.State.Health?.Status === "unhealthy" ? info : null; }, "disabled_healthcheck_not_unhealthy", 12000);
  manifest.stages.disabled_healthcheck = { status: unhealthy.State.Health.Status, failing_streak: unhealthy.State.Health.FailingStreak, last_exit_code: unhealthy.State.Health.Log.at(-1)?.ExitCode, interval_overridden_for_smoke_seconds: 2,start_period_overridden_for_smoke_seconds:1 };
  check(manifest.stages.disabled_healthcheck.last_exit_code === 1, "disabled_healthcheck_claimed_healthy");
  await stop(b);
  console.log("Verifying HTTP token rotation keeps stable journal authority");
  const c = await launch("c", await envFile("c", rotatedToken, scopeKey, token)); await ready(c); manifest.stages.token_rotation = await probe(c); await stop(c);
  const d = await launch("d", await envFile("d", rotatedToken, wrongScopeKey));
  const rejected = await waitFor(async () => { const info = await owned(d); return !info.State.Running ? info : null; }, "wrong_scope_did_not_exit");
  const wrongScopeLogs = await logs(d); check(rejected.State.ExitCode === 1 && wrongScopeLogs.includes("journal_authority_changed"), "wrong_scope_did_not_fail_closed");
  manifest.stages.wrong_scope = { exit_code: rejected.State.ExitCode, authority_change_rejected: true };
  await owned(c); await docker(["start", c], "restart_good_scope_after_rejection"); await ready(c); manifest.stages.good_scope_after_rejection = await probe(c); await stop(c);
  // Parse only: do not load production .env files or start any Compose service.
  const productionCompose=join(repository,"deploy","production","compose.yaml");
  const overlayCompose=join(directory,"compose.yaml");
  const composeText=await readFile(productionCompose,"utf8")+await readFile(overlayCompose,"utf8");
  const interpolatedNames=[...composeText.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match)=>match[1]);
  const composeEnvironment={...process.env,...Object.fromEntries(interpolatedNames.map((name)=>[name,""])),POSTGRES_IMAGE:"postgres:18-alpine",REDIS_IMAGE:"redis:8-alpine",APP_IMAGE:"zeroagent-gateway:smoke-config-only",POSTGRES_USER:"smoke",POSTGRES_PASSWORD:"synthetic-unused-password",POSTGRES_DB:"smoke",REDIS_PASSWORD:"synthetic-unused-redis",USA0_DATA_ROOT:join(output,"not-mounted"),USA_ZERO_ORIGIN:"https://usa0.top",USA_ZERO_AUTHORIZATION_ORIGIN:"https://usa0.top",ZEROAGENT_WEB_OAUTH_CLIENT_SECRET:"synthetic-unused-oauth",ZEROAGENT_GATEWAY_PUBLIC_ORIGIN:"https://smoke.invalid",ENV_FILE:bEnvironment,CLOUD_EXECUTOR_IMAGE:imageRef,CLOUD_EXECUTOR_ENV_FILE:bEnvironment,ZEROAGENT_CLOUD_EXECUTOR_TOKEN:token,ZEROAGENT_OBJECT_STORAGE_ENDPOINT:"https://objects.smoke.invalid",ZEROAGENT_OBJECT_STORAGE_BUCKET:"smoke-config-only",ZEROAGENT_OBJECT_STORAGE_REGION:"smoke-region",ZEROAGENT_OBJECT_STORAGE_ACCESS_KEY_ID:"synthetic-unused-access",ZEROAGENT_OBJECT_STORAGE_SECRET_ACCESS_KEY:"synthetic-unused-secret"};
  await docker(["compose","--project-name",`zeroagent-smoke-${short}`,"--env-file",bEnvironment,"-f",productionCompose,"-f",overlayCompose,"config","--quiet"],"compose_config_only",{env:composeEnvironment});
  manifest.stages.compose_config_only=true;
  manifest.complete = true;
} catch (error) {
  failure = error; manifest.failure = redact(error?.message || "smoke_failed");
  console.error(`CloudChat container smoke failed: ${manifest.failure}`);
} finally {
  console.log("Cleaning only task-labelled containers and volume");
  for (const [name] of [...containers].reverse()) {
    try { const info = await inspect(name); if (!info) continue; check(info.Config.Labels?.[label] === task && info.Name === `/${name}` && (!containers.get(name) || containers.get(name) === info.Id), "cleanup_container_ownership_changed"); await logs(name); await docker(["container", "rm", "--force", name], "remove_owned_container"); manifest.cleanup.containers.push(name); } catch (error) { failure ||= error; manifest.cleanup.failure = redact(error.message); }
  }
  if (volumeCreated) {
    try { const info = JSON.parse((await docker(["volume", "inspect", volume, "--format", "{{json .}}"], "inspect_owned_volume")).stdout); check(info.Name === volume && info.Labels?.[label] === task, "cleanup_volume_ownership_changed"); await docker(["volume", "rm", volume], "remove_owned_volume"); manifest.cleanup.volume_removed = true; } catch (error) { failure ||= error; manifest.cleanup.failure = redact(error.message); }
  }
  try {
    const remainingContainers=(await docker(["container","ls","--all","--filter",`label=${label}=${task}`,"--format","{{.ID}}"],"verify_owned_container_cleanup")).stdout.trim();
    const remainingVolumes=(await docker(["volume","ls","--filter",`label=${label}=${task}`,"--format","{{.Name}}"],"verify_owned_volume_cleanup")).stdout.trim();
    manifest.cleanup.no_labelled_resources_left=!remainingContainers && !remainingVolumes;
    check(manifest.cleanup.no_labelled_resources_left,"task_resources_not_cleaned");
  } catch(error) { failure ||= error; manifest.cleanup.failure=redact(error.message); }
  let credentialFilesRemoved=true;
  for (const file of envFiles) { try { await unlink(file); } catch (error) { credentialFilesRemoved=false; failure ||= error; } }
  manifest.cleanup.credential_files_removed = credentialFilesRemoved;
  manifest.complete &&= !failure;
  manifest.finished_at = new Date().toISOString();
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}
if (failure) process.exitCode = 1;
else console.log(`CloudChat isolated container smoke passed; manifest: ${join(output, "manifest.json")}`);
