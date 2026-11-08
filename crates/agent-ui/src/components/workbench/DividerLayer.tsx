import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import { cn } from "../../lib/shared/utils";
import {
  clampRatioToSideMinSizes,
  type DividerGeometry,
  MIN_CONVERSATION_PANE_HEIGHT,
  MIN_CONVERSATION_PANE_WIDTH,
} from "../../lib/workbench/geometry";
import { LabelTooltip } from "../ui/label-tooltip";

export type DividerSideMinSizes = { firstMin: number; secondMin: number };

export type DividerLayerProps = {
  dividers: readonly DividerGeometry[];
  dividerSize: number;
  /** Extra pointer target across the split axis; does not change pane geometry. */
  hitSlop?: number;
  separatorLabel: string;
  minPaneWidth?: number;
  minPaneHeight?: number;
  /**
   * Per-split minimum extents along the split axis (per-kind subtree sums).
   * Falls back to the symmetric minPaneWidth/Height when absent for a split.
   */
  minSizesForSplit?: (splitId: string) => DividerSideMinSizes | null;
  /** Live ratio preview while dragging; at most one call per frame. */
  onResizePreview: (splitId: string, ratio: number) => void;
  /** Final ratio on pointer-up / keyboard commit. */
  onResizeCommit: (splitId: string, ratio: number) => void;
  /** Clear the live preview without committing it. */
  onResizeCancel: () => void;
  onDragStateChange?: (dragging: boolean) => void;
  /** Double-click / Enter restores the caller's default (normally 50/50). */
  onEqualize?: (splitId: string) => void;
  /** Optional discoverability hint, composed onto the separator without a DOM wrapper. */
  resetHint?: string;
};

const KEYBOARD_RESIZE_STEP = 0.02;

function usableSplitSize(divider: DividerGeometry, dividerSize: number) {
  return (
    (divider.axis === "horizontal" ? divider.splitArea.width : divider.splitArea.height) -
    dividerSize
  );
}

function currentRatio(divider: DividerGeometry, dividerSize: number): number {
  const usable = usableSplitSize(divider, dividerSize);
  if (usable <= 0) return 0.5;
  return divider.axis === "horizontal"
    ? (divider.rect.left - divider.splitArea.left) / usable
    : (divider.rect.top - divider.splitArea.top) / usable;
}

/**
 * Pointer-captured split dividers. Rendered above the pane layer; each
 * divider maps pointer moves to a clamped ratio for its own split only.
 */
