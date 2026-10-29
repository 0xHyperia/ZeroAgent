// Executes inside the unnetworked real image; HTTP is loopback only.
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";

const token = process.env.ZEROAGENT_CLOUD_EXECUTOR_TOKEN;
const owner = { owner_scope: "smoke-owner", workspace_ref: "smoke-workspace" };
const foreign = { owner_scope: "foreign-owner", workspace_ref: owner.workspace_ref };
const base = "http://127.0.0.1:17843";
let protocolRequests = 0;
function check(value, reason) { if (!value) throw Error(reason); }
async function request(path, status, { method = "GET", body, headers = {}, credential = token } = {}) {
  protocolRequests++;
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${credential}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(3000) });
  const text = await response.text();
  check(text.length < 65536 && response.status === status, `protocol_status_${status}`);
  for (const secret of [token, process.env.ZEROAGENT_CLOUD_EXECUTOR_SCOPE_KEY, process.env.ZEROAGENT_SMOKE_OLD_TOKEN]) if (secret) check(!text.includes(secret), "credential_reflection");
  check(!response.headers.has("access-control-allow-origin"), "internal_cors_surface");
  return JSON.parse(text);
}
const scope = new URLSearchParams(owner).toString();
const foreignScope = new URLSearchParams(foreign).toString();
await request("/v1/health", 401, { credential: "synthetic-invalid-token" });
await request("/v1/health", 401, { headers: { Origin: "https://smoke.invalid" } });
if (process.env.ZEROAGENT_SMOKE_OLD_TOKEN) await request("/v1/health", 401, { credential: process.env.ZEROAGENT_SMOKE_OLD_TOKEN });
const health = await request("/v1/health", 200);
check(health.service === "zeroagent-cloud-executor" && health.enabled === false && health.disabled_reason === "ZEROAGENT_E2B_API_KEY_missing" && health.journal.records === 2, "disabled_health_not_honest");
const unknown = await request(`/v1/operations/crash-checkpoint?${scope}`, 200);
check(unknown.state === "unknown" && unknown.error?.code === "process_interrupted" && unknown.result?.sandbox_id === "synthetic-checkpoint-vm" && unknown.result?.checkpoint_marker === "before-true-sigkill", "checkpoint_lost_or_reexecuted");
check(!("request_hash" in unknown) && !("scope_hash" in unknown), "private_facts_leaked");
const replay = await request("/v1/operations", 200, { method: "POST", body: { ...owner, operation_id: "crash-checkpoint", action: "sandbox.create" } });
check(replay.state === "unknown", "unknown_replay_changed_state");
const unacknowledged = await request("/v1/operations/crash-checkpoint/acknowledge", 409, { method: "POST", body: owner });
check(unacknowledged.error?.code === "operation_not_terminal", "unknown_ack_allowed");
await request(`/v1/operations/crash-checkpoint?${foreignScope}`, 404);
const retired = await request(`/v1/operations/retired-download?${scope}`, 410);
check(retired.error?.code === "operation_result_retired", "retired_tombstone_lost");
const download = { ...owner, operation_id: "retired-download", action: "file.download.chunk", sandbox_id: "synthetic-checkpoint-vm", input: { path: "fixture.bin", offset: 0, max_bytes: 786432 } };
await request("/v1/operations", 410, { method: "POST", body: download });
await request("/v1/operations", 409, { method: "POST", body: { ...download, input: { ...download.input, max_bytes: 64 } } });
await request("/v1/operations", 404, { method: "POST", body: { ...download, ...foreign } });
const disabled = await request("/v1/operations", 503, { method: "POST", body: { ...owner, operation_id: "must-not-allocate", action: "sandbox.create" } });
check(disabled.error?.code === "e2b_disabled", "disabled_adapter_admitted_work");
const after = await request("/v1/health", 200);
check(after.journal.records === 2 && after.journal.result_bytes < 10000, "disabled_request_changed_journal");
check(process.getuid() === 10001 && process.getgid() === 10001, "root_execution");
const status = await readFile("/proc/self/status", "utf8");
check(/^CapEff:\s+0+$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status), "privilege_restrictions_missing");
check(Object.keys(networkInterfaces()).every((name) => name === "lo"), "unexpected_network_interface");
let markerMissing = false;
try { await access("/tmp/smoke-transient-marker"); } catch (error) { markerMissing = error.code === "ENOENT"; }
check(markerMissing, "tmpfs_survived_container_replacement");
let rootWriteDenied = false;
try { await writeFile("/app/smoke-write-probe", "must fail"); } catch (error) { rootWriteDenied = ["EROFS", "EACCES"].includes(error.code); }
check(rootWriteDenied, "root_filesystem_writable");
const permissions = {};
for (const path of [process.env.ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR, `${process.env.ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR}/ownership.sqlite`, `${process.env.ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR}/receipts.sqlite`]) {
  const info = await stat(path);
  permissions[path] = { uid: info.uid, gid: info.gid, mode: (info.mode & 0o777).toString(8) };
  check(info.uid === 10001 && !(info.mode & 0o077), "unsafe_volume_permissions");
}
const memoryMax = (await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim();
const pidsMax = (await readFile("/sys/fs/cgroup/pids.max", "utf8")).trim();
const cpuMax = (await readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim();
check(memoryMax === "268435456" && pidsMax === "64" && cpuMax.split(" ")[0] === cpuMax.split(" ")[1], "cgroup_limits_missing");
console.log(JSON.stringify({ protocol_http_requests: protocolRequests, enabled: false, journal_records: after.journal.records, journal_result_bytes: after.journal.result_bytes, unknown_checkpoint_preserved: true, retired_id_not_reexecuted: true, foreign_scope_rejected: true, unknown_ack_rejected: true, token_rotation_verified: !!process.env.ZEROAGENT_SMOKE_OLD_TOKEN, e2b_allocations: 0, allocation_evidence: "disabled_before_admission_and_no_network_or_key", uid: process.getuid(), gid: process.getgid(), root_write_denied: rootWriteDenied, tmpfs_marker_absent: markerMissing, network_interfaces: Object.keys(networkInterfaces()), cgroup: { memory_max: memoryMax, pids_max: pidsMax, cpu_max: cpuMax }, permissions }));
