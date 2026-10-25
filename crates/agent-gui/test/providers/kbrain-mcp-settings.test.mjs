import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { fromKBrainMcpSettings, toKBrainMcpSettings } = createTsModuleLoader().loadModule("src/lib/kbrain/mcp.ts");

test("backend omitted MCP selection clears legacy selection instead of restricting newly configured servers", () => {
  const fallback = { servers: [{ id: "old", enabled: true }], selected: ["old"] };
  const settings = fromKBrainMcpSettings({ settings: { servers: [{ id: "new", enabled: true }] } }, fallback);
  assert.deepEqual(settings.servers.map(server => server.id), ["new"]);
  assert.deepEqual(settings.selected, []);
});

test("standard SSE configuration survives backend round trips without changing protocols", () => {
  const mcp = { servers: [{ id: "sse-server", enabled: true, transport: "sse", url: "https://mcp.example.test/sse" }], selected: ["sse-server"] };
  const wire = toKBrainMcpSettings(mcp);
  assert.equal(wire.servers[0].transport, "sse");
  assert.equal(fromKBrainMcpSettings({ settings: wire }, { servers: [], selected: [] }).servers[0].transport, "sse");
});
