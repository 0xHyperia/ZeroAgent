import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("password proof preserves OAuth credentials and rejects account changes", async (t) => {
  const previous = { fetch: globalThis.fetch, localStorage: globalThis.localStorage, window: globalThis.window };
  t.after(() => Object.assign(globalThis, previous));
  for (const [mode, expectedStatus, expectedLogins] of [
    ["correct", undefined, 1], ["two-factor", undefined, 1], ["wrong-password", 401, 1],
    ["different-user", 403, 1], ["wrong-email", 403, 0], ["empty-challenge", 403, 1],
    ["changed-during-proof", 409, 1], ["changed-during-user-read", 409, 0],
  ]) {
    await t.test(mode, async () => {
      const initial = {
        "zeroagent.relay.access-token": "oauth-access",
        "zeroagent.relay.refresh-token": "oauth-refresh",
        "zeroagent.relay.auth-kind": "oauth",
        "zeroagent.relay.oauth-client-id": "zeroagent-desktop",
        "zeroagent.relay.expires-at": String(Date.now() + 3_600_000),
      };
      const values = new Map(Object.entries(initial));
      globalThis.localStorage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
      };
      globalThis.window = new EventTarget();
      let sessionEvents = 0;
      window.addEventListener("zeroagent:relay-session-changed", () => sessionEvents++);
      window.addEventListener("zeroagent:relay-token-changed", () => sessionEvents++);
      const requests = [];
      globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/app/me")) {
          if (mode === "changed-during-user-read") values.set("zeroagent.relay.access-token", "new-account-access");
          return Response.json({ success: true, data: { id: 7, email: "a@example.test" } });
        }
        assert.ok(String(url).endsWith("/auth/login"));
        assert.equal(init.headers.Authorization, undefined);
        assert.deepEqual(JSON.parse(init.body), { email: "a@example.test", password: " fixture-password " });
        if (mode === "changed-during-proof") values.set("zeroagent.relay.access-token", "new-account-access");
        if (mode === "wrong-password") return Response.json({ code: 1, message: "密码验证失败" }, { status: 401 });
        const data = mode === "two-factor" || mode === "empty-challenge"
          ? { requires_2fa: true, temp_token: mode === "empty-challenge" ? "" : "temporary-challenge" }
          : { access_token: "temporary-password-access", refresh_token: "temporary-password-refresh", expires_in: 3600, user: { id: mode === "different-user" ? 8 : 7, email: "a@example.test" } };
        return Response.json({ code: 0, data });
      };
      const loader = createTsModuleLoader({ mocks: {
        "./accountProxy": { prepareAccountRequest: async (_origin, headers) => ({ baseUrl: "http://127.0.0.1:4567/proxy/hub/api/v1", headers }) },
        "./installation": { getInstallationID: () => "fixture-installation" },
      } });
      const client = loader.loadModule("src/lib/relay/client.ts");
      const proof = client.verifyRelayPassword(mode === "wrong-email" ? "b@example.test" : " a@example.test ", " fixture-password ");
      if (expectedStatus) await assert.rejects(proof, (error) => error.status === expectedStatus);
      else await proof;
      assert.equal(requests.filter((request) => request.url.endsWith("/auth/login")).length, expectedLogins);
      const expected = { ...initial, ...(mode.startsWith("changed-") ? { "zeroagent.relay.access-token": "new-account-access" } : {}) };
      assert.deepEqual(Object.fromEntries(values), expected);
      assert.equal(sessionEvents, 0);
    });
  }
});
