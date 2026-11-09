// Project skills overrides and run-scoped MCP selection.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { changedWorkspaceSkillsOverrides, saveWorkspaceSkillsOverrides } =
  loader.loadModule("src/lib/kbrain/workspaceSkills.ts");
const { canonicalRunOptions } = loader.loadModule("src/pages/chat/turns/runKBrainConversationTurn");
const { getDefaultSettings, resolveWorkspaceResources, workspaceMcpServerIds } =
  loader.loadModule("src/lib/settings");

function withResources(entries) {
  const settings = getDefaultSettings();
  return {
    ...settings,
    skills: { ...settings.skills, enabled: true, selected: ["global-skill"] },
    system: { ...settings.system, workspaceResourceSettings: entries },
  };
}

function resource(mode, extra = {}) {
  return { mode, skillNames: [], mcpServerIds: [], projectPrompt: "", ...extra };
}

test("project skills changes are sent per workdir, and going back to inherit clears the override", () => {
  const before = withResources({
    "/work/a": resource("custom", { skillNames: ["one"] }),
    "/work/b": resource("off"),
  });
  const after = withResources({
    "/work/a": resource("inherit"),
    "/work/b": resource("off", { projectPrompt: "only the prompt changed" }),
    "/work/c": resource("custom", { skillNames: ["two"] }),
  });
  assert.deepEqual(changedWorkspaceSkillsOverrides(before, after), [
    { workdir: "/work/a", mode: "inherit", skillNames: [] },
    { workdir: "/work/c", mode: "custom", skillNames: ["two"] },
  ]);
  // A project that was removed from settings is cleared too.
  assert.deepEqual(changedWorkspaceSkillsOverrides(before, withResources({})), [
    { workdir: "/work/a", mode: "inherit", skillNames: [] },
    { workdir: "/work/b", mode: "inherit", skillNames: [] },
  ]);
});

function response(status, text = "") {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

test("saving project skills tries every project, skips missing folders and reports the first error", async () => {
  const bodies = [];
  const answers = {
    "/gone": response(422, "stat /gone: no such file or directory"),
    "/inherit-gone": response(422, "anything"),
    "/broken": response(500, "disk full"),
    "/ok": response(200),
  };
  const put = async (body) => {
    bodies.push(body);
    return answers[body.workdir];
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      saveWorkspaceSkillsOverrides(
        [
          { workdir: "/gone", mode: "off", skillNames: [] },
          { workdir: "/inherit-gone", mode: "inherit", skillNames: [] },
          { workdir: "/broken", mode: "custom", skillNames: ["one"] },
          { workdir: "/ok", mode: "custom", skillNames: ["two"] },
        ],
        { enabled: true, selected: ["global-skill"] },
        put,
      ),
      /disk full/,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(
    bodies.map((body) => body.workdir),
    ["/gone", "/inherit-gone", "/broken", "/ok"],
  );
  assert.deepEqual(bodies[3], {
    workdir: "/ok",
    enabled: true,
    selected: ["global-skill"],
    mode: "custom",
    skillNames: ["two"],
  });
  // Skill packs are left out so K-brain keeps them.
  assert.equal("packs" in bodies[3], false);
});

test("an agent run carries the project's MCP server choice; chat runs never do", () => {
  const settings = {
    ...withResources({
      "/custom": resource("custom", { mcpServerIds: ["docs", "disabled"] }),
      "/none": resource("custom"),
      "/off": resource("off"),
    }),
    mcp: {
      servers: [
        { id: "docs", enabled: true, transport: "stdio", command: "docs-mcp" },
        { id: "disabled", enabled: false, transport: "stdio", command: "x" },
        { id: "web", enabled: true, transport: "http", url: "https://mcp.example" },
      ],
      selected: [],
    },
  };
  const idsFor = (workdir) => {
    const mcpServerIds = workspaceMcpServerIds(resolveWorkspaceResources(settings, workdir));
    return canonicalRunOptions({ effectiveWorkdir: workdir, runtime: {}, mcpServerIds })
      .mcp_server_ids;
  };
  assert.equal(idsFor("/inherit"), undefined);
  assert.deepEqual(idsFor("/custom"), ["docs"]);
  assert.deepEqual(idsFor("/none"), ["liveagent:no-mcp-servers"]);
  assert.deepEqual(idsFor("/off"), ["liveagent:no-mcp-servers"]);

  const chat = canonicalRunOptions({ conversationCwd: "/off", runtime: {}, mcpServerIds: [] });
  assert.equal("mcp_server_ids" in chat, false);
});
