import type { PresentationData } from "@office-kit/pptx";
import type { WorkBook } from "xlsx";
import { inspectPreviewArchive } from "./previewArchive";
import type { PreviewWorkerInput, PreviewWorkerResult } from "./previewWorkerProtocol";

let presentation: PresentationData | null = null;
let workbook: WorkBook | null = null;

async function renderSlide(index: number): Promise<PreviewWorkerResult> {
  if (!presentation || !Number.isInteger(index)) throw new Error("幻灯片尚未就绪。");
  const [{ getSlides }, { renderSlideToSvg }] = await Promise.all([
    import("@office-kit/pptx"),
    import("@office-kit/pptx-preview"),
  ]);
  const slides = getSlides(presentation);
  if (index < 0 || index >= slides.length || slides.length > 150)
    throw new Error("演示文稿超过预览页数限制。");
  const context =
    typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
  const svg = renderSlideToSvg(presentation, slides[index], {
    textLayout: "svg",
    resolveFamily: (family) => family || "sans-serif",
    ...(context
      ? {
          measureText: (text, spec) => {
            context.font = `${spec.italic ? "italic " : ""}${spec.bold ? "bold " : ""}${spec.sizePx}px ${JSON.stringify(spec.family)}`;
            const metric = context.measureText(text);
            return {
              widthPx: metric.width + Math.max(0, [...text].length - 1) * spec.letterSpacingPx,
            };
          },
        }
      : {}),
  });
  if (svg.length > 8 * 1024 * 1024) throw new Error("此幻灯片过于复杂，请下载原件查看。");
  return { svg, slideCount: slides.length };
}

async function renderSheet(name: string): Promise<PreviewWorkerResult> {
  if (!workbook?.SheetNames.includes(name)) throw new Error("工作表不存在。");
  const { utils } = await import("xlsx");
  const sheet = workbook.Sheets[name];
  const range = utils.decode_range(sheet["!ref"] || "A1");
  range.s.r = 0;
  range.s.c = 0;
  range.e.r = Math.min(range.e.r, 499);
  range.e.c = Math.min(range.e.c, 79);
  const values = utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    range,
  });
  const rows = values.map((row) => row.map((value) => String(value ?? "").slice(0, 8192)));
  return { rows, sheetNames: workbook.SheetNames };
}

async function handle(input: PreviewWorkerInput): Promise<PreviewWorkerResult> {
  if (input.type === "slide") return renderSlide(input.index);
  if (input.type === "sheet") return renderSheet(input.name);
  const { bytes } = input;
  if (bytes.byteLength > 32 * 1024 * 1024) throw new Error("文件超过在线预览大小限制。");
  let entries: PreviewWorkerResult["entries"];
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) entries = inspectPreviewArchive(bytes);
  if (input.kind === "inspect") {
    if (!entries) throw new Error("文件不是受支持的 ZIP 容器。");
    return { entries };
  }
  if (input.kind === "pptx") {
    if (!entries?.some((entry) => entry.name === "ppt/presentation.xml"))
      throw new Error("此文件不是有效的 PPTX 演示文稿。");
    if (entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name)).length > 150)
      throw new Error("演示文稿超过 150 页，请下载原件查看。");
    const { loadPresentation } = await import("@office-kit/pptx");
    presentation = await loadPresentation(bytes);
    return renderSlide(0);
  }
  const { read } = await import("xlsx");
  workbook = read(bytes, {
    type: "array",
    sheetRows: 500,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false,
    raw: true,
  });
  if (!workbook.SheetNames.length || workbook.SheetNames.length > 50)
    throw new Error("工作表数量超出预览范围。");
  return renderSheet(workbook.SheetNames[0]);
}

self.onmessage = (event: MessageEvent<{ id: number; input: PreviewWorkerInput }>) => {
  const { id, input } = event.data;
  void handle(input).then(
    (result) => self.postMessage({ id, result }),
    () =>
      self.postMessage({
        id,
        error: "此文件未能安全解析。可能已损坏、加密或超过预览限制，请下载原件查看。",
      }),
  );
};
