import { isolatedPreviewDocument } from "./previewPolicy";

/** Scriptless, inert first-page crop. Never give a thumbnail its own scroll context. */
export function docxCoverDocument(styles: string, page: HTMLElement) {
  return isolatedPreviewDocument(
    `${styles}<style>html,body{padding:0!important;margin:0!important;overflow:hidden!important;scrollbar-width:none!important;height:100%!important;min-height:0!important;background:white!important}*::-webkit-scrollbar{display:none!important}.docx-wrapper{padding:0!important;margin:0!important;background:white!important}.docx-wrapper>section.docx{margin:0!important;box-shadow:none!important}</style><div class="docx-wrapper">${page.outerHTML}</div>`,
    "document",
  );
}
