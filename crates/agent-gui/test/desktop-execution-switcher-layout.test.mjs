import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const switcherSource = readFileSync(
  new URL("../src/components/DesktopExecutionSwitcher.tsx", import.meta.url),
  "utf8",
);

test("desktop execution menu opens below the trigger and stays inside the right viewport edge", () => {
  assert.match(switcherSource, /absolute right-0 top-full/);
  assert.doesNotMatch(switcherSource, /absolute left-0/);
  assert.match(switcherSource, /max-w-\[calc\(100vw-1rem\)\]/);
});

test("desktop execution switcher exposes its popup state", () => {
  assert.match(switcherSource, /aria-label=\{`切换设备，当前：/);
  assert.match(switcherSource, /aria-expanded=\{open\}/);
});
