import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const adapter = createTsModuleLoader().loadModule("src/lib/kbrain/mcp.ts");

test("MCP bootstrap preserves standard SSE and private settings through a backend roundtrip", () => {
  const input = {
    servers: [{ id: "remote", enabled: false, transport: "sse", command: "", args: [],
      url: "https://mcp.invalid/events",
      headers: { "X-Private": "user-header" }, auth: { type: "oauth", clientId: "client" } }],
    selected: ["remote"],
  };
  const original = structuredClone(input);
  const request = adapter.toKBrainMcpSettings(input);
  assert.equal(request.servers[0].transport, "sse");
  assert.equal(Object.hasOwn(request.servers[0], "messageUrl"), false);
  const restored = adapter.fromKBrainMcpSettings({ settings: JSON.parse(JSON.stringify(request)) }, input);
  assert.equal(restored.servers[0].transport, "sse");
  assert.equal(restored.servers[0].enabled, false);
  assert.equal(restored.servers[0].headers["X-Private"], "user-header");
  assert.deepEqual(input, original);
});

test("MCP bootstrap rejects retired endpoint overrides without echoing their value", () => {
  for (const transport of ["stdio", "http", "sse"]) {
    const input = { servers: [{ id: "remote", transport, messageUrl: "https://private.invalid/secret" }] };
    assert.throws(() => adapter.toKBrainMcpSettings(input), (error) =>
      error.message.includes("Message URL overrides are not supported") && !error.message.includes("private.invalid"));
  }
});
