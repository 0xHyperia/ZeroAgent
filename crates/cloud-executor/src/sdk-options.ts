import type { ConnectionOpts } from "e2b";
export function sanitizeSdkEnvironment() {
  // This modifies only the dedicated adapter process/worker environment, never
  // the user's shell or config. No CLI profiles or implicit SDK credentials.
  for (const name of Object.keys(process.env))
    if (name.startsWith("E2B_")) delete process.env[name];
}
export function sdkOptions(apiKey: string): ConnectionOpts {
  return {
    apiKey,
    domain: "e2b.app",
    apiUrl: "https://api.e2b.app",
    debug: false,
    retries: 0,
    requestTimeoutMs: 15_000,
    httpVersion: "2",
  };
}
