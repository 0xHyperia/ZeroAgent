import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { classifyTurnError } = loader.loadModule("@liveagent/ui/lib/chat/turnError.ts");
const { buildUiMessages } = loader.loadModule("src/lib/chat/messages/uiMessages.ts");
const { turnErrorOf } = loader.loadModule("@liveagent/ui/lib/chat/assistantStatus.ts");

const AUTH_ERROR =
  '401 Unauthorized: {"error":{"message":"Incorrect API key provided: sk-fake***.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}';

test("turn errors are classified from the raw provider or transport error", () => {
  assert.deepEqual(classifyTurnError(AUTH_ERROR), {
    kind: "auth",
    status: 401,
    detail: "Incorrect API key provided: sk-fake***.",
    raw: AUTH_ERROR,
  });
  assert.equal(classifyTurnError("429 Too Many Requests: rate limit reached").kind, "rate_limit");
  assert.equal(classifyTurnError("HTTP 503 Service Unavailable").kind, "server");
  assert.equal(classifyTurnError('500 Internal Server Error: {"error":{}}').status, 500);
  assert.equal(classifyTurnError("unexpected EOF").kind, "connection");
  assert.equal(
    classifyTurnError("K-brain event stream ended before the run reached a terminal event").kind,
    "connection",
  );
  assert.equal(classifyTurnError("tool budget exhausted").kind, "unknown");
});

test("a failed round renders its error once, as round meta, even with no content", () => {
  const user = { role: "user", content: "hi", timestamp: 1 };
  const failed = buildUiMessages([
    user,
    { role: "assistant", content: [], stopReason: "error", errorMessage: AUTH_ERROR, timestamp: 2 },
  ]);
  const rounds = failed.at(-1).rounds;
  assert.equal(rounds.length, 1);
  assert.deepEqual(rounds[0].blocks, []);
  assert.equal(turnErrorOf(rounds), AUTH_ERROR);
  // Replies saved before errors were separate repeat the error as text.
  const legacy = buildUiMessages([
    user,
    {
      role: "assistant",
      content: [{ type: "text", text: "boom" }],
      stopReason: "error",
      errorMessage: "boom",
      timestamp: 2,
    },
  ]);
  assert.deepEqual(legacy.at(-1).rounds[0].blocks, []);
  assert.equal(turnErrorOf(legacy.at(-1).rounds), "boom");
});
