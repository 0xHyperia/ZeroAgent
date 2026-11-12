import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as streamdown from "../../node_modules/streamdown/dist/index.js";
import remarkBreaks from "../../node_modules/remark-breaks/index.js";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const renders = [];
let deferRenders = false;
let config;
const mermaid = {
  initialize(next) { config = next; },
  registerLayoutLoaders() {},
  render(id, chart) {
    const theme = config.darkMode ? "dark" : "default";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" data-theme="${theme}"><text>${theme}</text></svg>`;
    const job = { id, chart, theme };
    renders.push(job);
    return deferRenders
      ? new Promise((resolve) => { job.complete = () => resolve({ svg }); })
      : Promise.resolve({ svg });
  },
};

const env = await createDomTestEnv({ mocks: {
  streamdown,
  "remark-breaks": { __esModule: true, default: remarkBreaks },
  "./loadMermaid": {
    loadMermaid: async () => ({ default: mermaid }),
    loadMermaidElk: async () => ({ default: [] }),
  },
  "@streamdown/code": { code: undefined },
  "@streamdown/math": { math: undefined },
  "@streamdown/cjk": { cjk: undefined },
  "@liveagent/app/shims/tauriOpener": { openUrl() {} },
  "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
  "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
} });
const { React, act, createRoot } = env;
const { Markdown } = env.loadModule("@liveagent/ui/components/Markdown.tsx");
const { MarkdownMermaidBlock } = env.loadModule("@liveagent/ui/components/markdown/MarkdownMermaidBlock.tsx");
const previousParser = globalThis.DOMParser;
const previousSerializer = globalThis.XMLSerializer;
globalThis.XMLSerializer = window.XMLSerializer;
const previousIntersectionObserver = globalThis.IntersectionObserver;
globalThis.DOMParser = window.DOMParser;
globalThis.IntersectionObserver = class {
  constructor(callback) { this.callback = callback; }
  observe(target) { this.callback([{ target, isIntersecting: true }]); }
  takeRecords() { return []; }
  disconnect() {}
};
after(() => {
  globalThis.DOMParser = previousParser;
  globalThis.XMLSerializer = previousSerializer;
  globalThis.IntersectionObserver = previousIntersectionObserver;
  env.cleanup();
});

async function mount(component) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(React.StrictMode, null, component)));
  return async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  assert.ok(predicate(), "Expected Mermaid render to complete");
}

async function setDark(dark) {
  await act(async () => { document.documentElement.classList.toggle("dark", dark); });
}

const chart = "flowchart LR\n  A[Input] --> B{Validate}\n  B --> C[Done]";
const inlineSvg = () => document.querySelector('[data-streamdown="mermaid"] svg[data-theme]');
const fullscreen = () => document.querySelector('[data-liveagent-mermaid-fullscreen]');

for (const props of [{ renderMode: "static" }, { renderMode: "streaming" }, { readOnly: true }]) {
  test(`mounted Markdown follows the effective html theme: ${JSON.stringify(props)}`, async () => {
    await setDark(true);
    const cleanup = await mount(React.createElement(Markdown, {
      content: `Stable paragraph\n\n\`\`\`mermaid\n${chart}\n\`\`\``,
      ...props,
    }));
    try {
      await eventually(() => inlineSvg()?.dataset.theme === "dark");
      const paragraph = document.querySelector("p");
      const darkSvg = inlineSvg();
      await setDark(false);
      await eventually(() => inlineSvg()?.dataset.theme === "default");
      assert.notEqual(inlineSvg(), darkSvg);
      assert.equal(document.querySelector("p"), paragraph, "Other Markdown must not remount");
      await setDark(true);
      await eventually(() => inlineSvg()?.dataset.theme === "dark");
      const count = renders.length;
      await act(async () => { document.documentElement.classList.toggle("unrelated-class"); });
      assert.equal(renders.length, count, "Unrelated html classes must not redraw diagrams");
    } finally { await cleanup(); }
  });
}

test("theme changes preserve expanded code blocks and an open fullscreen dialog", async () => {
  await setDark(false);
  const longCode = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
  const cleanup = await mount(React.createElement(Markdown, {
    content: `\`\`\`text\n${longCode}\n\`\`\`\n\n\`\`\`mermaid\n${chart}\n\`\`\``,
  }));
  try {
    await eventually(() => inlineSvg()?.dataset.theme === "default");
    await act(async () => [...document.querySelectorAll("button")].find((button) =>
      button.textContent.includes("chat.markdown.expandCode")).click());
    assert.equal(document.querySelector('[data-liveagent-code-preview="collapsed"]'), null);
    await act(async () => document.querySelector('[aria-label="chat.imageViewer.fullscreen"]').click());
    await eventually(() => fullscreen()?.querySelector("svg[data-theme]")?.dataset.theme === "default");
    const dialog = fullscreen();
    await setDark(true);
    await eventually(() => inlineSvg()?.dataset.theme === "dark" &&
      fullscreen()?.querySelector("svg[data-theme]")?.dataset.theme === "dark");
    assert.equal(fullscreen(), dialog);
    assert.equal(document.querySelector('[data-liveagent-code-preview="collapsed"]'), null);
    await setDark(false);
    await eventually(() => inlineSvg()?.dataset.theme === "default" &&
      fullscreen()?.querySelector("svg[data-theme]")?.dataset.theme === "default");
  } finally { await cleanup(); }
});

test("streaming fences wait for the full language and the closing delimiter", async () => {
  await setDark(false);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const initialCount = renders.length;
  const update = (content) => act(async () => root.render(React.createElement(Markdown, {
    renderMode: "streaming", showCaret: true, content,
  })));
  try {
    await update("```mer");
    assert.ok(container.querySelector("[data-waiting]"));
    await update("~~~mermaid\n" + chart + "\n");
    assert.ok(container.querySelector("[data-waiting]"));
    assert.equal(renders.length, initialCount);
    await update("~~~mermaid\n" + chart + "\n~~~");
    await eventually(() => inlineSvg());
    assert.equal(renders.length, initialCount + 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a serialized old-theme render cannot replace a newer requested theme", async () => {
  await setDark(false);
  renders.length = 0;
  deferRenders = true;
  const cleanup = await mount(React.createElement(MarkdownMermaidBlock, { chart }));
  try {
    await eventually(() => renders.length === 1);
    await setDark(true);
    assert.equal(renders.length, 1);
    await act(async () => renders[0].complete());
    await eventually(() => renders[1]?.theme === "dark");
    assert.equal(inlineSvg(), null);
    await act(async () => renders[1].complete());
    await eventually(() => inlineSvg()?.dataset.theme === "dark");
  } finally {
    for (const job of renders) job.complete?.();
    deferRenders = false;
    await cleanup();
  }
});

test("author configuration and diagram clicks cannot override the renderer", async () => {
  const source = [
    "---",
    "title: Preview title",
    "config:",
    "  securityLevel: loose",
    "---",
    '%%{init: {"themeCSS": ".untrusted{}"}}%%',
    chart,
    'click A "https://example.invalid"',
  ].join("\n");
  const cleanup = await mount(React.createElement(MarkdownMermaidBlock, { chart: source }));
  try {
    await eventually(() => inlineSvg());
    const renderedSource = renders.at(-1).chart;
    assert.match(renderedSource, /title: "Preview title"/);
    assert.match(renderedSource, /layout: elk/);
    assert.doesNotMatch(renderedSource, /securityLevel|themeCSS|\bclick\b/);
  } finally {
    await cleanup();
  }
});
