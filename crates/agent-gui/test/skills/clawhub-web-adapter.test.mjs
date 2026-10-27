import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("WebUI store preserves catalog, search and install parameters and nested registry metadata", async () => {
  const calls = [];
  const loader = createTsModuleLoader({
    rootDir: fileURLToPath(new URL("../../../agent-gateway/web/", import.meta.url)),
    mocks: {
      "../lib/storage": { loadToken: () => "fixture" },
      "../lib/gatewaySocket": { getGatewayWebSocketClient: () => ({ manageSkill: async (body) => {
        calls.push(body);
        if (body.action === "clawhub_install") return { action: body.action, installed: [{ name: body.slug }] };
        return { clawhubResults: [{ slug: "example", ownerHandle: "publisher", latestVersion: "2.3.4", topics: ["coding"], downloads: 12, stars: 3, installsCurrent: 7, updatedAt: 123 }], clawhubNextCursor: body.cursor ? null : "next+/=" };
      } }) },
    },
  });
  const adapter = loader.loadModule("src/agent-ui-adapters/kbrainSkills.ts").gatewaySkillsAdapter;
  const first = await adapter.storeSearch({ sort: "stars", limit: 2 });
  const second = await adapter.storeSearch({ sort: "stars", limit: 2, cursor: first.nextCursor });
  await adapter.storeSearch({ query: "code review", limit: 3, ownerHandle: "publisher" });
  const installed = await adapter.storeInstall({ slug: "example", ownerHandle: "publisher", version: "2.3.4", conflict: "fail" });
  assert.deepEqual(calls, [
    { sort: "stars", limit: 2, action: "clawhub_search" },
    { sort: "stars", limit: 2, cursor: "next+/=", action: "clawhub_search" },
    { query: "code review", limit: 3, ownerHandle: "publisher", action: "clawhub_search" },
    { slug: "example", ownerHandle: "publisher", version: "2.3.4", conflict: "fail", action: "clawhub_install" },
  ]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(first.items[0].topics, ["coding"]);
  assert.equal(first.items[0].installsCurrent, 7);
  assert.equal(first.items[0].updatedAt, 123);
  assert.equal(installed.installed[0].name, "example");
});
