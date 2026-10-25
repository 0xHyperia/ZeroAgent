import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

test("password proof uses the bound verification endpoint without changing cookie sessions", async (t) => {
  const previous = { localStorage: globalThis.localStorage, window: globalThis.window };
  t.after(() => Object.assign(globalThis, previous));
  for (const [status, body, expectedStatus, expired] of [
    [200, { verified: true }, undefined, 0], [403, { error: "密码验证失败" }, 403, 0],
    [409, { error: "account mismatch" }, 409, 0], [401, { error: "session expired" }, 401, 1],
    [200, { verified: false }, 403, 0],
  ]) {
    await t.test(`${status}/${String(body.verified)}`, async () => {
      globalThis.localStorage = { getItem: () => null, setItem: () => assert.fail("password proof published a cookie mutation"), removeItem: () => assert.fail("password proof cleared storage") };
      globalThis.window = new EventTarget();
      let expiredEvents = 0;
      window.addEventListener("zeroagent:relay-session-expired", () => expiredEvents++);
      const requests = [];
      const loader = createTsModuleLoader({ rootDir: fileURLToPath(new URL("..", import.meta.url)), mocks: {
        "../accountRequest": {
          ACCOUNT_SESSION_STORAGE_KEY: "fixture-session",
          accountFetch: async (url, init) => { requests.push({ url, init }); return Response.json(body, { status }); },
          accountOwnerHeaders: () => ({ "X-ZeroAgent-Account-ID": "7" }),
          invalidateAccountRequests: () => assert.fail("password proof changed the account epoch"),
        },
      } });
      const client = loader.loadModule("src/lib/relay/client.ts");
      const proof = client.verifyRelayPassword(" a@example.test ", " fixture-password ");
      if (expectedStatus) await assert.rejects(proof, (error) => error.status === expectedStatus);
      else await proof;
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "/api/auth/verify-password");
      assert.equal(requests[0].init.credentials, "include");
      assert.deepEqual(JSON.parse(requests[0].init.body), { email: "a@example.test", password: " fixture-password " });
      assert.equal(expiredEvents, expired);
    });
  }
});
