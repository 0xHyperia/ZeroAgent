// Explicit Native integration probe. Third-party files stay inside the disposable
// profile; the probe reads instructions as bytes and never invokes the skill.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../helpers/load-ts-module.mjs";

test("ClawHub public registry through the real Native facade and both resource adapters", { timeout: 150_000 }, async () => {
  const connection = { baseUrl: process.env.ZEROAGENT_SKILL_PROBE_URL, token: process.env.ZEROAGENT_SKILL_PROBE_TOKEN, protocolVersion: "kbrain.agent.v1" };
  const phase = process.env.ZEROAGENT_CLAWHUB_PROBE_PHASE;
  assert.ok(connection.baseUrl && connection.token && phase);
  const loader = createTsModuleLoader({ mocks: { [fileURLToPath(new URL("../../../../agent-ui/src/lib/hubFetch.ts", import.meta.url))]: { hubFetch: fetch } } });
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection(connection);
  const adapter = loader.loadModule("src/agent-ui-adapters/kbrainSkills.ts").createKbrainSkillsAdapter();
  const host = loader.loadModule("@liveagent/ui/lib/resourceHost.ts");
  host.configureResourceHostCapabilities({ ...host.kbrainResourceHostCapabilities, skillsAdapter: adapter });
  const initial = await adapter.list();
  const installed = initial.skills.filter((item) => item.source?.registry === "clawhub");
  if (phase === "reopened") {
    assert.equal(installed.length, 1, "downloaded skill must survive backend restart");
    const item = installed[0];
    assert.ok(initial.settings.selected.includes(item.name), "enabled selection survives restart");
    assert.match((await adapter.read(item.skillFile)).content, /\S/);
    console.log(JSON.stringify({ phase, installed: item.name, source: item.source, selected: true }));
    return;
  }
  assert.equal(installed.length, 0, "fresh account must not inherit another profile's store installation");
  if (phase === "isolated") return;

  const store = loader.loadModule("@liveagent/ui/pages/skills-hub/skillStoreCache.ts");
  const api = loader.loadModule("@liveagent/ui/lib/skills/clawHub.ts");
  const skills = loader.loadModule("@liveagent/ui/lib/skills/index.ts");
  const summary = { phase, sorts: {}, search: 0 };
  for (const sort of ["downloads", "stars", "installs", "updated", "newest"]) {
    const page = await store.loadSkillStoreCatalog({ query: "", sort, limit: 2 });
    assert.ok(page.items.length <= 2);
    assert.ok(page.items.length || page.cursor, `${sort} must return items or a continuation cursor`);
    summary.sorts[sort] = page.items.length;
    if (sort === "downloads") {
      assert.ok(page.cursor, "catalog must supply the next page");
      const second = await store.loadMoreSkillStoreCatalog({ sort, cursor: page.cursor, limit: 2 });
      assert.ok(second.items.length > page.items.length, "load more must append distinct skills");
      assert.equal(new Set(second.items.map(api.buildClawHubSkillKey)).size, second.items.length);
      summary.paginated = second.items.length;
    }
  }
  const search = await store.loadSkillStoreCatalog({ query: "github", sort: "downloads", limit: 3 });
  assert.ok(search.items.length > 0 && search.items.length <= 3);
  assert.equal(search.cursor, null, "public keyword search has no cursor pagination");
  summary.search = search.items.length;
  const chosen = search.items.find((item) => item.slug === "github" && item.ownerHandle === "steipete");
  assert.ok(chosen, "use the known, public GitHub CLI instruction skill for the isolated install");
  const detail = await store.loadSkillStoreDetail(chosen);
  assert.equal(detail.detail.slug, chosen.slug);
  assert.equal(detail.detail.ownerHandle, chosen.ownerHandle);
  assert.ok(detail.detail.latestVersion, "resolve a hosted version from detail when public search omits version");
  const knownVersion = detail.detail.latestVersion;
  assert.match(chosen.webUrl, /\/steipete\/skills\/github$/);

  // Exercise the actual WebUI adapter's manageSkill payload against the real
  // facade. The socket transport itself has its own existing session/lease tests.
  const webLoader = createTsModuleLoader({
    rootDir: fileURLToPath(new URL("../../../../agent-gateway/web/", import.meta.url)),
    mocks: {
      "../lib/storage": { loadToken: () => "synthetic-web-session" },
      "../lib/gatewaySocket": { getGatewayWebSocketClient: () => ({ manageSkill: async (body) => {
        const response = await fetch(`${connection.baseUrl}/v1/skills/manage`, { method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      } }) },
    },
  });
  const web = webLoader.loadModule("src/agent-ui-adapters/kbrainSkills.ts").gatewaySkillsAdapter;
  assert.equal((await web.storeSearch({ sort: "stars", limit: 2 })).items.length, 2);
  assert.ok((await web.storeSearch({ query: "github", limit: 2 })).items.length > 0);

  const receipt = await adapter.storeInstall({ slug: chosen.slug, ownerHandle: chosen.ownerHandle, version: knownVersion, conflict: "fail" });
  assert.equal(receipt.installed.length, 1);
  await adapter.manage({ action: "delete", name: receipt.installed[0].name });
  const job = await skills.startSkillInstallJob({ source: api.buildClawHubDownloadUrl(chosen.slug, chosen.ownerHandle, chosen.latestVersion), ownerHandle: chosen.ownerHandle, slug: chosen.slug, version: chosen.latestVersion, conflict: "fail" });
  let status;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    status = await skills.getSkillInstallJobStatus(job.jobId);
    if (["done", "error", "cancelled"].includes(status.phase)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status.phase, "done", JSON.stringify(status));
  assert.ok(status.downloadedBytes > 0);
  const current = await adapter.list();
  const item = current.skills.find((skill) => skill.source?.ownerHandle === chosen.ownerHandle && skill.source?.slug === chosen.slug);
  assert.ok(item);
  assert.equal(item.source.version ?? null, chosen.latestVersion, "latest search installs preserve an unspecified version when the registry omits it");
  assert.match((await adapter.read(item.skillFile)).content, /\S/);
  await adapter.settings({ enabled: true, selected: [...current.settings.selected, item.name] }, current);
  console.log(JSON.stringify({ ...summary, installed: item.name, bytes: status.downloadedBytes, version: item.source.version, preview: true, webAdapter: true }));
});
