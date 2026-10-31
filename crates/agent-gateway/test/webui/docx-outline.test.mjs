import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";

const loader = createWebModuleLoader();
const { prepareDocxOutline, createDocxOutline, DOCX_OUTLINE_LIMITS } = loader.loadModule("@liveagent/ui/components/resource-preview/docxOutline.ts");
const requireFromUI = createRequire(new URL("../../../agent-ui/package.json", import.meta.url));
const requireFromWeb = createRequire(new URL("../../web/package.json", import.meta.url));
const { JSDOM } = requireFromWeb("jsdom");
const { zipSync, strToU8 } = requireFromUI("fflate");
const paragraph = properties => ({ type: "paragraph", children: [], ...properties });
const model = (paragraphs, styles = []) => ({ documentPart: { body: { type: "document", children: paragraphs } }, stylesPart: { styles } });

test("DOCX outline uses paragraph levels and localized style inheritance, with explicit body text overriding a heading style", () => {
  const values = [paragraph({ outlineLevel: 0, className: "original" }), paragraph({ styleName: "正文带编号" }), paragraph({ styleName: "章标题" }), paragraph({ outlineLevel: 9, styleName: "章标题" }), paragraph({ styleName: "Heading1" })];
  const result = prepareDocxOutline(model(values, [
    { id: "正文带编号", target: "p", basedOn: "节标题" },
    { id: "章标题", target: "p", paragraphProps: { outlineLevel: 0 } },
    { id: "节标题", target: "p", basedOn: "章标题", paragraphProps: { outlineLevel: 2 } },
    { id: "Heading1", name: "Heading 1", target: "p" },
  ]));
  assert.deepEqual(result.map(entry => entry.level), [0, 2, 0]);
  assert.match(values[0].className, /^original za-docx-outline-mark-1$/);
  assert.equal(values[3].className, undefined);
  assert.equal(values[4].className, undefined);
});

test("DOCX outline bounds style inheritance and detects recursive or oversized document models", () => {
  const cycle = [{ id: "甲", target: "p", basedOn: "乙" }, { id: "乙", target: "p", basedOn: "甲" }];
  assert.deepEqual(prepareDocxOutline(model([paragraph({ styleName: "甲" })], cycle)), []);
  const chain = Array.from({ length: DOCX_OUTLINE_LIMITS.styleDepth + 1 }, (_, index) => ({ id: String(index), target: "p", basedOn: String(index + 1), ...(index === DOCX_OUTLINE_LIMITS.styleDepth ? { paragraphProps: { outlineLevel: 0 } } : {}) }));
  assert.deepEqual(prepareDocxOutline(model([paragraph({ styleName: "0" })], chain)), []);
  const recursive = paragraph({ outlineLevel: 0 }); recursive.children.push(recursive);
  assert.throws(() => prepareDocxOutline(model([recursive])), /文档结构较复杂/);
  let deep = paragraph({});
  for (let index = 0; index < DOCX_OUTLINE_LIMITS.depth + 1; index++) deep = { type: "table", children: [deep] };
  assert.throws(() => prepareDocxOutline(model([deep])), /文档结构较复杂/);
  assert.throws(() => prepareDocxOutline(model(Array.from({ length: DOCX_OUTLINE_LIMITS.nodes }, () => paragraph({})))), /文档内容较多/);
  assert.throws(() => prepareDocxOutline(model([], Array.from({ length: DOCX_OUTLINE_LIMITS.styles + 1 }, () => ({})))), /文档样式较多/);
  assert.equal(prepareDocxOutline(model(Array.from({ length: DOCX_OUTLINE_LIMITS.headings + 1 }, () => paragraph({ outlineLevel: 0 })))).length, DOCX_OUTLINE_LIMITS.headings);
});

test("DOCX directory reads rendered text, creates collision-free same-srcdoc anchors and preserves existing bookmarks", t => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>"); t.after(() => dom.window.close());
  const doc = dom.window.document, root = doc.createElement("div");
  root.innerHTML = '<span id="za-docx-section-1"></span><p id="原有书签" class="za-docx-outline-mark-1"></p><p class="za-docx-outline-mark-2"></p><p class="za-docx-outline-mark-3">  </p>';
  root.querySelector("p").textContent = '<img src=x onerror="alert(1)"> 同名标题';
  root.querySelectorAll("p")[1].textContent = "同名标题";
  const navigation = createDocxOutline(root, [{ marker: "za-docx-outline-mark-1", level: 0 }, { marker: "za-docx-outline-mark-2", level: 2 }, { marker: "za-docx-outline-mark-3", level: 1 }]);
  assert.ok(navigation); assert.equal(navigation.open, true);
  assert.equal(navigation.querySelectorAll("a").length, 2);
  assert.equal(navigation.querySelector("img,script"), null);
  assert.match(navigation.textContent, /<img src=x onerror="alert\(1\)"> 同名标题/);
  assert.ok(root.querySelector('[id="原有书签"]'));
  const destinations = [...navigation.querySelectorAll("a")].map(link => link.getAttribute("href"));
  assert.deepEqual(destinations, ["about:srcdoc#za-docx-section-1-2", "about:srcdoc#za-docx-section-2"]);
  for (const destination of destinations) assert.equal(root.querySelectorAll(`[id="${destination.split("#")[1]}"]`).length, 1);
  assert.equal(createDocxOutline(root, []), null);
});

