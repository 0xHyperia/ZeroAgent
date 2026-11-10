import type { PDFDocumentProxy } from "pdfjs-dist";
import { MAX_REVISION_EVIDENCE } from "../../lib/chat/documentRevisionMessage";
import type { DocumentRegion } from "./docxReaderDocument";
import type { DocumentRevisionComment } from "./ResourceDocumentComments";

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_DIMENSION = 1600;

/** Coordinates follow the PDF.js page viewport at scale 1, including page rotation. */
function evidenceCrop(bounds: DocumentRegion, width: number, height: number, point: boolean) {
  const margin = Math.max(24, Math.min(72, Math.min(bounds.width, bounds.height) / 4));
  const cropWidth = Math.min(width, point ? 360 : bounds.width + 2 * margin);
  const cropHeight = Math.min(height, point ? 240 : bounds.height + 2 * margin);
  return {
    left: Math.max(0, Math.min(width - cropWidth, bounds.left - (point ? 180 : margin))),
    top: Math.max(0, Math.min(height - cropHeight, bounds.top - (point ? 120 : margin))),
    width: cropWidth,
    height: cropHeight,
  };
}

async function renderEvidence(
  pdf: PDFDocumentProxy,
  comment: DocumentRevisionComment,
  number: number,
) {
  if (!comment.region || comment.page < 1 || comment.page > pdf.numPages) return null;
  const page = await pdf.getPage(comment.page);
  const { width, height } = page.getViewport({ scale: 1 });
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const bounds = {
    left: comment.region.left * width,
    top: comment.region.top * height,
    width: comment.region.width * width,
    height: comment.region.height * height,
  };
  if (Object.values(bounds).some((value) => !Number.isFinite(value) || value < 0)) return null;
  const point = comment.pdf?.kind === "point";
  const crop = evidenceCrop(bounds, width, height, point);
  const scale = Math.min(
    2,
    Math.max(1, 1200 / crop.width),
    MAX_EVIDENCE_DIMENSION / Math.max(crop.width, crop.height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(crop.width * scale);
  canvas.height = Math.ceil(crop.height * scale);
  try {
    const context = canvas.getContext("2d");
    if (!context) return null;
    const render = page.render({
      canvas,
      viewport: page.getViewport({ scale }),
      transform: [1, 0, 0, 1, -crop.left * scale, -crop.top * scale],
    });
    const timeout = setTimeout(() => render.cancel(), 4000);
    try {
      await render.promise;
    } finally {
      clearTimeout(timeout);
    }
    const x = (bounds.left - crop.left) * scale;
    const y = (bounds.top - crop.top) * scale;
    const w = bounds.width * scale;
    const h = bounds.height * scale;
    context.fillStyle = "#2563eb";
    if (!point) {
      context.strokeStyle = context.fillStyle;
      context.lineWidth = 3;
      context.strokeRect(x, y, w, h);
    }
    const radius = Math.min(11, canvas.width / 2, canvas.height / 2);
    const labelX = Math.max(radius, Math.min(canvas.width - radius, x + w));
    const labelY = Math.max(radius, Math.min(canvas.height - radius, y));
    context.beginPath();
    context.arc(labelX, labelY, radius, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = "#fff";
    context.stroke();
    context.fillStyle = "#fff";
    context.font = `bold ${Math.min(14, radius * 1.25)}px sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(number), labelX, labelY + 0.5);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return (
      blob &&
      new File([blob], `pdf-comment-${number}-page-${comment.page}.png`, { type: blob.type })
    );
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function capturePDFRevisionEvidence(
  pdf: PDFDocumentProxy,
  comments: readonly DocumentRevisionComment[],
  assertCurrent: () => void,
): Promise<readonly File[]> {
  const files: File[] = [];
  let bytes = 0;
  const deadline = Date.now() + 10_000;
  for (const [index, comment] of comments.entries()) {
    if (files.length >= MAX_REVISION_EVIDENCE || Date.now() >= deadline) break;
    assertCurrent();
    // A rendering failure leaves the structured comment intact. Authorization errors still surface.
    const file = await renderEvidence(pdf, comment, index + 1).catch(() => null);
    assertCurrent();
    if (!file || file.size > MAX_EVIDENCE_BYTES - bytes) continue;
    files.push(file);
    bytes += file.size;
  }
  return files;
}
