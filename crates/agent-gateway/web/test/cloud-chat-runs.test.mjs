import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

function load() {
  return createTsModuleLoader({ rootDir: fileURLToPath(new URL("..", import.meta.url)) })
    .loadModule("src/lib/cloudChatRuns.ts");
}

function run(overrides = {}) {
  return {
    id: "run-1", conversation_id: "conversation-1", client_request_id: "request-1",
    model: "test-model", state: "running", user_message_id: "user-message-1",
    assistant_message_id: "assistant-message-1", output: "", last_seq: "1",
    ...overrides,
  };
}

test("cancellation with unknown remote outcome does not claim confirmed remote stop", () => {
  const api = load();
  const text = api.cloudChatRunStatusText({ state: "interrupted", error_code: "cloud_cancellation_outcome_unknown" });
  assert.match(text, /远端执行结果或工作区结束状态尚未确认/);
  assert.match(text, /请勿直接重试/);
  assert.notEqual(text, api.cloudChatRunStatusText({ state: "cancelled" }));
});

test("run snapshots preserve normalized model parameters without sharing a mutable input array",()=>{
 const api=load(),input=run({model_parameters:{request_format:"openai-completions",context_window:64000,max_output_tokens:8000,input_modalities:["text","image"],provider_cache_mode:"auto",model_cache_mode:"none"}});
 const parsed=api.parseCloudChatRun(input);input.model_parameters.input_modalities.pop();assert.deepEqual(parsed.model_parameters.input_modalities,["text","image"]);
 assert.throws(()=>api.parseCloudChatRun(run({model_parameters:{request_format:"openai-responses"}})),/Chat Completions/);
 const evolved=api.parseCloudChatRun(run({model_parameters:{api_key:"private",future_metadata:{version:2},time_zone:"Asia/Hong_Kong",locale:"zh-HK"}}));assert.equal(evolved.model_parameters.api_key,undefined);assert.equal(evolved.model_parameters.future_metadata,undefined);assert.ok(!JSON.stringify(evolved.model_parameters).includes("private"));assert.equal(evolved.model_parameters.time_zone,"Asia/Hong_Kong");
});

test("model parameter rejections expose only bounded known reason copy and never echo error bodies",async()=>{
 const api=load();let calls=0;
 const client=api.createCloudChatRunsClient(async()=>{calls++;return Response.json({reason:"model_token_limits_invalid",error:"private-upstream-body"},{status:400});});
 await assert.rejects(client.createRun({conversation_id:"c",client_request_id:"r",model:"m",content:"x"}),cause=>cause.status===400&&/上下文窗口/.test(cause.message)&&!cause.message.includes("private"));assert.equal(calls,1);
 const unknown=api.createCloudChatRunsClient(async()=>Response.json({reason:"private-upstream-body",error:"private"},{status:400}));await assert.rejects(unknown.createRun({conversation_id:"c",client_request_id:"r",model:"m",content:"x"}),cause=>cause.status===400&&!cause.message.includes("private"));
});

test("skill reference rejections expose actionable feedback without reposting a definitely rejected draft", async () => {
  const api = load();
  for (const [status, reason, hint] of [
    [422, "skill_reference_unavailable", /更换引用/],
    [422, "skill_revision_conflict", /只能使用一个修订/],
    [503, "skill_catalog_unavailable", /稍后重试/],
  ]) {
    let posts = 0;
    const client = api.createCloudChatRunsClient(async (_path, init) => {
      assert.equal(init.method, "POST");
      posts++;
      return Response.json({ reason, error: "private diagnostic" }, { status });
    });
    await assert.rejects(client.createRun({
      conversation_id: "conversation-1", client_request_id: "request-1", model: "test-model",
      content: "Use zeroagent-skill:fixture/1/audit.",
    }), (cause) => cause.status === status && hint.test(cause.message) && !cause.message.includes("private"));
    assert.equal(posts, 1);
    assert.match(api.cloudChatRunStatusText({ state: "failed", error_code: reason }), hint);
  }
});

