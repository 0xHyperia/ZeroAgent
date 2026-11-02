import { isSourceFileName } from "./sourceFileType";

export const RESOURCE_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;
export const RESOURCE_TEXT_MAX_BYTES = 2 * 1024 * 1024;
export type ResourcePreviewKind =
  | "docx"
  | "pptx"
  | "pdf"
  | "sheet"
  | "image"
  | "audio"
  | "video"
  | "text"
  | "markdown"
  | "html"
  | "svg"
  | "archive"
  | "unsupported";

export type ResourcePreviewDescriptor = {
  /** Includes the host's owner lifetime and immutable version, never a credential. */
  identity: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
};

export function resourcePreviewKind(
  file: Pick<ResourcePreviewDescriptor, "name" | "mime">,
): ResourcePreviewKind {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "docx") return "docx";
  if (extension === "pptx") return "pptx";
  if (extension === "pdf") return "pdf";
  if (["xlsx", "xls", "xlsm", "xltx", "xltm", "csv", "tsv", "ods"].includes(extension ?? ""))
    return "sheet";
  if (extension === "svg" || file.mime === "image/svg+xml") return "svg";
  if (["html", "htm"].includes(extension ?? "")) return "html";
  if (["md", "markdown"].includes(extension ?? "")) return "markdown";
  if (
    ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"].includes(
      file.mime,
    )
  )
    return "image";
  if (
    ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm", "audio/flac"].includes(
      file.mime,
    )
  )
    return "audio";
  if (["video/mp4", "video/webm", "video/ogg", "video/quicktime"].includes(file.mime))
    return "video";
  if (extension === "zip" || file.mime === "application/zip") return "archive";
  if (
    isSourceFileName(file.name) ||
    file.mime.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-yaml",
    ].includes(file.mime)
  )
    return "text";
  return "unsupported";
}

export function resourceText(bytes: Uint8Array): string {
  if (bytes.byteLength > RESOURCE_TEXT_MAX_BYTES)
    throw new Error("文件较大，请下载原件查看完整内容。");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("此文件不是可预览的 UTF-8 文本，请下载原件。");
  return text;
}

/** Browser rendering does not make arbitrary bytes match a trusted file type. */
export function checkPreviewSignature(kind: ResourcePreviewKind, bytes: Uint8Array) {
  const isZIP = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (["docx", "pptx", "archive"].includes(kind) && !isZIP)
    throw new Error("文件格式不匹配，或文件已加密。请下载原件查看。");
  if (kind === "pdf" && new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-")
    throw new Error("PDF 文件头无效，请下载原件查看。");
}

// No scripts, cookies, same-origin privilege, forms or external subresources.
// Content is still placed inside a sandbox with no permissions by the viewer.
export function isolatedPreviewDocument(body: string, mode?: "document" | "image"): string {
  const styles = `
    html{color-scheme:light;background:#fff;color:#171717;font:15px/1.6 system-ui,sans-serif}
    body{margin:0;padding:16px;overflow-wrap:anywhere}
    img,svg{max-width:100%}
    .docx-wrapper{background:#f3f3f1!important;padding:24px!important}
    .docx-wrapper>section.docx{background:#fff!important;box-shadow:0 1px 3px #0001,0 8px 28px #0001!important;margin:0 auto 24px!important}
    ${mode === "document" ? "html,body{background:#f3f3f1}body{padding:0}" : ""}
    ${mode === "image" ? "html,body{width:100%;height:100%;padding:0;margin:0;overflow:hidden;background:transparent}body>svg{display:block;width:100%!important;height:100%!important;max-width:none}" : ""}
    ${
      mode === "document" || mode === "image"
        ? ""
        : `@media(max-width:960px){
      body{padding:4px}
      .docx-wrapper{padding:12px!important}
      .docx-wrapper>section.docx{box-sizing:border-box!important;width:100%!important;min-width:0!important;max-width:100%!important;min-height:0!important;padding:24px!important;margin-bottom:12px!important}
      .docx-wrapper table{width:100%!important;max-width:100%!important;table-layout:fixed!important;overflow-wrap:anywhere}
      .docx-wrapper col,.docx-wrapper td{width:auto!important;min-width:0!important}
    }`
    }`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer"><style>${styles}</style></head><body>${body}</body></html>`;
}
