import assert from "node:assert/strict";
import test from "node:test";
import { closeEdgeBrowser, edgeMeasureSkip as skip, measureInEdge } from "../helpers/edge-measure.mjs";

// Windows 上 spawn 出来的 msedge.exe 只是启动器，几十毫秒就退出，真正的无头浏览器是另一个进程。
// 以前 finally 等启动器的 exit 事件，事件早已错过，每次调用都白等 8s 超时。
test("browser close observes the browser when its launcher has already exited", async () => {
  const calls = [];
  let closeListener;
  const ws = {
    readyState: WebSocket.OPEN,
    addEventListener(event, listener) { assert.equal(event, "close"); closeListener = listener; },
    send(message) {
      assert.ok(closeListener, "close observer must exist before the request");
      assert.equal(JSON.parse(message).method, "Browser.close");
      calls.push("requested");
      queueMicrotask(() => { calls.push("observed"); closeListener(); });
    },
    close() { calls.push("socket-closed"); },
  };
  const launcher = { exitCode: 0, once() { assert.fail("must not wait for a missed launcher exit"); }, kill() { assert.fail("browser already closed"); } };
  const closed = await closeEdgeBrowser(ws, launcher, "fixture-owned-profile", {
    timeout(promise, ms) { assert.equal(ms, 8000); return promise; },
    killBrowsers() { assert.fail("must not use fallback after observing browser close"); },
  });
  assert.equal(closed, true);
  assert.deepEqual(calls, ["requested", "observed", "socket-closed"]);
});

test("browser close timeout keeps its profile-specific cleanup fallback", async () => {
  const calls = [];
  const ws = { readyState: WebSocket.OPEN, addEventListener() {}, send() {}, close() { calls.push("socket-closed"); } };
  const closed = await closeEdgeBrowser(ws, { kill() { calls.push("launcher-killed"); } }, "fixture-owned-profile", {
    timeout(_promise, ms) { assert.equal(ms, 8000); return Promise.reject(new Error("fixture close timeout")); },
    killBrowsers(profile) { assert.equal(profile, "fixture-owned-profile"); calls.push("profile-killed"); },
  });
  assert.equal(closed, false);
  assert.deepEqual(calls, ["launcher-killed", "profile-killed", "socket-closed"]);
});

test("measureInEdge evaluates a real one-page run and closes its fixture", { skip }, async () => {
  const results = await measureInEdge(
    [{ key: "k", surface: "web", width: 320, html: "<p>x</p>" }],
    "1 + 1",
  );
  assert.equal(results.get("k"), 2);
});
