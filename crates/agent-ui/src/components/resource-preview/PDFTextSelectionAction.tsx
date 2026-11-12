import { type RefObject, useEffect, useRef, useState } from "react";
import { normalizedPDFRegion, readPDFTextRange } from "./pdfTextRange";
import {
  ReaderTextSelectionAction,
  readerSelectionPosition,
  readerSelectionViewport,
} from "./ReaderTextSelectionAction";
import type { RevisionSelection } from "./ResourceDocumentComments";
import type { PreviewZoom } from "./readingSession";

function readAnchor(viewport: HTMLElement, workspace: HTMLElement, pageCount: number) {
  const selected = viewport.ownerDocument.getSelection();
  const node = selected?.anchorNode;
  const element = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
  const layer = element?.closest<HTMLElement>(".za-pdf-text-layer");
  const paper = layer?.closest<HTMLElement>("[data-pdf-page]");
  if (!layer || !paper || !viewport.contains(paper) || paper.getAttribute("aria-busy") === "true")
    return null;
  const text = readPDFTextRange(layer, selected);
  if (!text || !selected) return null;
  const { range, quote, start, end } = text;
  const page = Number(paper.dataset.pdfPage);
  const pageWidth = Number(paper.dataset.pdfPageWidth);
  const pageHeight = Number(paper.dataset.pdfPageHeight);
  if (!Number.isSafeInteger(page) || page < 1 || page > pageCount || !pageWidth || !pageHeight)
    return null;
  const paperBox = paper.getBoundingClientRect();
  const area = workspace.getBoundingClientRect();
  const view = viewport.getBoundingClientRect();
  if (!paperBox.width || !paperBox.height || !view.width || !view.height) return null;
  const { left, right, top, bottom } = readerSelectionViewport(viewport);
  const backwards =
    selected.anchorNode === range.endContainer && selected.anchorOffset === range.endOffset;
  const visibleRects = Array.from(range.getClientRects()).filter(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > left &&
      rect.left < right &&
      rect.bottom > top &&
      rect.top < bottom,
  );
  const anchor = backwards ? visibleRects[0] : visibleRects.at(-1);
  if (!anchor) return null;
  const rect = range.getBoundingClientRect();
  const revision: RevisionSelection = {
    id: `pdf-page-${page}`,
    page,
    start,
    end,
    quote,
    region: normalizedPDFRegion(rect, paperBox),
    pdf: { pageCount, pageWidth, pageHeight, kind: "text" },
    x: Math.max(12, Math.min(anchor.left - area.left, area.width - 352)),
    y: Math.min(anchor.bottom - area.top, area.height - 110),
  };
  return {
    position: readerSelectionPosition(anchor, { left, right, top, bottom }, area),
    revision,
  };
}

export function PDFTextSelectionAction({
  viewport,
  workspace,
  pageCount,
  zoom,
  assertCurrent,
  onPick,
}: {
  viewport: RefObject<HTMLElement | null>;
  workspace: RefObject<HTMLElement | null>;
  pageCount: number;
  zoom: PreviewZoom;
  assertCurrent: () => void;
  onPick: (selection: RevisionSelection) => void;
}) {
  const action = useRef<HTMLButtonElement>(null);
  const [candidate, setCandidate] = useState<ReturnType<typeof readAnchor>>(null);
  // Zoom changes paper size even when the viewport itself stays the same.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Re-read the selection after zoom changes.
  useEffect(() => {
    const view = viewport.current;
    const root = workspace.current;
    const doc = view?.ownerDocument;
    const win = doc?.defaultView;
    if (!view || !root || !doc || !win) return;
    let frame = 0;
    let dragging: number | null = null;
    const inspect = () => {
      if (dragging !== null || frame) return;
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        setCandidate(dragging === null ? readAnchor(view, root, pageCount) : null);
      });
    };
    const down = (event: PointerEvent) => {
      const target = event.target;
      if (event.button !== 0 || !(target instanceof Node) || action.current?.contains(target))
        return;
      if (view.contains(target)) dragging = event.pointerId;
      setCandidate(null);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== dragging) return;
      dragging = null;
      inspect();
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !action.current) return;
      if (
        !(event.target instanceof Node) ||
        (event.target !== doc.body && !root.contains(event.target))
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      doc.getSelection()?.removeAllRanges();
      if (doc.activeElement === action.current) view.focus({ preventScroll: true });
      setCandidate(null);
    };
    const scroll = ({ target }: Event) => {
      if (target === doc || (target instanceof Node && target.contains(view))) inspect();
    };
    const resize = new ResizeObserver(inspect);
    resize.observe(view);
    doc.addEventListener("selectionchange", inspect);
    doc.addEventListener("pointerdown", down, true);
    doc.addEventListener("pointerup", up, true);
    doc.addEventListener("pointercancel", up, true);
    doc.addEventListener("keydown", dismiss, true);
    win.addEventListener("scroll", scroll, { capture: true, passive: true });
    inspect();
    return () => {
      resize.disconnect();
      win.cancelAnimationFrame(frame);
      doc.removeEventListener("selectionchange", inspect);
      doc.removeEventListener("pointerdown", down, true);
      doc.removeEventListener("pointerup", up, true);
      doc.removeEventListener("pointercancel", up, true);
      doc.removeEventListener("keydown", dismiss, true);
      win.removeEventListener("scroll", scroll, true);
    };
  }, [viewport, workspace, pageCount, zoom]);
  if (!candidate) return null;
  return (
    <ReaderTextSelectionAction
      actionRef={action}
      position={candidate.position}
      onPick={() => {
        const view = viewport.current;
        const root = workspace.current;
        if (!view || !root) return;
        const anchor = readAnchor(view, root, pageCount);
        if (!anchor) return setCandidate(null);
        try {
          assertCurrent();
        } catch {
          setCandidate(null);
          return;
        }
        view.ownerDocument.getSelection()?.removeAllRanges();
        onPick(anchor.revision);
      }}
    />
  );
}
