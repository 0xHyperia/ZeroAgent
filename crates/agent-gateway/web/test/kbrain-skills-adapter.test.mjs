import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

test("Web Skills uses typed backend RPC for listing, reading, settings and management", async () => {
  const calls = [];
  let fail = false;
  const loader = createWebModuleLoader({ mocks: {
    "../hubFetch": { hubFetch: () => { throw Error("Skills RPC must not fetch Hub directly"); } },
    "../lib/storage": { loadToken: () => "test-token" },
    "../lib/gatewaySocket": { getGatewayWebSocketClient: token => {
      assert.equal(token, "test-token");
      return { manageSkill: async body => {
        calls.push(body);
        if (fail) throw Error("backend unavailable");
        if (body.action === "list") return { rootDir: "/backend", skills: [], settings: { enabled: true, selected: [] } };
        if (body.action === "read") return { content: "Skill text", truncated: false };
        return { installJob: { phase: "completed" } };
      } };
    } },
  } });
  const adapter = loader.loadModule("src/agent-ui-adapters/kbrainSkills.ts").gatewaySkillsAdapter;
  assert.equal((await adapter.list("/project")).rootDir, "/backend");
  assert.equal((await adapter.read("one/SKILL.md", 3, 20)).content, "Skill text");
  await adapter.settings({ enabled: false, selected: [] });
  assert.equal((await adapter.manage({ action: "install_status", jobId: "job" })).installJob.phase, "done");
  assert.deepEqual(calls.slice(0, 3), [
    { action: "list", workdir: "/project" },
    { action: "read", path: "one/SKILL.md", offset: 3, length: 20 },
    { enabled: false, selected: [], action: "settings", configurationVersion: undefined },
  ]);
  fail = true;
  await assert.rejects(adapter.list(), /backend unavailable/);
});

test("Web Skills saves carry the actual read baseline without rereading or lending a newer version", async () => {
  const calls = [];
  const first = { settings: { enabled: true, selected: [] }, configurationVersion: '"read-a"' };
  const second = { settings: { enabled: true, selected: [] }, configurationVersion: '"read-b"' };
  const loader = createWebModuleLoader({ mocks: {
    "../hubFetch": { hubFetch: () => { throw Error("Skills RPC must not fetch Hub directly"); } },
    "../lib/storage": { loadToken: () => "test-token" },
    "../lib/gatewaySocket": { getGatewayWebSocketClient: () => ({
      manageSkill: async body => {
        calls.push(body);
        if (body.action === "list") return calls.length === 1 ? first : second;
        if (body.configurationVersion !== second.configurationVersion) {
          throw Error(body.configurationVersion ? "ZEROAGENT_CONFIGURATION_CHANGED (HTTP 412)" : "ZEROAGENT_CONFIGURATION_VERSION_REQUIRED (HTTP 428)");
        }
        return { settings: { enabled: false, selected: [] }, configurationVersion: '"saved-c"' };
      },
    }) },
  } });
  const adapter = loader.loadModule("src/agent-ui-adapters/kbrainSkills.ts").gatewaySkillsAdapter;
  const a = await adapter.list("/project-a");
  const b = await adapter.list("/project-b");
  const body = { workdir: "/project-b", enabled: false, selected: [] };
  await assert.rejects(adapter.settings(body, a), /CONFIGURATION_CHANGED/);
  await assert.rejects(adapter.settings(body), /VERSION_REQUIRED/);
  const saved = await adapter.settings(body, b);
  assert.equal(saved.configurationVersion, '"saved-c"');
  assert.deepEqual(calls.map(call => call.action), ["list", "list", "settings", "settings", "settings"]);
  assert.equal(calls[2].configurationVersion, '"read-a"');
  assert.equal(calls[3].configurationVersion, undefined);
  assert.equal(calls[4].configurationVersion, '"read-b"');
  assert.deepEqual(body, { workdir: "/project-b", enabled: false, selected: [] });
  assert.equal(a.configurationVersion, '"read-a"');
});
