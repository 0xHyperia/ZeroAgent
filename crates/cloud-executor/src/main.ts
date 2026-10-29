import { readConfig } from "./config.ts";
import { E2BAdapter } from "./e2b-adapter.ts";
import { normalizedError } from "./protocol.ts";
import { Executor, httpServer } from "./service.ts";

try {
  const config = readConfig();
  const executor = new Executor(config, new E2BAdapter(config));
  await executor.init();
  const server = httpServer(executor);
  server.once("error", async () => {
    console.error("cloud-executor: listen_failed");
    await executor.close();
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    console.info(
      JSON.stringify({
        service: "zeroagent-cloud-executor",
        enabled: !!config.apiKey,
        address: server.address(),
      }),
    );
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    server.close();
    server.closeIdleConnections();
    await executor.close();
    server.closeAllConnections();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch (error) {
  console.error(JSON.stringify({ error: normalizedError(error) }));
  process.exitCode = 1;
}
