import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { buildWorkspaceHTMLPreview } from "../../../agent-ui/src/components/workspace-editor/workspaceHtmlDocument.ts";

const fixture = new Map([
  ["styles/layout.css", ["text/css", '@import "theme.css"; main { background: url("../assets/tile.png") }']],
  ["styles/theme.css", ["text/css", 'h1 { color: rgb(20, 30, 40) }']],
  ["assets/tile.png", ["image/png", "png fixture"]],
]);

function authorDocument(srcDoc) {
  const inner = /<iframe\b[^>]*srcdoc="([^"]*)"/.exec(srcDoc)?.[1];
  assert.ok(inner, "preview embeds a nested author frame");
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"' };
  return inner.replace(/&(amp|lt|gt|quot);/g, (_match, name) => entities[name]);
}

test("desktop HTML builds scoped styles, images and links in an isolated document", async () => {
  const nonce = randomUUID();
  const read = [];
  const { srcDoc, links } = await buildWorkspaceHTMLPreview({
    html: `<!doctype html><meta http-equiv="refresh" content="0;url=https://unsafe.invalid">
      <link rel="stylesheet" href="../styles/layout.css"><script id="author">alert(1)</script>
      <main><h1 onmouseover="alert(2)">Heading</h1>
      <img src="../assets/tile.png"><img src="https://unsafe.invalid/remote.png">
      <img src="../../outside.png"><img src="../assets%2ftile.png">
      <template id="tile"><img src="../assets/tile.png"><img src="https://unsafe.invalid/template.png"></template>
      <a href="next.md">Next</a><a href="https://example.org/path">External</a><a href="#heading">Anchor</a>
      <svg><animate attributeName="href" to="https://unsafe.invalid/"></animate></svg></main>`,
    documentPath: "pages/index.html",
    nonce,
    signal: new AbortController().signal,
    loadAsset: async (path) => {
      read.push(path);
      const [mime_type, source] = fixture.get(path);
      return { mime_type, data: Buffer.from(source).toString("base64") };
    },
  });
  assert.deepEqual(read.sort(), [...fixture.keys()].sort());
  assert.deepEqual([...links.values()], [
    { kind: "file", path: "pages/next.md" },
    { kind: "web", url: "https://example.org/path" },
  ]);
  const doc = authorDocument(srcDoc);
  assert.match(doc, /href="#heading"/);
  assert.match(doc, /img src="data:image\/png;base64,/);
  assert.match(doc, /<template id="tile"><img src="data:image\/png;base64,/);
  assert.match(doc, /script-src 'nonce-[^']+'/);
  assert.match(srcDoc, /frame-src about:/);
  assert.match(doc, /script-src 'unsafe-inline' data:/);
  assert.match(doc, /<script id="author" nonce="[^"]+">alert\(1\)<\/script>/);
  assert.match(doc, /onmouseover="alert\(2\)"/);
  assert.doesNotMatch(doc, /unsafe\.invalid|outside\.png|<animate/);
  const layout = Buffer.from(/href="data:text\/css;base64,([^"]+)"/.exec(doc)[1], "base64").toString();
  const theme = Buffer.from(/@import "data:text\/css;base64,([^"]+)"/.exec(layout)[1], "base64").toString();
  assert.match(layout, /background: url\("data:image\/png;base64,/);
  assert.match(theme, /rgb\(20, 30, 40\)/);
});

test("desktop HTML binds local modules once and preserves cyclic and literal dynamic imports", async () => {
  const read = [];
  const modules = new Map([
    ["pages/start.mjs", ["text/javascript", 'import { value } from "./cycle.mjs"; export const start = () => value;']],
    ["pages/cycle.mjs", ["text/javascript", 'export { start } from "./start.mjs"; export const value = 3;']],
    ["pages/extra.mjs", ["text/javascript", "export default 5;"]],
    ["pages/duplicate.mjs", ["text/javascript", "export default 5;"]],
    ["pages/info.json", ["application/json", '{"ok":true}']],
  ]);
  const { srcDoc } = await buildWorkspaceHTMLPreview({
    html: `<script type="importmap">{"imports":{"host":"https://unsafe.invalid/"}}</script>
      <script type="module" src="./start.mjs"></script>
      <script type="module">import info from "./info.json" with {type: "json"};
      import("./extra.mjs"); import("./duplicate.mjs"); import("https://unsafe.invalid/secret.mjs");</script>
      <script src="../../outside.js"></script>`,
    documentPath: "pages/index.html",
    nonce: randomUUID(),
    signal: new AbortController().signal,
    loadAsset: async (path) => {
      read.push(path);
      const [mime_type, source] = modules.get(path);
      return { mime_type, data: Buffer.from(source).toString("base64") };
    },
  });
  const doc = authorDocument(srcDoc);
  assert.deepEqual(read.sort(), [...modules.keys()].sort());
  assert.doesNotMatch(doc, /unsafe\.invalid|outside\.js/);
  const { imports } = JSON.parse(/<script type="importmap" nonce="[^"]+">([^<]+)<\/script>/.exec(doc)[1]);
  const entries = Object.entries(imports).map(([key, url]) => [key, Buffer.from(url.split("#", 1)[0].split(",")[1], "base64").toString()]);
  const start = entries.find(([, source]) => source.includes("export const start"));
  const cycle = entries.find(([, source]) => source.includes("export const value"));
  assert.ok(start[1].includes(cycle[0]));
  assert.ok(cycle[1].includes(start[0]));
  const duplicates = entries.filter(([, source]) => source === "export default 5;");
  assert.equal(duplicates.length, 2);
  assert.notEqual(imports[duplicates[0][0]], imports[duplicates[1][0]]);
  assert.match(doc, /import\("@zeroagent\/preview\/[^"]+"\)/);
});

test("desktop HTML asset references are bounded and cancel with the current reader", async () => {
  const read = [];
  const controller = new AbortController();
  const build = (html, signal) => buildWorkspaceHTMLPreview({
    html,
    documentPath: "index.html",
    nonce: randomUUID(),
    signal,
    loadAsset: async (path) => {
      read.push(path);
      return { mime_type: "image/png", data: "AA==" };
    },
  });
  await build(Array.from({ length: 72 }, (_, i) => `<img src="image-${i}.png">`).join(""), controller.signal);
  assert.equal(read.length, 64);
  controller.abort();
  await assert.rejects(build("<img src='cancel.png'>", controller.signal), { name: "AbortError" });
  assert.equal(read.length, 64);
});