test("an explicit account-queue rejection is known unaccepted and never immediately reposted or reconciled",async()=>{
 const api=load(),calls=[];let full=true;
 const request={conversation_id:"conversation-1",client_request_id:"request-1",model:"test-model",content:"preserved"};
 const client=api.createCloudChatRunsClient(async(path,init)=>{calls.push({path,init});return full?Response.json({reason:"account_queue_full",error:"private diagnostic"},{status:429}):Response.json({run:run({state:"queued"})},{status:202});});
 await assert.rejects(client.createRun(request),cause=>cause instanceof api.CloudChatAccountQueueFullError&&cause.status===429&&/尚未发送/.test(cause.message)&&!cause.message.includes("private"));
 assert.equal(calls.length,1);assert.equal(calls[0].init.method,"POST");
 full=false;await client.createRun(request);assert.equal(calls.length,2);assert.equal(calls[1].init.body,calls[0].init.body);
});

test("other 429 responses do not claim that a possibly accepted request was rejected by account admission",async()=>{
 const api=load();let posts=0;
 const client=api.createCloudChatRunsClient(async(_path,init)=>{if(init.method==="POST"){posts++;return Response.json({reason:"upstream_rate_limit",error:"private diagnostic"},{status:429});}return Response.json({runs:[]});});
 await assert.rejects(client.createRun({conversation_id:"conversation-1",client_request_id:"request-1",model:"test-model",content:"x"}),api.CloudChatSubmissionUnknownError);assert.equal(posts,2);
});

test("read_history is a public bounded operation progress status, never a second browser agent loop",()=>{
 const api=load(),tool={tool_id:"history-tool",name:"read_history",state:"executing",status:"正在查阅当前会话历史"};
 const value=api.parseCloudChatRun(run({active_tools:[tool]}));assert.equal(api.cloudChatRunToolStatus(value),tool.status);
 const event={run_id:value.id,seq:"2",type:"tool.started",data:tool};assert.equal(api.cloudChatRunToolStatus(api.reduceCloudChatRunEvent(run(),event)),tool.status);
});

test("extract_archive exposes the Go-owned archive operation progress without a browser execution loop",()=>{
 const api=load(),tool={tool_id:"archive-tool",name:"extract_archive",state:"executing",status:"正在解包代码资料"};
 const value=api.parseCloudChatRun(run({active_tools:[tool]}));assert.equal(api.cloudChatRunToolStatus(value),tool.status);
 assert.equal(api.cloudChatRunToolStatus(api.reduceCloudChatRunEvent(run(),{run_id:value.id,seq:"2",type:"tool.started",data:tool})),tool.status);
});

test("a live-stream quota response displays recoverable guidance and reconnects without posting or cancelling a Run",async()=>{
 const api=load(),calls=[],notices=[];let attempts=0;
 const client=api.createCloudChatRunsClient(async(path,init={})=>{calls.push({path,method:init.method??"GET"});if(path.includes("/events")){attempts++;return attempts===1?Response.json({reason:"cloud_stream_limit",error:"private"},{status:429}):sse([frame(event("2","message.delta",{delta:"finished"})),frame(event("3","run.completed"))]);}return Response.json({run:run()});});
 const result=await client.watchRun(run(),{signal:new AbortController().signal,onRun:()=>{},onRecoverableError:cause=>notices.push(cause),retry:async()=>{}});
 assert.equal(result.state,"completed");assert.equal(result.output,"finished");assert.equal(attempts,2);assert.equal(notices[0].reason,"cloud_stream_limit");assert.match(notices[0].message,/请关闭其他窗口.*任务会继续运行/);assert.ok(!(notices[0] instanceof api.CloudChatAccountQueueFullError));assert.ok(calls.every(call=>call.method==="GET"&&!call.path.endsWith("/cancel")));
});

test("admission sentinels are never interpreted as an unaccepted Run when received on an event-stream GET",async()=>{
 const api=load(),notices=[];
 const client=api.createCloudChatRunsClient(async(path)=>path.includes("/events")?Response.json({reason:"account_queue_full"},{status:429}):Response.json({run:run({state:"completed",last_seq:"2"})}));
 const result=await client.watchRun(run(),{signal:new AbortController().signal,onRun:()=>{},onRecoverableError:cause=>notices.push(cause),retry:async()=>{}});assert.equal(result.state,"completed");assert.equal(notices.length,1);assert.ok(!(notices[0] instanceof api.CloudChatAccountQueueFullError));assert.doesNotMatch(notices[0].message,/尚未发送/);
});

function event(seq, type, data = {}) {
  return { run_id: "run-1", seq, type, data };
}

