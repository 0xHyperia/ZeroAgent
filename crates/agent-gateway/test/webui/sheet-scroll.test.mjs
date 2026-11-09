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
  // The real worker, WASM and JSDOM share CPU with the other WebUI fixtures.
  // Keep the row-level assertions bounded; give the process watchdog headroom.
  timeout: 60000,
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
  let activeCell;
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
    for (let col = 1; col <= 80; col++) sheet.getColumn(col).width = 8 + col % 4;
    sheet.mergeCells("B1:AB1");
    sheet.getCell("B1").value = "Merged title spanning the horizontal window";
    sheet.mergeCells("D3:E6");
    sheet.getCell("D3").value = "Merged rows and columns";
    sheet.getCell("CB300").value = "End of worksheet";
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
          renderActiveCellOverlay: ({ cell }) => {
            activeCell = { ...cell };
            return null;
          },
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
      if (top === 0) {
        // A virtual row may mount before its cells arrive from the WASM worker.
        for (let attempts = 0; attempts < 30; attempts++) {
          if (host.querySelector('[data-xlsx-row="1"]')?.textContent.includes("Visible row 2"))
            break;
          await env.act(settle);
        }
      }
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
    // Worker mode has no synchronous worksheet object. Its metadata must still
    // keep every intersecting merge complete, rather than letting colspan consume
    // the trailing virtual spacer and change the title width on every scroll.
    for (const left of [0, 240, 720, 1500, 2600, 4000, 720, 240, 0]) {
      await env.act(async () => {
        viewport.scrollLeft = left;
        viewport.dispatchEvent(new window.Event("scroll"));
        await settle();
      });
      const rendered = [...host.querySelectorAll('tbody [data-xlsx-row="0"] [data-xlsx-cell]')];
      const title = host.querySelector('[data-xlsx-cell="0:1"]');
      if (left < 1500) assert.ok(title, "an intersecting merged title must retain its anchor");
      if (left === 0) {
        assert.ok(
          host.querySelector('[data-xlsx-cell="0:0"]'),
          "returning left cannot orphan the first cell",
        );
        assert.ok(
          [...host.querySelectorAll("thead th")].some((cell) => cell.textContent === "A"),
          "returning left cannot orphan the first column header",
        );
      }
      if (title) {
        assert.equal(title.colSpan, 27);
        const columnCount = host.querySelectorAll("colgroup col").length;
        const slots = [...title.parentElement.children].reduce(
          (count, cell) => count + cell.colSpan,
          0,
        );
        assert.equal(slots, columnCount, "a merge cannot consume virtual spacer columns");
      }
      assert.equal(new Set(rendered.map((cell) => cell.dataset.xlsxCell)).size, rendered.length);
      assert.ok(host.querySelectorAll("colgroup col").length < 84, "columns remain virtualized");
    }
    // A merged header can grow beyond the source row height after real layout.
    // Its DOM hit is authoritative even if estimated geometry points elsewhere.
    const mergedTitle = host.querySelector('[data-xlsx-cell="0:1"]');
    mergedTitle.getBoundingClientRect = () => ({
      x: 100, y: 100, left: 100, top: 100, right: 600, bottom: 160, width: 500, height: 60,
    });
    const pointer = (type, target, options = {}) => {
      const event = new window.MouseEvent(type, {
        bubbles: true, button: 0, clientX: 500, clientY: 130, ...options,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      target.dispatchEvent(event);
    };
    await env.act(async () => {
      pointer("pointerdown", mergedTitle);
      pointer("pointerup", mergedTitle);
      await settle();
    });
    assert.deepEqual(activeCell, { row: 0, col: 1 }, "a merged-cell click selects its visible anchor");
    const overlay = [...host.querySelectorAll("[data-xlsx-selection-overlay]")]
      .find((element) => element.style.visibility === "visible");
    assert.ok(overlay);
    assert.equal(overlay.style.left, "100px");
    assert.equal(overlay.style.top, "100px");
    assert.equal(overlay.style.width, "500px");
    assert.equal(overlay.style.height, "60px");
    const setRect = (cell, x, y, width, height) => {
      cell.getBoundingClientRect = () => ({
        x, y, left: x, top: y, right: x + width, bottom: y + height, width, height,
      });
    };
    const start = host.querySelector('[data-xlsx-cell="2:0"]');
    const end = host.querySelector('[data-xlsx-cell="2:3"]');
    setRect(start, 50, 200, 50, 30);
    setRect(end, 300, 200, 180, 120);
    setRect(host.querySelector('[data-xlsx-cell="5:0"]'), 50, 290, 50, 30);
    const click = async (cell, options) => env.act(async () => {
      pointer("pointerdown", cell, options);
      pointer("pointerup", cell, options);
      await settle();
    });
    const assertRangeBounds = () => {
      assert.equal(overlay.style.left, "50px");
      assert.equal(overlay.style.top, "200px");
      assert.equal(overlay.style.width, "430px");
      assert.equal(overlay.style.height, "120px");
    };
    await click(start);
    await click(end, { shiftKey: true });
    assertRangeBounds();
    // Dragging must hit the visible cell in this grid, even when estimated
    // coordinates disagree or another mounted viewer has the same cell address.
    const foreign = document.createElement("td");
    foreign.dataset.xlsxCell = "200:70";
    document.body.appendChild(foreign);
    document.elementsFromPoint = () => [foreign, end];
    await env.act(async () => {
      pointer("pointerdown", start, { clientX: 60, clientY: 210 });
      // Native pointer events arrive as separate tasks. Let the React/Preact
      // bridge commit pointerdown before dispatching the following drag events.
      await settle();
    });
    await env.act(async () => {
      pointer("pointermove", start, { clientX: 400, clientY: 220 });
      pointer("pointerup", window, { clientX: 400, clientY: 220 });
      await settle();
    });
    assertRangeBounds();
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
