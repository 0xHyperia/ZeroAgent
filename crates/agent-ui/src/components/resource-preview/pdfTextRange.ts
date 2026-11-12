import type { DocumentRegion } from "./docxReaderDocument";

export function normalizedPDFRegion(rect: DocumentRegion, paper: DOMRect): DocumentRegion {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const left = clamp((rect.left - paper.left) / paper.width);
  const top = clamp((rect.top - paper.top) / paper.height);
  return {
    left,
    top,
    width: clamp((rect.left + rect.width - paper.left) / paper.width) - left,
    height: clamp((rect.top + rect.height - paper.top) / paper.height) - top,
  };
}

export function readPDFTextRange(layer: HTMLElement, selection: Selection | null) {
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (
    !range ||
    range.collapsed ||
    !layer.contains(range.startContainer) ||
    !layer.contains(range.endContainer)
  )
    return null;
  const quote = range.toString().slice(0, 2000);
  if (!quote.trim()) return null;
  const prefix = layer.ownerDocument.createRange();
  prefix.selectNodeContents(layer);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  return { range, quote, start, end: start + quote.length };
}

/** Rebuild a TextLayer selection after rendering or zoom without trusting old DOM nodes. */
export function pdfTextRange(root: HTMLElement, start: number, end: number, quote: string) {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end - start > 2000
  )
    return null;
  const range = root.ownerDocument.createRange();
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range.toString() === quote ? range : null;
    }
    offset += length;
    if (offset > 2_000_000) return null;
  }
  return null;
}
