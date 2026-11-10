import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "../../../i18n";
import { ChevronDown, ChevronUp } from "../../IconSet";
import { TooltipButton } from "../../ui/tooltip-button";

function renderedHunks(viewport: HTMLElement) {
  const body = viewport.querySelector<HTMLElement>("[data-review-hunk-anchors]");
  if (!body) return [];
  const indexedRows = new Map<string, HTMLElement>();
  for (const number of body.querySelectorAll<HTMLElement>(
    "[data-line-old-num], [data-line-new-num], [data-line-num]",
  )) {
    const row = number.closest<HTMLElement>("tr");
    if (!row) continue;
    const oldLine = number.dataset.lineOldNum;
    const newLine = number.dataset.lineNewNum;
    const splitLine = number.dataset.lineNum;
    if (oldLine) indexedRows.set(`old:${oldLine}`, row);
    if (newLine) indexedRows.set(`new:${newLine}`, row);
    if (splitLine && row.dataset.side) indexedRows.set(`${row.dataset.side}:${splitLine}`, row);
  }
  const rows = new Set<HTMLElement>();
  for (const anchor of body.dataset.reviewHunkAnchors?.split(",") ?? []) {
    const row = indexedRows.get(anchor);
    if (row) rows.add(row);
  }
  return [...rows];
}

export function WorkspaceDiffNavigation({ root }: { root: RefObject<HTMLElement | null> }) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [position, setPosition] = useState({ current: -1, count: 0, focused: false });
  const targets = useRef<HTMLElement[]>([]);
  const viewport = useRef<HTMLElement | null>(null);
  const navigatedScrollTop = useRef<number | undefined>(undefined);
  const updatePosition = useCallback(() => {
    const scroll = viewport.current;
    if (!scroll) return;
    if (navigatedScrollTop.current === scroll.scrollTop) return;
    navigatedScrollTop.current = undefined;
    const top = scroll.getBoundingClientRect().top;
    const count = targets.current.length;
    let current = count - 1;
    while (current >= 0 && targets.current[current].getBoundingClientRect().top > top + 4)
      current--;
    setPosition((previous) =>
      previous.current === current && previous.count === count && !previous.focused
        ? previous
        : { current, count, focused: false },
    );
  }, []);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      const scroll = element.querySelector<HTMLElement>("[data-review-scroll-viewport]");
      if (scroll !== viewport.current) {
        viewport.current?.removeEventListener("scroll", updatePosition);
        viewport.current = scroll;
        scroll?.addEventListener("scroll", updatePosition, { passive: true });
      }
      targets.current = scroll ? renderedHunks(scroll) : [];
      navigatedScrollTop.current = undefined;
      if (scroll) updatePosition();
      else setPosition({ current: -1, count: 0, focused: false });
    };
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-review-hunk-anchors"],
    });
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.current?.removeEventListener("scroll", updatePosition);
      viewport.current = null;
      targets.current = [];
    };
  }, [root, updatePosition]);

  const navigate = (direction: -1 | 1) => {
    const scroll = viewport.current;
    if (!scroll) return;
    const index = position.current + direction;
    const target = targets.current[index];
    if (!target?.isConnected) return;
    scroll.scrollTop += target.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    navigatedScrollTop.current = scroll.scrollTop;
    setPosition({ current: index, count: targets.current.length, focused: true });
  };
  const prev = zh ? "上一处变更" : "Previous change";
  const next = zh ? "下一处变更" : "Next change";
  return (
    <div
      className="za-review-change-navigation"
      role="group"
      aria-label={zh ? "变更定位" : "Change navigation"}
    >
      <TooltipButton
        type="button"
        variant="ghost"
        size="icon-xs"
        className="za-review-icon"
        aria-label={prev}
        title={prev}
        tooltipSide="bottom"
        disabled={position.current <= 0}
        onClick={() => navigate(-1)}
      >
        <ChevronUp aria-hidden="true" className="size-3.5" />
      </TooltipButton>
      <span
        role="status"
        aria-live="polite"
        aria-label={
          position.focused
            ? zh
              ? `第 ${position.current + 1} 处，共 ${position.count} 处变更`
              : `${position.current + 1} of ${position.count} changes`
            : zh
              ? `共 ${position.count} 处变更`
              : `${position.count} changes`
        }
      >
        {position.focused ? `${position.current + 1}/${position.count}` : position.count}
      </span>
      <TooltipButton
        type="button"
        variant="ghost"
        size="icon-xs"
        className="za-review-icon"
        aria-label={next}
        title={next}
        tooltipSide="bottom"
        disabled={position.current >= position.count - 1}
        onClick={() => navigate(1)}
      >
        <ChevronDown aria-hidden="true" className="size-3.5" />
      </TooltipButton>
    </div>
  );
}
