import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

function clientWithResponse(response, onGuard = () => {}) {
  const loader = createWebModuleLoader({ mocks: {
    "./accountRequest": {
      accountFetch: async () => response,
      captureAccountRequestGuard: () => onGuard,
    },
  } });
  return loader.loadModule("src/lib/cloudImageSettings.ts").cloudImageSettings;
}

test("truncated image settings reads give an actionable message and a fresh read recovers", async () => {
  let reads = 0;
  const value = { provider_key_id: 0, model: "", version: 7 };
  const client = clientWithResponse({ ok: true, json: async () => {
    if (++reads === 1) throw new SyntaxError("Unexpected end of JSON input");
    return value;
  } });
  await assert.rejects(client(), { message: "暂时无法读取图像设置，请刷新后重试。" });
  assert.deepEqual(await client(), value);
  assert.equal(reads, 2);
});

test("an unreadable image settings save receipt is unconfirmed rather than a successful or retried write", async () => {
  let parses = 0;
  const client = clientWithResponse({ ok: true, json: async () => {
    parses++;
    throw new SyntaxError("Unexpected end of JSON input");
  } });
  await assert.rejects(client({ expected_version: 7, provider_key_id: 0, model: "" }), {
    message: "保存结果尚未确认，请刷新图像设置后核对。",
  });
  assert.equal(parses, 1);
});

test("malformed image settings payloads remain rejected with bounded recovery messages", async () => {
  for (const payload of [null, [], "bad response", { provider_key_id: -1, model: "", version: 7 }, { provider_key_id: 0, model: "" }]) {
    const client = clientWithResponse({ ok: true, json: async () => payload });
    await assert.rejects(client(), { message: "暂时无法读取图像设置，请刷新后重试。" });
  }
  const rejected = clientWithResponse({ ok: false, json: async () => ({ error: { message: "其他页面已修改，请刷新后重试。" } }) });
  await assert.rejects(rejected(), { message: "其他页面已修改，请刷新后重试。" });
});

test("account changes still retire an unreadable image settings response", async () => {
  const client = clientWithResponse({ ok: true, json: async () => {
    throw new SyntaxError("Unexpected end of JSON input");
  } }, () => { throw new Error("retired account"); });
  await assert.rejects(client(), { message: "retired account" });
});
