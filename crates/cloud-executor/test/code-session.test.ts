import assert from "node:assert/strict";
import { test } from "node:test";
import { Sandbox } from "@e2b/code-interpreter";
import { codeSession } from "../src/code-session.ts";
import { WorkspaceSandbox } from "../src/sandbox-access.ts";
import { sdkOptions } from "../src/sdk-options.ts";

test("code interpreter reuses the private VM capability without control-plane connect or TTL mutation", () => {
  const originalFetch = globalThis.fetch;
  const originalConnect = Sandbox.connect;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error("unexpected network call"); };
  Sandbox.connect = async () => { throw new Error("connect may extend TTL or resume"); };
  try {
    const sandbox = new WorkspaceSandbox({
      ...sdkOptions("never-send-test-key"),
      sandboxId: "sandbox-one",
      sandboxDomain: "e2b.app",
      envdVersion: "0.5.2",
      envdAccessToken: "private-envd-test",
      trafficAccessToken: "private-traffic-test",
    });
    const access = sandbox.access("0.5.2");
    const interpreter = codeSession(access, "never-send-test-key");
    assert.equal(interpreter.sandboxId, sandbox.sandboxId);
    assert.equal(interpreter.trafficAccessToken, "private-traffic-test");
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Sandbox.connect = originalConnect;
  }
});
