// Internal, read-only protocol check. Never allocate a sandbox or print secrets.
const token = process.env.ZEROAGENT_CLOUD_EXECUTOR_TOKEN;
const port = process.env.ZEROAGENT_CLOUD_EXECUTOR_PORT || "17843";
if (!token || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    const body = response.ok ? await response.json() : null;
    process.exitCode = body?.service === "zeroagent-cloud-executor" && body.protocol === 1 && body.enabled === true ? 0 : 1;
  } catch {
    process.exitCode = 1;
  }
}