export function DividerLayer(props: DividerLayerProps) {
  const { t } = useLocale();
  const {
    dividers,
    dividerSize,
    hitSlop = 0,
    separatorLabel,
    minPaneWidth = MIN_CONVERSATION_PANE_WIDTH,
    minPaneHeight = MIN_CONVERSATION_PANE_HEIGHT,
    minSizesForSplit,
    onResizePreview,
    onResizeCommit,
    onResizeCancel,
    onDragStateChange,
    onEqualize,
    resetHint,
  } = props;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragRef = useRef<{
    target: HTMLDivElement;
    pointerId: number;
    splitId: string;
    startPoint: number;
    startRatio: number;
    lastRatio: number;
    frame: number | null;
  } | null>(null);
  const finishDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      if (drag.frame !== null) cancelAnimationFrame(drag.frame);
      if (drag.target.hasPointerCapture?.(drag.pointerId))
        drag.target.releasePointerCapture(drag.pointerId);
      setDraggingId(null);
      onDragStateChange?.(false);
      if (commit && drag.lastRatio !== drag.startRatio)
        onResizeCommit(drag.splitId, drag.lastRatio);
      else onResizeCancel();
    },
    [onDragStateChange, onResizeCancel, onResizeCommit],
  );

  useLayoutEffect(() => {
    if (!draggingId) return;
    const cancel = () => finishDrag(false);
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", cancelOnEscape, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", cancelOnEscape, true);
      window.removeEventListener("blur", cancel);
    };
  }, [draggingId, finishDrag]);

  useLayoutEffect(() => {
    if (draggingId && !dividers.some(({ splitId }) => splitId === draggingId)) finishDrag(false);
  }, [dividers, draggingId, finishDrag]);

  useLayoutEffect(
    () => () => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.frame != null) cancelAnimationFrame(drag.frame);
    },
    [],
  );

  const clampFor = useCallback(
    (divider: DividerGeometry, ratio: number) => {
      const fallbackMin = divider.axis === "horizontal" ? minPaneWidth : minPaneHeight;
      const sides = minSizesForSplit?.(divider.splitId);
      return clampRatioToSideMinSizes({
        ratio,
        axis: divider.axis,
        splitArea: divider.splitArea,
        firstMin: sides?.firstMin ?? fallbackMin,
        secondMin: sides?.secondMin ?? fallbackMin,
        dividerSize,
      });
    },
    [dividerSize, minPaneHeight, minPaneWidth, minSizesForSplit],
  );

  return (
    <>
      {dividers.map((divider) => {
        const ratioNow = clampFor(divider, currentRatio(divider, dividerSize));
        const minRatio = clampFor(divider, 0);
        const maxRatio = clampFor(divider, 1);
        const separator = (
          // biome-ignore lint/a11y/useSemanticElements: This is an interactive, draggable separator with value semantics; hr cannot implement pointer capture or keyboard resizing.
          <div
            key={divider.splitId}
            data-workbench-divider={divider.splitId}
            data-resizing={draggingId === divider.splitId || undefined}
            role="separator"
            tabIndex={0}
            aria-label={separatorLabel}
            aria-description={t(
              onEqualize ? "layout.splitResizeResetKeys" : "layout.splitResizeKeys",
            )}
            aria-orientation={divider.axis === "horizontal" ? "vertical" : "horizontal"}
            aria-valuemin={Math.round(minRatio * 100)}
            aria-valuemax={Math.round(maxRatio * 100)}
            aria-valuenow={Math.round(ratioNow * 100)}
            className={cn(
              "absolute z-10 flex touch-none items-center justify-center bg-transparent",
              divider.axis === "horizontal" ? "cursor-col-resize" : "cursor-row-resize",
              "focus-visible:outline-none",
              "group/divider",
            )}
            style={{
              left: divider.rect.left - (divider.axis === "horizontal" ? hitSlop / 2 : 0),
              top: divider.rect.top - (divider.axis === "vertical" ? hitSlop / 2 : 0),
              width: divider.rect.width + (divider.axis === "horizontal" ? hitSlop : 0),
              height: divider.rect.height + (divider.axis === "vertical" ? hitSlop : 0),
            }}
            onDoubleClick={() => onEqualize?.(divider.splitId)}
            onPointerDown={(event) => {
              if (event.button !== 0 || dragRef.current) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              dragRef.current = {
                target: event.currentTarget,
                pointerId: event.pointerId,
                splitId: divider.splitId,
                startPoint: divider.axis === "horizontal" ? event.clientX : event.clientY,
                startRatio: ratioNow,
                lastRatio: ratioNow,
                frame: null,
              };
              setDraggingId(divider.splitId);
              onDragStateChange?.(true);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag || drag.pointerId !== event.pointerId) return;
              const usable = usableSplitSize(divider, dividerSize);
              if (usable <= 0) return;
              const point = divider.axis === "horizontal" ? event.clientX : event.clientY;
              drag.lastRatio = clampFor(
                divider,
                drag.startRatio + (point - drag.startPoint) / usable,
              );
              if (drag.frame !== null) return;
              drag.frame = requestAnimationFrame(() => {
                const active = dragRef.current;
                if (active?.splitId === divider.splitId) {
                  active.frame = null;
                  onResizePreview(divider.splitId, active.lastRatio);
                }
              });
            }}
            onPointerUp={(event) => {
              if (dragRef.current?.pointerId === event.pointerId) finishDrag(true);
            }}
            onPointerCancel={(event) => {
              if (dragRef.current?.pointerId === event.pointerId) finishDrag(false);
            }}
            onLostPointerCapture={(event) => {
              if (dragRef.current?.pointerId === event.pointerId) finishDrag(false);
            }}
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey || dragRef.current) return;
              if (event.key === "Enter" && onEqualize) {
                event.preventDefault();
                event.stopPropagation();
                onEqualize(divider.splitId);
                return;
              }
              const horizontal = divider.axis === "horizontal";
              const decreaseKey = horizontal ? "ArrowLeft" : "ArrowUp";
              const increaseKey = horizontal ? "ArrowRight" : "ArrowDown";
              const step = KEYBOARD_RESIZE_STEP * (event.shiftKey ? 4 : 1);
              const next =
                event.key === decreaseKey
                  ? ratioNow - step
                  : event.key === increaseKey
                    ? ratioNow + step
                    : event.key === "Home"
                      ? minRatio
                      : event.key === "End"
                        ? maxRatio
                        : null;
              if (next === null) return;
              event.preventDefault();
              event.stopPropagation();
              const ratio = clampFor(divider, next);
              if (ratio !== ratioNow) onResizeCommit(divider.splitId, ratio);
            }}
          >
            <span
              aria-hidden="true"
              className={cn(
                "bg-border/80 transition-colors duration-100 motion-reduce:transition-none",
                "group-hover/divider:bg-primary/50 group-focus-visible/divider:bg-primary/60",
                "group-data-[resizing]/divider:bg-primary/60",
                // Forced-colors modes drop the themed backgrounds entirely, so
                // the divider needs a system colour to stay visible at all.
                "forced-colors:bg-[CanvasText]",
                "group-hover/divider:forced-colors:bg-[Highlight] group-focus-visible/divider:forced-colors:bg-[Highlight] group-data-[resizing]/divider:forced-colors:bg-[Highlight]",
                divider.axis === "horizontal"
                  ? "h-full w-px group-hover/divider:w-[3px] group-focus-visible/divider:w-[3px] group-data-[resizing]/divider:w-[3px]"
                  : "h-px w-full -translate-y-px group-hover/divider:h-[3px] group-focus-visible/divider:h-[3px] group-data-[resizing]/divider:h-[3px]",
              )}
            />
          </div>
        );
        return resetHint && onEqualize ? (
          <LabelTooltip
            key={divider.splitId}
            label={resetHint}
            disabled={draggingId === divider.splitId}
            side={divider.axis === "horizontal" ? "right" : "bottom"}
            render={separator}
          />
        ) : (
          separator
        );
      })}
    </>
  );
}
