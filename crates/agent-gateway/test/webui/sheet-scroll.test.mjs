import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";

const requireUI = createRequire(new URL("../../../agent-ui/package.json", import.meta.url));

test("the real worker-backed grid survives reverse scrolling inside the shared React scroller", {
  timeout: 20000,
}, async () => {
  const env = await createWebDomTestEnv();
  const { window } = env.dom;
  const previous = new Map(
    ["DOMParser", "XMLSerializer", "Worker"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const workers = [];
  let root;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  try {
    // JSDOM supplies no layout. Only the viewport geometry is synthetic; the actual
    // WASM worker, virtual rows, React/Preact bridge and shared ScrollArea all run.
    const prototype = window.HTMLElement.prototype;
    for (const key of ["offsetHeight", "clientHeight"])
      Object.defineProperty(prototype, key, { configurable: true, get: () => 400 });
    for (const key of ["offsetWidth", "clientWidth"])
      Object.defineProperty(prototype, key, { configurable: true, get: () => 800 });
    prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      bottom: 400,
      right: 800,
      width: 800,
      height: 400,
    });
    prototype.scrollTo = function ({ top = 0, left = 0 }) {
      this.scrollTop = top;
      this.scrollLeft = left;
      this.dispatchEvent(new window.Event("scroll"));
    };
    window.HTMLCanvasElement.prototype.getContext = () => null;
    globalThis.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target) {
        this.callback([
          {
            target,
            borderBoxSize: [{ inlineSize: 800, blockSize: 400 }],
            contentRect: { width: 800, height: 400 },
          },
        ]);
      }
      unobserve() {}
      disconnect() {}
    };
    globalThis.DOMParser = window.DOMParser;
    globalThis.XMLSerializer = window.XMLSerializer;
    globalThis.Worker = class {
      constructor(url) {
        const bridge = `import { parentPort } from 'node:worker_threads';globalThis.self={addEventListener:(type,handler)=>parentPort.on(type,data=>handler({data})),postMessage:message=>parentPort.postMessage(message)};await import(${JSON.stringify(url.href)});`;
        this.worker = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(bridge)}`));
        this.listeners = new Map();
        workers.push(this.worker);
      }
      addEventListener(type, handler) {
        const listener = type === "message" ? (data) => handler({ data }) : handler;
        this.listeners.set(handler, listener);
        this.worker.on(type, listener);
      }
      removeEventListener(type, handler) {
        this.worker.off(type, this.listeners.get(handler));
      }
      postMessage(message, transfer) {
        this.worker.postMessage(message, transfer);
      }
      terminate() {
        void this.worker.terminate();
      }
    };

    const packageRoot = dirname(requireUI.resolve("@extend-ai/react-xlsx/package.json"));
    const engine = await import(pathToFileURL(join(packageRoot, "dist/index.js")));
    engine.setWasmSource(
      new Uint8Array(await readFile(join(packageRoot, "dist/duke_sheets_wasm_bg.wasm"))),
    );
    const ExcelJS = requireUI("exceljs");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Long worksheet");
    for (let row = 1; row <= 300; row++) {
      sheet.getCell(row, 1).value = `Visible row ${row}`;
      sheet.getRow(row).height = row % 5 ? 20 : 45;
    }
    const file = Uint8Array.from(await workbook.xlsx.writeBuffer()).buffer;
    const { ScrollArea } = env.loadModule("@liveagent/ui/components/ui/scroll-area.tsx");
    const renderScroller = ({ children, viewportProps: { ref, ...viewportProps } }) =>
      env.React.createElement(
        ScrollArea,
        { viewportRef: ref, viewportProps, horizontal: true },
        children,
      );
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = env.createRoot(host);
    await env.act(async () =>
      root.render(
        env.React.createElement(engine.XlsxViewer, {
          file,
          readOnly: true,
          useWorker: true,
          experimentalCanvas: false,
          height: 400,
          showDefaultToolbar: false,
          renderScroller,
        }),
      ),
    );
    for (let attempts = 0; attempts < 70 && !host.querySelector('[data-xlsx-row="1"]'); attempts++)
      await env.act(settle);
    const viewport = host.querySelector('[role="grid"]');
    assert.ok(viewport, "the real grid must finish loading");
    const initialCount = host.querySelectorAll("[data-xlsx-row]").length;
    assert.ok(initialCount > 2 && initialCount < 100, "the long worksheet stays virtualized");
    for (const top of [1800, 5000, 2200, 0, 4000, 0]) {
      await env.act(async () => {
        viewport.scrollTop = top;
        viewport.dispatchEvent(new window.Event("scroll"));
        await settle();
      });
      const rows = [...host.querySelectorAll("tbody tr")];
      const content = rows.filter((row) => row.hasAttribute("data-xlsx-row"));
      assert.ok(content.length > 2 && content.length < 100);
      assert.equal(
        new Set(content.map((row) => row.getAttribute("data-xlsx-row"))).size,
        content.length,
        "scrolling cannot orphan duplicate rows",
      );
      if (top > 0)
        assert.ok(
          Number(content[0].getAttribute("data-xlsx-row")) > 1,
          "lower rows must enter the viewport",
        );
      else {
        const second = rows.findIndex((row) => row.getAttribute("data-xlsx-row") === "1");
        assert.ok(second >= 0);
        assert.match(rows[second].textContent, /Visible row 2/);
        assert.ok(
          rows
            .slice(0, second)
            .every(
              (row) =>
                row.hasAttribute("data-xlsx-row") ||
                row.style.display === "none" ||
                Number.parseFloat(row.style.height || "0") === 0,
            ),
          "no stale spacer may push the first content offscreen after returning to the top",
        );
      }
    }
  } finally {
    if (root) await env.act(async () => root.unmount());
    await Promise.all(workers.map((worker) => worker.terminate()));
    await settle();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    env.cleanup();
  }
});
