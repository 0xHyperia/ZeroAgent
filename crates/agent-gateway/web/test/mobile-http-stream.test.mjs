import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t, invoke) {
  const previous = globalThis.window;
  const browserRequests = [];
  const window = new EventTarget();
  window.location = { href: "http://tauri.localhost/", origin: "http://tauri.localhost" };
  window.fetch = async (input, init) => {
    browserRequests.push({ input, init });
    return Response.json({ external: true });
  };
  window.__TAURI__ = { core: { invoke } };
  globalThis.window = window;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const module = createWebModuleLoader().loadModule("@/lib/mobileRuntime.ts");
  module.installGatewayFetchBridge();
  return { window, module, browserRequests };
}

const head = { kind: "headers", status: 200, headers: { "content-type": "text/event-stream" } };
const chunk = (bytes) => ({ kind: "chunk", data: Buffer.from(bytes).toString("base64") });
const options = { headers: { Accept: "text/event-stream" } };

test("binary downloads use native pull bytes without UTF-8 conversion", async (t) => {
  const bytes=Uint8Array.from([0,255,128,254,13,10,0x50,0x4b]);
  const items=[{kind:"headers",status:200,headers:{"content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}},chunk(bytes.subarray(0,3)),chunk(bytes.subarray(3)),null];
  const calls=[];const {window}=fixture(t,async(command,args)=>{calls.push({command,args});if(command==="mobile_gateway_stream_open")return "binary-stream";if(command==="mobile_gateway_stream_read")return items.shift();});
  const response=await window.fetch("/api/web-chat/artifacts/versions/version-id/download",{headers:{Accept:"application/octet-stream"}});
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
  assert.equal(calls[0].command,"mobile_gateway_stream_open");
  assert(!calls.some(call=>call.command==="mobile_gateway_http_request"));
});

test("SSE fetch returns headers before body completion and preserves split UTF-8 bytes", async (t) => {
  const calls = [];
  const bytes = Buffer.from("data: 你好\n\n");
  const items = [head, chunk(bytes.subarray(0, 7)), chunk(bytes.subarray(7)), null];
  const { window } = fixture(t, async (command, args) => {
    calls.push({ command, args });
    if (command === "mobile_gateway_stream_open") return "native-random-id";
    if (command === "mobile_gateway_stream_read") return items.shift();
  });
  const response = await window.fetch("/api/web-chat/runs/run/events?after_seq=4", options);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(calls.filter((call) => call.command === "mobile_gateway_stream_read").length, 1);
  assert.equal(await response.text(), "data: 你好\n\n");
  assert.ok(calls.some((call) => call.command === "mobile_gateway_stream_close"));
  assert.equal(calls[0].args.request.path, "/api/web-chat/runs/run/events?after_seq=4");
});

test("an abort while opening closes a late native registration without reading headers", async (t) => {
  const opening = deferred();
  const calls = [];
  const { window } = fixture(t, (command, args) => {
    calls.push({ command, args });
    if (command === "mobile_gateway_stream_open") return opening.promise;
    return Promise.resolve();
  });
  const controller = new AbortController();
  const pending = window.fetch("/api/web-chat/runs/run/events", { ...options, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  opening.resolve("late-native-id");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.some((call) => call.command === "mobile_gateway_stream_close" && call.args.id === "late-native-id"));
  assert.ok(!calls.some((call) => call.command === "mobile_gateway_stream_read"));
});

test("abort interrupts pending response headers and a pending body read", async (t) => {
  for (const duringBody of [false, true]) {
    const pendingRead = deferred();
    let reads = 0;
    const calls = [];
    const { window } = fixture(t, async (command) => {
      calls.push(command);
      if (command === "mobile_gateway_stream_open") return "stream";
      if (command === "mobile_gateway_stream_read") {
        reads++;
        if (duringBody && reads === 1) return head;
        return pendingRead.promise;
      }
    });
    const controller = new AbortController();
    const fetching = window.fetch("/api/web-chat/runs/run/events", { ...options, signal: controller.signal });
    const reading = duringBody ? (await fetching).body.getReader().read() : fetching;
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(reading, { name: "AbortError" });
    assert.ok(calls.includes("mobile_gateway_stream_close"));
    pendingRead.resolve(duringBody ? chunk("late") : head);
  }
});

test("reader cancellation closes the subscription without submitting run cancellation", async (t) => {
  const calls = [];
  const { window } = fixture(t, async (command, args) => {
    calls.push({ command, args });
    if (command === "mobile_gateway_stream_open") return "stream";
    if (command === "mobile_gateway_stream_read") return head;
  });
  const response = await window.fetch("/api/web-chat/runs/run/events", options);
  await response.body.cancel();
  assert.equal(calls.at(-1).command, "mobile_gateway_stream_close");
  assert.equal(calls.filter((call) => call.command === "mobile_gateway_stream_read").length, 1);
  assert.ok(!calls.some((call) => call.args?.request?.path?.endsWith("/cancel")));
});

test("native stream failures are surfaced and release the handle", async (t) => {
  let reads = 0;
  const calls = [];
  const { window } = fixture(t, async (command) => {
    calls.push(command);
    if (command === "mobile_gateway_stream_open") return "stream";
    if (command === "mobile_gateway_stream_read") {
      if (++reads === 1) return head;
      throw new Error("Gateway account session changed");
    }
  });
  const response = await window.fetch("/api/web-chat/runs/run/events", options);
  await assert.rejects(response.text(), /account session changed/);
  assert.ok(calls.includes("mobile_gateway_stream_close"));
});

test("Request input preserves stream headers, method, body and abort signal", async (t) => {
  const calls = [];
  const { window } = fixture(t, async (command, args) => {
    calls.push({ command, args });
    if (command === "mobile_gateway_stream_open") return "stream";
    if (command === "mobile_gateway_stream_read") return head;
  });
  const controller = new AbortController();
  const response = await window.fetch(new Request("http://tauri.localhost/api/web-chat/completions", {
    method: "POST", headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: '{"content":"hello"}', signal: controller.signal,
  }));
  assert.equal(calls[0].args.request.method, "POST");
  assert.equal(calls[0].args.request.body, '{"content":"hello"}');
  assert.equal(calls[0].args.request.headers.accept, "text/event-stream");
  controller.abort();
  await assert.rejects(response.text(), { name: "AbortError" });
});

test("external and origin-prefix URLs never receive the native credential bridge", async (t) => {
  const calls = [];
  const { window, browserRequests } = fixture(t, async (command) => { calls.push(command); });
  await window.fetch("http://tauri.localhost.evil.test/api/web-chat/events", options);
  await window.fetch("//other.test/api/web-chat/events", options);
  assert.equal(browserRequests.length, 2);
  assert.deepEqual(calls, []);
});

test("ordinary JSON requests and offline cache markers keep their existing behavior", async (t) => {
  const calls = [];
  const { window } = fixture(t, async (command, args) => {
    calls.push({ command, args });
    return { status: 200, headers: { "content-type": "application/json" }, body: '{"saved":true}', cached: true };
  });
  const response = await window.fetch("/api/web-chat/conversations");
  assert.deepEqual(await response.json(), { saved: true });
  assert.equal(response.headers.get("X-ZeroAgent-Cache"), "hit");
  assert.equal(calls[0].command, "mobile_gateway_request");
});

test("a no-content stream response closes the handle and retains its status", async (t) => {
  const calls = [];
  const { window } = fixture(t, async (command) => {
    calls.push(command);
    if (command === "mobile_gateway_stream_open") return "stream";
    if (command === "mobile_gateway_stream_read") return { ...head, status: 204 };
  });
  const response = await window.fetch("/api/web-chat/runs/run/events", options);
  assert.equal(response.status, 204);
  assert.equal(response.body, null);
  assert.ok(calls.includes("mobile_gateway_stream_close"));
});

test("leaving the page closes subscriptions and rejects a pending body read", async (t) => {
  const body = deferred();
  const calls = [];
  let reads = 0;
  const { window } = fixture(t, async (command) => {
    calls.push(command);
    if (command === "mobile_gateway_stream_open") return "stream";
    if (command === "mobile_gateway_stream_read") return ++reads === 1 ? head : body.promise;
  });
  const response = await window.fetch("/api/web-chat/runs/run/events", options);
  const pending = response.body.getReader().read();
  window.dispatchEvent(new Event("pagehide"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(calls.includes("mobile_gateway_stream_close"));
  body.resolve(chunk("late"));
});

test("HTTP error responses retain their status and streaming JSON body", async (t) => {
  const items = [{ ...head, status: 403, headers: { "content-type": "application/json" } }, chunk('{"error":"permission denied"}'), null];
  const { window } = fixture(t, async (command) => {
    if (command === "mobile_gateway_stream_open") return "stream";
    if (command === "mobile_gateway_stream_read") return items.shift();
  });
  const response = await window.fetch("/api/web-chat/runs/run/events", options);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "permission denied" });
});
