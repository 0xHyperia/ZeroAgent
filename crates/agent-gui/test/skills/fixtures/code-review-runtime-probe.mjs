// Invoked by the Native runtime test while its real owned backend/facade are alive.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../../helpers/load-ts-module.mjs";

test("Skills Hub discovers, selects and invokes the shipped code review skill", { timeout: 60_000 }, async (t) => {
  const name = "zeroagent-code-review";
  const connection = { baseUrl: process.env.ZEROAGENT_SKILL_PROBE_URL, token: process.env.ZEROAGENT_SKILL_PROBE_TOKEN, protocolVersion: "kbrain.agent.v1" };
  const privateUrl = process.env.ZEROAGENT_SKILL_PROBE_PRIVATE_URL;
  const privateToken = process.env.ZEROAGENT_SKILL_PROBE_PRIVATE_TOKEN;
  const cwd = process.env.ZEROAGENT_SKILL_PROBE_WORKDIR;
  assert.ok(connection.baseUrl && connection.token && privateUrl && privateToken && cwd);
  const InstalledSkillCard = () => null;
  const loader = createTsModuleLoader({ mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "./InstalledSkillCard": { InstalledSkillCard },
  } });
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection(connection);
  const adapter = loader.loadModule("src/agent-ui-adapters/kbrainSkills.ts").createKbrainSkillsAdapter();
  const doc = await adapter.list(cwd);
  const skill = doc.skills.find((item) => item.name === name);
  assert.ok(skill, "the active backend must ship zeroagent-code-review, not just the unused Native directory");
  assert.equal(skill.builtIn, true);
  assert.equal(doc.settings.selected.includes(name), process.env.ZEROAGENT_SKILL_PROBE_REOPENED === "1", "startup must preserve selections without forcing this optional skill on");
  const { findCodeReviewSkill } = loader.loadModule("@liveagent/ui/lib/chat/useComposerActions.ts");
  assert.equal(findCodeReviewSkill(doc.skills), skill, "Git Review must find the actual built-in skill");
  const { InstalledSkillsView } = loader.loadModule("@liveagent/ui/pages/skills-hub/InstalledSkillsView.tsx");
  const view = InstalledSkillsView({
    items: [{ skill, categories: [] }], skillsEnabled: true, selected: new Set(doc.settings.selected),
    bulkSelection: new Set(), categoryCounts: new Map(), rootDir: doc.rootDir,
    loading: false, initialContentPending: false, bulkMode: false, hasSkills: true,
    loadError: null, category: "all", searchQuery: "", filter: "", deletingSkillName: null,
    onRescan() {}, onToggle() {}, onEnterBulkMode() {}, onToggleBulkSelection() {},
    onBulkCardClick() {}, onOpenPreview() {}, onDelete() {}, onSelectCategory() {},
  });
  function findCard(node) {
    if (!node || typeof node !== "object") return undefined;
    if (node.type === InstalledSkillCard) return node;
    for (const child of (Array.isArray(node) ? node : [node.props?.children])) {
      const card = findCard(child); if (card) return card;
    }
  }
  assert.equal(findCard(view)?.props.skill.name, name, "Skills Hub must render the backend item");
  const shipped = await readFile(new URL("../../../src-tauri/prompt/skills/zeroagent-code-review/SKILL.md", import.meta.url), "utf8");
  assert.equal((await adapter.read(skill.skillFile, 0, 200)).content, shipped);
  await adapter.settings({ enabled: true, selected: [...doc.settings.selected, name], workdir: cwd, mode: "custom", skillNames: [...doc.settings.selected, name] }, doc);
  assert.ok((await adapter.list(cwd)).settings.selected.includes(name));
  for (const body of [{ action: "delete", name }, { action: "create", name, description: "hostile overwrite", body: "changed", conflict: "overwrite" }]) {
    await assert.rejects(adapter.manage(body), /built-in skills cannot/);
  }

  const seen = [];
  let requestedReviewers = false;
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); seen.push(body);
    if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "[]" }, finish_reason: "stop" }] })); return; }
    const child = body.messages.some((message) => message.role === "system" && String(message.content).includes("You are a subagent inside k-brain"));
    const reports = body.messages.filter((message) => {
      if (message.role !== "tool") return false;
      try { return JSON.parse(message.content).complete === true; } catch { return false; }
    }).length;
    const read = body.messages.some((message) => message.role === "tool" && String(message.content).includes("Never write to GitHub"));
    let delta;
    if (child) delta = { content: JSON.stringify({ complete: true, reviewedFiles: ["fixture.txt"], findings: [] }) };
    else if (reports >= 4) delta = { content: "review-runtime-ok" };
    else if (read && !requestedReviewers) { requestedReviewers = true; delta = { tool_calls: ["rules-a", "rules-b", "bugs-a", "bugs-b"].map((role, index) => ({ index, id: `review-${role}`, type: "function", function: { name: "subagent", arguments: JSON.stringify({ description: `Review fixture ${role}`, prompt: `Review only this supplied snapshot: fixture.txt is unchanged. Do not call tools or edit files. Return JSON with complete=true, reviewedFiles=["fixture.txt"] and findings=[]. Role: ${role}`, background: false, worktree: false }) } })) }; }
    else if (read) delta = { content: "review-runtime-ok" };
    else delta = { tool_calls: [{ index: 0, id: "read-review-skill", type: "function", function: { name: "SkillsManager", arguments: JSON.stringify({ action: "read", path: skill.skillFile, length: 200 }) } }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(async () => { provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve)); });
  const configured = await fetch(`${privateUrl}/v1/settings`, { method: "PUT", headers: { Authorization: `Bearer ${privateToken}`, "content-type": "application/json" }, body: JSON.stringify({ providers: [{ id: "fixture", api: "openai-completions", baseUrl: `http://127.0.0.1:${provider.address().port}`, apiKey: "synthetic-review-key", models: [{ id: "fixture-model", contextWindow: 32768, maxOutputTokens: 512 }], activeModels: ["fixture-model"] }] }) });
  assert.equal(configured.status, 200, await configured.text());
  const client = loader.loadModule("src/lib/kbrain/client.ts").createKBrainClient(connection);
  const session = await client.createSession({ cwd, model: { provider: "fixture", model: "fixture-model" } });
  const accepted = await client.startRun({ conversation_id: session.id, client_request_id: `review-${process.pid}`, prompt: `/${name} Read this skill to verify the runtime connection.`, options: { mode: "agent", approval_policy: "ask", permission_mode: loader.loadModule("@liveagent/ui/lib/chat/permissionModes.ts").resolveKBrainPermissionMode("always"), workspace_roots: [{ path: cwd, access: "write" }] } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const events = []; const answers = [];
  try {
    await client.subscribe(session.id, 0, { onEvent(event) {
      events.push(event);
      if (event.type === "permission.requested") answers.push(client.resolvePermission(session.id, event.payload.permission_id, "allow_once", accepted.run_id));
      if (event.type === "run.completed" || event.type === "run.failed") controller.abort();
    }, onError(error) { throw error; } }, controller.signal).catch((error) => { if (!controller.signal.aborted) throw error; });
    await Promise.all(answers);
  } finally { clearTimeout(timer); }
  assert.ok(events.some((event) => event.type === "run.completed"), JSON.stringify(events));
  assert.ok(seen.some((body) => body.messages.some((message) => message.role === "system" && String(message.content).includes(name))), "selected skill must reach the backend model prompt");
  assert.ok(seen.some((body) => body.messages.some((message) => message.role === "tool" && String(message.content).includes("Never write to GitHub"))), "the real Go SkillsManager must read the shipped workflow during a run");
  const children = seen.filter((body) => body.stream && body.messages.some((message) => message.role === "system" && String(message.content).includes("You are a subagent inside k-brain")));
  const reviewerRoles = new Set(children.flatMap((body) => body.messages.filter((m) => m.role === "user").map((m) => String(m.content).match(/Role: ([a-z-]+)/)?.[1]).filter(Boolean)));
  assert.deepEqual([...reviewerRoles].sort(), ["bugs-a", "bugs-b", "rules-a", "rules-b"], "all four independent review roles must execute");
  const completedReports = seen.map((body) => body.messages.filter((message) => {
    if (message.role !== "tool") return false;
    try { return JSON.parse(message.content).complete === true; } catch { return false; }
  }).length);
  assert.equal(Math.max(...completedReports), 4, "all four logical review reports must return to the parent");
  for (const child of children) assert.ok(child.messages.every((message) => message.role !== "tool"), "reviewers must start with a fresh snapshot context");
});
