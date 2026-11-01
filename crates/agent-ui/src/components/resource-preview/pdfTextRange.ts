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
