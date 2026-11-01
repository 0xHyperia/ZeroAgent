import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  zipSync,
  unzipSync,
  strToU8,
  strFromU8,
} from "../../../agent-ui/node_modules/fflate/esm/browser.js";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";
const requireUI = createRequire(new URL("../../../agent-ui/package.json", import.meta.url));
const fixture = new URL("../fixtures/resource-preview/complete-sheet.xlsx", import.meta.url);
async function prepare(t) {
  const env = await createWebDomTestEnv();
  t.after(() => env.cleanup());
  return env.loadModule("@liveagent/ui/components/resource-preview/sheetSource.ts")
    .prepareStyledSheet;
}
test("preview copy keeps embedded drawings and rules, normalizes dates, and strips remote relationships without changing originals", async (t) => {
  const source = await readFile(fixture),
    prepareSheet = await prepare(t),
    original = Buffer.from(source);
  const files = unzipSync(source);
  files["xl/_rels/external.xml.rels"] = strToU8(
    '<Relationships><Relationship Id="x" Target="https://invalid.example/image" TargetMode="External"/><Relationship Id="local" Target="../media/image1.png"/></Relationships>',
  );
  files["xl/styles.xml"] = strToU8(
    strFromU8(files["xl/styles.xml"]).replace('numFmtId="164"', 'numFmtId="57"'),
  );
  const result = unzipSync(prepareSheet(zipSync(files)));
  assert.equal(strFromU8(result["xl/_rels/external.xml.rels"]).includes("TargetMode"), false);
  assert.match(strFromU8(result["xl/_rels/external.xml.rels"]), /Id="local"/);
  assert.match(strFromU8(result["xl/styles.xml"]), /formatCode="m\/d\/yy"/);
  assert.deepEqual(result["xl/charts/chart1.xml"], files["xl/charts/chart1.xml"]);
  assert.deepEqual(result["xl/media/image1.png"], files["xl/media/image1.png"]);
  assert.deepEqual(source, original);
});
test("active XML/SVG and sparse worksheet attacks cannot enter the full engine", async (t) => {
  const prepareSheet = await prepare(t),
    files = unzipSync(await readFile(fixture));
  const create = (path, value) => zipSync({ ...files, [path]: strToU8(value) });
  assert.throws(
    () =>
      prepareSheet(
        create("xl/test.xml", '<!DOCTYPE t [<!ENTITY evil SYSTEM "file:///secret">]><t/>'),
      ),
    /XML/,
  );
  assert.throws(
    () => prepareSheet(create("xl/media/active.svg", "<svg><script>alert(1)</script></svg>")),
    /活动内容/,
  );
  assert.throws(
    () =>
      prepareSheet(
        create("xl/media/active.svg", '<svg><image href="https://invalid.example/image"/></svg>'),
      ),
    /外部/,
  );
  assert.equal(
    prepareSheet(
      create("xl/worksheets/sheet1.xml", '<worksheet><dimension ref="A1:XFD1048576"/></worksheet>'),
    ),
    null,
  );
});
test("real terminable engine retains four conditional rules, six sparklines, nine chart families and cached formulas", {
  timeout: 20000,
}, async (t) => {
  const root = dirname(requireUI.resolve("@extend-ai/react-xlsx/package.json"));
  const bridge = `import {parentPort} from 'node:worker_threads';globalThis.self={addEventListener:(type,handler)=>parentPort.on(type,data=>handler({data})),postMessage:m=>parentPort.postMessage(m)};await import(${JSON.stringify(pathToFileURL(join(root, "dist/xlsx-worker.js")).href)});`;
  const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(bridge)));
  t.after(() => worker.terminate());
  let sequence = 0;
  const pending = new Map();
  worker.on("message", (message) => pending.get(message.id)?.(message));
  const ask = (type, payload) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, resolve);
      worker.once("error", reject);
      worker.postMessage({ id, type, payload });
    });
  const prepareSheet = await prepare(t),
    source = prepareSheet(await readFile(fixture));
  const result = await ask("load", {
    buffer: source.slice().buffer,
    wasmSource: new Uint8Array(await readFile(join(root, "dist/duke_sheets_wasm_bg.wasm"))),
  });
  assert.equal(result.success, true, result.error);
  const sheet = result.result.sheets[0];
  assert.equal(sheet.conditionalFormatRules.length, 4);
  assert.equal(sheet.sparklines.length, 6);
  assert.equal(sheet.zeroagentVisualValues["3:1"], 15);
  assert.equal(
    result.result.sheets.some((sheet) => sheet.name === "隐藏资料"),
    false,
  );
  assert.deepEqual(sheet.freezePanes, { col: 1, row: 3 });
  const charts = result.result.chartsByWorkbookSheetIndex.flat();
  assert.equal(new Set(charts.map((chart) => chart.chartType)).size, 9);
  assert.ok(charts.every((chart) => chart.series.length));
  const cell = await ask("getCellSnapshot", { workbookSheetIndex: 0, row: 16, col: 1 });
  assert.deepEqual(cell.result, { displayValue: "41", formula: "=1+1" });
});
