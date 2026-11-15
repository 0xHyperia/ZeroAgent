import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const supportedVersions = new Set(["2.8.145", "2.8.146"]);

async function resolveArtifactTool() {
  const entry = process.env.ZEROAGENT_FILE_ARTIFACT_ENTRY;
  if (!entry || !path.isAbsolute(entry)) {
    throw new Error("The installed Artifact Tool runtime is unavailable.");
  }
  const manifest = JSON.parse(await readFile(path.resolve(path.dirname(entry), "../package.json"), "utf8"));
  if (manifest.name !== "@oai/artifact-tool" || !supportedVersions.has(manifest.version)) {
    throw new Error("Artifact Tool version does not match the runtime lock.");
  }
  return { entry, version: manifest.version };
}

export async function loadArtifactTool() {
  const { entry } = await resolveArtifactTool();
  return import(pathToFileURL(entry).href);
}

function position(box) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) {
    throw new Error("Each presentation object needs four finite coordinates.");
  }
  const [left, top, width, height] = box.map((inches) => inches * 96);
  return { left, top, width, height };
}

function setCell(sheet, address, value) {
  const range = sheet.getRange(address);
  if (typeof value === "string" && value.startsWith("=")) range.formulas = [[value]];
  else range.values = [[value]];
}

async function spreadsheet(api, { operation, source, output, request }) {
  const { Workbook, SpreadsheetFile, FileBlob } = api;
  const workbook = source ? await SpreadsheetFile.importXlsx(await FileBlob.load(source)) : Workbook.create();
  if (operation === "render") {
    const sheetName = request.sheet ?? workbook.worksheets.items[0]?.name;
    const image = await workbook.render({ sheetName, range: request.range, autoCrop: "all", format: "png", scale: request.scale ?? 1 });
    await writeFile(output, new Uint8Array(await image.arrayBuffer()));
    return { sheet: sheetName };
  }
  const specs = request.sheets?.length ? request.sheets : source ? [] : [{ name: "Sheet" }];
  for (const spec of specs) {
    if (!workbook.worksheets.items.some((sheet) => sheet.name === spec.name)) workbook.worksheets.add(spec.name);
  }
  for (const spec of specs) {
    const sheet = workbook.worksheets.getItem(spec.name);
    for (const [row, values] of (spec.rows ?? []).entries()) {
      for (const [column, value] of values.entries()) {
        const range = sheet.getCell(row, column);
        if (typeof value === "string" && value.startsWith("=")) range.formulas = [[value]];
        else range.values = [[value]];
      }
    }
    for (const [address, value] of Object.entries(spec.cells ?? {})) setCell(sheet, address, value);
    for (const [address, format] of Object.entries(spec.number_formats ?? {})) sheet.getRange(address).setNumberFormat(format);
    for (const table of spec.tables ?? []) sheet.tables.add(table.range, true, table.name);
    for (const chart of spec.charts ?? []) {
      const view = sheet.charts.add(chart.type, sheet.getRange(chart.range));
      view.title = chart.title ?? "";
      view.setPosition(chart.anchor, chart.end ?? "L16");
    }
    if (spec.validation?.length || Object.keys(spec.data_tables ?? {}).length || Object.keys(request.names ?? {}).length) {
      throw new Error("Use the original Artifact Tool API guide for validation, defined names and what-if tables.");
    }
  }
  workbook.recalculate();
  const artifact = await SpreadsheetFile.exportXlsx(workbook);
  await artifact.save(output);
  return { sheets: workbook.worksheets.items.map(({ name }) => name) };
}

async function presentations(api, { operation, source, output, request, inputs }) {
  const { Presentation, PresentationFile, FileBlob } = api;
  const presentation = source
    ? await PresentationFile.importPptx(await FileBlob.load(source))
    : Presentation.create({ slideSize: { width: 1280, height: 720 } });
  if (operation === "render") {
    const page = request.page ?? 1;
    const slide = presentation.slides.items[page - 1];
    if (!slide) throw new Error("The selected slide does not exist.");
    const image = await presentation.export({ slide, format: "png", scale: request.scale ?? 1 });
    await writeFile(output, new Uint8Array(await image.arrayBuffer()));
    return { page };
  }
  for (const spec of request.slides ?? []) {
    if (spec.layout !== undefined) throw new Error("Use the original template guide to select a named layout.");
    const slide = presentation.slides.add();
    if (spec.notes) slide.speakerNotes.text = spec.notes;
    for (const item of spec.objects ?? []) {
      const frame = position(item.box);
      if (item.type === "text" || item.type === "shape") {
        const shape = slide.shapes.add({
          geometry: item.type === "text" ? "textbox" : item.shape,
          position: frame,
          fill: item.fill ?? "none",
        });
        shape.text = item.text ?? "";
        if (item.style) shape.text.style = item.style;
        if (item.link) throw new Error("Use the original Artifact Tool API guide for linked text runs.");
      } else if (item.type === "chart") {
        slide.charts.add(item.chart, {
          position: frame,
          categories: item.categories,
          series: Object.entries(item.series).map(([name, values]) => ({ name, values })),
        });
      } else if (item.type === "image") {
        slide.images.add({ blob: new Uint8Array(await readFile(inputs[item.source])), position: frame, fit: "contain" });
      } else {
        throw new Error("Use the original Artifact Tool API guide for this slide object.");
      }
    }
  }
  if (!presentation.slides.items.length) throw new Error("Provide at least one slide.");
  const artifact = await PresentationFile.exportPptx(presentation);
  await artifact.save(output);
  return { slide_count: presentation.slides.items.length };
}

async function main() {
  const { entry, version } = await resolveArtifactTool();
  const api = await import(pathToFileURL(entry).href);
  if (process.argv[2] === "--probe") {
    process.stdout.write(JSON.stringify({ version, workbook: !!api.Workbook, presentation: !!api.Presentation }));
    return;
  }
  const job = JSON.parse(await readFile(process.argv[2], "utf8"));
  const result = await (job.kind === "spreadsheet" ? spreadsheet : presentations)(api, job);
  await writeFile(process.argv[3], JSON.stringify({ engine: "@oai/artifact-tool", ...result }), { flag: "wx" });
}

const launchedFile = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (launchedFile && import.meta.url === pathToFileURL(launchedFile).href) {
  await main().catch((error) => {
    process.stderr.write(String(error.message).slice(0, 700));
    process.exitCode = 1;
  });
}
