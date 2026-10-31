import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({ rootDir: fileURLToPath(new URL("..", import.meta.url)) });
const projection = loader.loadModule("src/lib/cloudChatPresentation.ts");
const runs = loader.loadModule("src/lib/cloudChatRuns.ts");
const history = loader.loadModule("src/lib/cloudChatHistory.ts");
const start = "2026-10-31T10:00:00.000Z";
const end = "2026-10-31T10:00:05.000Z";
const base = (more = {}) => ({
  id: "run-1", conversation_id: "conversation-1", client_request_id: "request-1",
  model: "test-model", state: "running", user_message_id: "u-1", assistant_message_id: "a-1",
  output: "", last_seq: "0", created_at: start, ...more,
});
const presentation = (blocks = [], more = {}) => ({ version: 1, blocks, ...more });
const text = (round = 0, value = "answer") => ({ id: `text:${round}`, type: "text", round, text: value, started_at: start });
const tool = (state = "executing", more = {}) => ({
  block_id: "tool:operation-1", tool_id: "operation-1", name: "publish_site", round: 0,
  state, status: "正在生成站点", started_at: start, ...more,
});
const event = (seq, type, data = {}) => ({ run_id: "run-1", seq: String(seq), type, data });
const apply = (run, type, data) => runs.reduceCloudChatRunEvent(run, event(BigInt(run.last_seq) + 1n, type, data));
const frame = (data, type = "cloud_run") => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const stream = (frames) => new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });

test("alternating content segments retain event order and per-round reasoning budget", () => {
  let run = base();
  for (const [type, id, delta] of [["reasoning.delta", "reasoning:0", "先思考"], ["message.delta", "text:0", "先回答"], ["reasoning.delta", "reasoning:0:2", "再思考"], ["message.delta", "text:0:2", "再回答"]]) {
    run = apply(run, type, {block_id:id,round:0,delta,started_at:start});
  }
  assert.deepEqual(run.presentation.blocks.map(block => block.id), ["reasoning:0", "text:0", "reasoning:0:2", "text:0:2"]);
  assert.equal(run.output,"先回答再回答");
  assert.deepEqual(projection.parseCloudChatPresentation(run.presentation),run.presentation);
  for (const id of ["text:0:1","text:0:02","text:0:0","text:1:2","reasoning:0:2"]) assert.throws(() => projection.parseCloudChatPresentation(presentation([{...text(),id}])));
  assert.throws(() => projection.parseCloudChatPresentation(presentation([{id:"reasoning:0",type:"reasoning",round:0,text:"x".repeat(600000)},{...text()},{id:"reasoning:0:2",type:"reasoning",round:0,text:"x".repeat(600000)}])));
});

test("tool output references survive stream completion and later run failure without retaining URLs or arguments", () => {
  const resource = {kind:"site",id:"94000000-0000-4000-8000-000000000001",family_id:"94000000-0000-4000-8000-000000000002",name:"私有预览站点",role:"output",mime:"text/html",version:2,url:"https://private/token",raw_result:"secret"};
  let run=apply(base(),"tool.completed",tool("succeeded",{resources:[resource],completed_at:end}));
  run=apply(run,"run.failed",{completed_at:end});
  const resources=run.presentation.blocks[0].resources;
  assert.equal(resources[0].id,resource.id);assert.equal(resources[0].family_id,resource.family_id);assert.equal(resources[0].url,undefined);assert.equal(resources[0].raw_result,undefined);
  const replayed=runs.reduceCloudChatRunEvent(run,event(run.last_seq,"tool.completed",tool("succeeded",{resources:[resource]})));
  assert.deepEqual(replayed.presentation.blocks[0].resources,resources);
  const restored=projection.parseCloudChatPresentation(run.presentation);assert.deepEqual(restored.blocks[0].resources,resources);
});

test("public tool resources validate immutable IDs, roles, limits, and Unicode display names",()=>{
  const valid={kind:"artifact",id:"94000000-0000-4000-8000-000000000001",name:"😀".repeat(240),role:"output",version:1};
  assert.equal(projection.parseCloudChatPresentationResources([valid])[0].name,valid.name);
  for(const value of [[{...valid,id:"../download"}],[{...valid,role:"execute"}],[{...valid,version:0}],[{...valid,name:"bad\nname"}],[valid,valid],Array.from({length:17},()=>valid)])assert.throws(()=>projection.parseCloudChatPresentationResources(value));
});