function docxFixture() {
  return zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/_rels/document.xml.rels": strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    "word/styles.xml": strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="中文标题"><w:name w:val="章标题"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="继承标题"><w:basedOn w:val="中文标题"/></w:style></w:styles>'),
    "word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="继承标题"/></w:pPr><w:r><w:t>实际中文章节</w:t></w:r></w:p><w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>独立三级标题</w:t></w:r></w:p><w:p><w:r><w:t>正文不会进入目录。</w:t></w:r></w:p></w:body></w:document>'),
  });
}

async function adapter(t, mocks = {}) {
  const env = await createWebDomTestEnv({ resolveDynamicImports: true, mocks });
  const parser = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
  globalThis.DOMParser = env.dom.window.DOMParser;
  const host = document.body.appendChild(document.createElement("div")), root = env.createRoot(host);
  t.after(async () => { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); if (parser) Object.defineProperty(globalThis, "DOMParser", parser); else delete globalThis.DOMParser; });
  const Component = env.loadModule("@liveagent/ui/components/resource-preview/ResourceDOCXPreview.tsx").default;
  const mount = async props => env.act(async () => root.render(env.React.createElement(Component, props)));
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await env.act(async () => new Promise(resolve => setTimeout(resolve, 10)));
    assert.ok(predicate(), host.textContent);
  };
  return { env, host, root, mount, waitFor };
}

test("real DOCX bytes are inspected before parse/render and produce one sandboxed document with its native directory", async t => {
  const calls = [];
  const real = requireFromUI("docx-preview");
  const { inspectPreviewArchive } = loader.loadModule("@liveagent/ui/components/resource-preview/previewArchive.ts");
  const app = await adapter(t, {
    "./previewWorkerClient": { createResourcePreviewWorker: () => ({ dispose() {}, async request(input) { calls.push("inspect"); return { entries: inspectPreviewArchive(input.bytes) }; } }) },
    "docx-preview": { async parseAsync(...args) { calls.push("parse"); return real.parseAsync(...args); }, async renderDocument(...args) { calls.push("render"); return real.renderDocument(...args); } },
  });
  await app.mount({ bytes: docxFixture(), name: "中文文档.docx", assertCurrent() {} });
  await app.waitFor(() => app.host.querySelector("iframe") || app.host.querySelector(".za-preview-unavailable"));
  assert.deepEqual(calls, ["inspect", "parse", "render"]);
  const frame = app.host.querySelector("iframe"); assert.ok(frame, app.host.textContent);
  assert.equal(frame.getAttribute("sandbox"), "");
  assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
  assert.match(frame.srcdoc, /script-src 'none'; connect-src 'none'/);
  assert.match(frame.srcdoc, /base-uri 'none'/);
  const rendered = new JSDOM(frame.srcdoc); t.after(() => rendered.window.close());
  const links = [...rendered.window.document.querySelectorAll('nav[aria-label="文档目录"] a')];
  assert.deepEqual(links.map(link => link.textContent), ["实际中文章节", "独立三级标题"]);
  assert.ok(links.every(link => link.getAttribute("href").startsWith("about:srcdoc#")));
  assert.equal(rendered.window.document.querySelector("h1,h2,h3"), null);
  assert.doesNotMatch(app.host.textContent, /页数|第.*页/);
});

test("retiring a DOCX adapter while parsing disposes its worker and never renders a late model", async t => {
  let release, disposed = false, rendered = false, signal;
  const app = await adapter(t, {
    "./previewWorkerClient": { createResourcePreviewWorker: current => { signal = current; return { dispose() { disposed = true; }, async request() { return { entries: [{ name: "word/document.xml", size: 1, directory: false }] }; } }; } },
    "docx-preview": { parseAsync: () => new Promise(resolve => { release = resolve; }), async renderDocument() { rendered = true; return []; } },
  });
  await app.mount({ bytes: docxFixture(), name: "慢文档.docx", assertCurrent() {} });
  await app.waitFor(() => Boolean(release));
  await app.env.act(async () => app.root.unmount());
  assert.equal(disposed, true); assert.equal(signal.aborted, true);
  await app.env.act(async () => release(model([paragraph({ outlineLevel: 0 })])));
  assert.equal(rendered, false); assert.equal(app.host.querySelector("iframe"), null);
});
