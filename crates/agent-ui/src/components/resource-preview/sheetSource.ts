import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { canReadStyledWorkbook } from "./sheetArchive";

/** Runs after ZIP expansion/path inspection, in a terminable worker. The original stays untouched. */
export function prepareStyledSheet(bytes: Uint8Array) {
  if (!canReadStyledWorkbook(bytes)) return null;
  const files = unzipSync(bytes);
  let sheets = 0;
  // Preserve portable short-date semantics; WASM's built-in 14 otherwise uses mm-dd-yy.
  if (files["xl/styles.xml"]) {
    let styles = strFromU8(files["xl/styles.xml"]);
    const dates = new Set([14, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55, 57, 58]);
    const used = new Set(
      [...styles.matchAll(/\bnumFmtId\s*=\s*["'](\d+)["']/g)].map((match) => Number(match[1])),
    );
    let dateId = 164;
    while (used.has(dateId)) dateId++;
    let dateUsed = false;
    styles = styles.replace(/\bnumFmtId\s*=\s*["'](\d+)["']/g, (attribute, value) => {
      const id = Number(value);
      if (dates.has(id)) {
        dateUsed = true;
        return `numFmtId="${dateId}"`;
      }
      if (id === 32 || id === 33) return 'numFmtId="21"';
      return attribute;
    });
    if (dateUsed) {
      const prefix = /<(\w+:)?styleSheet\b/.exec(styles)?.[1] ?? "";
      const format = `<${prefix}numFmt numFmtId="${dateId}" formatCode="m/d/yy"/>`;
      const formats = new RegExp(`<${prefix}numFmts\\b([^>]*)>([\\s\\S]*?)</${prefix}numFmts>`);
      const emptyFormats = new RegExp(`<${prefix}numFmts\\b[^>]*/>`);
      if (formats.test(styles))
        styles = styles.replace(
          formats,
          (_, _attrs: string, body: string) =>
            `<${prefix}numFmts count="${[...body.matchAll(/<(?:\w+:)?numFmt\b/g)].length + 1}">${body}${format}</${prefix}numFmts>`,
        );
      else if (emptyFormats.test(styles))
        styles = styles.replace(
          emptyFormats,
          `<${prefix}numFmts count="1">${format}</${prefix}numFmts>`,
        );
      else
        styles = styles.replace(
          /(<(?:\w+:)?styleSheet\b[^>]*>)/,
          `$1<${prefix}numFmts count="1">${format}</${prefix}numFmts>`,
        );
    }
    files["xl/styles.xml"] = strToU8(styles);
  }
  for (const [path, content] of Object.entries(files)) {
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(path)) sheets++;
    if (/\.xml$|\.rels$/i.test(path)) {
      const xml = strFromU8(content);
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("此工作簿包含不受支持的 XML 声明。");
      // External relationships (links, remote images, linked books) must never cause preview I/O.
      if (/\.rels$/i.test(path))
        files[path] = strToU8(
          xml.replace(
            /<(?:\w+:)?Relationship\b(?=[^>]*\bTargetMode\s*=\s*["']External["'])[^>]*\/?\s*>/gi,
            "",
          ),
        );
    }
    if (/\.svg$/i.test(path)) {
      const svg = strFromU8(content);
      if (
        /<(?:\w+:)?(?:script|foreignObject)\b|\bon\w+\s*=|(?:href\s*=\s*["']\s*(?!#|data:image\/(?:png|jpeg|gif|webp);base64,))|url\(\s*(?!#)/i.test(
          svg,
        )
      )
        throw new Error("此工作簿的矢量图像包含外部或活动内容，请下载原件查看。");
    }
  }
  if (!sheets || sheets > 50) throw new Error("工作表数量超出预览范围。");
  return zipSync(files, { level: 1 });
}
