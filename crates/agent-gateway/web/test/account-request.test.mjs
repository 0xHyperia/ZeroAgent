import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

function load() {
  return createTsModuleLoader({ rootDir: fileURLToPath(new URL("..", import.meta.url)) });
}

test("account assertions accompany local APIs and never external URLs", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const requests = [];
  globalThis.fetch = async (url, init) => { requests.push({ url, headers: new Headers(init.headers) }); return Response.json({}); };
  const api = load().loadModule("src/lib/accountRequest.ts");
  api.bindAccountRequests(1);
  await api.accountFetch("/api/web-chat/conversations");
  await api.accountFetch("https://external.example.test/api/models");
  assert.equal(requests[0].headers.get(api.ACCOUNT_OWNER_HEADER), "1");
  assert.equal(requests[1].headers.get(api.ACCOUNT_OWNER_HEADER), null);
  for (const id of [0, -1, NaN, 1.5]) assert.throws(() => api.bindAccountRequests(id));
});

test("an old account response is rejected before its 401 can expire a new login", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  let complete;
  globalThis.fetch = () => new Promise((resolve) => { complete = resolve; });
  const api = load().loadModule("src/lib/accountRequest.ts");
  api.bindAccountRequests(1);
  const pending = api.accountFetch("/api/environments");
  api.bindAccountRequests(2);
  complete(Response.json({ error: "expired old session" }, { status: 401 }));
  await assert.rejects(pending, /Account changed/);
});

test("a cookie owner mismatch is reported once per session revision", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  t.after(() => { globalThis.fetch = previousFetch; if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  globalThis.window = new EventTarget();
  globalThis.fetch = async () => Response.json({ error: "changed" }, { status: 409, headers: { "X-ZeroAgent-Account-Mismatch": "1" } });
  const api = load().loadModule("src/lib/accountRequest.ts");
  let events = 0;
  window.addEventListener(api.ACCOUNT_CHANGED_EVENT, () => events++);
  api.bindAccountRequests(1);
  await assert.rejects(api.accountFetch("/api/environments"), /another page/);
  await assert.rejects(api.accountFetch("/api/environments"), /another page/);
  assert.equal(events, 1);
  api.bindAccountRequests(2);
  await assert.rejects(api.accountFetch("/api/environments"), /another page/);
  assert.equal(events, 2);
});
