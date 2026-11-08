import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
const source = {
  id: ID,
  url: "https://example.com/start",
  final_url: "https://docs.example.com/final",
  title: "网页标题",
  snippet: "旧网页摘录",
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const load = () => createTsModuleLoader({
  rootDir: fileURLToPath(new URL("..", import.meta.url)),
}).loadModule("src/lib/cloudChatSources.ts");
const safe = () => () => undefined;

test("source links use one authenticated metadata read and reject a forged identity", async () => {
  const api = load();
  const calls = [];
  const client = api.createCloudChatSourcesClient(async (path, init) => {
    calls.push({ path, init });
    return Response.json({ source });
  }, safe);
  assert.deepEqual(await client.get(ID), {
    title: source.title, href: source.final_url, host: "docs.example.com",
  });
  assert.equal(calls[0].path, `/api/web-chat/sources/${ID}`);
  assert.equal(calls[0].init.credentials, "include");
  await assert.rejects(client.get("../secret"), /标识/);
  await assert.rejects(client.get("22222222-2222-4222-8222-222222222222"), /响应无效/);
  const result = api.createCloudChatSourcesClient(async () =>
    Response.json({ source: { ...source, final_url: undefined } }), safe);
  assert.equal((await result.get(ID)).href, source.url);
});

test("source metadata remains bound to the original account and limits response size", async () => {
  const api = load();
  let owner = 1;
  let release;
  const client = api.createCloudChatSourcesClient(async () => new Response(new ReadableStream({
    start(controller) {
      release = () => {
        owner = 2;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ source })));
        controller.close();
      };
    },
  })), () => {
    const captured = owner;
    return () => {
      if (captured !== owner) throw new Error("Account changed");
    };
  });
  const pending = client.get(ID);
  await Promise.resolve();
  release();
  await assert.rejects(pending, /Account changed/);
  const oversized = api.createCloudChatSourcesClient(async () =>
    new Response("x", { headers: { "Content-Length": String(64 * 1024 + 1) } }), safe);
  await assert.rejects(oversized.get(ID), /过大/);
  const failed = api.createCloudChatSourcesClient(async () =>
    Response.json({ error: "synthetic-secret-provider-body" }, { status: 503 }), safe);
  await assert.rejects(failed.get(ID), error =>
    error.status === 503 && !error.message.includes("synthetic-secret"));
});

test("source citations link to metadata and unsafe URLs stay blocked", () => {
  const api = load();
  assert.equal(
    api.linkCloudSourceCitations(`证据【来源:${ID}】`),
    `证据[来源](cloud-sources/${ID})`,
  );
  assert.equal(api.linkCloudSourceCitations(`【来源:${ID}:L1-L3】`), `【来源:${ID}:L1-L3】`);
  for (const url of ["javascript:alert(1)", "data:text/html,unsafe", "file:///secret",
    "https://user:password@example.com/", "https://example.com\\@elsewhere/"]) {
    assert.equal(api.cloudSourceExternalURL(url), null);
  }
});

test("the source dialog retries metadata and opens only the original URL", async (t) => {
  let revision = 0;
  let fail = true;
  const calls = [];
  const capture = () => {
    const account = revision;
    return () => {
      if (account !== revision) throw new Error("Account changed");
    };
  };
  const env = await createWebDomTestEnv({
    mocks: {
      "@/lib/accountRequest": { captureAccountRequestGuard: capture },
      "@liveagent/ui/i18n": { useLocale: () => ({ locale: "zh-CN" }) },
    },
  });
  const { createCloudChatSourcesClient } = env.loadModule("src/lib/cloudChatSources.ts");
  const { CloudChatSourceLinkDialog } = env.loadModule(
    "src/components/cloudchat/CloudChatSourceLinkDialog.tsx",
  );
  const client = createCloudChatSourcesClient(async (path) => {
    calls.push(path);
    return fail ? Response.json({}, { status: 503 }) : Response.json({ source });
  }, capture);
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  t.after(async () => {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  });
  await env.act(async () => {
    root.render(env.React.createElement(CloudChatSourceLinkDialog, {
      client, sourceId: ID, isCurrent: () => true, onClose: () => {}, onError: () => {},
    }));
    await tick();
  });
  assert.match(document.querySelector('[role="alert"]').textContent, /暂时无法读取/);
  assert.equal(document.querySelector('[role="dialog"] a'), null);
  fail = false;
  const retry = [...document.querySelectorAll('[role="dialog"] button')]
    .find(button => button.textContent === "重试");
  await env.act(async () => {
    retry.click();
    await tick();
  });
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /网页标题/);
  assert.match(dialog.textContent, /docs\.example\.com/);
  assert.doesNotMatch(dialog.textContent, /快照|旧网页摘录/);
  const link = dialog.querySelector("a");
  assert.equal(link.href, source.final_url);
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(link.target, "_blank");
  assert.deepEqual(calls, Array(2).fill(`/api/web-chat/sources/${ID}`));
  revision++;
  const click = new env.dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
  assert.equal(link.dispatchEvent(click), false);
});
