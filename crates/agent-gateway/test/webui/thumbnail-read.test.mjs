import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const setup = () => createWebModuleLoader().loadModule("@liveagent/ui/components/resource-preview/thumbnailRead.ts");

test("cover reads queue fairly with two slots and cancel waiting resources without running them", async () => {
  const { readThumbnail } = setup();
  const controllers = Array.from({ length: 5 }, () => new AbortController());
  const started = [], finish = [];
  const jobs = controllers.map((controller, index) => readThumbnail(controller.signal, async () => {
    started.push(index);
    return new Promise(resolve => { finish[index] = () => resolve(index); });
  }));
  const cancelled = assert.rejects(jobs[2], { name: "AbortError" });
  await flush();
  assert.deepEqual(started, [0, 1]);
  controllers[2].abort();
  await cancelled;
  finish[0](); await flush();
  assert.deepEqual(started, [0, 1, 3]);
  finish[1](); await flush();
  assert.deepEqual(started, [0, 1, 3, 4]);
  finish[3](); finish[4]();
  assert.deepEqual(await Promise.all([jobs[0], jobs[1], jobs[3], jobs[4]]), [0, 1, 3, 4]);
  assert.equal(await readThumbnail(new AbortController().signal, async () => "available"), "available");
});

test("rate-limited read retries are bounded and authentication/integrity failures never retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { readThumbnail } = setup();
  const limited = Object.assign(new Error("busy"), { status: 429 });
  let attempts = 0;
  const job = readThumbnail(new AbortController().signal, async () => { attempts++; throw limited; });
  const rejected = assert.rejects(job, error => error === limited);
  await flush(); assert.equal(attempts, 1);
  t.mock.timers.tick(1000); await flush(); assert.equal(attempts, 2);
  t.mock.timers.tick(3000); await rejected; assert.equal(attempts, 3);
  for (const status of [401, 403, 404, 502]) {
    let reads = 0;
    await assert.rejects(readThumbnail(new AbortController().signal, async () => { reads++; throw Object.assign(new Error("denied"), { status }); }));
    assert.equal(reads, 1);
  }
});

test("closing a cover cancels rate-limit backoff and cannot restart its load", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { readThumbnail } = setup();
  const controller = new AbortController();
  let reads = 0;
  const job = readThumbnail(controller.signal, async () => { reads++; throw Object.assign(new Error("busy"), { status: 429 }); });
  const rejected = assert.rejects(job, { name: "AbortError" });
  await flush(); controller.abort(); await rejected;
  t.mock.timers.tick(10_000); await flush(); assert.equal(reads, 1);
});
