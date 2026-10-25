import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { isolatedKbrainFixtureEnv } from "./kbrain-startup-budget.mjs";

test("fixture environment cannot inherit or override a real user data root", () => {
  const before = [process.env.HOME, process.env.USERPROFILE, process.env.LIVEAGENT_HOME];
  const root = path.resolve("private-backend-fixture");
  const result = isolatedKbrainFixtureEnv(root, {
    HOME:"outside", USERPROFILE:"outside", LIVEAGENT_HOME:"outside", K_BRAIN_HOME:"outside", TZ:"Europe/Paris",
  });
  for (const key of ["HOME", "USERPROFILE", "LIVEAGENT_HOME"]) assert.equal(result[key], root);
  assert.equal(result.K_BRAIN_HOME, "");
  assert.equal(result.LIVEAGENT_KBRAIN_PROXY, "direct");
  assert.equal(result.TZ, "Europe/Paris");
  assert.deepEqual([process.env.HOME, process.env.USERPROFILE, process.env.LIVEAGENT_HOME], before);
});

test("relative fixture roots are rejected before a subprocess can use them", () => {
  assert.throws(() => isolatedKbrainFixtureEnv("relative-root"), /must be absolute/);
});