function sse(frames, splitBytes = false) {
  const bytes = new TextEncoder().encode(frames.join(""));
  return new Response(new ReadableStream({
    start(controller) {
      if (splitBytes) for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1));
      else controller.enqueue(bytes);
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

function frame(value, name = "cloud_run") {
  return `event: ${name}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
}

const request = {
  conversation_id: "conversation-1", client_request_id: "request-1", model: "test-model", content: "你好",
};

test("event reducer preserves large sequence precision, ignores duplicates and rejects gaps and wrong runs", () => {
  const api = load();
  const initial = run({ last_seq: "9007199254740992", output: "A" });
  const next = api.reduceCloudChatRunEvent(initial, event("9007199254740993", "message.delta", { delta: "B" }));
  assert.equal(next.output, "AB");
  assert.equal(next.last_seq, "9007199254740993");
  assert.equal(api.reduceCloudChatRunEvent(next, event("9007199254740993", "message.delta", { delta: "B" })), next);
  assert.throws(() => api.reduceCloudChatRunEvent(next, event("9007199254740995", "message.delta", { delta: "C" })), /重新同步/);
  assert.throws(() => api.reduceCloudChatRunEvent(next, { ...event("9007199254740994", "message.delta"), run_id: "other" }), /身份/);
  for (const invalid of [1, "-1", "1.0", "01", "1e3", "9".repeat(81)]) {
    assert.throws(() => api.cloudChatSequence(invalid), /水位/);
  }
});

test("stream parser handles split UTF-8, CRLF, multiline JSON, snapshots and a terminal event", async () => {
  const api = load();
  const updates = [];
  const calls = [];
  const client = api.createCloudChatRunsClient(async (url, init) => {
    calls.push({ url, init });
    return sse([
      ": heartbeat\r\n\r\n",
      frame({ run: run() }, "snapshot"),
      "event: cloud_run\r\ndata: {\r\ndata: \"run_id\":\"run-1\",\"seq\":\"2\",\"type\":\"message.delta\",\"data\":{\"delta\":\"你好🌍\"}}\r\n\r\n",
      frame(event("3", "run.completed", { usage: { completion_tokens: 3 } })),
    ], true);
  });
  const result = await client.watchRun(run(), { signal: new AbortController().signal, onRun: (next) => updates.push(next) });
  assert.equal(result.output, "你好🌍");
  assert.equal(result.state, "completed");
  assert.equal(result.last_seq, "3");
  assert.deepEqual(result.usage, { completion_tokens: 3 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /events\?after_seq=1$/);
  assert.equal(calls[0].init.headers.Accept, "text/event-stream");
  assert.equal(updates.at(-1).output, "你好🌍");
});

test("a lost create response is reconciled using the original request ID without another POST", async () => {
  const api = load();
  const posts = [];
  const client = api.createCloudChatRunsClient(async (url, init) => {
    if (init.method === "POST") {
      posts.push(init.body);
      throw new Error("response lost after commit");
    }
    const query = new URL(url, "https://fixture.invalid").searchParams;
    assert.equal(query.get("conversation_id"), "conversation-1");
    assert.equal(query.get("client_request_id"), request.client_request_id);
    return Response.json({ runs: [run()] });
  });
  const result = await client.createRun(request);
  assert.equal(result.id, "run-1");
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0]), request);
});

test("tool failures remain operation progress and never terminate the Run before its own event", () => {
  const api = load();
  let current = run({ state: "running", last_seq: "0" });
  const progress = (seq, type, state) => ({ run_id: current.id, seq: String(seq), type, data: { tool_id: "tool-1", name: "execute_code", state, status: "正在分析与计算" } });
  current = api.reduceCloudChatRunEvent(current, progress(1, "tool.prepared", "prepared"));
  current = api.reduceCloudChatRunEvent(current, progress(2, "tool.started", "executing"));
  assert.equal(api.cloudChatRunToolStatus(current), "正在分析与计算");
  current = api.reduceCloudChatRunEvent(current, progress(3, "tool.prepared", "prepared"));
  assert.equal(current.active_tools[0].state, "executing");
  current = api.reduceCloudChatRunEvent(current, progress(4, "tool.failed", "failed"));
  assert.equal(current.state, "running");
  assert.equal(current.active_tools.length, 0);
  current = api.reduceCloudChatRunEvent(current, progress(5, "tool.unknown", "unknown"));
  assert.equal(current.state, "running");
  current = api.reduceCloudChatRunEvent(current, { run_id: current.id, seq: "6", type: "run.interrupted", data: { state: "interrupted" } });
  assert.equal(current.active_tools.length, 0);
  assert.equal(api.cloudChatRunToolStatus(current), null);
  assert.throws(() => api.parseCloudChatRun({ ...run(), active_tools: [{ tool_id: "not-public", name: "sandbox.create", state: "executing", status: "internal" }] }), /进度/);
});

test("retrying an uncertain create sends exactly the same body and request ID", async () => {
  const api = load();
  const posts = [];
  const client = api.createCloudChatRunsClient(async (_url, init) => {
    if (init.method === "POST") {
      posts.push(init.body);
      if (posts.length === 1) throw new Error("transport failed");
      return Response.json({ run: run() }, { status: 202 });
    }
    return Response.json({ runs: [] });
  });
  await client.createRun(request);
  assert.equal(posts.length, 2);
  assert.equal(posts[0], posts[1]);
});

test("unknown submission stays unknown; known rejections are not retried", async () => {
  const api = load();
  let posts = 0;
  const client = api.createCloudChatRunsClient(async (_url, init) => {
    if (init.method === "POST") { posts++; throw new Error("offline"); }
    return Response.json({ runs: [] });
  });
  await assert.rejects(client.createRun(request), api.CloudChatSubmissionUnknownError);
  assert.equal(posts, 2);
  for (const status of [400, 401, 403, 409]) {
    let calls = 0;
    const rejected = api.createCloudChatRunsClient(async () => { calls++; return new Response(null, { status }); });
    await assert.rejects(rejected.createRun(request), (error) => error.status === status);
    assert.equal(calls, 1);
  }
});

test("reconnect reads authoritative state and resumes after its sequence without duplicating output", async () => {
  const api = load();
  const streams = [];
  const states = [];
  const client = api.createCloudChatRunsClient(async (url) => {
    if (!url.includes("/events")) return Response.json({ run: run({ last_seq: "2", output: "AB" }) });
    streams.push(url);
    if (streams.length === 1) return sse([frame(event("2", "message.delta", { delta: "B" }))]);
    return sse([
      frame(event("2", "message.delta", { delta: "B" })),
      frame(event("3", "message.delta", { delta: "C" })),
      frame(event("4", "run.completed")),
    ]);
  });
  const result = await client.watchRun(run({ output: "A" }), {
    signal: new AbortController().signal,
    onRun: () => undefined,
    onConnection: (state) => states.push(state),
    retry: async () => undefined,
  });
  assert.equal(result.output, "ABC");
  assert.deepEqual(streams, [
    "/api/web-chat/runs/run-1/events?after_seq=1",
    "/api/web-chat/runs/run-1/events?after_seq=2",
  ]);
  assert.ok(states.includes("reconnecting"));
});

test("missing terminal event is recovered from run status and does not restart generation", async () => {
  const api = load();
  const methods = [];
  const client = api.createCloudChatRunsClient(async (url, init) => {
    methods.push(init.method ?? "GET");
    return url.includes("/events") ? sse([]) : Response.json({ run: run({ state: "completed", output: "完成", last_seq: "4" }) });
  });
  const result = await client.watchRun(run(), { signal: new AbortController().signal, onRun: () => undefined });
  assert.equal(result.state, "completed");
  assert.equal(result.output, "完成");
  assert.deepEqual(methods, ["GET", "GET"]);
});

test("heartbeats keep a quiet run connected and a silent transport resumes at the latest read cursor", async (t) => {
  const api = load();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const calls = [];
  const connections = [];
  let snapshots = 0;
  let stream;
  let cancelled = false;
  const client = api.createCloudChatRunsClient(async (path, init) => {
    calls.push([path, init.method ?? "GET"]);
    if (!path.includes("/events")) return Response.json({ run: run({ output: "AB", last_seq: "2" }) });
    if (stream) return sse([
      frame(event("2", "message.delta", { delta: "B" })),
      frame(event("3", "message.delta", { delta: "C" })),
      frame(event("4", "run.completed")),
    ]);
    return new Response(new ReadableStream({
      start(controller) { stream = controller; },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
  });
  const watching = client.watchRun(run({ output: "A" }), {
    signal: new AbortController().signal,
    onRun: () => {},
    onConnection: (state) => connections.push(state),
    onSnapshot: () => snapshots++,
    retry: async () => {},
  });
  await flush();
  t.mock.timers.tick(20_000);
  stream.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
  await flush();
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(cancelled, false);
  assert.deepEqual(connections, ["connecting", "connected"]);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(10_000);
  const result = await watching;
  assert.equal(cancelled, true);
  assert.equal(result.output, "ABC");
  assert.equal(snapshots, 1);
  assert.deepEqual(calls, [
    ["/api/web-chat/runs/run-1/events?after_seq=1", "GET"],
    ["/api/web-chat/runs/run-1", "GET"],
    ["/api/web-chat/runs/run-1/events?after_seq=2", "GET"],
  ]);
});

test("three unreachable checks stop the viewer and ignore late snapshots even if a host missed abort", async (t) => {
  const api = load();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const calls = [];
  const snapshots = [];
  const updates = [];
  const client = api.createCloudChatRunsClient(async (path, init) => {
    calls.push([path, init.method ?? "GET", init.signal]);
    if (path.includes("/events")) return new Promise(() => {});
    return new Promise((resolve) => snapshots.push(resolve));
  });
  const watching = client.watchRun(run({ output: "preserved" }), {
    signal: new AbortController().signal,
    onRun: (state) => updates.push(state.output),
    retry: async () => {},
  });
  const unavailable = assert.rejects(watching, { name: "TimeoutError" });
  for (let attempt = 0; attempt < 3; attempt++) {
    await flush();
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(snapshots.length, attempt + 1);
    t.mock.timers.tick(8_000);
  }
  await unavailable;
  for (const resolve of snapshots)
    resolve(Response.json({ run: run({ state: "completed", output: "late", last_seq: "4" }) }));
  await flush();
  assert.deepEqual(updates, ["preserved"]);
  assert.equal(calls.length, 6);
  assert.ok(calls.every(([path, method, signal]) =>
    path.startsWith("/api/web-chat/runs/run-1") && method === "GET" && signal.aborted,
  ));
});

test("a heartbeat followed by EOF cannot hide repeated failures to read the run", async () => {
  const api = load();
  let streams = 0;
  let reads = 0;
  const client = api.createCloudChatRunsClient(async (path) => {
    if (path.includes("/events")) {
      streams++;
      return sse([": heartbeat\n\n"]);
    }
    reads++;
    return new Response(null, { status: 503 });
  });
  await assert.rejects(client.watchRun(run(), {
    signal: new AbortController().signal,
    onRun: () => {},
    retry: async () => {},
  }), (error) => error.status === 503);
  assert.equal(streams, 3);
  assert.equal(reads, 3);
});

test("aborting a viewer closes its stream without cancelling the server run or applying late frames", async () => {
  const api = load();
  const controller = new AbortController();
  let closed = false;
  let body;
  const updates = [];
  const calls = [];
  const client = api.createCloudChatRunsClient(async (url) => {
    calls.push(url);
    return new Response(new ReadableStream({
      start(value) { body = value; },
      cancel() { closed = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
  });
  const watching = client.watchRun(run(), { signal: controller.signal, onRun: (next) => updates.push(next) });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(watching, (error) => error.name === "AbortError");
  assert.equal(closed, true);
  assert.equal(updates.length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls.every((url) => !url.endsWith("/cancel")));
  assert.throws(() => body.enqueue(new TextEncoder().encode(frame(event("2", "message.delta", { delta: "late" })))));
});

test("an expired stream or changed account is not retried against the next identity", async () => {
  const api = load();
  for (const cause of [new api.CloudChatRunRequestError(401), new Error("Account changed while the request was pending")]) {
    let calls = 0;
    const client = api.createCloudChatRunsClient(async () => { calls++; throw cause; });
    await assert.rejects(client.watchRun(run(), { signal: new AbortController().signal, onRun: () => undefined }), (error) => error === cause);
    assert.equal(calls, 1);
  }
});

test("cancel uses an explicit endpoint and waits for persisted cancellation state", async () => {
  const api = load();
  let called;
  const client = api.createCloudChatRunsClient(async (url, init) => {
    called = { url, method: init.method };
    return Response.json({ run: run({ state: "cancelling" }) });
  });
  const result = await client.cancelRun("run-1");
  assert.deepEqual(called, { url: "/api/web-chat/runs/run-1/cancel", method: "POST" });
  assert.equal(result.state, "cancelling");
  assert.equal(api.isCloudChatRunTerminal(result), false);
});
