import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const switcherSource = readFileSync(
  new URL("../src/components/DesktopExecutionSwitcher.tsx", import.meta.url),
  "utf8",
);

test("desktop execution menu opens below the trigger with compact left alignment", () => {
  assert.match(switcherSource, /<DropdownMenuContent align="start"/);
  assert.match(switcherSource, /max-w-\[calc\(100vw-1rem\)\]/);
});

test("desktop execution switcher exposes its popup state", () => {
  assert.match(switcherSource, /aria-label=\{\s*text\(\s*`切换工作台，当前：\$\{label\}/);
  assert.match(switcherSource, /<DropdownMenuTrigger/);
});
