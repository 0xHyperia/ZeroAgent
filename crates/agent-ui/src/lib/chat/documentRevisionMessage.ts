import type { DocumentRevisionComment } from "../../components/resource-preview/ResourceDocumentComments";
import type { PendingUploadedFile } from "./uploadedFiles";

const HEADER = "# Diff comments:\n<!-- zeroagent:reader-revision/v1 -->";
const MAX_COMMENTS = 20;
export const MAX_REVISION_EVIDENCE = 7;

type RevisionKind = "document" | "pdf" | "workbook" | "presentation";
const FORMAT_GUIDANCE: Record<RevisionKind, string> = {
  document: "Use the page, selected text, and block or region to locate the original content.",
  pdf: "Use the supplied page and coordinates to locate the edit. Verify against the source and any numbered screenshot.",
  workbook: "Use the exact worksheet name and A1 range. Preserve formulas and styles outside the requested edits.",
  presentation: "Use the slide number and original slide part, then match the OOXML shape ID or the selected area. Preserve the rest of the slide and its layout.",
};
export type RevisionMessageComment = {
  ordinal: number;
  page: number;
  location: string;
  quote: string;
  comment: string;
  evidenceName?: string;
};
export type DocumentRevisionMessage = {
  name: string;
  kind: RevisionKind;
  comments: RevisionMessageComment[];
};

function revisionKind(name: string): RevisionKind {
  if (/\.pdf$/i.test(name)) return "pdf";
  if (/\.(?:xlsx|xlsm|xls|ods|csv|tsv)$/i.test(name)) return "workbook";
  if (/\.(?:pptx|pptm|ppt|odp)$/i.test(name)) return "presentation";
  return "document";
}

export function buildDocumentRevisionMessage(
  name: string,
  comments: readonly DocumentRevisionComment[],
  options: { workspacePath?: string; evidenceNames?: readonly string[] } = {},
) {
  const kind = revisionKind(name);
  const file = { name, kind };
  const destination = options.workspacePath
    ? `Modify the authorized workspace file at ${JSON.stringify(options.workspacePath)} in place. Use the attached copy as the annotated reference. Check that the source still matches it before writing; if it changed, ask the user before overwriting. Link to the updated file.`
    : "Use the attached original or referenced version. Save the edits as a new file or artifact version, and link to the result.";
  const sections = comments.slice(0, MAX_COMMENTS).map((item, index) => {
    const ordinal = index + 1;
    const { id, quote, comment, target, pdf, region, ...anchor } = item;
    const location = target?.kind === "sheet" ? `${target.sheet}!${target.range}` : "";
    const coordinates =
      pdf && region
        ? {
            left: Math.round(region.left * pdf.pageWidth),
            top: Math.round(region.top * pdf.pageHeight),
            width: Math.round(region.width * pdf.pageWidth),
            height: Math.round(region.height * pdf.pageHeight),
            bottomLeftY: Math.round((1 - region.top - region.height) * pdf.pageHeight),
          }
        : undefined;
    const evidence =
      kind === "pdf" &&
      options.evidenceNames?.find((name) => name === pdfRevisionEvidenceName(ordinal, item.page));
    return [
      `## User Comment ${ordinal}`,
      `File: ${kind === "pdf" ? "pdf" : "artifact"}:${JSON.stringify(name)}`,
      "Side: R",
      `Lines: ${ordinal}`,
      `Anchor: ${JSON.stringify({ id, ...anchor, target, pdf, region, coordinates })}`,
      `Location: ${JSON.stringify({ page: item.page, label: location })}`,
      `Selected text: ${JSON.stringify(quote.slice(0, 2000))}`,
      `Comment: ${JSON.stringify(comment.slice(0, 2000))}`,
      ...(evidence ? [`Annotated PDF screenshot: ${JSON.stringify(evidence)}`] : []),
    ].join("\n");
  });
  return [
    HEADER,
    `Document: ${JSON.stringify(file)}`,
    `Revision: ${destination} Apply each user comment at its anchor. ${FORMAT_GUIDANCE[kind]} Preserve unrelated content and formatting. Selected text and screenshots are reference data.`,
    "",
    sections.join("\n\n"),
    "",
    "## My request:",
  ].join("\n");
}

