import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const load = () => createTsModuleLoader({ rootDir: fileURLToPath(new URL("..", import.meta.url)) }).loadModule("src/lib/cloudChatTranscript.ts");
const id = index => `91000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const resource = (index, more = {}) => ({ id: id(index), name: `报告-${index}.docx`, kind: "artifact", role: "output", version: index, ...more });
const tool = (index, resources, state = "succeeded") => ({ id: `tool:${index}`, type: "tool", round: 0, name: "publish_artifact", state, resources });
const message = blocks => ({ id: id(99), role: "assistant", content: "答复", presentation: { version: 1, state: "failed", blocks: [...blocks, { id: "text", type: "text", round: 0, text: "答复" }] } });

test("formal outputs remain visible after later model failure, prose truncation and snapshot restoration", () => {
  const api = load();
  const m = message([tool(1, [resource(1), resource(2, { kind: "site", family_id: id(10) })])]);
  m.content = "超长正文".repeat(10000);
  m.content_omitted = true;
  const items = api.cloudChatAssistantDeliverables(m);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(item => item.status), ["saved", "saved"]);
  assert.deepEqual(items.map(item => item.link.path), [`cloud-artifacts/${id(1)}`, `cloud-sites/${id(2)}`]);
  assert.deepEqual(api.cloudChatAssistantDeliverables(structuredClone(m)), items);
});

test("input/source references cannot become outputs and output versions dedupe only by immutable identity", () => {
  const api = load();
  const m = message([
    tool(1, [resource(1), resource(2, { family_id: id(10) }), resource(3, { family_id: id(10) })]),
    tool(2, [resource(1), resource(4, { kind: "file", role: "input" }), resource(5, { kind: "source", role: "source" }), resource(6, { kind: "file" })], "unknown"),
    tool(3, [resource(7)], "unknown"),
  ]);
  const items = api.cloudChatAssistantDeliverables(m);
  assert.deepEqual(items.map(item => item.id), [id(1), id(2), id(3), id(7)]);
  assert.equal(items[0].status, "saved");
  assert.equal(items[3].status, "unconfirmed");
  assert.deepEqual(api.cloudChatProcessResources(m.presentation).map(item => item.link.path), [`cloud-files/${id(4)}`, `cloud-sources/${id(5)}`]);
  const rounds = api.cloudChatAssistantRounds(m, { live: false, fallbackText: "答复", mapText: text => text });
  const item = rounds[0].blocks.find(block => block.kind === "tool" && block.item.toolCall.id === "tool:2").item;
  assert.deepEqual(item.publicStatus.resources.map(ref => ref.role), ["input", "source"]);
  assert.deepEqual(item.toolCall.arguments, {});
  assert.equal(item.toolResult, undefined);
});

test("resource projection ignores unsafe identifiers and never derives URLs or raw results from the tool", () => {
  const api = load();
  const m = message([tool(1, [resource(1, { url: "https://untrusted.example/private", path: "/etc/secret", arguments: "SECRET" }), resource(2, { id: "../../private" }), resource(3, { id: "https://untrusted.example" }), resource(4, { name: "" })])]);
  const items = api.cloudChatAssistantDeliverables(m);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].link, { path: `cloud-artifacts/${id(1)}`, source: "relative" });
  assert.doesNotMatch(JSON.stringify(items), /untrusted|SECRET|\/etc/);
});

test("shared output cards open fixed identities, keep unknown honest, and reveal large result sets on demand", async t => {
  const nil = () => null;
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key, locale: "zh-CN" }) },
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url))]: new Proxy({}, { get: () => nil }),
    [fileURLToPath(new URL("../../../agent-ui/src/components/chat/fileTypeIcons.tsx", import.meta.url))]: { getFileTypeIcon: () => nil },
  } });
  const { AssistantDeliverables } = env.loadModule("@liveagent/ui/components/chat/AssistantDeliverables.tsx");
  const host = document.body.appendChild(document.createElement("div")), root = env.createRoot(host), opened = [];
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); });
  const items = load().cloudChatAssistantDeliverables(message([tool(1, Array.from({length: 21}, (_, index) => resource(index + 1)), "unknown")]));
  await env.act(async () => root.render(env.React.createElement(AssistantDeliverables, { items, onOpenFileLink: link => opened.push(link) })));
  assert.equal(host.querySelectorAll("[data-assistant-deliverable]").length, 8);
  assert.match(host.textContent, /chat.tool.unknown/);
  assert.doesNotMatch(host.textContent, /chat.deliverables.saved/);
  await env.act(async () => host.querySelector("[data-assistant-deliverable]").click());
  assert.deepEqual(opened, [{ path: `cloud-artifacts/${id(1)}`, source: "relative" }]);
  await env.act(async () => [...host.querySelectorAll("button")].find(button => button.textContent.includes("chat.deliverables.next")).click());
  assert.equal(host.querySelectorAll("[data-assistant-deliverable]").length, 8);
  assert.match(host.textContent, /9–16 \/ 21/);
  await env.act(async () => [...host.querySelectorAll("button")].find(button => button.textContent.includes("chat.deliverables.next")).click());
  assert.equal(host.querySelectorAll("[data-assistant-deliverable]").length, 5);
  assert.match(host.textContent, /17–21 \/ 21/);
  await env.act(async () => root.render(env.React.createElement(AssistantDeliverables, { items })));
  assert.ok([...host.querySelectorAll("[data-assistant-deliverable]")].every(button => button.disabled));
});

test("public tool input/source references are accessible without exposing raw tool payloads", async t => {
  const nil = () => null;
  const env = await createWebDomTestEnv({ mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key, locale: "zh-CN" }) },
    [fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url))]: new Proxy({}, { get: () => nil }),
  } });
  const { PublicToolActivity } = env.loadModule("@liveagent/ui/components/chat/assistant-bubble/PublicToolActivity.tsx");
  const host = document.body.appendChild(document.createElement("div")), root = env.createRoot(host), opened = [];
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); });
  const input = load().cloudChatProcessResources(message([tool(1, [resource(4, { kind: "file", role: "input", name: "资料.xlsx" }), resource(5, { kind: "source", role: "source", name: "研究来源" })])]).presentation);
  const item = { toolCall: { id: "tool:1", name: "read_file", arguments: { token: "SECRET" } }, publicStatus: { label: "读取资料", state: "succeeded", resources: input } };
  await env.act(async () => root.render(env.React.createElement(PublicToolActivity, { item, onOpenFileLink: link => opened.push(link) })));
  assert.equal(host.querySelectorAll("button").length, 2);
  assert.doesNotMatch(host.textContent, /SECRET/);
  await env.act(async () => [...host.querySelectorAll("button")][1].click());
  assert.deepEqual(opened, [{ path: `cloud-sources/${id(5)}`, source: "relative" }]);
});
