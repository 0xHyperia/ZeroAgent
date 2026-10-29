import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedFetch } from "../src/bounded-fetch.ts";

test("interpreter raw response is bounded before an unterminated NDJSON line can accumulate", async () => {
  let cancelled = 0;
  const fakeFetch: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(32));
        },
        cancel() {
          cancelled++;
        },
      }),
    );
  const response = await boundedFetch(fakeFetch, 64)("https://no-network.invalid");
  await assert.rejects(response.text(), /output_limit/);
  assert.equal(cancelled, 1);
});
test("interpreter response budget is cumulative across requests and keeps bytes and HTTP metadata", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(new Uint8Array([0xe4, 0xbd, 0xa0]), {
      status: 201,
      headers: { "x-test": "kept" },
    });
  const bounded = boundedFetch(fakeFetch, 4);
  const response = await bounded("https://no-network.invalid");
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-test"), "kept");
  assert.equal(await response.text(), "你");
  await assert.rejects((await bounded("https://no-network.invalid")).arrayBuffer(), /output_limit/);
});
