import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../../../agent-gui/test/helpers/load-ts-module.mjs";

const { cloudChatScrollFollowing: follow } = createTsModuleLoader({
  rootDir: fileURLToPath(new URL("..", import.meta.url)),
}).loadModule("src/lib/cloudChatScrollFollow.ts");

test("scrolling up releases the streaming answer before the reader leaves its vicinity", () => {
  assert.equal(follow(true, 1000, 970, 30), false);
  assert.equal(follow(false, 970, 940, 60), false);
  // Content growth or a stationary scrollbar must not attach a reader far from the end.
  assert.equal(follow(false, 940, 940, 400), false);
});

test("scrolling back towards the moving end attaches within a wider arrival band", () => {
  assert.equal(follow(false, 940, 1100, 140), true);
  assert.equal(follow(false, 940, 980, 300), false);
  assert.equal(follow(true, 1100, 1098, 10), true);
  assert.equal(follow(false, -1, 2000, 0), false);
});