test("snapshots keep only public fields, detach mutable input and accept legacy runs", () => {
  const input = presentation([text()], {
    model: "test-model", reasoning_effort: "high", state: "completed",
    usage: { completion_tokens: 42, access_token: "private" },
    rounds: [{ round: 0, model: "test-model", usage: { prompt_tokens: 12 }, started_at: start, completed_at: end }],
    started_at: start, completed_at: end, access_token: "private",
  });
  input.blocks[0].raw_result = "private";
  const result = runs.parseCloudChatRun(base({ presentation: input }));
  input.blocks[0].text = "mutated";
  input.rounds[0].usage.prompt_tokens = 999;
  assert.equal(result.presentation.blocks[0].text, "answer");
  assert.equal(result.presentation.rounds[0].usage.prompt_tokens, 12);
  assert.deepEqual(result.presentation.usage, { completion_tokens: 42 });
  assert.ok(!JSON.stringify(result.presentation).includes("private"));
  assert.equal(runs.parseCloudChatRun(base()).presentation, undefined);
  assert.equal(runs.parseCloudChatRun(base({ presentation: null })).presentation, undefined);
});

test("reasoning, text, rounds and tool receipts form one ordered persistent projection", () => {
  let run = base();
  run = apply(run, "model.started", { round: 0, model: "test-model", started_at: start });
  run = apply(run, "reasoning.delta", { block_id: "reasoning:0", round: 0, delta: "先检查", started_at: start });
  const first = run;
  run = apply(run, "reasoning.delta", { block_id: "reasoning:0", round: 0, delta: "数据。", started_at: end });
  run = apply(run, "message.delta", { block_id: "text:0", round: 0, delta: "准备好了。", started_at: start });
  run = apply(run, "model.completed", { round: 0, model: "test-model", usage: { completion_tokens: 9 }, started_at: start, completed_at: end });
  run = apply(run, "tool.prepared", tool("prepared"));
  run = apply(run, "tool.started", tool());
  assert.equal(runs.cloudChatRunToolStatus(run), "正在生成站点");
  run = apply(run, "tool.completed", tool("succeeded", { status: "已完成", completed_at: end }));
  run = apply(run, "model.started", { round: 1, model: "test-model", started_at: end });
  run = apply(run, "message.delta", { block_id: "text:1", round: 1, delta: "已交付。", started_at: end });
  run = apply(run, "run.completed", { completed_at: end, usage: { completion_tokens: 15 } });
  assert.equal(run.output, "准备好了。已交付。");
  assert.equal(run.state, "completed");
  assert.deepEqual(run.active_tools, []);
  assert.deepEqual(run.presentation.blocks.map(block => block.id), ["reasoning:0", "text:0", "tool:operation-1", "text:1"]);
  assert.equal(run.presentation.blocks[0].text, "先检查数据。");
  assert.equal(run.presentation.blocks[0].started_at, start);
  assert.equal(first.presentation.blocks[0].text, "先检查");
  assert.equal(run.presentation.blocks[2].state, "succeeded");
  assert.equal(run.presentation.blocks[0].completed_at, start);
  assert.ok(run.presentation.blocks.slice(1).every(block => block.completed_at === end));
  assert.equal(run.presentation.rounds[0].usage.completion_tokens, 9);
  assert.equal(run.presentation.rounds[1].completed_at, end);
  assert.equal(run.presentation.usage.completion_tokens, 15);
  assert.equal(run.presentation.state, "completed");
  assert.deepEqual(projection.parseCloudChatPresentation(JSON.parse(JSON.stringify(run.presentation))), run.presentation);
});

test("reasoning ends at the first answer token and survives later model completion", () => {
  const answerAt = "2026-10-31T10:00:03.000Z";
  let run = apply(base(), "reasoning.delta", { block_id: "reasoning:0", round: 0, delta: "thinking", started_at: start });
  run = apply(run, "message.delta", { block_id: "text:0", round: 0, delta: "first", started_at: answerAt });
  run = apply(run, "message.delta", { block_id: "text:0", round: 0, delta: " last", started_at: end });
  run = apply(run, "model.completed", { round: 0, model: "test-model", completed_at: end });
  assert.equal(run.presentation.blocks[0].completed_at, answerAt);
  assert.equal(run.presentation.blocks[1].started_at, answerAt);
  assert.equal(run.presentation.blocks[1].completed_at, end);
  assert.deepEqual(projection.parseCloudChatPresentation(run.presentation), run.presentation);
});

