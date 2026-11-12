import type { RefObject } from "react";
import { useLocale } from "../../i18n";
import { SquareMousePointer } from "../IconSet";
import { Button } from "../ui/button";

export function readerSelectionViewport(viewport: HTMLElement) {
  const view = viewport.getBoundingClientRect();
  const win = viewport.ownerDocument.defaultView;
  return {
    left: Math.max(view.left, 0),
    right: Math.min(view.right, win?.innerWidth ?? view.right),
    top: Math.max(view.top, 0),
    bottom: Math.min(view.bottom, win?.innerHeight ?? view.bottom),
  };
}

export function readerSelectionPosition(
  anchor: DOMRectReadOnly,
  view: ReturnType<typeof readerSelectionViewport>,
  area: DOMRectReadOnly,
) {
  const below = anchor.top - view.top < 52;
  return {
    x: (Math.max(anchor.left, view.left) + Math.min(anchor.right, view.right)) / 2 - area.left,
    y: (below ? anchor.bottom : anchor.top) - area.top,
    below,
  };
}

export function ReaderTextSelectionAction({
  actionRef,
  position,
  onPick,
}: {
  actionRef?: RefObject<HTMLButtonElement | null>;
  position: ReturnType<typeof readerSelectionPosition>;
  onPick: () => void;
}) {
  const { locale } = useLocale();
  return (
    <Button
      ref={actionRef}
      type="button"
      variant="outline"
      size="sm"
      className="za-reader-text-selection-action"
      data-below={position.below}
      style={{
        left: `clamp(min(50%, 80px), ${position.x}px, max(50%, calc(100% - 80px)))`,
        top: position.y,
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button === 0) event.preventDefault();
      }}
      onClick={onPick}
    >
      <SquareMousePointer className="size-4" aria-hidden="true" />
      {locale === "zh-CN" ? "请求修改" : "Request changes"}
    </Button>
  );
}
