import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../package.json", import.meta.url));

test("shared popup primitives use a quiet opacity transition with reduced-motion support", () => {
 for (const name of ["popover", "dropdown-menu"]) {
  const source=readFileSync(new URL(`../../../agent-ui/src/components/ui/${name}.tsx`,import.meta.url),"utf8");
  assert.match(source,/transition-opacity/);assert.match(source,/data-\[starting-style\]:opacity-0/);assert.match(source,/data-\[ending-style\]:opacity-0/);assert.match(source,/motion-reduce:transition-none/);
  assert.doesNotMatch(source,/zoom-in|zoom-out|scale-95/);
 }
});

test("branch menu inherits shared dropdown animation without a second transition", () => {
  const source = readFileSync(new URL("../../../agent-ui/src/components/git/GitBranchSelector.tsx", import.meta.url), "utf8");
  const popup = source.slice(source.indexOf("<DropdownMenuContent"), source.indexOf("</DropdownMenuContent>"));
  assert.doesNotMatch(popup, /data-\[starting-style\]|data-\[ending-style\]/);
  const primitive = readFileSync(new URL("../../../agent-ui/src/components/ui/dropdown-menu.tsx", import.meta.url), "utf8");
  assert.match(primitive, /data-\[starting-style\]:opacity-0/);
  assert.match(primitive, /data-\[ending-style\]:opacity-0/);
});