test("sequence replay, gaps and run identity guard projection as well as text", () => {
  const initial = base({ last_seq: "9007199254740992" });
  const delta = event("9007199254740993", "reasoning.delta", { block_id: "reasoning:0", round: 0, delta: "once" });
  const once = runs.reduceCloudChatRunEvent(initial, delta);
  assert.equal(runs.reduceCloudChatRunEvent(once, delta), once);
  assert.equal(once.presentation.blocks[0].text, "once");
  assert.throws(() => runs.reduceCloudChatRunEvent(once, { ...delta, seq: "9007199254740995" }), /重新同步/);
  assert.throws(() => runs.reduceCloudChatRunEvent(once, { ...delta, run_id: "other" }), /身份/);
  assert.equal(initial.presentation, undefined);
});

test("legacy output stays visible when an active run first receives structured events", () => {
  const old = base({ output: "旧正文。" });
  const next = apply(old, "message.delta", { block_id: "text:0", round: 0, delta: "新正文。", started_at: end });
  assert.equal(next.output, "旧正文。新正文。");
  assert.deepEqual(next.presentation.blocks.map(block => [block.id, block.text]), [
    ["legacy:text", "旧正文。"], ["text:0", "新正文。"],
  ]);
  assert.deepEqual(projection.parseCloudChatPresentation(next.presentation), next.presentation);
  assert.equal(apply(old, "message.delta", { delta: "旧事件" }).presentation, undefined);
});

test("interrupted runs preserve partial thoughts and do not claim external tools were cancelled", () => {
  let run = apply(base(), "reasoning.delta", { block_id: "reasoning:0", round: 0, delta: "partial" });
  run = apply(run, "tool.started", tool());
  const final = apply(run, "run.interrupted", { completed_at: end, error_code: "cloud_cancellation_outcome_unknown" });
  assert.equal(final.presentation.blocks[0].text, "partial");
  assert.equal(final.presentation.blocks[1].state, "unknown");
  assert.equal(final.presentation.blocks[1].status, "结果待确认");
  assert.equal(final.presentation.completed_at, end);
  assert.equal(final.error_code, "cloud_cancellation_outcome_unknown");
  assert.equal(run.presentation.blocks[1].state, "executing");
});

test("tool transitions keep stable ownership, accept public site publication and reject private operations", () => {
  let run = apply(base(), "tool.started", tool());
  run = apply(run, "tool.prepared", tool("prepared", { status: "正在准备任务" }));
  assert.equal(run.presentation.blocks[0].state, "executing");
  assert.equal(run.active_tools[0].state, "executing");
  assert.throws(() => apply(run, "tool.started", tool("executing", { name: "execute_code" })), /无效/);
  assert.throws(() => apply(run, "tool.started", tool("executing", { round: 1 })), /无效/);
  assert.throws(() => apply(run, "tool.started", tool("executing", { name: "sandbox.create" })), /无效/);
  run = apply(run, "tool.completed", tool("succeeded", { completed_at: end, status: "已完成" }));
  const later = apply(run, "tool.started", tool());
  assert.equal(later.presentation.blocks[0].state, "succeeded");
  assert.equal(later.last_seq, "4");
  assert.equal(runs.parseCloudChatRun(base({ active_tools: [tool()] })).active_tools[0].name, "publish_site");
});

test("snapshots reject invalid identity, duplicate blocks, versions, metadata and excessive text", () => {
  const invalid = [
    presentation([text(), text()]), presentation([{ ...text(), id: "reasoning:0" }]),
    presentation([{ ...text(), round: -1 }]), presentation([{ ...text(), round: 0.5 }]),
    presentation([{ ...text(), started_at: "yesterday" }]), presentation([], { version: 2 }),
    presentation([], { rounds: [{ round: 0 }, { round: 0 }] }),
    presentation([], { state: "done" }), presentation([], { reasoning_effort: "unlimited" }),
    presentation([], { usage: { total_tokens: -1 } }),
    presentation([], { usage: { total_tokens: Number.MAX_SAFE_INTEGER + 1 } }),
    presentation(Array.from({ length: 513 }, (_, index) => text(index, "x"))),
    presentation([text(0, "x".repeat(projection.CLOUD_CHAT_PRESENTATION_MAX_BYTES))]),
  ];
  for (const value of invalid) assert.throws(() => projection.parseCloudChatPresentation(value));
  assert.throws(() => apply(base(), "message.delta", { block_id: "text:0", delta: "missing round" }), /无效/);
});

