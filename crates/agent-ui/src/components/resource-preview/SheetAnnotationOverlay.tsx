import { parseXlsxRange, type XlsxCellAddress } from "@extend-ai/react-xlsx";
import { type RefObject, useLayoutEffect, useRef } from "react";
import { SquareMousePointer } from "../IconSet";
import { KbdShortcut } from "../ui/kbd";
import { LabelTooltip } from "../ui/label-tooltip";
import { TooltipButton as Button } from "../ui/tooltip-button";
import type { DocumentRevisionComment, RevisionSelection } from "./ResourceDocumentComments";
import { COMMENT_PIN } from "./readerInteraction";
import { projectSheetRange, type SheetGrid, sheetRangeTopRight } from "./sheetAnnotationGeometry";

export type SheetRevisionCandidate = {
  selection: RevisionSelection;
  endpoint: XlsxCellAddress;
  below: boolean;
  leading: boolean;
};

function RangeOutline() {
  return [0, 1, 2, 3].map((quadrant) => (
    <span key={quadrant} aria-hidden="true" className="za-sheet-range-outline" hidden />
  ));
}

export function SheetAnnotationOverlay({
  viewport,
  sheetName,
  geometry,
  draft,
  candidate,
  marks,
  onEdit,
  onRequest,
  onDismiss,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  sheetName: string;
  geometry: SheetGrid;
  draft: RevisionSelection | null;
  candidate: SheetRevisionCandidate | null;
  marks: readonly DocumentRevisionComment[];
  onEdit: (id: string) => void;
  onRequest: () => void;
  onDismiss: () => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Updating the logical targets replaces the overlay nodes.
  useLayoutEffect(() => {
    const root = overlay.current;
    const view = viewport.current;
    const engine = root?.closest<HTMLElement>(".za-sheet-engine");
    if (!root || !view || !engine) return;
    const shortcut = root.querySelector<HTMLElement>(".za-sheet-range-action");
    const ranges = Array.from(root.querySelectorAll<HTMLElement>("[data-sheet-range]"), (node) => ({
      range: parseXlsxRange(node.dataset.sheetRange ?? ""),
      pieces: Array.from(node.querySelectorAll<HTMLElement>(".za-sheet-range-outline")),
      pin: node.querySelector<HTMLElement>(".za-sheet-comment-pin"),
      draft: node.hasAttribute("data-sheet-draft"),
    }));
    if (!shortcut && !ranges.length) return;

    const editor = engine.querySelector<HTMLElement>(".za-document-comment-editor");
    let editorWidth = editor?.offsetWidth ?? 294;
    let editorHeight = editor?.offsetHeight ?? 48;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const viewState = {
        width: view.clientWidth,
        height: view.clientHeight,
        left: view.scrollLeft,
        top: view.scrollTop,
      };
      for (const { range, pieces, pin, draft } of ranges) {
        const parts =
          range?.kind === "cells" ? projectSheetRange(geometry, range.range, viewState) : [];
        for (const [index, piece] of pieces.entries()) {
          const rect = parts[index];
          piece.hidden = !rect;
          if (!rect) continue;
          piece.style.left = `${rect.left}px`;
          piece.style.top = `${rect.top}px`;
          piece.style.width = `${rect.width}px`;
          piece.style.height = `${rect.height}px`;
        }
        if (pin) {
          const anchor = sheetRangeTopRight(parts);
          pin.hidden = !anchor;
          if (anchor) {
            pin.style.left = `${anchor.left + anchor.width}px`;
            pin.style.top = `${Math.max(13, anchor.top)}px`;
          }
        }
        if (draft) {
          const bounds = parts.at(-1);
          engine.toggleAttribute("data-sheet-comment-offscreen", !bounds);
          if (bounds) {
            const width = viewState.width;
            const x = Math.max(
              12,
              Math.min(bounds.left + bounds.width - editorWidth, width - editorWidth - 12),
            );
            const below = bounds.top + bounds.height + 8;
            const above = bounds.top - editorHeight - 8;
            const bottom = viewState.height - editorHeight - 8;
            const y = Math.max(8, below <= bottom ? below : above >= 8 ? above : bottom);
            engine.style.setProperty("--za-sheet-comment-left", `${x}px`);
            engine.style.setProperty("--za-sheet-comment-top", `${y}px`);
          }
        }
      }
      if (candidate && shortcut) {
        const { endpoint } = candidate;
        const rect = projectSheetRange(geometry, { start: endpoint, end: endpoint }, viewState)[0];
        shortcut.hidden = !rect;
        if (rect) {
          const bottom = rect.top + rect.height;
          const below = rect.top < 48 || (candidate.below && bottom + 48 <= viewState.height);
          shortcut.dataset.below = String(below);
          shortcut.style.top = `${below ? bottom : rect.top}px`;
          shortcut.style.left = candidate.leading
            ? `clamp(6px, ${rect.left}px, calc(100% - 148px))`
            : "";
          shortcut.style.right = candidate.leading
            ? ""
            : `clamp(6px, calc(100% - ${rect.left + rect.width}px), calc(100% - 148px))`;
        }
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(view);
    const resizeEditor = new ResizeObserver(() => {
      if (!editor) return;
      editorWidth = editor.offsetWidth;
      editorHeight = editor.offsetHeight;
      schedule();
    });
    if (editor) resizeEditor.observe(editor);
    view.addEventListener("scroll", schedule, { passive: true });
    draw();
    return () => {
      view.removeEventListener("scroll", schedule);
      resize.disconnect();
      resizeEditor.disconnect();
      cancelAnimationFrame(frame);
      engine.removeAttribute("data-sheet-comment-offscreen");
    };
  }, [viewport, sheetName, geometry, marks, draft, candidate]);

  return (
    <div className="za-sheet-annotations" ref={overlay}>
      {marks.map((mark) => {
        const { target } = mark;
        if (
          mark.id === draft?.editingCommentId ||
          target?.kind !== "sheet" ||
          target.sheet !== sheetName
        )
          return null;
        return (
          <div key={mark.id} data-sheet-comment={mark.id} data-sheet-range={target.range}>
            <RangeOutline />
            <LabelTooltip
              label={mark.comment}
              side="top"
              contentClassName="za-slide-comment-preview"
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`编辑表格批注 ${target.range}`}
                  className="za-sheet-comment-pin"
                  hidden
                  onClick={() => onEdit(mark.id)}
                >
                  <span aria-hidden="true" style={{ backgroundImage: COMMENT_PIN }} />
                </Button>
              }
            />
          </div>
        );
      })}
      {draft?.target?.kind === "sheet" && draft.target.sheet === sheetName && (
        <div data-sheet-draft="" data-sheet-range={draft.target.range}>
          <RangeOutline />
        </div>
      )}
      {candidate?.selection.target?.kind === "sheet" &&
        candidate.selection.target.sheet === sheetName && (
          <Button
            variant="outline"
            size="sm"
            className="za-sheet-range-action"
            aria-label="对选区请求修改"
            aria-keyshortcuts="Control+Shift+X Meta+Shift+X"
            hidden
            onClick={onRequest}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              onDismiss();
            }}
          >
            <SquareMousePointer className="size-3.5" />
            请求修改
            <KbdShortcut
              shortcut="Mod+Shift+KeyX"
              variant="plain"
              size="sm"
              className="za-sheet-range-shortcut"
              aria-hidden="true"
            />
          </Button>
        )}
    </div>
  );
}
