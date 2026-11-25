import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { convertMessages } = loader.loadModule("src/lib/kbrain/history.ts");
const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");
const { classifyTurnError } = loader.loadModule("@liveagent/ui/lib/chat/turnError.ts");

const user = (id, text) => ({ id, role: "user", content: [{ type: "text", text }] });

test("history's leading thinking block reopens as the turn's reasoning", () => {
  const [, assistant] = convertMessages([
    user("u1", "q"),
    {
      id: "m1",
      role: "assistant",
      content: [
        { type: "thinking", text: "Let me check the readme." },
        { type: "text", text: "Done." },
      ],
    },
  ]);
  assert.deepEqual(assistant.content, [
    { type: "thinking", thinking: "Let me check the readme." },
    { type: "text", text: "Done." },
  ]);
});

test("error_detail decides the notice kind; text classification is the fallback", () => {
  const cases = [
    ["invalid_api_key", "auth"],
    ["rate_limited", "rate_limit"],
    ["server_error", "server"],
    ["connection_lost", "connection"],
    ["unreachable", "connection"],
    ["timeout", "timeout"],
    ["context_limit", "context_limit"],
    ["bad_request", "bad_request"],
    ["not_found", "bad_request"],
    ["something_new", "unknown"],
  ];
  for (const [kind, expected] of cases) {
    // The raw text alone would read as a rate limit; the detail wins.
    assert.equal(classifyTurnError("429 Too Many Requests", { kind }).kind, expected, kind);
  }
  assert.equal(classifyTurnError("429 Too Many Requests").kind, "rate_limit");
  assert.equal(classifyTurnError("429 Too Many Requests", null).kind, "rate_limit");
});

test("a cancelled turn reopens with its partial reply", () => {
  const [, assistant] = convertMessages([
    user("u1", "say something"),
    {
      id: "m1",
      role: "assistant",
      content: [{ type: "text", text: "Here is the first part" }],
      stop_reason: "cancelled",
    },
  ]);
  assert.equal(assistant.stopReason, "aborted");
  assert.deepEqual(assistant.content, [{ type: "text", text: "Here is the first part" }]);
});

function sseFixture(events) {
  const line = (seq, type, payload) =>
    `data: ${JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", seq, type, payload })}\n\n`;
  return async (url) => {
    const path = new URL(url).pathname;
    if (path === "/v1/sessions") return Response.json({ id: "s" });
    if (path.endsWith("/runs"))
      return Response.json({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", accepted_seq: 1 });
    if (path.endsWith("/events")) {
      return new Response(events.map(([type, payload], index) => line(index + 2, type, payload)).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    throw new Error(`Unexpected request ${path}`);
  };
}

const turnParams = (fetch, conversationId) => ({
  baseUrl: "http://fixture.test",
  fetch,
  model: { provider: "fixture", model: "test" },
  sessionId: "frontend",
  conversationId,
  cwd: "/tmp",
  context: { messages: [] },
  prompt: "hello",
  signal: new AbortController().signal,
  onTextDelta() {},
  onThinkingDelta() {},
  onToolCall() {},
  onToolResult() {},
});

test("a live failure keeps the streamed reply and reports the error", async () => {
  const message = await runKBrainTurn(
    turnParams(
      sseFixture([
        ["assistant.text.delta", { text: "Here is the first part" }],
        [
          "assistant.message.created",
          {
            id: "m1",
            role: "assistant",
            content: [{ type: "text", text: "Here is the first part" }],
            stop_reason: "error",
          },
        ],
        ["run.failed", { state: "failed", error: "unexpected EOF" }],
      ]),
      "outcome-drop",
    ),
  );
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "unexpected EOF");
  assert.deepEqual(message.content, [{ type: "text", text: "Here is the first part" }]);
});

test("a live cancellation is marked stopped without an error", async () => {
  const message = await runKBrainTurn(
    turnParams(sseFixture([["run.cancelled", { state: "cancelled" }]]), "outcome-cancelled"),
  );
  assert.equal(message.stopReason, "aborted");
  assert.equal(message.errorMessage, undefined);
});