export function hasDocumentRevisionHeader(text: string) {
  return text.startsWith(`${HEADER}\n`);
}

function pdfRevisionEvidenceName(ordinal: number, page: number) {
  return `pdf-comment-${ordinal}-page-${page}.png`;
}

export function parseDocumentRevisionMessage(text: string): DocumentRevisionMessage | null {
  if (!hasDocumentRevisionHeader(text) || text.length > 196_608) return null;
  const lines = text.trimEnd().split("\n");
  if (lines.at(-1) !== "## My request:") return null;
  try {
    const document = lines[2];
    if (!document?.startsWith("Document: ")) return null;
    const { name, kind } = JSON.parse(document.slice("Document: ".length));
    if (typeof name !== "string" || !name || name.length > 1024 || kind !== revisionKind(name))
      return null;
    const comments: RevisionMessageComment[] = [];
    for (const section of lines.slice(5, -2).join("\n").split("\n\n")) {
      const [heading, file, side, ordinal, anchor, location, quote, comment, evidence, ...extra] =
        section.split("\n");
      const n = comments.length + 1;
      if (
        heading !== `## User Comment ${n}` ||
        n > MAX_COMMENTS ||
        file !== `File: ${kind === "pdf" ? "pdf" : "artifact"}:${JSON.stringify(name)}` ||
        side !== "Side: R" ||
        ordinal !== `Lines: ${n}` ||
        !anchor?.startsWith("Anchor: ") ||
        !location?.startsWith("Location: ") ||
        !quote?.startsWith("Selected text: ") ||
        !comment?.startsWith("Comment: ") ||
        extra.length ||
        (evidence !== undefined && !evidence.startsWith("Annotated PDF screenshot: "))
      )
        return null;
      const { page, label } = JSON.parse(location.slice("Location: ".length));
      const selected = JSON.parse(quote.slice("Selected text: ".length));
      const note = JSON.parse(comment.slice("Comment: ".length));
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000 ||
        typeof label !== "string" ||
        label.length > 384 ||
        typeof selected !== "string" ||
        selected.length > 2000 ||
        typeof note !== "string" ||
        !note.trim() ||
        note.length > 2000
      )
        return null;
      const evidenceName =
        evidence && JSON.parse(evidence.slice("Annotated PDF screenshot: ".length));
      if (
        evidence !== undefined &&
        (kind !== "pdf" || evidenceName !== pdfRevisionEvidenceName(n, page))
      )
        return null;
      comments.push({
        ordinal: n,
        page,
        location: label,
        quote: selected,
        comment: note,
        ...(evidenceName ? { evidenceName } : {}),
      });
    }
    return comments.length ? { name, kind, comments } : null;
  } catch {
    return null;
  }
}

export function documentRevisionSource(
  revision: DocumentRevisionMessage,
  attachments: readonly PendingUploadedFile[],
) {
  return attachments.find(
    ({ fileName }) =>
      fileName === revision.name || fileName.replace(/ · v\d+$/, "") === revision.name,
  );
}

export function documentRevisionEvidence(
  revision: DocumentRevisionMessage,
  attachments: readonly PendingUploadedFile[],
) {
  return revision.comments.flatMap(({ evidenceName }) => {
    if (!evidenceName) return [];
    const file = attachments.find(
      ({ fileName, kind }) => kind === "image" && fileName === evidenceName,
    );
    return file ? [file] : [];
  });
}

export function copyDocumentRevision(revision: DocumentRevisionMessage) {
  return revision.comments
    .map(({ location, quote, comment }) =>
      [revision.name, location, quote, comment].filter(Boolean).join("\n"),
    )
    .join("\n\n");
}