test("reasoning limits count UTF-8 bytes and incremental updates preserve surrogate pairs", () => {
  const maximum = projection.CLOUD_CHAT_REASONING_MAX_BYTES;
  const input = "中".repeat(Math.floor(maximum / 3));
  let run = apply(base(), "reasoning.delta", { block_id: "reasoning:0", round: 0, delta: input });
  assert.throws(() => apply(run, "reasoning.delta", { block_id: "reasoning:0", round: 0, delta: "中" }), /上限/);
  assert.equal(run.presentation.blocks[0].text, input);
  run = apply(base(), "reasoning.delta", { block_id: "reasoning:0", round: 0, delta: "a".repeat(maximum - 4) + "\ud83d" });
  run = apply(run, "reasoning.delta", { block_id: "reasoning:0", round: 0, delta: "\ude00" });
  assert.equal(new TextEncoder().encode(run.presentation.blocks[0].text).byteLength, maximum);
  assert.throws(() => apply(run, "reasoning.delta", { block_id: "reasoning:0", round: 0, delta: "x" }), /上限/);
  assert.deepEqual(projection.parseCloudChatPresentation(run.presentation), run.presentation);
});

test("reconnection accepts authoritative projection and ignores replayed text or reasoning", async () => {
  const snapshot = base({ last_seq: "2", output: "prefix", presentation: presentation([
    { id: "reasoning:0", type: "reasoning", round: 0, text: "thought", started_at: start }, text(0, "prefix"),
  ]) });
  const calls = [];
  let attempt = 0;
  const client = runs.createCloudChatRunsClient(async path => {
    calls.push(path);
    if (!path.includes("events")) return Response.json({ run: snapshot });
    attempt++;
    if (attempt === 1) return stream([frame(event(1, "reasoning.delta", { block_id: "reasoning:0", round: 0, delta: "thought" }))]);
    return stream([
      frame({ run: snapshot }, "snapshot"),
      frame(event(2, "message.delta", { block_id: "text:0", round: 0, delta: "prefix" })),
      frame(event(3, "message.delta", { block_id: "text:0", round: 0, delta: " final" })),
      frame(event(4, "run.completed", { completed_at: end })),
    ]);
  });
  const final = await client.watchRun(base(), { signal: new AbortController().signal, onRun: () => {}, retry: async () => {} });
  assert.equal(final.output, "prefix final");
  assert.equal(final.presentation.blocks[0].text, "thought");
  assert.equal(final.presentation.blocks[1].text, "prefix final");
  assert.equal(final.presentation.state, "completed");
  assert.match(calls.at(-1), /after_seq=2$/);
});

test("run HTTP snapshots are bounded before JSON decoding and invalid responses do not echo bodies", async () => {
  const tooBig = runs.createCloudChatRunsClient(async () => new Response("private body", { headers: { "Content-Length": String(34 * 1024 * 1024) } }));
  await assert.rejects(tooBig.getRun("run-1"), /上限/);
  const invalid = runs.createCloudChatRunsClient(async () => new Response("private body"));
  await assert.rejects(invalid.getRun("run-1"), error => /响应无效/.test(error.message) && !error.message.includes("private"));
});

test("bounded history omits only presentation and explicit full loading restores its process", async () => {
  const full = { id: "a-1", role: "assistant", content: "answer", presentation: presentation([text()], { state: "completed" }) };
  const client = history.createCloudChatHistoryClient(async path => Response.json(path.includes("/messages/")
    ? { message: full }
    : { messages: [{ id: "a-1", role: "assistant", content: "answer", presentation_omitted: true }], next_before_id: "", has_more: false }), () => () => {});
  const page = await client.list("conversation-1");
  assert.equal(page.messages[0].content, "answer");
  assert.equal(page.messages[0].presentation_omitted, true);
  const loaded = await client.get("conversation-1", "a-1");
  assert.equal(loaded.presentation.blocks[0].text, "answer");
  const merged = history.mergeCloudChatHistory([loaded], page.messages);
  assert.equal(merged[0].presentation.blocks[0].text, "answer");
  assert.equal(merged[0].presentation_omitted, true);
  const refreshed = history.mergeCloudChatHistory(merged, [loaded]);
  assert.equal(refreshed[0].presentation_omitted, undefined);
  const invalid = history.createCloudChatHistoryClient(async () => Response.json({ message: { ...full, presentation_omitted: true, presentation: undefined } }), () => () => {});
  await assert.rejects(invalid.get("conversation-1", "a-1"), /尚未完整读取/);
});

test("terminal history can update process metadata while keeping an already expanded large body", () => {
  const current = [{ id: "a-1", role: "assistant", content: "already loaded", presentation: presentation([text()], { state: "running" }) }];
  const incoming = [{ id: "a-1", role: "assistant", content: null, content_omitted: true, presentation: presentation([text()], { state: "completed", completed_at: end }) }];
  const result = history.mergeCloudChatHistory(current, incoming);
  assert.equal(result[0].content, "already loaded");
  assert.equal(result[0].presentation.state, "completed");
  assert.equal(result[0].content_omitted, undefined);
});
