import type { PresentationData } from "@office-kit/pptx";
import type { Workbook } from "exceljs";
import type { WorkBook } from "xlsx";
import { inspectPreviewArchive } from "./previewArchive";
import type { PreviewWorkerInput, PreviewWorkerResult } from "./previewWorkerProtocol";
import { canReadStyledWorkbook } from "./sheetArchive";
import { excelSheetModel, type SheetModel, sheetStyle } from "./sheetModel";
import { prepareStyledSheet } from "./sheetSource";

let presentation: PresentationData | null = null;
let workbook: WorkBook | null = null;
let formattedWorkbook: Workbook | null = null;
let formatLimited = false;

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
  if (formattedWorkbook) {
    const sheet = formattedWorkbook.getWorksheet(name);
    if (!sheet || sheet.state !== "visible") throw new Error("工作表不存在。");
    const { SSF } = await import("xlsx");
    return {
      sheet: excelSheetModel(
        formattedWorkbook,
        sheet,
        SSF.format,
        (address) => workbook?.Sheets[name]?.[address]?.w,
      ),
      sheetNames: formattedWorkbook.worksheets
        .filter((item) => item.state === "visible")
        .map((item) => item.name),
    };
  }
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
  let textBudget = 0;
  const rows = values.map((row) =>
    row.map((value) => {
      const text = String(value ?? "").slice(0, 8192);
      textBudget += text.length;
      if (textBudget > 4 * 1024 * 1024) throw new Error("工作表文字较多，请下载原件查看。");
      return text;
    }),
  );
  const model: SheetModel = {
    name,
    formatLimited,
    widths: Array.from({ length: range.e.c + 1 }, (_, i) => {
      const column = sheet["!cols"]?.[i];
      return column?.hidden ? 0 : (column?.wpx ?? (column?.wch ? column.wch * 8 : 96));
    }),
    heights: Array.from({ length: Math.max(1, rows.length) }, (_, i) => {
      const row = sheet["!rows"]?.[i];
      return row?.hidden ? 0 : (row?.hpx ?? (row?.hpt ? (row.hpt * 4) / 3 : 24));
    }),
    cells: rows.flatMap((row, r) =>
      row.map((text, c) => ({
        row: r,
        column: c,
        text,
        formula: sheet[utils.encode_cell({ r, c })]?.f
          ? `=${sheet[utils.encode_cell({ r, c })].f}`
          : undefined,
        style: 0,
      })),
    ),
    styles: [sheetStyle()],
    merges: (sheet["!merges"] ?? [])
      .filter((m) => m.s.r <= range.e.r && m.s.c <= range.e.c)
      .slice(0, 2000)
      .map((m) => ({
        r1: m.s.r,
        c1: m.s.c,
        r2: Math.min(range.e.r, m.e.r),
        c2: Math.min(range.e.c, m.e.c),
      })),
    truncated:
      utils.decode_range(sheet["!fullref"] || sheet["!ref"] || "A1").e.r > 499 ||
      utils.decode_range(sheet["!ref"] || "A1").e.c > 79,
  };
  return { rows, sheet: model, sheetNames: workbook.SheetNames };
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
  if (input.kind === "sheet-source") {
    if (entries?.some((entry) => entry.name === "xl/workbook.xml")) {
      const workbookBytes = prepareStyledSheet(bytes);
      return workbookBytes ? { workbookBytes } : { sheetFallback: true };
    }
    // Keep the bounded legacy/text parser for XLS and delimiter-separated input.
    return { sheetFallback: true };
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
  formatLimited =
    !!entries?.some((entry) => entry.name === "xl/workbook.xml") && !canReadStyledWorkbook(bytes);
  if (entries?.some((entry) => entry.name === "xl/workbook.xml") && !formatLimited) {
    const ExcelJS = (await import("exceljs")).default;
    formattedWorkbook = new ExcelJS.Workbook();
    await formattedWorkbook.xlsx.load(bytes.slice().buffer, {
      ignoreNodes: [
        "drawing",
        "picture",
        "legacyDrawing",
        "extLst",
        "dataValidations",
        "conditionalFormatting",
      ],
    });
    const visible = formattedWorkbook.worksheets.filter((sheet) => sheet.state === "visible");
    if (!visible.length || formattedWorkbook.worksheets.length > 50)
      throw new Error("工作表数量超出预览范围。");
    // SheetJS supplies locale-sensitive saved display values (including built-in CJK date formats).
    // ExcelJS supplies the original geometry and styles. Neither engine executes formulas.
    workbook = read(bytes, {
      type: "array",
      sheetRows: 500,
      cellHTML: false,
      cellFormula: false,
      cellStyles: false,
      bookVBA: false,
    });
    return renderSheet(visible[0].name);
  }
  formattedWorkbook = null;
  workbook = read(bytes, {
    type: "array",
    sheetRows: 500,
    cellFormula: true,
    cellHTML: false,
    cellStyles: true,
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
