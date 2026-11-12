import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { fitMermaidViewBox, panMermaidViewBox, zoomMermaidViewBox } = loader.loadModule(
  "@liveagent/ui/lib/mermaidViewBox.ts",
);

test("Mermaid opens at natural size on large canvases and fits smaller ones without cropping", () => {
  const diagram = { x: 10, y: 20, width: 200, height: 100 };

  assert.deepEqual(fitMermaidViewBox(diagram, { width: 600, height: 400 }, 16), {
    x: -190,
    y: -130,
    width: 600,
    height: 400,
  });
  assert.deepEqual(fitMermaidViewBox(diagram, { width: 132, height: 160 }, 16), {
    x: -22,
    y: -90,
    width: 264,
    height: 320,
  });
});

test("Mermaid viewBox zoom keeps the center and avoids CSS scaling", () => {
  const source = { x: 10, y: 20, width: 200, height: 100 };

  assert.deepEqual(zoomMermaidViewBox(source, 1), source);
  assert.deepEqual(zoomMermaidViewBox(source, 2), {
    x: 60,
    y: 45,
    width: 100,
    height: 50,
  });
});

test("Mermaid viewBox pan converts screen pixels to SVG units", () => {
  assert.deepEqual(
    panMermaidViewBox(
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 20, y: -10 },
      { width: 200, height: 100 },
    ),
    { x: -10, y: 5, width: 100, height: 50 },
  );
});
